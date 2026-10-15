// Segment rows → CSV for POST /api/segments/export.csv.
// Pure: rows in, RFC 4180 text out. Columns are SEGMENT_COLUMNS in that order, email first so
// the file imports into beehiiv unchanged, and the status column is always present so a list
// that deliberately includes unsubscribed can never pass for an email list. Which rows are in
// the file is decided by the segment's own status filter (compile.ts), never here. Field
// quoting is ingest's toCsvRecord, the repo's one RFC 4180 record writer. A cell a spreadsheet
// would read as a formula is neutralized first.

import { toCsvRecord } from '../ingest/subscribers'
import { SEGMENT_COLUMNS, type SegmentRow } from './compile'

/** RFC 4180 record separator. */
const CRLF = '\r\n'

/** The first characters with which a spreadsheet starts a formula, plus tab and carriage return (OWASP CSV injection). */
export const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'] as const

/**
 * CSV formula injection: a cell starting with `= + - @`, a tab or a carriage return gets a leading `'`, so
 * Excel, Sheets and Numbers show it as text instead of evaluating it. Quoting stays RFC 4180.
 */
function neutralized(cell: string): string {
  return (FORMULA_PREFIXES as readonly string[]).includes(cell.charAt(0)) ? `'${cell}` : cell
}

/** A null date or source is an empty field; has_app is written `true` / `false`. */
function fields(row: SegmentRow): string[] {
  return SEGMENT_COLUMNS.map((column) => {
    const value = row[column]
    return neutralized(value === null ? '' : String(value))
  })
}

/** The export file for a segment's rows: the header record, then one record per row, each CRLF-terminated. */
export function segmentCsv(rows: readonly SegmentRow[]): string {
  return [[...SEGMENT_COLUMNS], ...rows.map(fields)].map((record) => toCsvRecord(record) + CRLF).join('')
}
