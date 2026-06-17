import { Data, DateTime, Schema } from "effect"

/**
 * The four coding-agent tools Tailings can pull from. Gemini is best-effort
 * (its on-disk layout is unverified until a real install is present).
 */
export const ProviderSchema = Schema.Literals(["claude", "codex", "opencode", "gemini"])
export type Provider = Schema.Schema.Type<typeof ProviderSchema>

/**
 * Whether a memory artifact is keyed to a specific working directory
 * (Claude's per-project `memory/`) or is global agent knowledge that the tool
 * applies everywhere (Codex's `~/.codex/memories/`, OpenCode `AGENTS.md`).
 */
export type MemoryScope = "project" | "global"

/**
 * One rendered turn in a transcript. `text` is already flattened to plain text
 * (thinking, tool calls, tool output and patches are folded in) — Tailings is
 * about co-locating readable context, not re-deriving structured events.
 */
export type Message = {
  readonly role: string
  readonly text: string
  readonly at?: DateTime.Utc | undefined
}

/**
 * The inverse of tvagent's `UsageEvent`: one whole conversation with its content
 * preserved and the token math discarded. This is the unit `pull` co-locates.
 */
export type SessionArchive = {
  readonly provider: Provider
  readonly sessionId: string
  /** Working directory the session ran in (the thing we filter on). */
  readonly cwd?: string | undefined
  readonly title?: string | undefined
  readonly gitBranch?: string | undefined
  readonly model?: string | undefined
  readonly startedAt?: DateTime.Utc | undefined
  readonly updatedAt?: DateTime.Utc | undefined
  /** The on-disk file or database the session was read from. */
  readonly sourcePath: string
  readonly messages: ReadonlyArray<Message>
}

/**
 * An agent-written knowledge file (Claude `memory/*.md`, Codex `MEMORY.md`,
 * OpenCode `AGENTS.md`/`knowledge/`, Gemini `GEMINI.md`). Already well-structured
 * for an agent to read — Tailings just co-locates it.
 */
export type MemoryArchive = {
  readonly provider: Provider
  readonly scope: MemoryScope
  /** Relative name used for the co-located file, e.g. `memory/decisions.md`. */
  readonly name: string
  readonly content: string
  readonly sourcePath: string
  readonly updatedAt?: DateTime.Utc | undefined
}

/** Everything one tool found for a directory in a single pull. */
export type ToolPull = {
  readonly provider: Provider
  readonly sessions: ReadonlyArray<SessionArchive>
  readonly memories: ReadonlyArray<MemoryArchive>
  /** Non-fatal notes surfaced to the user (e.g. "Gemini store not present"). */
  readonly notes: ReadonlyArray<string>
}

export const emptyToolPull = (provider: Provider): ToolPull => ({
  provider,
  sessions: [],
  memories: [],
  notes: []
})

export const sessionMessageCount = (session: SessionArchive): number => session.messages.length

export const sessionWordCount = (session: SessionArchive): number =>
  session.messages.reduce((sum, message) => sum + countWords(message.text), 0)

const countWords = (text: string): number => {
  const trimmed = text.trim()
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length
}

/**
 * Coerce a timestamp-ish value into a DateTime, falling back when it is missing
 * or unparseable. Ported from tvagent's Domain helper.
 */
export const dateTimeOrFallback = (input: unknown, fallback: DateTime.Utc): DateTime.Utc =>
  typeof input === "string" || typeof input === "number" || input instanceof Date
    ? DateTime.makeUnsafe(input)
    : fallback

export const safeDateTime = (input: unknown, fallback: DateTime.Utc): DateTime.Utc => {
  try {
    return dateTimeOrFallback(input, fallback)
  } catch {
    return fallback
  }
}

// --- Tagged errors -----------------------------------------------------------

export class PeriodParseError extends Data.TaggedError("PeriodParseError")<{
  readonly input: string
  readonly message: string
  readonly cause?: unknown
}> {}

/** A source store could not be read (missing file, locked db, permissions). */
export class SourceReadError extends Data.TaggedError("SourceReadError")<{
  readonly source: string
  readonly message: string
  readonly cause?: unknown
}> {}

/** A raw on-disk record did not match its expected `Schema`. */
export class ArchiveDecodeError extends Data.TaggedError("ArchiveDecodeError")<{
  readonly source: string
  readonly message: string
  readonly cause?: unknown
}> {}

/** Writing the pulled archive into the target directory failed. */
export class PullWriteError extends Data.TaggedError("PullWriteError")<{
  readonly target: string
  readonly message: string
  readonly cause?: unknown
}> {}
