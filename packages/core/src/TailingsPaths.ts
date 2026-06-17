import { Config, Context, Effect, Layer, Path } from "effect"

/**
 * Resolves every source store Tailings reads from, plus our own archive root.
 * Ported from tvagent's `LocalPaths`, extended with memory roots and the
 * Tailings index/archive directory.
 */
export class TailingsPaths extends Context.Service<TailingsPaths, {
  readonly home: string
  // Claude Code
  readonly claudeProjectsDir: string
  readonly claudeGlobalMemory: string
  // Codex
  readonly codexSessionsDir: string
  readonly codexSessionIndex: string
  readonly codexMemoriesDir: string
  // OpenCode
  readonly openCodeDbPath: string
  readonly openCodeConfigDir: string
  // Gemini (unverified layout — present only if installed)
  readonly geminiDir: string
  // Tailings' own store
  readonly tailingsDataDir: string
  readonly tailingsIndexDbPath: string
}>()("tailings/TailingsPaths") {}

export const TailingsPathsLive = Layer.effect(
  TailingsPaths,
  Effect.gen(function*() {
    const path = yield* Path.Path
    const home = yield* Config.string("HOME").pipe(Config.withDefault("."))
    const tailingsDataDir = yield* Config.string("TAILINGS_DATA_DIR").pipe(
      Config.withDefault(path.join(home, ".local", "share", "tailings"))
    )

    return TailingsPaths.of({
      home,
      claudeProjectsDir: path.join(home, ".claude", "projects"),
      claudeGlobalMemory: path.join(home, ".claude", "CLAUDE.md"),
      codexSessionsDir: path.join(home, ".codex", "sessions"),
      codexSessionIndex: path.join(home, ".codex", "session_index.jsonl"),
      codexMemoriesDir: path.join(home, ".codex", "memories"),
      openCodeDbPath: path.join(home, ".local", "share", "opencode", "opencode.db"),
      openCodeConfigDir: path.join(home, ".config", "opencode"),
      geminiDir: path.join(home, ".gemini"),
      tailingsDataDir,
      tailingsIndexDbPath: path.join(tailingsDataDir, "index.db")
    })
  })
)

/**
 * Claude encodes a working directory into a project folder name by replacing
 * **both** `/` and `.` with `-`. So `/Users/me/.config/x` becomes
 * `-Users-me--config-x` (note the double dash from the dot).
 */
export const encodeClaudeProjectDir = (cwd: string): string => cwd.replace(/[/.]/g, "-")

/**
 * A directory is "within" the target if it is the target itself or a
 * subdirectory of it. Used to keep a pull scoped to one directory tree.
 */
export const isWithinDir = (candidate: string, target: string): boolean => {
  const normalize = (dir: string) => (dir.endsWith("/") && dir.length > 1 ? dir.slice(0, -1) : dir)
  const c = normalize(candidate)
  const t = normalize(target)
  // Root contains everything; comparing against `${t}/` would become `//` and
  // match nothing.
  if (t === "/") return true
  return c === t || c.startsWith(`${t}/`)
}
