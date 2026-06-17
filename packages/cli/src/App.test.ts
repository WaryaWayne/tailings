import { describe, expect, it } from "@effect/vitest"
import { parseTools } from "./App"

describe("parseTools", () => {
  it("defaults to all tools when empty or 'all'", () => {
    expect(parseTools("").tools).toEqual(["claude", "codex", "opencode", "gemini"])
    expect(parseTools("all").tools).toEqual(["claude", "codex", "opencode", "gemini"])
  })

  it("selects and dedups the named subset", () => {
    expect(parseTools("codex, claude, codex").tools).toEqual(["codex", "claude"])
    expect(parseTools("codex, claude").unknown).toEqual([])
  })

  it("reports unknown tokens instead of silently widening to all", () => {
    const parsed = parseTools("clade")
    expect(parsed.tools).toEqual([])
    expect(parsed.unknown).toEqual(["clade"])
  })

  it("keeps valid tools and flags only the typos in a mixed list", () => {
    const parsed = parseTools("claude, clyde")
    expect(parsed.tools).toEqual(["claude"])
    expect(parsed.unknown).toEqual(["clyde"])
  })
})
