import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Exit } from "effect"
import { inPeriod, parsePullPeriod } from "./Period"

describe("parsePullPeriod", () => {
  it.effect("accepts an absolute window and labels it", () =>
    Effect.gen(function*() {
      const period = yield* parsePullPeriod("2026-01-01", "2026-02-01")
      expect(period.label).toBe("2026-01-01 to 2026-02-01")
      expect(inPeriod(DateTime.makeUnsafe("2026-01-15"), period)).toBe(true)
      expect(inPeriod(DateTime.makeUnsafe("2026-03-01"), period)).toBe(false)
    }))

  it.effect("resolves a Nd duration relative to until", () =>
    Effect.gen(function*() {
      const period = yield* parsePullPeriod("7d", "2026-02-01")
      expect(period.label).toBe("last 7 days")
      expect(DateTime.formatIsoDate(period.since)).toBe("2026-01-25")
    }))

  it.effect("rejects an inverted window (since after until) instead of dropping everything", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(parsePullPeriod("2030-01-01", "2026-01-01"))
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})
