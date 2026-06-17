import { DateTime, Effect, FileSystem, Path } from "effect"
import {
  type MemoryArchive,
  type Provider,
  PullWriteError,
  type SessionArchive,
  type ToolPull
} from "../../core/src/Domain"
import type { PullPeriod } from "../../core/src/Period"
import { renderSessionMarkdown, sessionHeadline, slugify } from "../../core/src/Render"
import { ClaudeArchive } from "../../adapter-claude/src/ClaudeArchive"
import { CodexArchive } from "../../adapter-codex/src/CodexArchive"
import { GeminiArchive } from "../../adapter-gemini/src/GeminiArchive"
import { OpenCodeArchive } from "../../adapter-opencode/src/OpenCodeArchive"
import { buildDigest, mergeAgentsMd } from "./AgentsMd"

/** One artifact to write under ./.tailings/: its destination and its body. */
type WriteEntry = { readonly provider: Provider; readonly content: string; readonly absPath: string }

export type OutputMode = "files" | "stdout"

export type PullOptions = {
  readonly dir: string
  readonly tools: ReadonlyArray<Provider>
  readonly period?: PullPeriod | undefined
  readonly out: OutputMode
  /** CLI-level notes (e.g. unknown-tool warnings) to surface alongside adapter notes. */
  readonly extraNotes?: ReadonlyArray<string> | undefined
}

export type PullResult = {
  readonly dir: string
  readonly digest: string
  readonly sessionCount: number
  readonly memoryCount: number
  readonly notes: ReadonlyArray<string>
  readonly toolSummary: ReadonlyArray<{ readonly provider: Provider; readonly sessions: number; readonly memories: number }>
  readonly wroteFiles: boolean
}

const updatedMillis = (session: SessionArchive): number =>
  session.updatedAt === undefined ? 0 : DateTime.toEpochMillis(session.updatedAt)

const runAdapter = (
  provider: Provider,
  pull: Effect.Effect<ToolPull, unknown>
): Effect.Effect<ToolPull> =>
  pull.pipe(
    Effect.catch((error) =>
      Effect.succeed({
        provider,
        sessions: [],
        memories: [],
        notes: [`${provider}: ${errorMessage(error)}`]
      } satisfies ToolPull)
    )
  )

const errorMessage = (error: unknown): string => {
  if (error !== null && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

const gatherPulls = (options: PullOptions) =>
  Effect.gen(function*() {
    const claude = yield* ClaudeArchive
    const codex = yield* CodexArchive
    const opencode = yield* OpenCodeArchive
    const gemini = yield* GeminiArchive

    const available: ReadonlyArray<{ provider: Provider; run: Effect.Effect<ToolPull, unknown> }> = [
      { provider: "claude", run: claude.pull(options.dir, options.period) },
      { provider: "codex", run: codex.pull(options.dir, options.period) },
      { provider: "opencode", run: opencode.pull(options.dir, options.period) },
      { provider: "gemini", run: gemini.pull(options.dir, options.period) }
    ]

    const selected = available.filter((entry) => options.tools.includes(entry.provider))
    return yield* Effect.all(selected.map((entry) => runAdapter(entry.provider, entry.run)), {
      concurrency: "unbounded"
    })
  })

// --- File layout helpers -----------------------------------------------------

/** Return `fileName`, or a `-2`/`-3`/… variant, so it is unique within `used`. */
export const uniqueName = (fileName: string, used: Set<string>): string => {
  if (!used.has(fileName)) {
    used.add(fileName)
    return fileName
  }
  const dot = fileName.lastIndexOf(".")
  const stem = dot === -1 ? fileName : fileName.slice(0, dot)
  const ext = dot === -1 ? "" : fileName.slice(dot)
  let counter = 2
  while (used.has(`${stem}-${counter}${ext}`)) counter += 1
  const name = `${stem}-${counter}${ext}`
  used.add(name)
  return name
}

const sessionFileName = (session: SessionArchive, used: Set<string>): string =>
  uniqueName(`${slugify(sessionHeadline(session))}-${session.sessionId.slice(-8)}.md`, used)

const memoryFileName = (memory: MemoryArchive, used: Set<string>): string => {
  const segments = memory.name.split("/")
  return uniqueName(segments[segments.length - 1] ?? memory.name, used)
}

const writeTextFile = (filePath: string, content: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
      Effect.mapError((cause) =>
        new PullWriteError({ target: filePath, message: "Could not create output directory.", cause })
      )
    )
    yield* fs.writeFileString(filePath, content).pipe(
      Effect.mapError((cause) =>
        new PullWriteError({ target: filePath, message: "Could not write file.", cause })
      )
    )
  })

// --- Orchestration -----------------------------------------------------------

export const pull = Effect.fn("Pull.pull")(function*(options: PullOptions) {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const generatedAt = yield* DateTime.now

  const toolPulls = yield* gatherPulls(options)

  const allSessions = toolPulls
    .flatMap((toolPull) => toolPull.sessions)
    .sort((left, right) => updatedMillis(right) - updatedMillis(left))
  const allMemories = toolPulls.flatMap((toolPull) => toolPull.memories)
  const allNotes = [...(options.extraNotes ?? []), ...toolPulls.flatMap((toolPull) => toolPull.notes)]

  const tailingsDir = path.join(options.dir, ".tailings")

  // One write entry per artifact: where it goes and what it holds. The digest in
  // AGENTS.md only references the *count* per provider — the content lives solely
  // under ./.tailings/ (gitignored), never inlined into the committed AGENTS.md.
  const usedNames = new Map<Provider, Set<string>>()
  const sessionEntries: Array<WriteEntry> = []
  for (const session of allSessions) {
    const used = usedNames.get(session.provider) ?? new Set<string>()
    usedNames.set(session.provider, used)
    const fileName = sessionFileName(session, used)
    sessionEntries.push({
      provider: session.provider,
      content: renderSessionMarkdown(session),
      absPath: path.join(tailingsDir, "sessions", session.provider, fileName)
    })
  }

  const usedMemoryNames = new Map<Provider, Set<string>>()
  const memoryEntries: Array<WriteEntry> = []
  for (const memory of allMemories) {
    const used = usedMemoryNames.get(memory.provider) ?? new Set<string>()
    usedMemoryNames.set(memory.provider, used)
    const fileName = memoryFileName(memory, used)
    memoryEntries.push({
      provider: memory.provider,
      content: memory.content,
      absPath: path.join(tailingsDir, "memories", memory.provider, fileName)
    })
  }

  const digest = buildDigest({
    dir: options.dir,
    generatedAt,
    periodLabel: options.period?.label,
    tools: options.tools,
    sessions: sessionEntries,
    memories: memoryEntries,
    notes: allNotes
  })

  let wroteFiles = false
  if (options.out === "files") {
    // Prune the managed subtrees first so transcripts from a prior run (renamed
    // sessions, a narrower --since) don't linger as orphans nothing links to.
    for (const sub of ["sessions", "memories"] as const) {
      yield* fs.remove(path.join(tailingsDir, sub), { recursive: true, force: true }).pipe(
        Effect.mapError((cause) =>
          new PullWriteError({ target: path.join(tailingsDir, sub), message: "Could not clear stale archive.", cause })
        )
      )
    }
    // Self-ignore the whole archive so pasted secrets in old transcripts never
    // get committed from the working directory.
    yield* writeTextFile(path.join(tailingsDir, ".gitignore"), "*\n")
    for (const entry of sessionEntries) yield* writeTextFile(entry.absPath, entry.content)
    for (const entry of memoryEntries) yield* writeTextFile(entry.absPath, entry.content)

    const agentsMdPath = path.join(options.dir, "AGENTS.md")
    const existing = yield* fs.exists(agentsMdPath).pipe(Effect.orElseSucceed(() => false))
    const current = existing ? yield* fs.readFileString(agentsMdPath).pipe(Effect.orElseSucceed(() => "")) : ""
    yield* writeTextFile(agentsMdPath, mergeAgentsMd(current, digest))
    wroteFiles = true
  }

  return {
    dir: options.dir,
    digest,
    sessionCount: sessionEntries.length,
    memoryCount: memoryEntries.length,
    notes: allNotes,
    toolSummary: toolPulls.map((toolPull) => ({
      provider: toolPull.provider,
      sessions: toolPull.sessions.length,
      memories: toolPull.memories.length
    })),
    wroteFiles
  } satisfies PullResult
})
