// Tool execution (design 03 §Gateway layers rows 7-9; 07 §H "execute … scan result"). Origin:
// palisade lib/chat/tool-executor.ts L46-132 (14 §2.3, §4 "adapt"): dispatch on handler_type to
// a static registry, a generic error to the model instead of a stack. Dispatch by handler_type
// (03 row 9): a `builtin` row runs the registry handler it names (builtin-handlers.ts); a `query`
// row runs its own SQL template over the v_* views with its param_mapping inputs bound as
// parameters, through Gate 2 and Gate 3 (queryHandler, 09 D-41); `passthrough` is parked and the
// loader refuses it. The loader resolves each row to its handler once (tool-loader.ts), so both
// types run through `tool.handler.run` below, with the same gates, scan and audit. Changes:
//   - every call passes Gate 2's authorizeToolCall first (gates/gate2-tool-authorizer.ts): a name
//     that is not a loaded tool is denied and audited as `blocked` with UNKNOWN_TOOL_ERROR; an
//     input that fails the row's input_schema is denied before any handler runs (09 D-24)
//   - a Gate 2 or Gate 3 refusal (GateDenied, from authorizeToolCall or from the SQL checks of
//     query_sql or a query row) goes back to the model once as an error result and is audited as `kind=blocked`
//     with `gate2_denied: …` / `gate3_denied: …` and, for SQL, the SQL as sent (03 row 11)
//   - every result is framed as untrusted data (format-results.ts) and scanned with
//     assertNoPII before it enters the conversation; a hit aborts the request (05 §Scanner)
//   - every call writes an awaited ai_audit row (03 row 11); query_sql and query-row calls carry the
//     SQL that ran
//   - input the handler rejects, or a query the database refuses, goes back to the model once as
//     an error result (is_error), so it can correct the call within the iteration cap; any other
//     failure (a D1 error outside Gate 3's run, a broken row) is audited and thrown: fail loud, no
//     silent retry (CLAUDE.md)
//   - every error text is scanned before it is logged, stored or sent, since it may quote what
//     the model wrote (05 §Scanner "logging")

import type Anthropic from '@anthropic-ai/sdk'
import type { AuditTrace } from '../audit/ai-audit'
import { authorizeToolCall } from '../gates/gate2-tool-authorizer'
import { GateDenied } from '../gates/gate3-readonly-sql'
import { guardPayload } from '../gates/pii-guard'
import { type ToolOutput, ToolInputError } from './builtin-handlers'
import { formatToolError, formatToolOutput } from './format-results'
import type { LoadedTool, LoadedTools } from './tool-loader'

/** The ai_audit error of a tool name the model invented; the loop goes on (worker/routes/audit.ts reads it). */
export const UNKNOWN_TOOL_ERROR = 'unknown_tool: the model called a tool that is not loaded'
/** The ai_audit error of a tool that threw; the request ends in a 500 (worker/routes/audit.ts reads it). */
export const TOOL_FAILED_ERROR = 'tool_failed'

/** True for the ai_audit error of a Gate 2/3 refusal; the loop goes on (worker/routes/audit.ts reads it). */
export function isGateDenialError(error: string | null): boolean {
  return error !== null && (error.startsWith('gate2_denied: ') || error.startsWith('gate3_denied: '))
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ExecutedCall {
  /** What goes back to the model, already framed and scanned. */
  result: Anthropic.ToolResultBlockParam
  /** The full result for the UI table; null when the call did not run. */
  output: ToolOutput | null
}

export interface ToolContext {
  db: D1Database
  trace: AuditTrace
  tools: LoadedTools
}

/** A Gate 2 or Gate 3 refusal: scanned, logged, audited as blocked, and sent to the model as an error. */
async function deny(ctx: ToolContext, call: ToolCall, tool: LoadedTool, denial: GateDenied, started: number): Promise<ExecutedCall> {
  const content = formatToolError(tool.name, denial.problems)
  await guardPayload(ctx.trace, content, 'tool_result', tool.name)
  console.warn(JSON.stringify({ at: 'tool-executor', trace_id: ctx.trace.traceId, tool_name: tool.name, outcome: `${denial.gate}_denied`, problems: denial.problems }))
  await ctx.trace.write({
    kind: 'blocked',
    status: 'blocked',
    tool_name: tool.name,
    latency_ms: Date.now() - started,
    request_json: call.input,
    response_json: content,
    sql: denial.sql,
    error: `${denial.gate}_denied: ${denial.problems.join('; ')}`,
  })
  return { result: { type: 'tool_result', tool_use_id: call.id, content, is_error: true }, output: null }
}

/** Runs one tool_use block and returns its tool_result. Throws on a PII hit or an unexpected failure. */
export async function executeToolCall(ctx: ToolContext, call: ToolCall): Promise<ExecutedCall> {
  const started = Date.now() // wall clock for ai_audit.latency_ms only (02 §Time allow-list)
  const authorization = authorizeToolCall(ctx.tools, call) // Gate 2 (03 row 7)
  if (!authorization.allowed && authorization.reason === 'unknown_tool') {
    // The name came from the model; it is neither logged nor stored, only that it was unknown.
    console.error(JSON.stringify({ at: 'tool-executor', trace_id: ctx.trace.traceId, error: 'unknown_tool' }))
    await ctx.trace.write({ kind: 'blocked', status: 'blocked', error: UNKNOWN_TOOL_ERROR })
    const content = formatToolError('unknown', ['there is no tool with that name; use only the tools provided'])
    return { result: { type: 'tool_result', tool_use_id: call.id, content, is_error: true }, output: null }
  }
  if (!authorization.allowed) {
    return deny(ctx, call, authorization.tool, new GateDenied('gate2', authorization.problems.map((p) => `input_schema: ${p}`)), started)
  }
  const { tool, input } = authorization

  let output: ToolOutput
  try {
    output = await tool.handler.run(ctx.db, input)
  } catch (err) {
    if (err instanceof GateDenied) return deny(ctx, call, tool, err, started)
    if (err instanceof ToolInputError) {
      const content = formatToolError(tool.name, err.problems)
      await guardPayload(ctx.trace, content, 'tool_result', tool.name)
      console.warn(JSON.stringify({ at: 'tool-executor', trace_id: ctx.trace.traceId, tool_name: tool.name, outcome: err.code, problems: err.problems }))
      await ctx.trace.write({
        kind: 'tool_call',
        status: 'error',
        tool_name: tool.name,
        latency_ms: Date.now() - started,
        request_json: call.input,
        response_json: content,
        sql: err.sql,
        error: `${err.code}: ${err.problems.join('; ')}`,
      })
      return { result: { type: 'tool_result', tool_use_id: call.id, content, is_error: true }, output: null }
    }
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error(JSON.stringify({ at: 'tool-executor', trace_id: ctx.trace.traceId, tool_name: tool.name, error: 'tool_failed', reason }))
    await ctx.trace.write({ kind: 'tool_call', status: 'error', tool_name: tool.name, latency_ms: Date.now() - started, error: TOOL_FAILED_ERROR })
    throw err
  }

  const content = formatToolOutput(output)
  // Both what the model reads and the full rows kept for the UI must be PII-free (05 §Scanner).
  await guardPayload(ctx.trace, { content, rows: output.rows }, 'tool_result', tool.name)
  await ctx.trace.write({
    kind: 'tool_call',
    status: 'success',
    tool_name: tool.name,
    latency_ms: Date.now() - started,
    request_json: call.input,
    response_json: content,
    sql: output.sql ?? null,
    row_count: output.total_rows,
  })
  return { result: { type: 'tool_result', tool_use_id: call.id, content }, output }
}
