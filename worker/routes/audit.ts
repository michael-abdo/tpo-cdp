// GET /api/audit?limit= and GET /api/audit/:trace_id (04 §GET /api/audit; 06 §/audit; 05 §Proof
// surfaces; R5.5). Mounted at /api by worker/index.ts, behind requireSession. Read-only over
// ai_audit (01), the rows worker/assistant/audit/ai-audit.ts wrote:
//   - the list: the latest assistant traces, newest first, one line each: when it started, the
//     redacted question as the model received it (messages[0] of the trace's first model_request
//     row; null when the request stopped before any model call, e.g. at Gate 1), how the request
//     ended (`outcome`, read from the trace's last row: see traceOutcome), the most severe row
//     status, the number of model and tool rows, and the tokens summed over the trace. Outcome and
//     status differ on purpose: a D-58 discard, an unknown tool, a Gate 2/3 refusal or an invalid
//     tool input writes a blocked or error row and the request still answers 200, so the worst row
//     is not the result
//   - one trace: every ai_audit row of the trace in write order, each field as stored. request_json
//     is the exact payload sent after the scanner (the writer refuses a row that fails the PII
//     scan), so nothing here can hold an email; the re-hydrated result is never stored (05
//     §Re-hydration). session_sub is not returned: the screen does not need it.
// Nothing is cached (03 §No-restart): a trace written a moment ago is in the next response.

import { Hono } from 'hono'
import { ApiError } from '../auth/middleware'
import { SQL_DISCARD_ERROR } from '../assistant/route'
import { isGateDenialError, TOOL_FAILED_ERROR, UNKNOWN_TOOL_ERROR } from '../assistant/tools/tool-executor'
import type { AppEnv } from '../env'

/** Traces the list returns when the request names no limit. */
export const AUDIT_DEFAULT_LIMIT = 20
/** Upper bound on the list's traces. */
export const AUDIT_MAX_LIMIT = 100

export type AuditStatus = 'success' | 'error' | 'blocked'

/**
 * How a request ended, from the last row its trace holds:
 *   answered                the last row is a successful model call: the request returned 200
 *                           (the iteration cap and a malformed block also end here, as partial)
 *   answered_text_replaced  the last row is the D-58 discard: 200 with the server sentence
 *   blocked                 the last row is a refusal that ended the request (Gate 1, rate limit,
 *                           missing key, tool loading, the PII scanner)
 *   failed                  the last row is a failed model call or a tool that threw: 502 or 500
 *   unfinished              the last row is a step the loop goes on from (a tool call, an unknown
 *                           tool, a Gate 2/3 refusal, an invalid tool input): the request is still running, or it
 *                           stopped on an error that wrote no row
 */
export type AuditOutcome = 'answered' | 'answered_text_replaced' | 'blocked' | 'failed' | 'unfinished'

/** One line of GET /api/audit. */
export interface AuditTraceSummary {
  trace_id: string
  /** created_at of the trace's first row (wall clock, UTC). */
  started_at: string
  /** The redacted question the model received; null when no model_request row was stored. */
  question: string | null
  /**
   * True when the question was sent to the AI: a model_request row exists, or the AI's reply was
   * blocked by the PII scanner before its row was written (loop.ts guards model_output first).
   */
  reached_ai: boolean
  /** How the request ended (traceOutcome). */
  outcome: AuditOutcome
  /** The most severe row status: blocked if any row is blocked, else error if any row is an error, else success. */
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

/** The fields of a trace's last row that decide its outcome. */
interface LastRow {
  last_kind: AuditRowOut['kind']
  last_status: AuditStatus
  last_error: string | null
}

/** How the request ended, from its trace's last row (AuditOutcome). */
export function traceOutcome({ last_kind: kind, last_status: status, last_error: error }: LastRow): AuditOutcome {
  // The discard row names its sign after the fixed text: "<SQL_DISCARD_ERROR> (select_line)".
  if (kind === 'blocked' && error !== null && error.startsWith(SQL_DISCARD_ERROR)) return 'answered_text_replaced'
  if (kind === 'model_request' && status === 'success') return 'answered'
  if (status === 'blocked') return error === UNKNOWN_TOOL_ERROR || isGateDenialError(error) ? 'unfinished' : 'blocked'
  if (status === 'error') return kind === 'model_request' || error === TOOL_FAILED_ERROR ? 'failed' : 'unfinished'
  return 'unfinished'
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
         (sum(kind = 'model_request') > 0
          OR sum(kind = 'blocked' AND error LIKE '% in model_output') > 0) AS reached_ai,
         sum(kind = 'tool_call') AS tool_calls,
         coalesce(sum(tokens_in), 0) AS tokens_in,
         coalesce(sum(tokens_out), 0) AS tokens_out
  FROM ai_audit
  GROUP BY trace_id
  ORDER BY started_at DESC, first_rowid DESC
  LIMIT ?
)
SELECT t.trace_id, t.started_at, t.status, t.reached_ai, t.model_calls, t.tool_calls, t.tokens_in, t.tokens_out,
       (SELECT CASE json_type(a.request_json, '$.messages[0].content')
                 WHEN 'text' THEN json_extract(a.request_json, '$.messages[0].content') END
        FROM ai_audit a
        WHERE a.trace_id = t.trace_id AND a.kind = 'model_request'
        ORDER BY a.created_at, a.rowid
        LIMIT 1) AS question,
       l.kind AS last_kind, l.status AS last_status, l.error AS last_error
FROM traces t
JOIN ai_audit l ON l.rowid = (SELECT a.rowid FROM ai_audit a WHERE a.trace_id = t.trace_id
                              ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1)
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
  const { results } = await c.env.DB.prepare(LIST_SQL)
    .bind(limit)
    .all<Omit<AuditTraceSummary, 'outcome' | 'reached_ai'> & { reached_ai: number } & LastRow>()
  const traces: AuditTraceSummary[] = results.map((r) => ({
    trace_id: r.trace_id,
    started_at: r.started_at,
    question: r.question,
    reached_ai: r.reached_ai === 1,
    outcome: traceOutcome(r),
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
