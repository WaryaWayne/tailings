import { DateTime } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { normalizeClaudeSession } from "./ClaudeArchive"

const fallback = DateTime.makeUnsafe("2026-06-01T00:00:00.000Z")
const line = (value: unknown) => JSON.stringify(value)

describe("normalizeClaudeSession", () => {
  it("renders user text, assistant thinking/text/tool, and tool results", () => {
    const lines = [
      line({
        type: "user",
        sessionId: "s1",
        cwd: "/repo",
        gitBranch: "main",
        timestamp: "2026-06-01T01:00:00.000Z",
        message: { role: "user", content: "hello there" }
      }),
      line({
        type: "assistant",
        sessionId: "s1",
        timestamp: "2026-06-01T01:00:05.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            { type: "thinking", thinking: "let me think" },
            { type: "text", text: "here is my answer" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } }
          ]
        }
      }),
      line({
        type: "user",
        sessionId: "s1",
        timestamp: "2026-06-01T01:00:10.000Z",
        message: { role: "user", content: [{ type: "tool_result", content: "file.txt\n" }] }
      })
    ]

    const session = normalizeClaudeSession({
      filePath: "/tmp/s1.jsonl",
      sessionIdFallback: "fallback-id",
      fallbackDate: fallback,
      lines
    })

    expect(session.provider).toBe("claude")
    expect(session.sessionId).toBe("s1")
    expect(session.cwd).toBe("/repo")
    expect(session.gitBranch).toBe("main")
    expect(session.model).toBe("claude-opus-4-8")
    expect(session.messages).toHaveLength(3)

    expect(session.messages[0]?.role).toBe("user")
    expect(session.messages[0]?.text).toContain("hello there")

    expect(session.messages[1]?.role).toBe("assistant")
    expect(session.messages[1]?.text).toContain("let me think")
    expect(session.messages[1]?.text).toContain("here is my answer")
    expect(session.messages[1]?.text).toContain("Bash")

    // A user turn that is only a tool_result is relabelled as a tool message.
    expect(session.messages[2]?.role).toBe("tool")
    expect(session.messages[2]?.text).toContain("file.txt")
  })

  it("skips metadata records, empty lines, and empty messages", () => {
    const lines = [
      "",
      line({ type: "mode", mode: "default" }),
      line({ type: "file-history-snapshot", messageId: "x" }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "" }] } })
    ]
    const session = normalizeClaudeSession({
      filePath: "/f.jsonl",
      sessionIdFallback: "fb",
      fallbackDate: fallback,
      lines
    })
    expect(session.messages).toHaveLength(0)
    expect(session.sessionId).toBe("fb")
  })
})
