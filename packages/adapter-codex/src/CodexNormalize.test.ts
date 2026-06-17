import { DateTime } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { extractCodexCwd, normalizeCodexSession } from "./CodexNormalize"

const fallback = DateTime.makeUnsafe("2026-02-16T00:00:00.000Z")
const line = (value: unknown) => JSON.stringify(value)

describe("extractCodexCwd", () => {
  it("reads cwd from session_meta", () => {
    expect(extractCodexCwd([line({ type: "session_meta", payload: { id: "x", cwd: "/repo" } })])).toBe("/repo")
  })
  it("falls back to turn_context", () => {
    const lines = [
      line({ type: "event_msg", payload: { type: "task_started" } }),
      line({ type: "turn_context", payload: { cwd: "/other" } })
    ]
    expect(extractCodexCwd(lines)).toBe("/other")
  })
  it("returns undefined when no cwd is present", () => {
    expect(extractCodexCwd([line({ type: "event_msg", payload: { type: "task_complete" } })])).toBeUndefined()
  })
})

describe("normalizeCodexSession", () => {
  it("renders user/assistant/tool, skips developer boilerplate", () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: "2026-02-16T10:00:00.000Z",
        payload: { id: "sess", cwd: "/repo", model: "gpt-5-codex" }
      }),
      line({
        type: "response_item",
        timestamp: "2026-02-16T10:00:01.000Z",
        payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "INSTRUCTIONS" }] }
      }),
      line({
        type: "response_item",
        timestamp: "2026-02-16T10:00:02.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] }
      }),
      line({
        type: "response_item",
        timestamp: "2026-02-16T10:00:03.000Z",
        payload: { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" }
      }),
      line({
        type: "response_item",
        timestamp: "2026-02-16T10:00:04.000Z",
        payload: { type: "function_call_output", output: "file.txt" }
      }),
      line({
        type: "response_item",
        timestamp: "2026-02-16T10:00:05.000Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "all done" }] }
      })
    ]

    const session = normalizeCodexSession({
      filePath: "/f.jsonl",
      sessionIdFallback: "fb",
      fallbackDate: fallback,
      lines
    })

    expect(session.provider).toBe("codex")
    expect(session.sessionId).toBe("sess")
    expect(session.cwd).toBe("/repo")
    expect(session.model).toBe("gpt-5-codex")
    expect(session.messages.map((m) => m.role)).toEqual(["user", "tool", "tool", "assistant"])
    expect(session.messages[0]?.text).toBe("hello codex")
    expect(session.messages[1]?.text).toContain("exec_command")
    expect(session.messages[1]?.text).toContain("ls")
    expect(session.messages[2]?.text).toContain("file.txt")
    expect(session.messages[3]?.text).toBe("all done")
  })
})
