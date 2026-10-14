// POST /api/segments/preview, POST /api/segments/export.csv and GET /api/segments/options (04
// §/api/segments/preview, §/api/segments/export.csv; 19 §5.2–5.3; R3, 09 D-07, D-69). Mounted at
// /api behind requireJson and requireSession. The filters are validated and compiled by
// worker/segments/compile.ts to one bound SELECT (the UI may see emails, 03 §Request flows); every
// query here runs that SQL with its parameters, wrapped only in count(*) or LIMIT ?. The preview
// echoes the canonical filters that parseFilters returned, so the browser keys Previous searches
// on the server's form and never normalizes a value itself (19 §2). Nothing is cached (03
// §No-restart).

import { Hono } from 'hono'
import { SITE_PAGE_PATTERN } from '../../shared/segment-filters'
import { ApiError } from '../auth/middleware'
import type { AppEnv } from '../env'
import {
  type CompiledSegment,
  compileSegment,
  hiddenUnsubscribedFilters,
  parseFilters,
  type RawSegmentRow,
  type SegmentFilters,
  type SegmentRow,
  toSegmentRow,
} from '../segments/compile'
import { segmentCsv } from '../segments/export'

/** Rows a preview returns when the body names no limit (04). */
export const PREVIEW_DEFAULT_LIMIT = 100
/** Upper bound on a preview's rows; the full segment is what export.csv is for. */
export const PREVIEW_MAX_LIMIT = 1000

const PREVIEW_KEYS = ['filters', 'limit']
const EXPORT_KEYS = ['filters']

/** A 400 invalid_body, logged with its reason first (fail loud). */
function invalidBody(route: string, message: string, details: string[]): ApiError {
  console.warn(JSON.stringify({ at: route, outcome: 'invalid_body', details }))
  return new ApiError(400, 'invalid_body', message, details)
}

/** The JSON body as an object holding only `allowed` keys, or 400 invalid_body. */
async function readBody(req: Request, route: string, allowed: readonly string[]): Promise<Record<string, unknown>> {
  let parseError: string | undefined
  const body: unknown = await req.json().catch((err: unknown) => {
    // The error's class name only: a JSON SyntaxError message quotes the body.
    parseError = err instanceof Error ? err.name : 'unknown'
    return undefined
  })
  const shape = `Send a JSON object with only ${allowed.map((k) => `"${k}"`).join(' and ')}.`
  if (parseError !== undefined) throw invalidBody(route, shape, [`body is not JSON: ${parseError}`])
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidBody(route, shape, ['body is not a JSON object'])
  }
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) {
    throw invalidBody(route, shape, unknown.map((k) => `unknown field: ${k}`))
  }
  return body as Record<string, unknown>
}

/** parseFilters, with every rejection logged with its reasons (fail loud). */
function filtersFrom(body: Record<string, unknown>, route: string): SegmentFilters {
  try {
    return parseFilters(body.filters)
  } catch (err) {
    if (err instanceof ApiError) {
      console.warn(JSON.stringify({ at: route, outcome: err.code, details: err.details }))
    }
    throw err
  }
}

function previewLimit(value: unknown, route: string): number {
  if (value === undefined) return PREVIEW_DEFAULT_LIMIT
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > PREVIEW_MAX_LIMIT) {
    const message = `limit must be a whole number from 1 to ${PREVIEW_MAX_LIMIT}.`
    throw invalidBody(route, message, [message])
  }
  return value
}

/** The number of subscribers the compiled segment matches. */
export async function countSegment(db: D1Database, segment: CompiledSegment): Promise<number> {
  const n = await db
    .prepare(`SELECT count(*) AS n FROM (${segment.sql})`)
    .bind(...segment.params)
    .first<number>('n')
  if (n === null) throw new Error('segments: count(*) returned no row')
  return n
}

/** The segment's rows in email order, all of them or the first `limit`. */
export async function segmentRows(db: D1Database, segment: CompiledSegment, limit?: number): Promise<SegmentRow[]> {
  const statement =
    limit === undefined
      ? db.prepare(segment.sql).bind(...segment.params)
      : db.prepare(`${segment.sql} LIMIT ?`).bind(...segment.params, limit)
  const { results } = await statement.all<RawSegmentRow>()
  return results.map(toSegmentRow)
}

/** Unsubscribed rows matching every other filter, or 0 when the status filter already includes them (02 §Defaults). */
export async function hiddenUnsubscribed(db: D1Database, filters: SegmentFilters): Promise<number> {
  const hidden = hiddenUnsubscribedFilters(filters)
  return hidden === null ? 0 : countSegment(db, compileSegment(hidden))
}

/** Mounted at /api by worker/index.ts, behind requireSession. */
export const segmentRoutes = new Hono<AppEnv>()

segmentRoutes.post('/segments/preview', async (c) => {
  const body = await readBody(c.req.raw, 'segments/preview', PREVIEW_KEYS)
  const filters = filtersFrom(body, 'segments/preview')
  const limit = previewLimit(body.limit, 'segments/preview')
  const segment = compileSegment(filters)
  const db = c.env.DB
  const [count, hidden_unsubscribed, rows] = await Promise.all([
    countSegment(db, segment),
    hiddenUnsubscribed(db, filters),
    segmentRows(db, segment, limit),
  ])
  return c.json({ count, hidden_unsubscribed, rows, sql_shape: segment.sql_shape, filters })
})

segmentRoutes.post('/segments/export.csv', async (c) => {
  // The whole list in one response, so a per-client limit (EXPORT_LIMITER, 09 D-70 #6). Cloudflare
  // sets CF-Connecting-IP at the edge; local dev has no edge, so every local client shares one key.
  const { success } = await c.env.EXPORT_LIMITER.limit({ key: c.req.header('cf-connecting-ip') ?? 'local' })
  if (!success) {
    console.warn(JSON.stringify({ at: 'segments/export.csv', outcome: 'rate_limited' }))
    throw new ApiError(429, 'rate_limited', 'Too many exports from this network in the last minute. Wait a minute and try again.')
  }
  const body = await readBody(c.req.raw, 'segments/export.csv', EXPORT_KEYS)
  const segment = compileSegment(filtersFrom(body, 'segments/export.csv'))
  const rows = await segmentRows(c.env.DB, segment)
  return c.body(segmentCsv(rows), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="segment.csv"',
  })
})

/**
 * Every page in the site visits, ordered by how many subscribers visited it (most first), then
 * alphabetically: the choices of the site_visit_page filter (19 §5.3). Reads v_web_events, whose
 * pkey is NULL for an anonymous visitor, so count(DISTINCT pkey) counts linked subscribers only.
 * A stored page the filter's pattern would refuse fails loud: offering it would only produce a
 * 400 on the next preview.
 */
export async function segmentPageOptions(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT page, count(DISTINCT pkey) AS subscribers FROM v_web_events GROUP BY page ORDER BY subscribers DESC, page')
    .all<{ page: string; subscribers: number }>()
  const pattern = new RegExp(SITE_PAGE_PATTERN)
  const refused = results.filter((r) => !pattern.test(r.page)).length
  if (refused > 0) throw new Error(`segments/options: ${refused} stored page(s) do not match the site_visit_page pattern`)
  return results.map((r) => r.page)
}

segmentRoutes.get('/segments/options', async (c) => {
  return c.json({ pages: await segmentPageOptions(c.env.DB) })
})
