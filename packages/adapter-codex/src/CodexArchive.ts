import { DatabaseSync } from "node:sqlite"
import { Context, DateTime, Effect, FileSystem, Layer, Option, Path } from "effect"
import {
  ArchiveDecodeError,
  type MemoryArchive,
  type SessionArchive,
  SourceReadError,
  type ToolPull
} from "../../core/src/Domain"
import { makeArchivePull } from "../../core/src/Adapter"
import { type PullPeriod, sessionInPeriod } from "../../core/src/Period"
import { isWithinDir, TailingsPaths } from "../../core/src/TailingsPaths"
import { extractCodexCwd, normalizeCodexSession } from "./CodexNormalize"

export class CodexArchive extends Context.Service<CodexArchive, {
  readonly pull: (
    dir: string,
    period?: PullPeriod
  ) => Effect.Effect<ToolPull, SourceReadError | ArchiveDecodeError>
}>()("tailings/CodexArchive") {}

type RolloutFile = { readonly path: string; readonly mtime: number; readonly size: number }
type ResolvedFile = { readonly path: string; readonly cwd: string | undefined; readonly mtime: number }

const discoverRolloutFiles = Effect.fn("CodexArchive.discover")(function*(dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const exists = yield* fs.exists(dir).pipe(
    Effect.mapError((cause) =>
      new SourceReadError({ source: dir, message: "Could not check Codex sessions directory.", cause })
    )
  )
  if (!exists) return [] as ReadonlyArray<RolloutFile>

  const entries = yield* fs.readDirectory(dir, { recursive: true }).pipe(
    Effect.mapError((cause) =>
      new SourceReadError({ source: dir, message: "Could not list Codex sessions.", cause })
    )
  )

  const files: Array<RolloutFile> = []
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue
    if (!path.basename(entry).startsWith("rollout-")) continue
    const full = path.isAbsolute(entry) ? entry : path.join(dir, entry)
    const stat = yield* fs.stat(full).pipe(Effect.option)
    if (Option.isNone(stat)) continue
    files.push({
      path: full,
      mtime: Option.isSome(stat.value.mtime) ? Math.floor(stat.value.mtime.value.getTime()) : 0,
      size: Number(stat.value.size)
    })
  }
  return files as ReadonlyArray<RolloutFile>
})

/**
 * Codex sessions are date-partitioned and carry no cwd in the session index, so
 * we keep our own `path → cwd` index keyed by (mtime, size). On each run only
 * new or changed rollout files are re-read to recover their cwd.
 */
const resolveCwds = Effect.fn("CodexArchive.resolveCwds")(function*(
  indexDbPath: string,
  dataDir: string,
  files: ReadonlyArray<RolloutFile>
) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(dataDir, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined))

  return yield* Effect.scoped(
    Effect.gen(function*() {
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new DatabaseSync(indexDbPath),
          catch: (cause) =>
            new SourceReadError({ source: indexDbPath, message: "Could not open Tailings index.", cause })
        }),
        (db) => Effect.sync(() => db.close())
      )

      const statements = yield* Effect.try({
        try: () => {
          // Two concurrent pulls share this index; WAL + a busy timeout let the
          // upsert wait its turn instead of failing the run with SQLITE_BUSY.
          db.exec("PRAGMA busy_timeout = 5000")
          db.exec("PRAGMA journal_mode = WAL")
          db.exec(
            "CREATE TABLE IF NOT EXISTS codex_files (path TEXT PRIMARY KEY, cwd TEXT, mtime INTEGER, size INTEGER)"
          )
          return {
            select: db.prepare("SELECT cwd, mtime, size FROM codex_files WHERE path = ?"),
            upsert: db.prepare(
              "INSERT INTO codex_files (path, cwd, mtime, size) VALUES (?, ?, ?, ?) " +
                "ON CONFLICT(path) DO UPDATE SET cwd = excluded.cwd, mtime = excluded.mtime, size = excluded.size"
            )
          }
        },
        catch: (cause) =>
          new SourceReadError({ source: indexDbPath, message: "Could not prepare Tailings index.", cause })
      })

      const resolved: Array<ResolvedFile> = []
      for (const file of files) {
        const row = yield* Effect.try({
          try: () => statements.select.get(file.path) as
            | { cwd: string | null; mtime: number; size: number }
            | undefined,
          catch: (cause) =>
            new SourceReadError({ source: indexDbPath, message: "Could not read Tailings index.", cause })
        })

        if (row !== undefined && row.mtime === file.mtime && row.size === file.size) {
          resolved.push({ path: file.path, cwd: row.cwd ?? undefined, mtime: file.mtime })
          continue
        }

        const content = yield* fs.readFileString(file.path).pipe(Effect.orElseSucceed(() => ""))
        const cwd = extractCodexCwd(content.split(/\r?\n/))
        yield* Effect.try({
          try: () => statements.upsert.run(file.path, cwd ?? null, file.mtime, file.size),
          catch: (cause) =>
            new SourceReadError({ source: indexDbPath, message: "Could not update Tailings index.", cause })
        })
        resolved.push({ path: file.path, cwd, mtime: file.mtime })
      }
      return resolved as ReadonlyArray<ResolvedFile>
    })
  )
})

const readCodexSession = Effect.fn("CodexArchive.readSession")(function*(filePath: string, mtime: number) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  // Reuse the mtime captured during discovery instead of stat'ing again.
  const fallbackDate = mtime > 0 ? DateTime.makeUnsafe(mtime) : yield* DateTime.now
  const content = yield* fs.readFileString(filePath).pipe(
    Effect.mapError((cause) =>
      new SourceReadError({ source: filePath, message: "Could not read Codex session file.", cause })
    )
  )
  return normalizeCodexSession({
    filePath,
    sessionIdFallback: path.basename(filePath).replace(/\.jsonl$/, ""),
    fallbackDate,
    lines: content.split(/\r?\n/)
  })
})

const readCodexMemories = Effect.fn("CodexArchive.readMemories")(function*(memoriesDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const memories: Array<MemoryArchive> = []
  for (const name of ["MEMORY.md", "memory_summary.md", "raw_memories.md"]) {
    const file = path.join(memoriesDir, name)
    const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
    if (!exists) continue
    const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
    if (content.trim().length === 0) continue
    const stat = yield* fs.stat(file).pipe(Effect.option)
    memories.push({
      provider: "codex",
      scope: "global",
      name,
      content,
      sourcePath: file,
      updatedAt: Option.isSome(stat) && Option.isSome(stat.value.mtime)
        ? DateTime.makeUnsafe(stat.value.mtime.value)
        : undefined
    })
  }
  return memories
})

export const pullCodex = Effect.fn("CodexArchive.pull")(function*(dir: string, period?: PullPeriod) {
  const paths = yield* TailingsPaths
  const files = yield* discoverRolloutFiles(paths.codexSessionsDir)
  const notes: Array<string> = []

  if (files.length === 0) {
    return { provider: "codex", sessions: [], memories: [], notes: ["No Codex sessions found on this machine."] } satisfies ToolPull
  }

  const resolved = yield* resolveCwds(paths.tailingsIndexDbPath, paths.tailingsDataDir, files)
  const matched = resolved.filter((file) => file.cwd !== undefined && isWithinDir(file.cwd, dir))

  const sessions: Array<SessionArchive> = []
  for (const file of matched) {
    const session = yield* readCodexSession(file.path, file.mtime)
    if (session.messages.length === 0) continue
    if (session.cwd !== undefined && !isWithinDir(session.cwd, dir)) continue
    if (!sessionInPeriod(session.updatedAt, period)) continue
    sessions.push(session)
  }

  const memories = yield* readCodexMemories(paths.codexMemoriesDir)
  if (sessions.length === 0) notes.push("No Codex sessions found for this directory.")

  return { provider: "codex", sessions, memories, notes } satisfies ToolPull
})

export const CodexArchiveLive = Layer.effect(
  CodexArchive,
  Effect.map(makeArchivePull(pullCodex), (pull) => CodexArchive.of({ pull }))
)
