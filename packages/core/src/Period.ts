import { DateTime, Effect } from "effect"
import { PeriodParseError } from "./Domain"

/**
 * A bounded time window for `pull --since`. Ported from tvagent's Period, kept
 * deliberately small: a duration like `30d` or an absolute ISO date.
 */
export type PullPeriod = {
  readonly since: DateTime.Utc
  readonly until: DateTime.Utc
  readonly label: string
}

const parseDate = (input: string) =>
  Effect.try({
    try: () => DateTime.makeUnsafe(input),
    catch: (cause) =>
      new PeriodParseError({
        input,
        message: "Expected a duration like 30d or an ISO date.",
        cause
      })
  })

export const parsePullPeriod = Effect.fn("Period.parsePullPeriod")(function*(
  sinceInput: string,
  untilInput?: string
) {
  const until = untilInput === undefined ? yield* DateTime.now : yield* parseDate(untilInput)
  const durationMatch = /^([1-9][0-9]*)d$/.exec(sinceInput)

  let since: DateTime.Utc
  let label: string
  if (durationMatch !== null) {
    const days = Number(durationMatch[1])
    since = DateTime.subtract(until, { days })
    label = `last ${days} ${days === 1 ? "day" : "days"}`
  } else {
    since = yield* parseDate(sinceInput)
    label = `${DateTime.formatIsoDate(since)} to ${DateTime.formatIsoDate(until)}`
  }

  // An inverted window (since after until) matches nothing — fail loudly rather
  // than silently dropping every session.
  if (DateTime.toEpochMillis(since) > DateTime.toEpochMillis(until)) {
    return yield* new PeriodParseError({
      input: untilInput === undefined ? sinceInput : `${sinceInput}..${untilInput}`,
      message: `Start (${DateTime.formatIsoDate(since)}) is after end (${DateTime.formatIsoDate(until)}).`
    })
  }

  return { since, until, label } satisfies PullPeriod
})

export const inPeriod = (occurredAt: DateTime.Utc, period: PullPeriod): boolean =>
  DateTime.between(occurredAt, {
    minimum: period.since,
    maximum: period.until
  })

/**
 * Filter by a session's most recent activity. A session with no timestamps is
 * kept (we'd rather over-include than silently drop history).
 */
export const sessionInPeriod = (
  updatedAt: DateTime.Utc | undefined,
  period: PullPeriod | undefined
): boolean => {
  if (period === undefined) return true
  if (updatedAt === undefined) return true
  return inPeriod(updatedAt, period)
}
