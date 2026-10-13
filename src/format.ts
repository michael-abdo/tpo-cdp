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
