import { DateTime, Option, Schema } from "effect"
import { type Message, type SessionArchive, safeDateTime } from "../../core/src/Domain"

// The Schema is the single source of truth for each row shape; the row types are
// derived from it so the decode result needs no cast and drift is a type error.
export const SessionRowSchema = Schema.Struct({
  id: Schema.String,
  directory: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  time_created: Schema.NullOr(Schema.Number),
  time_updated: Schema.NullOr(Schema.Number),
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String)
})

export const MessageRowSchema = Schema.Struct({
  id: Schema.String,
  data: Schema.String,
  time_created: Schema.NullOr(Schema.Number)
})

export const PartRowSchema = Schema.Struct({
  message_id: Schema.String,
  data: Schema.String,
  time_created: Schema.NullOr(Schema.Number)
})

export type OpenCodeSessionRow = Schema.Schema.Type<typeof SessionRowSchema>
export type OpenCodeMessageRow = Schema.Schema.Type<typeof MessageRowSchema>
export type OpenCodePartRow = Schema.Schema.Type<typeof PartRowSchema>

// --- part.data / message.data content (each JSON blob decoded via Schema) -----

const ModelObject = Schema.Struct({
  providerID: Schema.optionalKey(Schema.String),
  modelID: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String)
})
const decodeModelObject = Schema.decodeUnknownOption(Schema.fromJsonString(ModelObject))

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.optionalKey(Schema.String) })
const ReasoningPart = Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.optionalKey(Schema.String) })
const ToolPart = Schema.Struct({
  type: Schema.Literal("tool"),
  tool: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(
    Schema.Struct({ input: Schema.optionalKey(Schema.Unknown), output: Schema.optionalKey(Schema.String) })
  )
})
const PatchPart = Schema.Struct({ type: Schema.Literal("patch"), files: Schema.optionalKey(Schema.Unknown) })
const FilePart = Schema.Struct({
  type: Schema.Literal("file"),
  filename: Schema.optionalKey(Schema.String),
  mime: Schema.optionalKey(Schema.String)
})
const PartData = Schema.Union([TextPart, ReasoningPart, ToolPart, PatchPart, FilePart])
const decodePartData = Schema.decodeUnknownOption(Schema.fromJsonString(PartData))

const MessageData = Schema.Struct({ role: Schema.optionalKey(Schema.String) })
const decodeMessageData = Schema.decodeUnknownOption(Schema.fromJsonString(MessageData))

const decodeArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))
const jsonBody = (value: unknown): string => (value === undefined ? "{}" : JSON.stringify(value, null, 2))

/** OpenCode stores `model` as either a plain string or a JSON object — let the
 * schema decide which, rather than sniffing for a leading `{`. */
export const normalizeOpenCodeModel = (model: string | null | undefined): string | undefined => {
  const text = model?.trim()
  if (text === undefined || text.length === 0) return undefined
  const decoded = decodeModelObject(text)
  if (Option.isSome(decoded)) {
    const id = decoded.value.modelID ?? decoded.value.id ?? decoded.value.name
    if (id !== undefined) return decoded.value.providerID !== undefined ? `${decoded.value.providerID}/${id}` : id
  }
  return text
}

const renderToolPart = (part: Schema.Schema.Type<typeof ToolPart>): string => {
  const lines = [`**→ ${part.tool ?? "tool"}**`]
  const input = part.state?.input
  const output = part.state?.output
  if (input !== undefined) lines.push(`\`\`\`json\n${jsonBody(input)}\n\`\`\``)
  if (output !== undefined && output.length > 0) lines.push(`**← output**\n${output}`)
  return lines.join("\n")
}

/** Render one OpenCode `part.data` blob into plain text, or `undefined` to skip. */
export const renderOpenCodePart = (raw: string): string | undefined => {
  const decoded = decodePartData(raw)
  if (Option.isNone(decoded)) return undefined
  const part = decoded.value
  switch (part.type) {
    case "text":
      return part.text?.trim() || undefined
    case "reasoning": {
      const text = part.text?.trim()
      return text !== undefined && text.length > 0 ? `_(reasoning)_\n${text}` : undefined
    }
    case "tool":
      return renderToolPart(part)
    case "patch": {
      const arr = decodeArray(part.files)
      const files = Option.isSome(arr) ? arr.value.map(String) : []
      return files.length > 0 ? `**patch**\n${files.map((f) => `- ${f}`).join("\n")}` : undefined
    }
    case "file":
      return `_(attached ${part.filename ?? part.mime ?? "file"})_`
  }
}

const messageRole = (raw: string): string => {
  const decoded = decodeMessageData(raw)
  return Option.isSome(decoded) ? decoded.value.role ?? "assistant" : "assistant"
}

export const epochToDateTime = (value: number | null | undefined, fallback: DateTime.Utc): DateTime.Utc => {
  if (typeof value !== "number") return fallback
  // OpenCode timestamps are epoch milliseconds.
  return safeDateTime(value < 10_000_000_000 ? value * 1000 : value, fallback)
}

export const buildOpenCodeSession = (input: {
  readonly session: OpenCodeSessionRow
  readonly messages: ReadonlyArray<OpenCodeMessageRow>
  readonly partsByMessage: ReadonlyMap<string, ReadonlyArray<OpenCodePartRow>>
  readonly dbPath: string
  readonly fallbackDate: DateTime.Utc
}): SessionArchive => {
  const messages: Array<Message> = []

  for (const messageRow of input.messages) {
    const parts = input.partsByMessage.get(messageRow.id) ?? []
    const rendered = parts
      .map((part) => renderOpenCodePart(part.data))
      .filter((text): text is string => text !== undefined && text.length > 0)
    if (rendered.length === 0) continue
    messages.push({
      role: messageRole(messageRow.data),
      text: rendered.join("\n\n"),
      at: epochToDateTime(messageRow.time_created, input.fallbackDate)
    })
  }

  return {
    provider: "opencode",
    sessionId: input.session.id,
    cwd: input.session.directory ?? undefined,
    title: input.session.title ?? undefined,
    model: normalizeOpenCodeModel(input.session.model),
    startedAt: epochToDateTime(input.session.time_created, input.fallbackDate),
    updatedAt: epochToDateTime(input.session.time_updated ?? input.session.time_created, input.fallbackDate),
    sourcePath: input.dbPath,
    messages
  }
}
