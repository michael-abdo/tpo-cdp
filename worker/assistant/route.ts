// One assistant request, layer by layer (POST /api/assistant).
// worker/routes/assistant.ts reads the body and calls `answerQuestion`; this file holds the order:
//
//   0  per-client burst limit: ASSISTANT_LIMITER, 10 a minute keyed by CF-Connecting-IP
//      (wrangler.jsonc); then the hourly limit: 100 calls/hour
//      for this session and, separately, for this client (ai_audit.client_key, a keyed hash of
//      CF-Connecting-IP, migrations/0005), so signing in again does not reset either.
//      Counted from ai_audit rows because the Rate Limiting binding has no hour period.
//      Approximate: two requests racing at call 100 can both pass, as with the binding
//   2  Gate 1 (enforceGate1)                         → 400 invalid_question
//      ANTHROPIC_API_KEY present (checked lazily, so the rest of the app runs without it) → 503 assistant_unavailable;
//      a key that Anthropic rejects is reported by the first call as 502 model_error
//   3  tool loading (tools/tool-loader.ts)           → 500 no_tools | tool_config_error
//   4  the view schema for the system prompt (schema-context.ts)
//   5-9, 11  the model loop (loop.ts): build, scan, call, audit, execute tools
//   10 respond.ts types the result and discards a model text that shows SQL (T-AI-5);
//      the result is scanned once more; rehydrate.ts swaps pk_ keys for emails in the HTTP
//      response only
//
// Every error this route can answer is written to ai_audit under the request's trace, so the
// audit log shows every refusal: Gate 1, the scanner, the executor and the loop write their own rows;
// this file writes the rate-limit, missing-key and tool-loading rows, and the SQL-text discard row
// (kind=blocked: the model's text was blocked from the teammate; the request still answers 200).

import { HOSTED_URL } from '../../shared/config'
import { ApiError } from '../auth/middleware'
import { pinPeriod } from '../insights/board'
import { type AuditTrace, startTrace } from './audit/ai-audit'
import { enforceGate1 } from './gates/gate1-input-sanitizer'
import { guardPayload } from './gates/pii-guard'
import { type MessagesTransport, runLoop } from './loop'
import { collectPkeys, loadEmailsByPkey, rehydrate } from './rehydrate'
import { type AssistantResult, respond } from './respond'
import { viewSchemas } from './schema-context'
import { loadTools, type LoadedTools } from './tools/tool-loader'

/** The ai_audit error of a discarded model text that showed SQL; the sign (sql_fence, select_line, select_from) follows in brackets. */
export const SQL_DISCARD_ERROR = 'sql_in_output: model text discarded and replaced by the server sentence (09 D-58)'

/** Per session and per client; high enough that a live demo never hits it. */
export const ASSISTANT_CALLS_PER_HOUR = 100

export interface AssistantDeps {
  db: D1Database
  /** ANTHROPIC_API_KEY; empty or absent → 503. Never logged. */
  apiKey: string | undefined
  /** Builds the model transport from the key: production passes anthropicTransport, tests their own. */
  transportFor: (apiKey: string) => MessagesTransport
  /** The session's random `sub`. */
  sessionSub: string
  /** ASSISTANT_LIMITER (wrangler.jsonc): the per-client limit a new session does not reset. */
  clientLimiter: RateLimit
  /** The client's CF-Connecting-IP, or 'local' where there is no edge (as the login limit): the ASSISTANT_LIMITER key. Never stored. */
  clientIp: string
  /** clientKeyHash(PII_KEY_SECRET, clientIp) (shared/pseudonym.ts): ai_audit.client_key, the hourly per-client count. */
  clientKey: string
}

/** The response body. */
export interface AssistantResponse extends AssistantResult {
  audit_id: string
  /**
   * The time period "Pin to board" would store for this answer, resolved on TODAY, or null when
   * its lookup has none (worker/insights/board.ts pinPeriod, the reading POST /api/insights does).
   */
  pin_window: { from: string; to: string } | null
  /**
   * The dates the pinned lookup sets itself when it takes no time period (a query row's built-in
   * window), or null; the tile shows the same dates in its footer (board.ts pinPeriod, ownDates).
   */
  pin_own_dates: { from: string; to: string } | null
  /**
   * Why "Pin to board" is refused for this answer, as one plain sentence (e.g. free-form SQL in a
   * shape the server cannot verify, or a board-only lookup), or null; the answer card then offers no Pin.
   */
  pin_refusal: string | null
}

/** Distinct traces in the last hour, not counting rate-limited ones, per session and per client. */
const CALLS_IN_LAST_HOUR_SQL = {
  session_sub: `SELECT count(DISTINCT trace_id) AS n FROM ai_audit
    WHERE session_sub = ? AND created_at >= ? AND (error IS NULL OR error NOT LIKE 'rate_limited%')`,
  client_key: `SELECT count(DISTINCT trace_id) AS n FROM ai_audit
    WHERE client_key = ? AND created_at >= ? AND (error IS NULL OR error NOT LIKE 'rate_limited%')`,
} as const

async function callsInLastHourBy(db: D1Database, column: keyof typeof CALLS_IN_LAST_HOUR_SQL, value: string): Promise<number> {
  // Wall clock: the one-hour window over ai_audit.created_at (bookkeeping, not a business date).
  const since = new Date(Date.now() - 3_600_000).toISOString()
  const n = await db
    .prepare(CALLS_IN_LAST_HOUR_SQL[column])
    .bind(value, since)
    .first<number>('n')
  if (n === null) throw new Error('assistant: count(DISTINCT trace_id) returned no row')
  return n
}

/**
 * Assistant calls in the last hour that count against this request: the larger of this
 * session's and this client's. Two counts, not one `OR`, so each uses its
 * own index (0003, 0005).
 */
export async function callsInLastHour(db: D1Database, sessionSub: string, clientKey: string): Promise<number> {
  const [bySession, byClient] = await Promise.all([
    callsInLastHourBy(db, 'session_sub', sessionSub),
    callsInLastHourBy(db, 'client_key', clientKey),
  ])
  return Math.max(bySession, byClient)
}

/** Logs, audits (awaited) and returns the error; the caller throws it. */
async function refuse(trace: AuditTrace, err: ApiError, detail: string): Promise<ApiError> {
  console.error(JSON.stringify({ at: 'assistant', trace_id: trace.traceId, error: err.code, detail }))
  await trace.write({ kind: 'blocked', status: 'blocked', error: `${err.code}: ${detail}` })
  return err
}

async function toolsOrRefuse(trace: AuditTrace, db: D1Database): Promise<LoadedTools> {
  try {
    return await loadTools(db)
  } catch (err) {
    if (err instanceof ApiError) throw await refuse(trace, err, err.message)
    throw err
  }
}

export async function answerQuestion(deps: AssistantDeps, question: string): Promise<AssistantResponse> {
  const trace = await startTrace(deps.db, deps.sessionSub, deps.clientKey)

  const { success } = await deps.clientLimiter.limit({ key: deps.clientIp })
  if (!success) {
    throw await refuse(
      trace,
      new ApiError(429, 'rate_limited', 'Too many assistant questions from this network in the last minute. Wait a minute and try again.'),
      'over the per-client limit (ASSISTANT_LIMITER)',
    )
  }

  const calls = await callsInLastHour(deps.db, deps.sessionSub, deps.clientKey)
  if (calls >= ASSISTANT_CALLS_PER_HOUR) {
    throw await refuse(
      trace,
      new ApiError(429, 'rate_limited', `The assistant allows ${ASSISTANT_CALLS_PER_HOUR} questions per hour per session and per network. Try again later.`),
      `${calls} calls in the last hour`,
    )
  }

  const sanitized = await enforceGate1(trace, question)

  const apiKey = deps.apiKey
  if (apiKey === undefined || apiKey === '') {
    throw await refuse(
      trace,
      new ApiError(503, 'assistant_unavailable', `The assistant is not configured here: ANTHROPIC_API_KEY is missing. Use the hosted app at ${HOSTED_URL}.`),
      'ANTHROPIC_API_KEY missing',
    )
  }

  const tools = await toolsOrRefuse(trace, deps.db)
  const views = await viewSchemas(deps.db)
  const loop = await runLoop({ db: deps.db, trace, views, tools, question: sanitized, transport: deps.transportFor(apiKey) })

  const { result, notes } = respond({ modelText: loop.finalText, outputs: loop.outputs, capped: loop.capped })
  if (notes.malformed !== null || notes.sqlDiscarded !== null) {
    console.warn(
      JSON.stringify({ at: 'respond', trace_id: trace.traceId, outcome: 'partial_or_discarded', malformed: notes.malformed, sql_discarded: notes.sqlDiscarded, stop_reason: loop.stopReason }),
    )
  }
  if (notes.sqlDiscarded !== null) {
    // Names the sign only, never the discarded text (it is unscanned model output).
    await trace.write({ kind: 'blocked', status: 'blocked', error: `${SQL_DISCARD_ERROR} (${notes.sqlDiscarded})` })
  }
  // The typed result is built from scanned parts; it is scanned whole before anything is added to it.
  await guardPayload(trace, result, 'model_output')

  const hydrated = rehydrate(result, await loadEmailsByPkey(deps.db, collectPkeys(result)))
  // Two calendar dates from the trace's own audit rows; nothing else is added.
  const { window, own_dates, refusal } = await pinPeriod(deps.db, trace.traceId)
  return {
    ...hydrated,
    audit_id: trace.traceId,
    pin_window: window === null ? null : { from: window.from, to: window.to },
    pin_own_dates: own_dates,
    pin_refusal: refusal,
  }
}
