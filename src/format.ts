// Display helpers. Timestamps are stored as `YYYY-MM-DDTHH:MM:SSZ` (worker/ingest) and shown
// labelled UTC (02 §Time, 06); nothing here converts to the viewer's local zone.

const STORED_UTC = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/

/** `2026-09-02 14:03:11 UTC`; a value in any other shape is shown as-is and flagged, never guessed at. */
export function utc(ts: string): string {
  const match = STORED_UTC.exec(ts)
  if (!match) return `${ts} (unrecognized timestamp)`
  return `${match[1]} ${match[2]} UTC`
}

/** A nullable date, with the reason it is empty spelled out. */
export function dateOr(date: string | null, empty: string): string {
  return date ?? empty
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const STORED_DATE = /^(\d{4})-(\d{2})-(\d{2})/

/**
 * A stored date or timestamp as plain words, `Sep 2, 2026` (06 §UI principles 4). Reads the
 * digits as stored, so no time-zone shift; any other shape is shown as-is and flagged.
 */
export function humanDate(date: string): string {
  const match = STORED_DATE.exec(date)
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined
  if (!match || month === undefined) return `${date} (unrecognized date)`
  return `${month} ${Number(match[3])}, ${match[1]}`
}

/** A stored timestamp without seconds, `Sep 2, 2026, 4:19 PM UTC`; utc() keeps the seconds for Technical details. */
export function humanDateTime(ts: string): string {
  const match = STORED_UTC.exec(ts)
  if (!match) return `${ts} (unrecognized timestamp)`
  const [hh, mm] = match[2].split(':').map(Number)
  const hour12 = hh % 12 === 0 ? 12 : hh % 12
  return `${humanDate(match[1])}, ${hour12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'} UTC`
}

/** A stored code word with its first letter capitalized for display (`instagram` → `Instagram`). */
export function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}
