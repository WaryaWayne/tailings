import { DatabaseSync } from "node:sqlite"
import { Context, DateTime, Effect, FileSystem, Layer, Option, Path, Result, Schema } from "effect"
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
import {
  buildOpenCodeSession,
  epochToDateTime,
  MessageRowSchema,
  type OpenCodePartRow,
  PartRowSchema,
  SessionRowSchema
} from "./OpenCodeNormalize"

export class OpenCodeArchive extends Context.Service<OpenCodeArchive, {
  readonly pull: (
    dir: string,
    period?: PullPeriod
  ) => Effect.Effect<ToolPull, SourceReadError | ArchiveDecodeError>
}>()("tailings/OpenCodeArchive") {}

const decodeRows = <A>(
  rows: ReadonlyArray<unknown>,
  decode: (row: unknown) => Result.Result<A, unknown>,
  dbPath: string
) =>
  Effect.gen(function*() {
    const decoded: Array<A> = []
    for (const row of rows) {
      const result = decode(row)
      if (Result.isFailure(result)) {
        return yield* new ArchiveDecodeError({
          source: dbPath,
          message: "OpenCode row did not decode.",
          cause: result.failure
        })
      }
      decoded.push(result.success)
    }
    return decoded as ReadonlyArray<A>
  })

const readOpenCodeSessions = Effect.fn("OpenCodeArchive.readSessions")(function*(
  dbPath: string,
  dir: string,
  period: PullPeriod | undefined
) {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(dbPath).pipe(
    Effect.mapError((cause) =>
      new SourceReadError({ source: dbPath, message: "Could not check OpenCode database.", cause })
    )
  )
  if (!exists) return { sessions: [] as ReadonlyArray<SessionArchive>, found: false }

  const fallbackDate = yield* DateTime.now

  const raw = yield* Effect.scoped(
    Effect.gen(function*() {
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new DatabaseSync(dbPath, { readOnly: true }),
          catch: (cause) =>
            new SourceReadError({ source: dbPath, message: "Could not open OpenCode database.", cause })
        }),
        (db) => Effect.sync(() => db.close())
      )

      return yield* Effect.try({
        try: () => {
          const sessionRows = db
            .prepare(
              "SELECT id, directory, title, time_created, time_updated, agent, model FROM session"
            )
            .all() as ReadonlyArray<unknown>
          const messageStmt = db.prepare(
            "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created, id"
          )
          const partStmt = db.prepare(
            "SELECT message_id, data, time_created FROM part WHERE session_id = ? ORDER BY time_created, id"
          )
          return { sessionRows, messageStmt, partStmt }
        },
        catch: (cause) =>
          new SourceReadError({ source: dbPath, message: "Could not query OpenCode database.", cause })
      }).pipe(
        Effect.flatMap(({ sessionRows, messageStmt, partStmt }) =>
          Effect.gen(function*() {
            const decodedSessions = yield* decodeRows(
              sessionRows,
              Schema.decodeUnknownResult(SessionRowSchema),
              dbPath
            )
            const matched = decodedSessions.filter(
              (row) => row.directory !== null && isWithinDir(row.directory, dir)
            )

            const sessions: Array<SessionArchive> = []
            for (const session of matched) {
              // Apply the period filter up front — its time-unit handling matches
              // buildOpenCodeSession's — so out-of-window sessions skip the
              // per-session message/part queries entirely (was an N+1 after the
              // fact). Filtering in memory rather than in SQL stays correct even
              // when rows mix epoch seconds and milliseconds.
              const updatedAt = epochToDateTime(session.time_updated ?? session.time_created, fallbackDate)
              if (!sessionInPeriod(updatedAt, period)) continue

              const messageRows = yield* Effect.try({
                try: () => messageStmt.all(session.id) as ReadonlyArray<unknown>,
                catch: (cause) =>
                  new SourceReadError({ source: dbPath, message: "Could not read OpenCode messages.", cause })
              })
              const partRows = yield* Effect.try({
                try: () => partStmt.all(session.id) as ReadonlyArray<unknown>,
                catch: (cause) =>
                  new SourceReadError({ source: dbPath, message: "Could not read OpenCode parts.", cause })
              })

              const messages = yield* decodeRows(
                messageRows,
                Schema.decodeUnknownResult(MessageRowSchema),
                dbPath
              )
              const parts = yield* decodeRows(
                partRows,
                Schema.decodeUnknownResult(PartRowSchema),
                dbPath
              )

              const partsByMessage = new Map<string, Array<OpenCodePartRow>>()
              for (const part of parts) {
                const list = partsByMessage.get(part.message_id)
                if (list === undefined) partsByMessage.set(part.message_id, [part])
                else list.push(part)
              }

              sessions.push(
                buildOpenCodeSession({
                  session,
                  messages,
                  partsByMessage,
                  dbPath,
                  fallbackDate
                })
              )
            }
            return sessions as ReadonlyArray<SessionArchive>
          })
        )
      )
    })
  )

  // Period is already applied above (before the message/part queries); only the
  // empty-transcript filter remains.
  const sessions = raw.filter((session) => session.messages.length > 0)
  return { sessions, found: true }
})

const readOpenCodeMemories = Effect.fn("OpenCodeArchive.readMemories")(function*(configDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const memories: Array<MemoryArchive> = []

  const candidates: Array<{ readonly name: string; readonly file: string }> = [
    { name: "AGENTS.md", file: path.join(configDir, "AGENTS.md") }
  ]

  const knowledgeDir = path.join(configDir, "knowledge")
  const knowledgeExists = yield* fs.exists(knowledgeDir).pipe(Effect.orElseSucceed(() => false))
  if (knowledgeExists) {
    const entries = yield* fs.readDirectory(knowledgeDir).pipe(Effect.orElseSucceed(() => [] as Array<string>))
    for (const entry of entries) {
      if (entry.endsWith(".md")) candidates.push({ name: `knowledge/${entry}`, file: path.join(knowledgeDir, entry) })
    }
  }

  for (const candidate of candidates) {
    const exists = yield* fs.exists(candidate.file).pipe(Effect.orElseSucceed(() => false))
    if (!exists) continue
    const content = yield* fs.readFileString(candidate.file).pipe(Effect.orElseSucceed(() => ""))
    if (content.trim().length === 0) continue
    const stat = yield* fs.stat(candidate.file).pipe(Effect.option)
    memories.push({
      provider: "opencode",
      scope: "global",
      name: candidate.name,
      content,
      sourcePath: candidate.file,
      updatedAt: Option.isSome(stat) && Option.isSome(stat.value.mtime)
        ? DateTime.makeUnsafe(stat.value.mtime.value)
        : undefined
    })
  }
  return memories
})

export const pullOpenCode = Effect.fn("OpenCodeArchive.pull")(function*(dir: string, period?: PullPeriod) {
  const paths = yield* TailingsPaths
  const { found, sessions } = yield* readOpenCodeSessions(paths.openCodeDbPath, dir, period)
  const memories = yield* readOpenCodeMemories(paths.openCodeConfigDir)
  const notes: Array<string> = []
  if (!found) notes.push("OpenCode database not found.")
  else if (sessions.length === 0) notes.push("No OpenCode sessions found for this directory.")
  return { provider: "opencode", sessions, memories, notes } satisfies ToolPull
})

export const OpenCodeArchiveLive = Layer.effect(
  OpenCodeArchive,
  Effect.map(makeArchivePull(pullOpenCode), (pull) => OpenCodeArchive.of({ pull }))
)
