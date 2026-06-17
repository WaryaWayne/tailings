import { DateTime } from "effect"
import type { Message, SessionArchive } from "./Domain"

/** Hard ceiling on a single rendered message so one runaway tool dump can't
 * bloat a transcript into the tens of MB. Transcripts are the gold, but a 5 MB
 * base64 screenshot is not. */
const MAX_MESSAGE_CHARS = 24_000

const DATA_URL_RE = /data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/g

export const stripDataUrls = (text: string): string =>
  text.replace(DATA_URL_RE, "[inline base64 data omitted]")

export const truncate = (text: string, max = MAX_MESSAGE_CHARS): string => {
  if (text.length <= max) return text
  const omitted = text.length - max
  return `${text.slice(0, max)}\n\n…[truncated ${omitted.toLocaleString("en-US")} chars]`
}

export const cleanText = (text: string): string => truncate(stripDataUrls(text).trim())

/** Filesystem-safe slug for a session/memory filename. */
export const slugify = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled"

const roleLabel = (role: string): string => {
  switch (role) {
    case "user":
      return "User"
    case "assistant":
      return "Assistant"
    case "system":
      return "System"
    case "developer":
      return "Developer"
    case "tool":
      return "Tool"
    case "summary":
      return "Summary"
    default:
      return role.charAt(0).toUpperCase() + role.slice(1)
  }
}

const formatTime = (at: DateTime.Utc | undefined): string =>
  at === undefined ? "" : ` · ${DateTime.formatIso(at)}`

const renderMessage = (message: Message): string => {
  const body = cleanText(message.text)
  if (body.length === 0) return ""
  return `### ${roleLabel(message.role)}${formatTime(message.at)}\n\n${body}`
}

const isoOrUnknown = (at: DateTime.Utc | undefined): string =>
  at === undefined ? "unknown" : DateTime.formatIso(at)

/** A one-line index entry, e.g. for AGENTS.md. */
export const sessionHeadline = (session: SessionArchive): string => {
  const title = session.title?.trim() || firstUserLine(session) || session.sessionId
  return title.replace(/\s+/g, " ").slice(0, 100)
}

const firstUserLine = (session: SessionArchive): string | undefined => {
  const firstUser = session.messages.find((m) => m.role === "user" && m.text.trim().length > 0)
  if (firstUser === undefined) return undefined
  const line = firstUser.text.trim().split(/\r?\n/)[0] ?? ""
  return line.length === 0 ? undefined : line
}

/** Render a whole session to a standalone markdown document for `./.tailings/`. */
export const renderSessionMarkdown = (session: SessionArchive): string => {
  const lines: Array<string> = []
  lines.push(`# ${sessionHeadline(session)}`)
  lines.push("")
  lines.push(`- **Tool:** ${session.provider}`)
  lines.push(`- **Session:** \`${session.sessionId}\``)
  if (session.cwd !== undefined) lines.push(`- **Directory:** \`${session.cwd}\``)
  if (session.gitBranch !== undefined) lines.push(`- **Git branch:** ${session.gitBranch}`)
  if (session.model !== undefined) lines.push(`- **Model:** ${session.model}`)
  lines.push(`- **Started:** ${isoOrUnknown(session.startedAt)}`)
  lines.push(`- **Updated:** ${isoOrUnknown(session.updatedAt)}`)
  lines.push(`- **Messages:** ${session.messages.length}`)
  lines.push(`- **Source:** \`${session.sourcePath}\``)
  lines.push("")
  lines.push("---")
  lines.push("")
  for (const message of session.messages) {
    const rendered = renderMessage(message)
    if (rendered.length === 0) continue
    lines.push(rendered)
    lines.push("")
  }
  return `${lines.join("\n").trimEnd()}\n`
}
