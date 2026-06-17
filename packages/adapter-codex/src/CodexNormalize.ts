import { DateTime, Option, Schema } from "effect"
import { type Message, type SessionArchive, safeDateTime } from "../../core/src/Domain"

// --- On-disk shapes (Schema = source of truth; unmapped variants fall through) ---

/** One rollout JSONL line. Parse + decode in a single step via fromJsonString. */
const CodexLine = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.String),
  payload: Schema.optionalKey(Schema.Unknown)
})
const decodeCodexLine = Schema.decodeUnknownOption(Schema.fromJsonString(CodexLine))

/** `session_meta` / `turn_context` metadata — fields vary by record, all optional. */
const MetaPayload = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  session_id: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String)
})
const decodeMeta = Schema.decodeUnknownOption(MetaPayload)

/** `response_item` payload variants we render. Opaque sub-payloads stay Unknown. */
const MessageItem = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Unknown)
})
const ReasoningItem = Schema.Struct({ type: Schema.Literal("reasoning"), summary: Schema.optionalKey(Schema.Unknown) })
const ToolCallItem = Schema.Struct({
  type: Schema.Literals(["function_call", "custom_tool_call"]),
  name: Schema.optionalKey(Schema.String),
  arguments: Schema.optionalKey(Schema.Unknown),
  input: Schema.optionalKey(Schema.Unknown)
})
const ToolOutputItem = Schema.Struct({
  type: Schema.Literals(["function_call_output", "custom_tool_call_output"]),
  output: Schema.optionalKey(Schema.Unknown)
})
const SearchItem = Schema.Struct({
  type: Schema.Literals(["web_search_call", "tool_search_call"]),
  query: Schema.optionalKey(Schema.String)
})
const ResponseItem = Schema.Union([MessageItem, ReasoningItem, ToolCallItem, ToolOutputItem, SearchItem])
const decodeResponseItem = Schema.decodeUnknownOption(ResponseItem)

/** Content / summary blocks inside a message or reasoning item. */
const CodexTextBlock = Schema.Struct({
  type: Schema.Literals(["input_text", "output_text", "text", "summary_text"]),
  text: Schema.optionalKey(Schema.String)
})
const CodexImageBlock = Schema.Struct({ type: Schema.Literals(["input_image", "output_image"]) })
const CodexBlock = Schema.Union([CodexTextBlock, CodexImageBlock])
const decodeCodexBlock = Schema.decodeUnknownOption(CodexBlock)

const decodeString = Schema.decodeUnknownOption(Schema.String)
const decodeBlockArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** Render a decoded value as a fenced body; absent payloads → `{}`. */
const jsonBody = (value: unknown): string => (value === undefined ? "{}" : JSON.stringify(value, null, 2))

/** Tool args may arrive as a JSON string or an object — pretty-print either. */
const renderArgs = (value: unknown): string => {
  const asStr = decodeString(value)
  if (Option.isSome(asStr)) {
    const parsed = decodeJsonString(asStr.value)
    return Option.isSome(parsed) ? jsonBody(parsed.value) : asStr.value
  }
  return jsonBody(value)
}

const renderContentBlocks = (content: unknown): string => {
  const asText = decodeString(content)
  if (Option.isSome(asText)) return asText.value
  const asBlocks = decodeBlockArray(content)
  if (Option.isNone(asBlocks)) return ""
  const parts: Array<string> = []
  for (const raw of asBlocks.value) {
    const decoded = decodeCodexBlock(raw)
    if (Option.isNone(decoded)) continue
    const block = decoded.value
    switch (block.type) {
      case "input_text":
      case "output_text":
      case "text":
      case "summary_text":
        if (block.text !== undefined) parts.push(block.text)
        break
      case "input_image":
      case "output_image":
        parts.push("_(image)_")
        break
    }
  }
  return parts.join("\n\n")
}

/**
 * Pull the working directory out of a rollout's metadata records as cheaply as
 * possible — used to build the `cwd → sessions` index. Returns the first cwd
 * found in `session_meta` or `turn_context`.
 */
export const extractCodexCwd = (lines: ReadonlyArray<string>): string | undefined => {
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    const decoded = decodeCodexLine(line)
    if (Option.isNone(decoded)) continue
    const record = decoded.value
    if (record.type !== "session_meta" && record.type !== "turn_context") continue
    const meta = decodeMeta(record.payload)
    if (Option.isSome(meta) && meta.value.cwd !== undefined) return meta.value.cwd
  }
  return undefined
}

const messageFromResponseItem = (payload: unknown, at: DateTime.Utc): Message | undefined => {
  const decoded = decodeResponseItem(payload)
  if (Option.isNone(decoded)) return undefined
  const item = decoded.value

  switch (item.type) {
    case "message": {
      const role = item.role ?? "assistant"
      if (role === "developer" || role === "system") return undefined
      const text = renderContentBlocks(item.content).trim()
      if (text.length === 0) return undefined
      return { role, text, at }
    }
    case "reasoning": {
      const summary = renderContentBlocks(item.summary).trim()
      if (summary.length === 0) return undefined
      return { role: "assistant", text: `_(reasoning)_\n${summary}`, at }
    }
    case "function_call":
    case "custom_tool_call":
      return { role: "tool", text: `**→ ${item.name ?? "tool"}**\n\`\`\`\n${renderArgs(item.arguments ?? item.input)}\n\`\`\``, at }
    case "function_call_output":
    case "custom_tool_call_output": {
      const out = decodeString(item.output)
      const text = Option.isSome(out) ? out.value : jsonBody(item.output)
      if (text.trim().length === 0) return undefined
      return { role: "tool", text: `**← output**\n${text}`, at }
    }
    case "web_search_call":
    case "tool_search_call":
      return { role: "tool", text: `**→ ${item.type}** ${item.query ?? ""}`.trim(), at }
  }
}

export const normalizeCodexSession = (input: {
  readonly filePath: string
  readonly sessionIdFallback: string
  readonly fallbackDate: DateTime.Utc
  readonly lines: ReadonlyArray<string>
}): SessionArchive => {
  const messages: Array<Message> = []
  let sessionId = input.sessionIdFallback
  let cwd: string | undefined
  let model: string | undefined
  let startedAt: DateTime.Utc | undefined
  let updatedAt: DateTime.Utc | undefined

  for (const raw of input.lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    const decoded = decodeCodexLine(line)
    if (Option.isNone(decoded)) continue
    const record = decoded.value
    const at = safeDateTime(record.timestamp, input.fallbackDate)

    if (record.type === "session_meta" || record.type === "turn_context") {
      const meta = decodeMeta(record.payload)
      if (Option.isSome(meta)) {
        sessionId = meta.value.id ?? meta.value.session_id ?? sessionId
        cwd = meta.value.cwd ?? cwd
        model = meta.value.model ?? model
        if (record.type === "session_meta" && startedAt === undefined) startedAt = at
      }
      continue
    }

    if (record.type === "response_item") {
      const message = messageFromResponseItem(record.payload, at)
      if (message !== undefined) {
        messages.push(message)
        if (startedAt === undefined) startedAt = at
        updatedAt = at
      }
    }
  }

  return {
    provider: "codex",
    sessionId,
    cwd,
    model,
    startedAt,
    updatedAt,
    sourcePath: input.filePath,
    messages
  }
}
