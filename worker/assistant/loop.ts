// The model loop (design 03 §Gateway layers rows 5, 6, 11; 07 §H; 09 D-03, D-54). Origin:
// palisade app/api/chat/route.ts runAnthropic L242-358 (14 §1.2, §4 "adapt heavily"): a
// non-streaming messages.create in a loop of at most 5 tool iterations. Changes:
//   - the transport is a parameter (09 D-54): production passes `anthropicTransport`, the
//     official SDK against Anthropic's own URL (09 D-03, no AI Gateway in the MVP) with SDK retries
//     off (fail loud, no silent retries); tests pass a function returning a Messages-API-shaped
//     response written in the test file
//   - every request is built by the pure buildModelRequest and scanned with assertNoPII before
//     it is sent; every response is scanned before anything reads it (05 §Scanner)
//   - every model call writes an awaited ai_audit `model_request` row holding the exact
//     payload that was sent (03 row 11)
//   - after 5 tool rounds a further tool request is not run: the loop stops with `capped`
//     and respond.ts returns `partial: true` (04)
//   - one JSON response, no streaming (parked, 16)

import Anthropic from '@anthropic-ai/sdk'
import { ApiError } from '../auth/middleware'
import type { AuditTrace } from './audit/ai-audit'
import { buildModelRequest, type ToolRound } from './build-request'
import type { SanitizedQuestion } from './gates/gate1-input-sanitizer'
import { guardPayload } from './gates/pii-guard'
import type { ViewSchema } from './schema-context'
import type { ToolOutput } from './tools/builtin-handlers'
import { executeToolCall } from './tools/tool-executor'
import type { LoadedTools } from './tools/tool-loader'

/** 03 row 6. */
export const MAX_TOOL_ITERATIONS = 5

/** One Messages API call (09 D-54). */
export type MessagesTransport = (request: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>

/** Production transport: Anthropic's Messages API, called directly with ANTHROPIC_API_KEY (09 D-03). */
export function anthropicTransport(apiKey: string): MessagesTransport {
  const client = new Anthropic({ apiKey, maxRetries: 0 })
  return (request) => client.messages.create(request)
}

/** 502 model_error (04). The status and the provider's message are logged, never the key. */
export class ModelError extends ApiError {
  constructor() {
    super(502, 'model_error', 'The AI model could not be reached or returned an error. The failure has been logged; try again.')
    this.name = 'ModelError'
  }
}

export interface LoopInput {
  db: D1Database
  trace: AuditTrace
  views: readonly ViewSchema[]
  tools: LoadedTools
  question: SanitizedQuestion
  transport: MessagesTransport
}

export interface LoopResult {
  /** The text blocks of the last response, joined; null when the loop was capped. */
  finalText: string | null
  stopReason: Anthropic.StopReason | null
  /** Every tool result that ran, in call order (the last one feeds table.rows, 09 D-42). */
  outputs: ToolOutput[]
  /** The model asked for a sixth tool round (03 row 6). */
  capped: boolean
  modelCalls: number
}

/** The response blocks as request params, unchanged in content (thinking blocks must go back as they came). */
function toParams(content: readonly Anthropic.ContentBlock[]): Anthropic.ContentBlockParam[] {
  return content.map((block): Anthropic.ContentBlockParam => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text }
      case 'thinking':
        return { type: 'thinking', thinking: block.thinking, signature: block.signature }
      case 'redacted_thinking':
        return { type: 'redacted_thinking', data: block.data }
      case 'tool_use':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
      default:
        // The request declares no server tools, so no other block type can come back.
        throw new Error(`loop: unexpected response block type ${block.type}`)
    }
  })
}

function errorSummary(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.name} status=${err.status ?? 'none'}: ${err.message}`
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const rounds: ToolRound[] = []
  const outputs: ToolOutput[] = []
  for (let call = 1; ; call += 1) {
    const request = buildModelRequest({ views: input.views, tools: input.tools.definitions, question: input.question, rounds })
    await guardPayload(input.trace, request, 'model_request')

    const started = Date.now() // ai_audit.latency_ms, operational metadata (02 §Time)
    let response: Anthropic.Message
    try {
      response = await input.transport(request)
    } catch (err) {
      const reason = errorSummary(err)
      // The request passed the scanner, so nothing the provider echoes back can hold PII from us.
      console.error(JSON.stringify({ at: 'loop', trace_id: input.trace.traceId, error: 'model_error', call, reason }))
      await input.trace.write({
        kind: 'model_request',
        status: 'error',
        model: request.model,
        latency_ms: Date.now() - started,
        request_json: request,
        error: `model_error: ${reason}`,
      })
      throw new ModelError()
    }

    await guardPayload(input.trace, response.content, 'model_output')
    await input.trace.write({
      kind: 'model_request',
      status: 'success',
      model: response.model,
      latency_ms: Date.now() - started,
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
      request_json: request,
      response_json: { stop_reason: response.stop_reason, content: response.content },
    })

    const uses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
    if (response.stop_reason !== 'tool_use' || uses.length === 0) {
      const finalText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      return { finalText, stopReason: response.stop_reason, outputs, capped: false, modelCalls: call }
    }
    if (rounds.length >= MAX_TOOL_ITERATIONS) {
      console.warn(JSON.stringify({ at: 'loop', trace_id: input.trace.traceId, outcome: 'iteration_cap', rounds: rounds.length }))
      return { finalText: null, stopReason: response.stop_reason, outputs, capped: true, modelCalls: call }
    }

    // Tool calls of one response run in order; all their results go back in one user message.
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const use of uses) {
      const executed = await executeToolCall({ db: input.db, trace: input.trace, tools: input.tools }, use)
      results.push(executed.result)
      if (executed.output !== null) outputs.push(executed.output)
    }
    rounds.push({ assistant: toParams(response.content), results })
  }
}
