import { describe, expect, it } from "@effect/vitest"
import { uniqueName } from "./Pull"

describe("uniqueName", () => {
  it("returns the name unchanged when unused", () => {
    const used = new Set<string>()
    expect(uniqueName("MEMORY.md", used)).toBe("MEMORY.md")
  })

  it("disambiguates same-basename collisions before the extension", () => {
    const used = new Set<string>()
    expect(uniqueName("MEMORY.md", used)).toBe("MEMORY.md")
    expect(uniqueName("MEMORY.md", used)).toBe("MEMORY-2.md")
    expect(uniqueName("MEMORY.md", used)).toBe("MEMORY-3.md")
  })

  it("handles names without an extension", () => {
    const used = new Set<string>()
    expect(uniqueName("AGENTS", used)).toBe("AGENTS")
    expect(uniqueName("AGENTS", used)).toBe("AGENTS-2")
  })
})
