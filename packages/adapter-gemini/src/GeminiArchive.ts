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
import { isWithinDir, TailingsPaths } from "../../core/src/TailingsPaths"

/**
 * Gemini CLI was NOT installed on the machine Tailings was built on, so its
 * on-disk layout is a *hypothesis* (per the README): sessions are expected under
 * `~/.gemini/tmp/<project-hash>/` as logs + `/chat save` checkpoints, each
 * recording the cwd they belong to. This adapter reads conservatively: if it
 * cannot recover a session's cwd it skips the file rather than mis-attributing
 * history to the wrong directory.
 */
export class GeminiArchive extends Context.Service<GeminiArchive, {
  readonly pull: (
    dir: string,
    period?: PullPeriod
  ) => Effect.Effect<ToolPull, SourceReadError | ArchiveDecodeError>
}>()("tailings/GeminiArchive") {}

// The Gemini on-disk layout is a hypothesis, so the schema is deliberately
// lenient: every field optional, history under any of three keys, and turns
// decoded one at a time so a single odd turn can't sink the whole checkpoint.
const GeminiCheckpoint = Schema.Struct({
  cwd: Schema.optionalKey(Schema.String),
  projectRoot: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
  directory: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Struct({ cwd: Schema.optionalKey(Schema.String) })),
  history: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  contents: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  messages: Schema.optionalKey(Schema.Array(Schema.Unknown))
})
type GeminiCheckpoint = Schema.Schema.Type<typeof GeminiCheckpoint>
const decodeCheckpoint = Schema.decodeUnknownOption(Schema.fromJsonString(GeminiCheckpoint))

const GeminiTurn = Schema.Struct({
  role: Schema.optionalKey(Schema.String),
  parts: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  text: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String)
})
const decodeTurn = Schema.decodeUnknownOption(GeminiTurn)
const decodePartText = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.optionalKey(Schema.String) }))
const decodeString = Schema.decodeUnknownOption(Schema.String)

/** Recover the cwd a Gemini checkpoint belongs to, trying a few likely keys. */
const checkpointCwd = (checkpoint: GeminiCheckpoint): string | undefined =>
  checkpoint.cwd ?? checkpoint.projectRoot ?? checkpoint.workspace ?? checkpoint.directory ?? checkpoint.metadata?.cwd

/** Render Gemini `contents` (the Google GenAI history shape) into messages. */
const messagesFromCheckpoint = (checkpoint: GeminiCheckpoint, at: DateTime.Utc): ReadonlyArray<Message> => {
  const history = checkpoint.history ?? checkpoint.contents ?? checkpoint.messages ?? []
  const messages: Array<Message> = []
  for (const raw of history) {
    const turnOption = decodeTurn(raw)
    if (Option.isNone(turnOption)) continue
    const turn = turnOption.value
    const role = turn.role === "model" ? "assistant" : turn.role ?? "user"
    const text = (turn.parts ?? [])
      .map((part) => {
        const held = decodePartText(part)
        if (Option.isSome(held) && held.value.text !== undefined) return held.value.text
        const str = decodeString(part)
        return Option.isSome(str) ? str.value : undefined
      })
      .filter((t): t is string => t !== undefined && t.length > 0)
      .join("\n\n")
    const body = (text || turn.text || turn.content || "").trim()
    if (body.length === 0) continue
    messages.push({ role, text: body, at })
  }
  return messages
}

const readCheckpoint = Effect.fn("GeminiArchive.readCheckpoint")(function*(filePath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const stat = yield* fs.stat(filePath).pipe(Effect.option)
  const fallbackDate = Option.isSome(stat) && Option.isSome(stat.value.mtime)
    ? DateTime.makeUnsafe(stat.value.mtime.value)
    : yield* DateTime.now
  const content = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""))
  const decoded = decodeCheckpoint(content)
  if (Option.isNone(decoded)) return undefined
  const checkpoint = decoded.value
  const cwd = checkpointCwd(checkpoint)
  const messages = messagesFromCheckpoint(checkpoint, fallbackDate)
  if (messages.length === 0) return undefined
  return {
    provider: "gemini",
    sessionId: path.basename(filePath).replace(/\.json$/, ""),
    cwd,
    startedAt: messages[0]?.at,
    updatedAt: safeDateTime(undefined, fallbackDate),
    sourcePath: filePath,
    messages
  } satisfies SessionArchive
})

export const pullGemini = Effect.fn("GeminiArchive.pull")(function*(dir: string, period?: PullPeriod) {
  const paths = yield* TailingsPaths
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const exists = yield* fs.exists(paths.geminiDir).pipe(Effect.orElseSucceed(() => false))
  if (!exists) {
    return {
      provider: "gemini",
      sessions: [],
      memories: [],
      notes: ["Gemini CLI not detected (~/.gemini absent) — skipping."]
    } satisfies ToolPull
  }

  const tmpDir = path.join(paths.geminiDir, "tmp")
  const tmpExists = yield* fs.exists(tmpDir).pipe(Effect.orElseSucceed(() => false))
  const sessions: Array<SessionArchive> = []
  const notes: Array<string> = []

  if (tmpExists) {
    const entries = yield* fs.readDirectory(tmpDir, { recursive: true }).pipe(
      Effect.orElseSucceed(() => [] as Array<string>)
    )
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const full = path.isAbsolute(entry) ? entry : path.join(tmpDir, entry)
      const session = yield* readCheckpoint(full)
      if (session === undefined) continue
      // Conservative: only keep sessions whose cwd we could confirm is in-tree.
      if (session.cwd === undefined || !isWithinDir(session.cwd, dir)) continue
      if (!sessionInPeriod(session.updatedAt, period)) continue
      sessions.push(session)
    }
  }

  // GEMINI.md (hierarchical, like CLAUDE.md) co-located from the global store.
  const memories: Array<MemoryArchive> = []
  const geminiMd = path.join(paths.geminiDir, "GEMINI.md")
  const mdExists = yield* fs.exists(geminiMd).pipe(Effect.orElseSucceed(() => false))
  if (mdExists) {
    const md = yield* fs.readFileString(geminiMd).pipe(Effect.orElseSucceed(() => ""))
    if (md.trim().length > 0) {
      memories.push({ provider: "gemini", scope: "global", name: "GEMINI.md", content: md, sourcePath: geminiMd })
    }
  }

  if (sessions.length === 0) {
    notes.push("Gemini store present but no in-directory sessions recovered (layout unverified — see GeminiArchive).")
  }
  return { provider: "gemini", sessions, memories, notes } satisfies ToolPull
})

export const GeminiArchiveLive = Layer.effect(
  GeminiArchive,
  Effect.map(makeArchivePull(pullGemini), (pull) => GeminiArchive.of({ pull }))
)
