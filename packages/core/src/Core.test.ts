import { describe, expect, it } from "@effect/vitest"
import { renderSessionMarkdown, slugify, stripDataUrls, truncate } from "./Render"
import { encodeClaudeProjectDir, isWithinDir } from "./TailingsPaths"
import { DateTime } from "effect"

describe("TailingsPaths", () => {
  it("encodes both / and . to - (Claude project folder scheme)", () => {
    expect(encodeClaudeProjectDir("/Users/me/Desktop/projects")).toBe("-Users-me-Desktop-projects")
    expect(encodeClaudeProjectDir("/Users/me/.config/x")).toBe("-Users-me--config-x")
  })

  it("isWithinDir matches the dir and its subdirs, but not siblings", () => {
    expect(isWithinDir("/a/b", "/a/b")).toBe(true)
    expect(isWithinDir("/a/b/c", "/a/b")).toBe(true)
    expect(isWithinDir("/a/bc", "/a/b")).toBe(false)
    expect(isWithinDir("/a", "/a/b")).toBe(false)
  })

  it("isWithinDir treats root as containing everything", () => {
    expect(isWithinDir("/a/b", "/")).toBe(true)
    expect(isWithinDir("/", "/")).toBe(true)
  })
})

describe("Render", () => {
  it("slugify produces a filesystem-safe slug", () => {
    expect(slugify("Hello, World!")).toBe("hello-world")
    expect(slugify("   ")).toBe("untitled")
  })

  it("stripDataUrls removes inline base64 blobs", () => {
    const out = stripDataUrls("before data:image/png;base64,AAAABBBBCCCC after")
    expect(out).toContain("[inline base64 data omitted]")
    expect(out).not.toContain("AAAABBBB")
  })

  it("truncate marks oversized text", () => {
    expect(truncate("abcdefghij", 4)).toContain("truncated")
    expect(truncate("abc", 10)).toBe("abc")
  })

  it("renderSessionMarkdown produces a readable document", () => {
    const md = renderSessionMarkdown({
      provider: "claude",
      sessionId: "s1",
      cwd: "/repo",
      model: "claude-opus-4-8",
      startedAt: DateTime.makeUnsafe("2026-06-01T00:00:00.000Z"),
      updatedAt: DateTime.makeUnsafe("2026-06-01T01:00:00.000Z"),
      sourcePath: "/tmp/s1.jsonl",
      messages: [
        { role: "user", text: "hello", at: DateTime.makeUnsafe("2026-06-01T00:00:00.000Z") },
        { role: "assistant", text: "hi", at: DateTime.makeUnsafe("2026-06-01T00:00:05.000Z") }
      ]
    })
    expect(md).toContain("**Tool:** claude")
    expect(md).toContain("### User")
    expect(md).toContain("### Assistant")
    expect(md).toContain("hello")
  })
})
