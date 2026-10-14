// One assistant request, layer by layer (design 03 §Gateway layers rows 0-11 in that order; 07 §H;
// 04 §POST /api/assistant). Origin: palisade app/api/chat/route.ts POST L489-662 (14 §1.1, §4).
// worker/routes/assistant.ts reads the body and calls `answerQuestion`; this file holds the order:
//
//   0  per-session limit: 100 calls/hour (04 §Auth, 09 D-40), counted from ai_audit rows
//      because the Rate Limiting binding has no hour period (wrangler.jsonc). Approximate: two
//      requests racing at call 100 can both pass, as with the binding
//   2  Gate 1 (enforceGate1)                         → 400 invalid_question
//      ANTHROPIC_API_KEY present (the lazy check, 11 §Deploy) → 503 assistant_unavailable;
//      a key that Anthropic rejects is reported by the first call as 502 model_error
//   3  tool loading (tools/tool-loader.ts)           → 500 no_tools | tool_config_error
//   4  the view schema for the system prompt (schema-context.ts)
//   5-9, 11  the model loop (loop.ts): build, scan, call, audit, execute tools
//   10 respond.ts types the result and discards a model text that shows SQL (T-AI-5, 09 D-58);
//      the result is scanned once more; rehydrate.ts swaps pk_ keys for emails in the HTTP
//      response only (05 §Re-hydration)
//
// Every error in the 04 table is written to ai_audit under the request's trace (04 "Errors (also
// written to ai_audit)"): Gate 1, the scanner, the executor and the loop write their own rows;
// this file writes the rate-limit, missing-key and tool-loading rows, and the D-58 discard row
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

/** The ai_audit error of a D-58 discard; the sign (sql_fence, select_line, select_from) follows in brackets. */
export const SQL_DISCARD_ERROR = 'sql_in_output: model text discarded and replaced by the server sentence (09 D-58)'

/** 09 D-40. */
export const ASSISTANT_CALLS_PER_HOUR = 100

export interface AssistantDeps {
  db: D1Database
  /** ANTHROPIC_API_KEY; empty or absent → 503. Never logged. */
  apiKey: string | undefined
  /** Builds the model transport from the key (09 D-54): production passes anthropicTransport. */
  transportFor: (apiKey: string) => MessagesTransport
  /** The session's random `sub` (04 §Auth). */
  sessionSub: string
}

/** The 04 response body. */
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
   * Why "Pin to board" is refused for this answer, as one plain sentence (09 D-64a: free-form SQL
   * and board-only lookups are never pinned), or null; the answer card then offers no Pin.
   */
  pin_refusal: string | null
}

/** Assistant calls this session made in the last hour: distinct traces, not counting rate-limited ones. */
export async function callsInLastHour(db: D1Database, sessionSub: string): Promise<number> {
  // Wall clock: the per-session one-hour window over ai_audit.created_at (02 §Time allow-list; 09 D-40).
  const since = new Date(Date.now() - 3_600_000).toISOString()
  const n = await db
    .prepare(
      `SELECT count(DISTINCT trace_id) AS n FROM ai_audit
       WHERE session_sub = ? AND created_at >= ? AND (error IS NULL OR error NOT LIKE 'rate_limited%')`,
    )
    .bind(sessionSub, since)
    .first<number>('n')
  if (n === null) throw new Error('assistant: count(DISTINCT trace_id) returned no row')
  return n
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
  const trace = await startTrace(deps.db, deps.sessionSub)

  const calls = await callsInLastHour(deps.db, deps.sessionSub)
  if (calls >= ASSISTANT_CALLS_PER_HOUR) {
    throw await refuse(
      trace,
      new ApiError(429, 'rate_limited', `The assistant allows ${ASSISTANT_CALLS_PER_HOUR} questions per hour per session. Try again later.`),
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
  // Two calendar dates from the trace's own audit rows (09 D-64); nothing else is added.
  const { window, own_dates, refusal } = await pinPeriod(deps.db, trace.traceId)
  return {
    ...hydrated,
    audit_id: trace.traceId,
    pin_window: window === null ? null : { from: window.from, to: window.to },
    pin_own_dates: own_dates,
    pin_refusal: refusal,
  }
}
