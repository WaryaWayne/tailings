import { describe, expect, it } from "@effect/vitest"
import { DateTime } from "effect"
import { buildDigest, mergeAgentsMd, TAILINGS_END, TAILINGS_START } from "./AgentsMd"

describe("buildDigest", () => {
  const base = {
    dir: "/repo",
    generatedAt: DateTime.makeUnsafe("2026-06-16T00:00:00.000Z"),
    tools: ["claude", "codex", "opencode", "gemini"] as const,
    notes: [] as ReadonlyArray<string>
  }

  it("points the next agent at ./.tailings/ and never inlines content", () => {
    const digest = buildDigest({
      ...base,
      sessions: [{ provider: "claude" }, { provider: "claude" }],
      memories: [{ provider: "claude" }, { provider: "codex" }]
    })
    expect(digest).toContain("./.tailings/")
    expect(digest).toContain("./.tailings/memories/")
    expect(digest).toContain("./.tailings/sessions/")
    // Counts only, per provider that has history — no transcript/memory bodies.
    expect(digest).toContain("**claude** — 2 sessions, 1 memory file")
    expect(digest).toContain("**codex** — 0 sessions, 1 memory file")
    // Providers with no history here are omitted.
    expect(digest).not.toContain("opencode")
    expect(digest).not.toContain("gemini")
  })

  it("reports an empty pull plainly", () => {
    const digest = buildDigest({ ...base, sessions: [], memories: [] })
    expect(digest).toContain("No prior agent history")
  })
})

describe("mergeAgentsMd", () => {
  it("creates a fresh block when AGENTS.md is empty", () => {
    const out = mergeAgentsMd("", "DIGEST BODY")
    expect(out).toContain(TAILINGS_START)
    expect(out).toContain(TAILINGS_END)
    expect(out).toContain("DIGEST BODY")
  })

  it("appends below existing user content without clobbering it", () => {
    const out = mergeAgentsMd("# My project\n\nHand-written notes.\n", "DIGEST")
    expect(out.startsWith("# My project")).toBe(true)
    expect(out).toContain("Hand-written notes.")
    expect(out).toContain("DIGEST")
  })

  it("replaces only the marked block, preserving surrounding content", () => {
    const existing = `keep-before\n${TAILINGS_START}\nOLD DIGEST\n${TAILINGS_END}\nkeep-after`
    const out = mergeAgentsMd(existing, "NEW DIGEST")
    expect(out).toContain("NEW DIGEST")
    expect(out).not.toContain("OLD DIGEST")
    expect(out).toContain("keep-before")
    expect(out).toContain("keep-after")
  })

  it("does not delete user text when markers are unbalanced (orphan start)", () => {
    // An interrupted prior write or a marker echoed in prose leaves an orphan
    // start before a real block. Splicing across it must not eat user text.
    const existing = `${TAILINGS_START}\nUSER PROSE\n${TAILINGS_START}\nOLD DIGEST\n${TAILINGS_END}`
    const out = mergeAgentsMd(existing, "NEW DIGEST")
    expect(out).toContain("USER PROSE")
    expect(out).toContain("NEW DIGEST")
  })

  it("is idempotent across repeated runs on a clean block", () => {
    const once = mergeAgentsMd("# Title\n", "DIGEST A")
    const twice = mergeAgentsMd(once, "DIGEST B")
    expect(twice).toContain("DIGEST B")
    expect(twice).not.toContain("DIGEST A")
    expect(twice.split(TAILINGS_START).length - 1).toBe(1)
    expect(twice.split(TAILINGS_END).length - 1).toBe(1)
  })
})
