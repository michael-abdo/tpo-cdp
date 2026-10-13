// Tool execution (design 03 §Gateway layers row 9; 07 §H "execute … scan result"). Origin:
// palisade lib/chat/tool-executor.ts L46-132 (14 §2.3, §4 "adapt"): dispatch on handler_type to
// a static registry, a generic error to the model instead of a stack. Changes:
//   - every result is framed as untrusted data (format-results.ts) and scanned with
//     assertNoPII before it enters the conversation; a hit aborts the request (05 §Scanner)
//   - every call writes an awaited ai_audit `tool_call` row (03 row 11)
//   - a name that is not a loaded tool is denied and audited as `blocked` (14 §4); the full
//     Gate 2 authorizer with server-side input_schema validation comes with query_sql (16, Friday).
//     Until then each builtin validates its own input and rejects anything it does not read.
//   - input the handler rejects goes back to the model once as an error result (is_error), so it
//     can correct the call within the iteration cap; any other failure (a D1 error, a broken
//     row) is audited and thrown: fail loud, no silent retry (CLAUDE.md)

import type Anthropic from '@anthropic-ai/sdk'
import type { AuditTrace } from '../audit/ai-audit'
import { guardPayload } from '../gates/pii-guard'
import { type ToolOutput, ToolInputError } from './builtin-handlers'
import { formatToolError, formatToolOutput } from './format-results'
import type { LoadedTools } from './tool-loader'

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

/** Runs one tool_use block and returns its tool_result. Throws on a PII hit or an unexpected failure. */
export async function executeToolCall(ctx: ToolContext, call: ToolCall): Promise<ExecutedCall> {
  const tool = ctx.tools.byName.get(call.name)
  if (tool === undefined) {
    // The name came from the model; it is neither logged nor stored, only that it was unknown.
    console.error(JSON.stringify({ at: 'tool-executor', trace_id: ctx.trace.traceId, error: 'unknown_tool' }))
    await ctx.trace.write({ kind: 'blocked', status: 'blocked', error: 'unknown_tool: the model called a tool that is not loaded' })
    const content = formatToolError('unknown', ['there is no tool with that name; use only the tools provided'])
    return { result: { type: 'tool_result', tool_use_id: call.id, content, is_error: true }, output: null }
  }

  const started = Date.now() // ai_audit.latency_ms is operational metadata (02 §Time: ai_audit timestamps)
  let output: ToolOutput
  try {
    if (typeof call.input !== 'object' || call.input === null || Array.isArray(call.input)) {
      throw new ToolInputError(['the tool input must be a JSON object'])
    }
    output = await tool.handler.run(ctx.db, call.input as Record<string, unknown>)
  } catch (err) {
    if (err instanceof ToolInputError) {
      const content = formatToolError(tool.name, err.problems)
      await guardPayload(ctx.trace, content, 'tool_result', tool.name)
      await ctx.trace.write({
        kind: 'tool_call',
        status: 'error',
        tool_name: tool.name,
        latency_ms: Date.now() - started,
        request_json: call.input,
        response_json: content,
        error: `invalid_input: ${err.problems.join('; ')}`,
      })
      return { result: { type: 'tool_result', tool_use_id: call.id, content, is_error: true }, output: null }
    }
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error(JSON.stringify({ at: 'tool-executor', trace_id: ctx.trace.traceId, tool_name: tool.name, error: 'tool_failed', reason }))
    await ctx.trace.write({ kind: 'tool_call', status: 'error', tool_name: tool.name, latency_ms: Date.now() - started, error: 'tool_failed' })
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
    row_count: output.total_rows,
  })
  return { result: { type: 'tool_result', tool_use_id: call.id, content }, output }
}
