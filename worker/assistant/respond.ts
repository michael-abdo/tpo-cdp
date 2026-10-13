// The typed result (design 03 §Gateway layers row 10; 04 §POST /api/assistant; 09 D-42).
// The model picks the shape in a final fenced json block (system-prompt.ts "Output"); the server
// supplies the data:
//   - the block is zod-validated; a missing or malformed block → `type: answer` with the model's
//     text and `partial: true` (D-42)
//   - `table.rows` are always the server-held rows of the last tool result, never model text
//   - a `segment` answer must name filters that a segment tool call of this request ran with;
//     its count is that call's count, which is the segment builder's (T-AI-3). Filters the
//     server never counted make the block malformed, so no count can be invented
//   - SQL never reaches the teammate (04, 14 §6 #6): fenced code blocks and SQL statements are
//     cut from `text`, belt and braces with the system-prompt rule (T-AI-5)
//   - the iteration cap → `partial: true` with whatever table exists and a sentence saying so
//
// Pure: the model text and the request's tool outputs in, the result out. Re-hydration of pk_
// keys is a separate step (rehydrate.ts), after this and after the output scan.

import { z } from 'zod'
import { DEFINITIONS, type DefinitionKey } from '../../shared/derive'
import { ApiError } from '../auth/middleware'
import { isIsoDate } from '../ingest/quarantine'
import { parseFilters, type SegmentFilters } from '../segments/compile'
import { OUTPUT_TYPES } from './system-prompt'
import type { Cell, ResultRow, ToolOutput } from './tools/builtin-handlers'
import { MAX_TOOL_ITERATIONS } from './loop'

export type OutputType = (typeof OUTPUT_TYPES)[number]

export interface AssistantTable {
  columns: string[]
  rows: Record<string, Cell>[]
}

/** The 04 response body before re-hydration and without `audit_id`. */
export interface AssistantResult {
  type: OutputType
  text: string
  table: AssistantTable | null
  segment: { filters: SegmentFilters; count: number } | null
  window: { from: string; to: string } | null
  filters_applied: Record<string, unknown>
  definitions_used: DefinitionKey[]
  partial: boolean
}

export interface RespondInput {
  modelText: string | null
  outputs: readonly ToolOutput[]
  capped: boolean
}

export interface Responded {
  result: AssistantResult
  /** Why the result is partial or was cleaned, for the caller's log line. */
  notes: { malformed: string | null; sqlRemoved: boolean }
}

const DEFINITION_KEYS = Object.keys(DEFINITIONS) as [DefinitionKey, ...DefinitionKey[]]
const isoDate = z.string().refine(isIsoDate, 'must be YYYY-MM-DD')

/** The final json block (09 D-42). Unknown fields are dropped. */
export const FinalBlock = z
  .object({
    type: z.enum(OUTPUT_TYPES),
    text: z.string().trim().min(1),
    window: z.object({ from: isoDate, to: isoDate }).nullable(),
    filters_applied: z.record(z.string(), z.unknown()),
    definitions_used: z.array(z.enum(DEFINITION_KEYS)),
    segment: z.object({ filters: z.record(z.string(), z.unknown()) }).optional(),
  })
  .refine((block) => (block.type === 'segment') === (block.segment !== undefined), {
    message: 'segment is required exactly when type is "segment"',
  })

const FENCED = /```[^\n`]*\n?[\s\S]*?```/g
// The closing fence must start a line: a JSON string cannot hold a raw line break, so a ``` inside
// the block's own "text" value (an SQL fence the model quoted) cannot end the block early.
const JSON_FENCE = /```json[ \t]*\n([\s\S]*?)\n[ \t]*```/g
/** An upper-case SQL statement, or a lower-case one that reads a v_* view, up to `;` or the line end. */
const SQL_STATEMENTS = [/\b(?:SELECT|WITH)\b[^;\n]*?\bFROM\b[^;\n]*;?/g, /\bselect\b[^;\n]*?\bfrom\s+v_[a-z_]+[^;\n]*;?/gi]

/** `text` with fenced code blocks and SQL statements removed. Pure; exported for tests. */
export function removeSql(text: string): { text: string; removed: boolean } {
  let removed = false
  const cut = () => {
    removed = true
    return ' '
  }
  let out = text.replace(FENCED, cut)
  for (const pattern of SQL_STATEMENTS) out = out.replace(pattern, cut)
  if (!removed) return { text: text.trim(), removed }
  out = out
    .replace(/`\s*`/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:])/g, '$1')
    .trim()
  return { text: out, removed }
}

function lastJsonBlock(text: string): string | null {
  let last: string | null = null
  for (const match of text.matchAll(JSON_FENCE)) last = match[1]
  return last
}

/** Filters compared as sets: the order the model lists statuses or sources in does not matter. */
function filterKey(filters: SegmentFilters): string {
  return JSON.stringify({
    status: [...filters.status].sort(),
    source: filters.source === undefined ? null : [...filters.source].sort(),
    days_since_open_gte: filters.days_since_open_gte ?? null,
    include_never_opened: filters.include_never_opened,
    has_app: filters.has_app,
  })
}

function tableOf(output: ToolOutput | undefined): AssistantTable | null {
  if (output === undefined) return null
  return { columns: [...output.columns], rows: output.rows.map((row: ResultRow) => ({ ...row })) }
}

const CAPPED_TEXT = `The assistant reached its limit of ${MAX_TOOL_ITERATIONS} tool rounds before it finished, so this answer is incomplete.`
const EMPTY_TEXT = 'The assistant did not return a usable answer.'

export function respond(input: RespondInput): Responded {
  const last = input.outputs.at(-1)
  const partialResult = (text: string, malformed: string): Responded => {
    const cleaned = removeSql(text.replace(JSON_FENCE, ' '))
    return {
      result: {
        type: 'answer',
        text: cleaned.text === '' ? EMPTY_TEXT : cleaned.text,
        table: tableOf(last),
        segment: null,
        window: null,
        filters_applied: {},
        definitions_used: [],
        partial: true,
      },
      notes: { malformed, sqlRemoved: cleaned.removed },
    }
  }

  if (input.capped) {
    const prefix = input.modelText === null ? '' : `${input.modelText}\n`
    const capped = partialResult(prefix, 'iteration_cap')
    capped.result.text = capped.result.text === EMPTY_TEXT ? CAPPED_TEXT : `${capped.result.text} ${CAPPED_TEXT}`
    return capped
  }
  const text = input.modelText ?? ''
  const raw = lastJsonBlock(text)
  if (raw === null) return partialResult(text, 'no json block')

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return partialResult(text, `json block does not parse (${err instanceof Error ? err.name : 'unknown'})`)
  }
  const parsed = FinalBlock.safeParse(json)
  if (!parsed.success) {
    return partialResult(text, `json block invalid: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'block'} ${i.message}`).join('; ')}`)
  }
  const block = parsed.data

  let segment: AssistantResult['segment'] = null
  if (block.segment !== undefined) {
    let filters: SegmentFilters
    try {
      filters = parseFilters(block.segment.filters)
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      return partialResult(block.text, `segment filters invalid: ${(err.details ?? []).map(String).join('; ')}`)
    }
    const key = filterKey(filters)
    const counted = input.outputs.filter((o) => o.segment !== undefined && filterKey(o.segment.filters) === key).at(-1)
    if (counted?.segment === undefined) return partialResult(block.text, 'segment filters were never counted by the segment tool')
    segment = { filters: counted.segment.filters, count: counted.segment.count }
  }

  const cleaned = removeSql(block.text)
  return {
    result: {
      type: block.type,
      text: cleaned.text === '' ? EMPTY_TEXT : cleaned.text,
      table: block.type === 'answer' ? null : tableOf(last),
      segment,
      window: block.window,
      filters_applied: block.filters_applied,
      definitions_used: [...new Set(block.definitions_used)],
      partial: false,
    },
    notes: { malformed: null, sqlRemoved: cleaned.removed },
  }
}
