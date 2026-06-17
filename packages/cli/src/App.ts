import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { type Provider } from "../../core/src/Domain"
import { parsePullPeriod } from "../../core/src/Period"
import { TailingsPaths, TailingsPathsLive } from "../../core/src/TailingsPaths"
import {
  indentBlock,
  renderBanner,
  renderTable,
  type TerminalStyle,
  terminalStyle
} from "../../core/src/Terminal"
import { ClaudeArchiveLive } from "../../adapter-claude/src/ClaudeArchive"
import { CodexArchiveLive } from "../../adapter-codex/src/CodexArchive"
import { GeminiArchiveLive } from "../../adapter-gemini/src/GeminiArchive"
import { OpenCodeArchiveLive } from "../../adapter-opencode/src/OpenCodeArchive"
import { type OutputMode, pull, type PullResult } from "./Pull"

const ALL_TOOLS: ReadonlyArray<Provider> = ["claude", "codex", "opencode", "gemini"]

export type PackageMetadata = {
  readonly name: string
  readonly version: string
}

const PackageMetadataSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String
})

export const AppLayer = Layer.mergeAll(
  ClaudeArchiveLive,
  CodexArchiveLive,
  OpenCodeArchiveLive,
  GeminiArchiveLive
).pipe(Layer.provideMerge(TailingsPathsLive))

export const readPackageMetadata = Effect.fn("Cli.readPackageMetadata")(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const currentFile = yield* path.fromFileUrl(new URL(import.meta.url))
  const packageJsonPath = yield* findPackageJson(path.dirname(currentFile))
  const packageJson = yield* fs.readFileString(packageJsonPath)
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageMetadataSchema))(packageJson)
})

const findPackageJson = Effect.fn("Cli.findPackageJson")(function*(startDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  let current = startDir
  while (true) {
    const candidate = path.join(current, "package.json")
    const exists = yield* fs.exists(candidate)
    if (exists) return candidate
    const parent = path.dirname(current)
    if (parent === current) return candidate
    current = parent
  }
})

export type ParsedTools = {
  readonly tools: ReadonlyArray<Provider>
  /** Tokens the user passed that aren't real providers (for a warning). */
  readonly unknown: ReadonlyArray<string>
}

export const parseTools = (input: string): ParsedTools => {
  const parts = input.split(",").map((part) => part.trim().toLowerCase()).filter((part) => part.length > 0)
  if (parts.includes("all") || parts.length === 0) return { tools: ALL_TOOLS, unknown: [] }
  const valid = new Set<Provider>(ALL_TOOLS)
  const isProvider = (part: string): part is Provider => valid.has(part as Provider)
  const tools = [...new Set(parts.filter(isProvider))]
  const unknown = [...new Set(parts.filter((part) => !isProvider(part)))]
  // A typo must not silently widen scope to every tool: keep only what matched
  // (possibly nothing) and let the caller surface the unknown tokens.
  return { tools, unknown }
}

const outputMode = (input: string): OutputMode => (input === "-" || input === "stdout" ? "stdout" : "files")

export const runPull = Effect.fn("Cli.runPull")(function*(input: {
  readonly dir: string
  readonly since?: string | undefined
  readonly tools: string
  readonly out: string
}) {
  const path = yield* Path.Path
  const metadata = yield* readPackageMetadata()
  const dir = path.resolve(input.dir)
  const out = outputMode(input.out)
  const period = input.since === undefined ? undefined : yield* parsePullPeriod(input.since)
  const { tools, unknown } = parseTools(input.tools)
  const extraNotes = unknown.length === 0
    ? []
    : [`Ignored unknown tool(s): ${unknown.join(", ")}. Valid tools are ${ALL_TOOLS.join(", ")}.`]
  const result = yield* pull({ dir, tools, period, out, extraNotes })
  return out === "stdout" ? result.digest : renderPullSummary(result, metadata, terminalStyle())
})

export const renderPullSummary = (
  result: PullResult,
  metadata: PackageMetadata,
  style: TerminalStyle
): string => {
  const rows = result.toolSummary.map((tool) => [
    style.tool(tool.provider),
    style.count(String(tool.sessions), tool.sessions),
    style.count(String(tool.memories), tool.memories)
  ])
  const table = renderTable(["Tool", "Sessions", "Memories"], rows, style)

  const lines: Array<string> = [
    renderBanner({ name: metadata.name, version: metadata.version }, style),
    "",
    indentBlock(
      `Pulled ${style.heading(String(result.sessionCount))} session(s) and ` +
        `${style.heading(String(result.memoryCount))} memory file(s) for`
    ),
    indentBlock(style.path(result.dir)),
    "",
    indentBlock(table)
  ]

  if (result.notes.length > 0) {
    lines.push("")
    lines.push(indentBlock(style.note("Notes")))
    for (const note of result.notes) lines.push(indentBlock(style.note(`- ${note}`)))
  }

  lines.push("")
  lines.push(
    indentBlock(
      result.wroteFiles
        ? style.success("✓ Wrote ./AGENTS.md + ./.tailings/ — the next agent in any tool reads it natively.")
        : style.note("Nothing written (stdout mode).")
    )
  )
  return lines.join("\n")
}

export const runDoctor = Effect.fn("Cli.runDoctor")(function*() {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* TailingsPaths
  const style = terminalStyle()

  const checks = [
    ["Claude projects", paths.claudeProjectsDir, yield* fs.exists(paths.claudeProjectsDir)],
    ["Codex sessions", paths.codexSessionsDir, yield* fs.exists(paths.codexSessionsDir)],
    ["Codex memories", paths.codexMemoriesDir, yield* fs.exists(paths.codexMemoriesDir)],
    ["OpenCode database", paths.openCodeDbPath, yield* fs.exists(paths.openCodeDbPath)],
    ["OpenCode config", paths.openCodeConfigDir, yield* fs.exists(paths.openCodeConfigDir)],
    ["Gemini store", paths.geminiDir, yield* fs.exists(paths.geminiDir)],
    ["Tailings index", paths.tailingsIndexDbPath, yield* fs.exists(paths.tailingsIndexDbPath)]
  ] as const

  const lines = [
    style.heading("tailings doctor"),
    "",
    ...checks.map(([label, location, ok]) =>
      `${ok ? style.success("ok     ") : style.warn("missing")}  ${label}: ${style.note(location)}`
    ),
    "",
    style.note("All reads are local. Missing stores just mean that tool has no history here yet.")
  ]
  return lines.join("\n")
})
