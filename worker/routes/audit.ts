// GET /api/audit?limit= and GET /api/audit/:trace_id (04 §GET /api/audit; 06 §/audit; 05 §Proof
// surfaces; R5.5). Mounted at /api by worker/index.ts, behind requireSession. Read-only over
// ai_audit (01), the rows worker/assistant/audit/ai-audit.ts wrote:
//   - the list: the latest assistant traces, newest first, one line each: when it started, the
//     redacted question as the model received it (messages[0] of the trace's first model_request
//     row; null when the request stopped before any model call, e.g. at Gate 1), the most severe
//     row status, the number of model and tool rows, and the tokens summed over the trace
//   - one trace: every ai_audit row of the trace in write order, each field as stored. request_json
//     is the exact payload sent after the scanner (the writer refuses a row that fails the PII
//     scan), so nothing here can hold an email; the re-hydrated result is never stored (05
//     §Re-hydration). session_sub is not returned: the screen does not need it.
// Nothing is cached (03 §No-restart): a trace written a moment ago is in the next response.

import { Hono } from 'hono'
import { ApiError } from '../auth/middleware'
import type { AppEnv } from '../env'

/** Traces the list returns when the request names no limit. */
export const AUDIT_DEFAULT_LIMIT = 20
/** Upper bound on the list's traces. */
export const AUDIT_MAX_LIMIT = 100

export type AuditStatus = 'success' | 'error' | 'blocked'

/** One line of GET /api/audit. */
export interface AuditTraceSummary {
  trace_id: string
  /** created_at of the trace's first row (wall clock, UTC). */
  started_at: string
  /** The redacted question the model received; null when no model call was made. */
  question: string | null
  /** blocked if any row is blocked, else error if any row is an error, else success. */
  status: AuditStatus
  model_calls: number
  tool_calls: number
  tokens_in: number
  tokens_out: number
}

/** One ai_audit row as stored (01), without session_sub. */
export interface AuditRowOut {
  id: string
  kind: 'model_request' | 'tool_call' | 'blocked'
  tool_name: string | null
  status: AuditStatus
  latency_ms: number | null
  model: string | null
  tokens_in: number | null
  tokens_out: number | null
  request_json: string | null
  response_json: string | null
  sql: string | null
  row_count: number | null
  error: string | null
  created_at: string
}

function auditLimit(raw: string | undefined): number {
  if (raw === undefined) return AUDIT_DEFAULT_LIMIT
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(n) || n < 1 || n > AUDIT_MAX_LIMIT) {
    const message = `limit must be a whole number from 1 to ${AUDIT_MAX_LIMIT}.`
    console.warn(JSON.stringify({ at: 'audit', outcome: 'invalid_limit' }))
    throw new ApiError(400, 'invalid_limit', message, [message])
  }
  return n
}

// Traces ordered by their first row; min(rowid) breaks a same-millisecond tie in write order.
const LIST_SQL = `
WITH traces AS (
  SELECT trace_id,
         min(created_at) AS started_at,
         min(rowid) AS first_rowid,
         CASE WHEN sum(status = 'blocked') > 0 THEN 'blocked'
              WHEN sum(status = 'error') > 0 THEN 'error'
              ELSE 'success' END AS status,
         sum(kind = 'model_request') AS model_calls,
         sum(kind = 'tool_call') AS tool_calls,
         coalesce(sum(tokens_in), 0) AS tokens_in,
         coalesce(sum(tokens_out), 0) AS tokens_out
  FROM ai_audit
  GROUP BY trace_id
  ORDER BY started_at DESC, first_rowid DESC
  LIMIT ?
)
SELECT t.trace_id, t.started_at, t.status, t.model_calls, t.tool_calls, t.tokens_in, t.tokens_out,
       (SELECT CASE json_type(a.request_json, '$.messages[0].content')
                 WHEN 'text' THEN json_extract(a.request_json, '$.messages[0].content') END
        FROM ai_audit a
        WHERE a.trace_id = t.trace_id AND a.kind = 'model_request'
        ORDER BY a.created_at, a.rowid
        LIMIT 1) AS question
FROM traces t
ORDER BY t.started_at DESC, t.first_rowid DESC`

const TRACE_SQL = `
SELECT id, kind, tool_name, status, latency_ms, model, tokens_in, tokens_out,
       request_json, response_json, sql, row_count, error, created_at
FROM ai_audit
WHERE trace_id = ?
ORDER BY created_at, rowid`

export const auditRoutes = new Hono<AppEnv>()

auditRoutes.get('/audit', async (c) => {
  const limit = auditLimit(c.req.query('limit'))
  const { results } = await c.env.DB.prepare(LIST_SQL).bind(limit).all<AuditTraceSummary>()
  const traces: AuditTraceSummary[] = results.map((r) => ({
    trace_id: r.trace_id,
    started_at: r.started_at,
    question: r.question,
    status: r.status,
    model_calls: r.model_calls,
    tool_calls: r.tool_calls,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
  }))
  return c.json({ traces })
})

auditRoutes.get('/audit/:trace_id', async (c) => {
  const traceId = c.req.param('trace_id')
  const { results } = await c.env.DB.prepare(TRACE_SQL).bind(traceId).all<AuditRowOut>()
  if (results.length === 0) {
    console.warn(JSON.stringify({ at: 'audit', outcome: 'not_found' }))
    throw new ApiError(404, 'not_found', 'There is no audit trace with this id.')
  }
  return c.json({ trace_id: traceId, rows: results })
})
