// Display helpers. Timestamps are stored as `YYYY-MM-DDTHH:MM:SSZ` (worker/ingest) and shown
// labelled UTC (02 §Time, 06); nothing here converts to the viewer's local zone.

import { humanDate, MONTHS } from '../shared/date-words'

export { humanDate, humanRange } from '../shared/date-words'

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

/** A `YYYY-MM` month in words, `Aug 2026`; any other shape is shown as-is and flagged. */
export function humanMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  const name = match ? MONTHS[Number(match[2]) - 1] : undefined
  if (!match || name === undefined) return `${month} (unrecognized month)`
  return `${name} ${match[1]}`
}
