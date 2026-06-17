import { DateTime } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { buildOpenCodeSession, normalizeOpenCodeModel, renderOpenCodePart } from "./OpenCodeNormalize"

const fallback = DateTime.makeUnsafe("2026-05-30T00:00:00.000Z")

describe("normalizeOpenCodeModel", () => {
  it("returns a plain string model as-is", () => {
    expect(normalizeOpenCodeModel("gpt-5")).toBe("gpt-5")
  })
  it("flattens a JSON model object to provider/model", () => {
    expect(normalizeOpenCodeModel(JSON.stringify({ providerID: "openai", modelID: "gpt-5.4-mini" }))).toBe(
      "openai/gpt-5.4-mini"
    )
  })
  it("returns undefined for null/empty", () => {
    expect(normalizeOpenCodeModel(null)).toBeUndefined()
    expect(normalizeOpenCodeModel("  ")).toBeUndefined()
  })
})

describe("renderOpenCodePart", () => {
  it("renders text and reasoning, skips bookkeeping parts", () => {
    expect(renderOpenCodePart(JSON.stringify({ type: "text", text: "hi" }))).toBe("hi")
    expect(renderOpenCodePart(JSON.stringify({ type: "reasoning", text: "because" }))).toContain("because")
    expect(renderOpenCodePart(JSON.stringify({ type: "step-start" }))).toBeUndefined()
    expect(renderOpenCodePart(JSON.stringify({ type: "step-finish" }))).toBeUndefined()
  })
  it("renders a tool part with input and output", () => {
    const rendered = renderOpenCodePart(
      JSON.stringify({ type: "tool", tool: "bash", state: { input: { command: "ls" }, output: "out.txt" } })
    )
    expect(rendered).toContain("bash")
    expect(rendered).toContain("ls")
    expect(rendered).toContain("out.txt")
  })
})

describe("buildOpenCodeSession", () => {
  it("groups parts under their message and preserves order", () => {
    const session = {
      id: "ses1",
      directory: "/repo",
      title: "My session",
      time_created: 1_780_000_000_000,
      time_updated: 1_780_000_005_000,
      agent: "build",
      model: JSON.stringify({ providerID: "openai", modelID: "gpt-5" })
    }
    const messages = [
      { id: "m1", data: JSON.stringify({ role: "user" }), time_created: 1_780_000_000_000 },
      { id: "m2", data: JSON.stringify({ role: "assistant" }), time_created: 1_780_000_001_000 }
    ]
    const partsByMessage = new Map([
      ["m1", [{ message_id: "m1", data: JSON.stringify({ type: "text", text: "hello" }), time_created: 1 }]],
      ["m2", [{ message_id: "m2", data: JSON.stringify({ type: "text", text: "world" }), time_created: 2 }]]
    ])

    const built = buildOpenCodeSession({ session, messages, partsByMessage, dbPath: "/db", fallbackDate: fallback })

    expect(built.provider).toBe("opencode")
    expect(built.sessionId).toBe("ses1")
    expect(built.cwd).toBe("/repo")
    expect(built.model).toBe("openai/gpt-5")
    expect(built.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(built.messages.map((m) => m.text)).toEqual(["hello", "world"])
  })
})
