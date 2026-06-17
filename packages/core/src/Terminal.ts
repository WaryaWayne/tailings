/**
 * Terminal styling primitives, ported from the house style used in `ai-hr`'s
 * Renderers: ANSI colour gated on real terminal colour support, plus a
 * visible-length-aware table renderer so colour codes never break alignment.
 */

const ANSI_PATTERN = /\[[0-9;]*m/g

const ansi = (code: string, value: string): string => `[${code}m${value}[0m`

const identity = (value: string): string => value

export type TerminalStyle = {
  readonly brand: (value: string) => string
  readonly heading: (value: string) => string
  readonly tool: (value: string) => string
  readonly count: (value: string, n: number) => string
  readonly path: (value: string) => string
  readonly success: (value: string) => string
  readonly warn: (value: string) => string
  readonly note: (value: string) => string
  readonly tableHeader: (value: string) => string
}

export const plainTerminalStyle: TerminalStyle = {
  brand: identity,
  heading: identity,
  tool: identity,
  count: (value) => value,
  path: identity,
  success: identity,
  warn: identity,
  note: identity,
  tableHeader: identity
}

export const createTerminalStyle = (useColor: boolean): TerminalStyle =>
  useColor
    ? {
      brand: (value) => ansi("1;33", value),
      heading: (value) => ansi("1;36", value),
      tool: (value) => ansi("36", value),
      count: (value, n) => (n > 0 ? ansi("32", value) : ansi("2", value)),
      path: (value) => ansi("4", value),
      success: (value) => ansi("32", value),
      warn: (value) => ansi("33", value),
      note: (value) => ansi("2", value),
      tableHeader: (value) => ansi("2", value)
    }
    : plainTerminalStyle

export const supportsTerminalColor = (): boolean => {
  const stdout = process.stdout as typeof process.stdout & {
    readonly hasColors?: () => boolean
  }
  return typeof stdout.hasColors === "function" && stdout.hasColors()
}

export const terminalStyle = (): TerminalStyle => createTerminalStyle(supportsTerminalColor())

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "")

const visibleLength = (value: string): number => stripAnsi(value).length

const padVisible = (value: string, width: number): string =>
  `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`

export const renderTable = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  style: TerminalStyle = plainTerminalStyle
): string => {
  const widths = headers.map((header, index) =>
    Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[index] ?? "")))
  )
  const line = (values: ReadonlyArray<string>) =>
    `| ${values.map((value, index) => padVisible(value, widths[index] ?? visibleLength(value))).join(" | ")} |`
  const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`
  return [line(headers.map((header) => style.tableHeader(header))), separator, ...rows.map(line)].join("\n")
}

export const indentBlock = (value: string, indent = "  "): string =>
  value.split("\n").map((line) => `${indent}${line}`).join("\n")

const PAN_AVATAR = [
  String.raw`    \   ·*·   /`,
  String.raw`     \ ·___· /`,
  String.raw`      \_____/`
].join("\n")

/** The styled banner shown above interactive/summary output. */
export const renderBanner = (
  options: { readonly name: string; readonly version: string },
  style: TerminalStyle = terminalStyle()
): string => {
  const title = `${style.brand(options.name)} ${style.note(`v${options.version}`)}`
  return [
    indentBlock(style.warn(PAN_AVATAR)),
    "",
    indentBlock(title),
    indentBlock(
      style.note("the tail-end of the value you already received — pulled back out for the next agent.")
    )
  ].join("\n")
}
