// The only builder of a model request (design 05 §Exactly what the model receives; 03 §Gateway
// layers row 4). Origin: palisade app/api/chat/route.ts L53-93 buildSystemPrompt and the request
// assembly in runAnthropic L242-358 (14 §7), extracted as one pure function (14 §4).
//
// Pure: no database, no clock, no randomness, no network. It takes typed inputs, never rows:
//   1. system  — rendered by system-prompt.ts from the view schema
//   2. messages — the Gate 1 question (a SanitizedQuestion, so raw text cannot be passed), then for
//      each tool round the model's own content blocks and the framed tool results of this request
//      (single-shot: no history, 09 D-34)
//   3. tools   — the enabled assistant_tools rows as Anthropic tool definitions (03 row 3)
// The caller scans the returned object with assertNoPII before it is sent (03 row 5).

import type Anthropic from '@anthropic-ai/sdk'
import type { SanitizedQuestion } from './gates/gate1-input-sanitizer'
import type { ViewSchema } from './schema-context'
import { renderSystemPrompt } from './system-prompt'

/** 09 D-03: Claude Opus 5.5, called directly. */
export const MODEL = 'claude-opus-5-5'

/**
 * 09 D-57 (amends D-45): the model's thinking counts against max_tokens, and 2,048 could cut an
 * answer short.
 */
export const MAX_TOKENS = 8192

// 09 D-57: no sampling parameter (temperature, top_p, top_k) and no forced tool_choice is sent,
// because Claude Opus 5.5 rejects each with a 400; tool_choice stays at its default (auto) and
// thinking at the model's default, which cannot be disabled. Determinism comes from the tools
// (fixed SQL, stored definitions), not from sampling.

/** One tool as sent to the model: an assistant_tools row's name, description and input_schema. */
export type ModelTool = Pick<Anthropic.Tool, 'name' | 'description' | 'input_schema'>

/**
 * One tool round of this request: the model's response content, sent back unchanged (it may
 * hold thinking blocks that must be returned as they came), and one result per tool_use block,
 * already framed as untrusted data by the tool executor (03 row 9).
 */
export interface ToolRound {
  assistant: readonly Anthropic.ContentBlockParam[]
  results: readonly Anthropic.ToolResultBlockParam[]
}

export interface ModelRequestInput {
  views: readonly ViewSchema[]
  tools: readonly ModelTool[]
  question: SanitizedQuestion
  rounds: readonly ToolRound[]
}

function checkRound(round: ToolRound, index: number): void {
  const used = round.assistant.filter((block) => block.type === 'tool_use').map((block) => block.id)
  if (used.length === 0) throw new Error(`build-request: tool round ${index} has no tool_use block`)
  const answered = round.results.map((result) => result.tool_use_id)
  const unanswered = used.filter((id) => !answered.includes(id))
  const unknown = answered.filter((id) => !used.includes(id))
  if (unanswered.length > 0 || unknown.length > 0 || answered.length !== new Set(answered).size) {
    throw new Error(`build-request: tool round ${index} must return exactly one result per tool_use block`)
  }
}

export function buildModelRequest(input: ModelRequestInput): Anthropic.MessageCreateParamsNonStreaming {
  if (input.tools.length === 0) throw new Error('build-request: no tools; the tool loader answers no_tools before this')
  const names = input.tools.map((tool) => tool.name)
  if (new Set(names).size !== names.length) throw new Error('build-request: two tools share a name')
  input.rounds.forEach(checkRound)

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: input.question.text }]
  for (const round of input.rounds) {
    messages.push({ role: 'assistant', content: [...round.assistant] })
    // All results of a round go back in one user message (parallel tool use).
    messages.push({ role: 'user', content: [...round.results] })
  }
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // 09 D-74 / design 20 §3 R1: the system prompt as one text block with an ephemeral cache
    // breakpoint, so tools + system (rendered before it, see module header) are served from
    // Anthropic's prompt cache on every call within the 5-minute TTL. The bytes the model reads
    // are unchanged (pii.test.ts "buildModelRequest is pure"); no marker on a tool (T-AI-1 pins
    // tools verbatim) and no top-level cache_control (it would land on the unique tail and pay a
    // write per call).
    system: [{ type: 'text', text: renderSystemPrompt(input.views), cache_control: { type: 'ephemeral' } }],
    tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
    messages,
  }
}
