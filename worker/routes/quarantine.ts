// GET /api/quarantine?reason= (04 §/api/quarantine, 09 D-61; R1.1): the rows the import set aside,
// each with its fields as written in the file, for Overview's "Needs review" card (06 §Overview).
// Returns raw emails, so it sits behind the session guard and is never an assistant tool (05).
// Read-only: there is no route that edits or deletes a quarantined row (09 D-13).

import { Hono } from 'hono'
import { ApiError } from '../auth/middleware'
import type { AppEnv } from '../env'
import { APP_COLUMNS } from '../ingest/app'
import { parseCsv } from '../ingest/csv'
import { QUARANTINE_REASONS, type QuarantineReason, SUBSCRIBER_COLUMNS } from '../ingest/quarantine'
import { WEB_COLUMNS } from '../ingest/web'

/** The `file` values of the quarantine table (migrations/0001_core.sql CHECK). */
export type QuarantineFile = 'subscribers' | 'web_events' | 'app_users'

/**
 * Each file's CSV header, in the file's own column order. test/quarantine.test.ts pins each one
 * against the first line of the real data/*.csv, since the seed stores `raw_row` without its header.
 */
export const FILE_HEADERS: Readonly<Record<QuarantineFile, readonly string[]>> = {
  subscribers: SUBSCRIBER_COLUMNS,
  web_events: WEB_COLUMNS,
  app_users: APP_COLUMNS,
}

export interface QuarantinedRowOut {
  file: QuarantineFile
  line_no: number
  reason: QuarantineReason
  /** Column name → the field's text exactly as written in the file (never trimmed or normalized). */
  fields: Record<string, string>
}

/**
 * Splits one stored `raw_row` into named fields with the same parser the seed used (worker/ingest/csv.ts),
 * so quoting rules cannot differ. A record whose field count is not the header's throws (fail loud).
 */
export function quarantineFields(file: QuarantineFile, rawRow: string): Record<string, string> {
  const parsed = parseCsv(`${FILE_HEADERS[file].join(',')}\n${rawRow}`)
  const [row, extra] = parsed.rows
  if (row === undefined || extra !== undefined) {
    throw new Error(`quarantine: a ${file} raw_row holds ${parsed.rows.length} records, expected 1`)
  }
  return Object.fromEntries(parsed.header.map((name, i) => [name, row[i]]))
}

function reasonFilter(raw: string | undefined): QuarantineReason | null {
  if (raw === undefined) return null
  if ((QUARANTINE_REASONS as readonly string[]).includes(raw)) return raw as QuarantineReason
  console.warn(JSON.stringify({ at: 'quarantine', outcome: 'invalid_reason' }))
  throw new ApiError(
    400,
    'invalid_reason',
    `reason must be one of ${QUARANTINE_REASONS.join(', ')}, or left out.`,
  )
}

/** Mounted at /api by worker/index.ts, behind requireSession. */
export const quarantineRoutes = new Hono<AppEnv>()

quarantineRoutes.get('/quarantine', async (c) => {
  const reason = reasonFilter(c.req.query('reason'))
  // Oldest file order: import_runs ids follow the seed's file order, then the line in that file.
  const sql = `SELECT file, line_no, reason, raw_row FROM quarantine
    ${reason === null ? '' : 'WHERE reason = ?1'} ORDER BY run_id, line_no`
  const stmt = c.env.DB.prepare(sql)
  const { results } = await (reason === null ? stmt : stmt.bind(reason)).all<{
    file: QuarantineFile
    line_no: number
    reason: QuarantineReason
    raw_row: string
  }>()
  const rows: QuarantinedRowOut[] = results.map((r) => ({
    file: r.file,
    line_no: r.line_no,
    reason: r.reason,
    fields: quarantineFields(r.file, r.raw_row),
  }))
  return c.json({ rows })
})
