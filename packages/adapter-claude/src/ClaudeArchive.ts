import { Context, DateTime, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import {
  ArchiveDecodeError,
  type Message,
  type MemoryArchive,
  type SessionArchive,
  SourceReadError,
  type ToolPull,
  safeDateTime
} from "../../core/src/Domain"
import { makeArchivePull } from "../../core/src/Adapter"
import { type PullPeriod, sessionInPeriod } from "../../core/src/Period"
import { encodeClaudeProjectDir, isWithinDir, TailingsPaths } from "../../core/src/TailingsPaths"

export class ClaudeArchive extends Context.Service<ClaudeArchive, {
  readonly pull: (
    dir: string,
    period?: PullPeriod
  ) => Effect.Effect<ToolPull, SourceReadError | ArchiveDecodeError>
}>()("tailings/ClaudeArchive") {}

// --- Raw record shape (Schema = source of truth for the on-disk envelope) ----

const ClaudeMessageSchema = Schema.Struct({
  role: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Unknown)
})

const ClaudeRecordSchema = Schema.Struct({
  type: Schema.String,
  sessionId: Schema.optionalKey(Schema.String),
  session_id: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  gitBranch: Schema.optionalKey(Schema.String),
  isMeta: Schema.optionalKey(Schema.Boolean),
  message: Schema.optionalKey(ClaudeMessageSchema)
})
type ClaudeRecord = Schema.Schema.Type<typeof ClaudeRecordSchema>

/** Parse + decode one JSONL line straight into a record in a single step. */
const decodeClaudeLine = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeRecordSchema))

// --- Content blocks (Schema = source of truth; unmapped blocks fall through) --

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.optionalKey(Schema.String) })
const ThinkingBlock = Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.optionalKey(Schema.String) })
const RedactedThinkingBlock = Schema.Struct({ type: Schema.Literal("redacted_thinking") })
const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  name: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Unknown)
})
const ToolResultBlock = Schema.Struct({ type: Schema.Literal("tool_result"), content: Schema.optionalKey(Schema.Unknown) })
const ImageBlock = Schema.Struct({ type: Schema.Literal("image") })

const ContentBlock = Schema.Union([
  TextBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock
])
const decodeBlock = Schema.decodeUnknownOption(ContentBlock)

const decodeString = Schema.decodeUnknownOption(Schema.String)
const decodeBlockArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))
// A tool_result's content is either a plain string or blocks carrying `text`.
const decodeTextHolder = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.optionalKey(Schema.String) }))

/** Render a decoded value as a fenced JSON body; absent payloads → `{}`. */
const jsonBody = (value: unknown): string => (value === undefined ? "{}" : JSON.stringify(value, null, 2))

const renderToolResult = (content: unknown): string => {
  const asText = decodeString(content)
  if (Option.isSome(asText)) return asText.value
  const asBlocks = decodeBlockArray(content)
  if (Option.isSome(asBlocks)) {
    return asBlocks.value
      .map((block) => {
        const held = decodeTextHolder(block)
        return Option.isSome(held) ? held.value.text ?? "" : ""
      })
      .filter((text) => text.length > 0)
      .join("\n")
  }
  return jsonBody(content)
}

type RenderedContent = { readonly text: string; readonly toolResultOnly: boolean }

const renderClaudeContent = (content: unknown): RenderedContent => {
  const asText = decodeString(content)
  if (Option.isSome(asText)) return { text: asText.value, toolResultOnly: false }
  const asBlocks = decodeBlockArray(content)
  if (Option.isNone(asBlocks)) return { text: "", toolResultOnly: false }

  const parts: Array<string> = []
  let sawNonToolResult = false
  let sawToolResult = false

  for (const raw of asBlocks.value) {
    const decoded = decodeBlock(raw)
    if (Option.isNone(decoded)) {
      sawNonToolResult = true // an unmapped block still counts as model content
      continue
    }
    const block = decoded.value
    switch (block.type) {
      case "text":
        parts.push(block.text ?? "")
        sawNonToolResult = true
        break
      case "thinking":
        if (block.thinking !== undefined && block.thinking.length > 0) parts.push(`_(thinking)_\n${block.thinking}`)
        sawNonToolResult = true
        break
      case "redacted_thinking":
        parts.push("_(redacted thinking)_")
        sawNonToolResult = true
        break
      case "tool_use":
        parts.push(`**→ ${block.name ?? "tool"}**\n\`\`\`json\n${jsonBody(block.input)}\n\`\`\``)
        sawNonToolResult = true
        break
      case "tool_result":
        parts.push(`**← tool result**\n${renderToolResult(block.content)}`)
        sawToolResult = true
        break
      case "image":
        parts.push("_(image)_")
        sawNonToolResult = true
        break
    }
  }

  return {
    text: parts.filter((part) => part.length > 0).join("\n\n"),
    toolResultOnly: sawToolResult && !sawNonToolResult
  }
}

const messageFromRecord = (record: ClaudeRecord, fallbackDate: DateTime.Utc): Message | undefined => {
  const message = record.message
  if (message === undefined) return undefined
  const role = message.role ?? (record.type === "assistant" ? "assistant" : "user")
  const rendered = renderClaudeContent(message.content)
  if (rendered.text.trim().length === 0) return undefined
  const resolvedRole = role === "user" && rendered.toolResultOnly ? "tool" : role
  return {
    role: resolvedRole,
    text: rendered.text,
    at: safeDateTime(record.timestamp, fallbackDate)
  }
}

// --- Normalization (pure, testable) ------------------------------------------

export const normalizeClaudeSession = (input: {
  readonly filePath: string
  readonly sessionIdFallback: string
  readonly fallbackDate: DateTime.Utc
  readonly lines: ReadonlyArray<string>
}): SessionArchive => {
  const messages: Array<Message> = []
  let sessionId = input.sessionIdFallback
  let cwd: string | undefined
  let gitBranch: string | undefined
  let model: string | undefined
  let startedAt: DateTime.Utc | undefined
  let updatedAt: DateTime.Utc | undefined

  for (const raw of input.lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    const decoded = decodeClaudeLine(line)
    if (Option.isNone(decoded)) continue
    const record = decoded.value

    sessionId = record.sessionId ?? record.session_id ?? sessionId
    if (record.cwd !== undefined) cwd = record.cwd
    if (record.gitBranch !== undefined) gitBranch = record.gitBranch
    if (record.message?.model !== undefined) model = record.message.model

    if (record.type !== "user" && record.type !== "assistant") continue
    if (record.isMeta === true) continue

    const message = messageFromRecord(record, input.fallbackDate)
    if (message === undefined) continue
    messages.push(message)
    if (message.at !== undefined) {
      if (startedAt === undefined) startedAt = message.at
      updatedAt = message.at
    }
  }

  return {
    provider: "claude",
    sessionId,
    cwd,
    gitBranch,
    model,
    startedAt,
    updatedAt,
    sourcePath: input.filePath,
    messages
  }
}

// --- Filesystem reads --------------------------------------------------------

const claudeProjectDirsForTarget = Effect.fn("ClaudeArchive.projectDirs")(function*(
  projectsRoot: string,
  targetDir: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const exists = yield* fs.exists(projectsRoot).pipe(
    Effect.mapError((cause) =>
      new SourceReadError({ source: projectsRoot, message: "Could not check Claude projects directory.", cause })
    )
  )
  if (!exists) return [] as ReadonlyArray<string>

  const entries = yield* fs.readDirectory(projectsRoot).pipe(
    Effect.mapError((cause) =>
      new SourceReadError({ source: projectsRoot, message: "Could not list Claude projects.", cause })
    )
  )

  const encoded = encodeClaudeProjectDir(targetDir)
  return entries
    .filter((entry) => entry === encoded || entry.startsWith(`${encoded}-`))
    .map((entry) => path.join(projectsRoot, entry))
})

const discoverSessionFiles = Effect.fn("ClaudeArchive.discoverFiles")(function*(dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* fs.readDirectory(dir).pipe(
    Effect.mapError((cause) =>
      new SourceReadError({ source: dir, message: "Could not list Claude session files.", cause })
    )
  )
  return entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => path.join(dir, entry))
})

const readSessionFile = Effect.fn("ClaudeArchive.readSession")(function*(filePath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const stat = yield* fs.stat(filePath).pipe(
    Effect.mapError((cause) =>
      new SourceReadError({ source: filePath, message: "Could not stat Claude session file.", cause })
    )
  )
  const fallbackDate = Option.isSome(stat.mtime) ? DateTime.makeUnsafe(stat.mtime.value) : yield* DateTime.now
  const content = yield* fs.readFileString(filePath).pipe(
    Effect.mapError((cause) =>
      new SourceReadError({ source: filePath, message: "Could not read Claude session file.", cause })
    )
  )
  return normalizeClaudeSession({
    filePath,
    sessionIdFallback: path.basename(filePath).replace(/\.jsonl$/, ""),
    fallbackDate,
    lines: content.split(/\r?\n/)
  })
})

const readProjectMemories = Effect.fn("ClaudeArchive.readMemories")(function*(projectDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const memoryDir = path.join(projectDir, "memory")
  const exists = yield* fs.exists(memoryDir).pipe(
    Effect.mapError((cause) =>
      new SourceReadError({ source: memoryDir, message: "Could not check Claude memory directory.", cause })
    )
  )
  if (!exists) return [] as ReadonlyArray<MemoryArchive>

  const entries = yield* fs.readDirectory(memoryDir).pipe(
    Effect.mapError((cause) =>
      new SourceReadError({ source: memoryDir, message: "Could not list Claude memory files.", cause })
    )
  )

  const memories: Array<MemoryArchive> = []
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    const filePath = path.join(memoryDir, entry)
    const stat = yield* fs.stat(filePath).pipe(
      Effect.mapError((cause) =>
        new SourceReadError({ source: filePath, message: "Could not stat Claude memory file.", cause })
      )
    )
    const content = yield* fs.readFileString(filePath).pipe(
      Effect.mapError((cause) =>
        new SourceReadError({ source: filePath, message: "Could not read Claude memory file.", cause })
      )
    )
    memories.push({
      provider: "claude",
      scope: "project",
      name: `memory/${entry}`,
      content,
      sourcePath: filePath,
      updatedAt: Option.isSome(stat.mtime) ? DateTime.makeUnsafe(stat.mtime.value) : undefined
    })
  }
  return memories
})

export const pullClaude = Effect.fn("ClaudeArchive.pull")(function*(dir: string, period?: PullPeriod) {
  const paths = yield* TailingsPaths
  const projectDirs = yield* claudeProjectDirsForTarget(paths.claudeProjectsDir, dir)

  const sessions: Array<SessionArchive> = []
  const memories: Array<MemoryArchive> = []
  const notes: Array<string> = []

  for (const projectDir of projectDirs) {
    const files = yield* discoverSessionFiles(projectDir)
    for (const file of files) {
      const session = yield* readSessionFile(file)
      if (session.messages.length === 0) continue
      // The encoded folder name is lossy (both `/` and `.` → `-`), so confirm
      // each session's recorded cwd is actually within the target tree.
      if (session.cwd !== undefined && !isWithinDir(session.cwd, dir)) continue
      if (!sessionInPeriod(session.updatedAt, period)) continue
      sessions.push(session)
    }
    memories.push(...(yield* readProjectMemories(projectDir)))
  }

  if (projectDirs.length === 0) notes.push("No Claude Code history found for this directory.")

  return { provider: "claude", sessions, memories, notes } satisfies ToolPull
})

export const ClaudeArchiveLive = Layer.effect(
  ClaudeArchive,
  Effect.map(makeArchivePull(pullClaude), (pull) => ClaudeArchive.of({ pull }))
)
