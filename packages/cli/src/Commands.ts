import { Console, Effect, Option } from "effect"
import { Command, Flag, Prompt } from "effect/unstable/cli"
import { renderBanner } from "../../core/src/Terminal"
import { readPackageMetadata, runDoctor, runPull } from "./App"

const dir = Flag.string("dir").pipe(
  Flag.withDefault("."),
  Flag.withDescription("Directory to gather history for (default: current directory).")
)

const since = Flag.string("since").pipe(
  Flag.optional,
  Flag.withDescription("Bound how far back, e.g. 30d or an ISO date (default: all).")
)

const tools = Flag.string("tools").pipe(
  Flag.withDefault("claude,codex,opencode,gemini"),
  Flag.withDescription("Comma-separated subset: claude, codex, opencode, gemini — or 'all'.")
)

const out = Flag.string("out").pipe(
  Flag.withDefault("files"),
  Flag.withDescription("'files' writes ./AGENTS.md + ./.tailings/; '-' prints the digest to stdout.")
)

const optionalSince = (value: Option.Option<string>): { readonly since?: string } =>
  Option.isSome(value) ? { since: value.value } : {}

const pull = Command.make("pull", { dir, since, tools, out }, (config) =>
  Effect.gen(function*() {
    const output = yield* runPull({
      dir: config.dir,
      ...optionalSince(config.since),
      tools: config.tools,
      out: config.out
    })
    yield* Console.log(output)
  })).pipe(
    Command.withDescription(
      "Gather ONLY this directory's coding-agent sessions + memories into it, for the next agent to read."
    )
  )

const doctor = Command.make("doctor", {}, () => Effect.flatMap(runDoctor(), Console.log)).pipe(
  Command.withDescription("Check which agent stores are present on this machine.")
)

const root = Command.make("tailings", {}, () =>
  Effect.gen(function*() {
    const metadata = yield* readPackageMetadata()
    yield* Console.log(renderBanner({ name: metadata.name, version: metadata.version }))
    yield* Console.log("")

    if (process.stdin.isTTY !== true) {
      yield* Console.log("  Run `tailings pull` to gather this directory's agent history into ./AGENTS.md.")
      return
    }

    const proceed = yield* Prompt.confirm({
      message: "Pull this directory's agent history into ./AGENTS.md + ./.tailings/?"
    })
    if (!proceed) {
      yield* Console.log("  Okay — run `tailings pull` whenever you're ready.")
      return
    }
    yield* Console.log("")
    yield* Console.log(yield* runPull({ dir: ".", tools: "claude,codex,opencode,gemini", out: "files" }))
  }))

export const command = root.pipe(
  Command.withDescription("Pull a directory's coding-agent history into it so the next agent is caught up."),
  Command.withSubcommands([pull, doctor])
)
