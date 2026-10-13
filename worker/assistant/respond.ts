// The typed result (design 03 §Gateway layers row 10; 04 §POST /api/assistant; 09 D-42).
// The model picks the shape in a final fenced json block (system-prompt.ts "Output"); the server
// supplies the data:
//   - the block is zod-validated; a missing or malformed block → `type: answer` with the model's
//     text and `partial: true` (D-42)
//   - `table.rows` are always the server-held rows of the last tool result, never model text
//   - a `segment` answer must name filters that a segment tool call of this request ran with;
//     its count is that call's count, which is the segment builder's (T-AI-3). Filters the
//     server never counted make the block malformed, so no count can be invented
//   - SQL never reaches the teammate (04, 14 §6 #6; T-AI-5): a text with any D-58 sign of SQL
//     (sqlSign below) is discarded whole and replaced by a server sentence built from the typed
//     result (discardSentence), belt and braces with the system-prompt rule. Nothing is stripped:
//     every stripping rule that tried to keep prose left a bypass (09 D-58)
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
  /** Why the result is partial, and which D-58 sign discarded the model text, for the caller's log and ai_audit row. */
  notes: { malformed: string | null; sqlDiscarded: SqlSign | null }
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

// The closing fence must start a line: a JSON string cannot hold a raw line break, so a ``` inside
// the block's own "text" value (an SQL fence the model quoted) cannot end the block early.
const JSON_FENCE = /```json[ \t]*\n([\s\S]*?)\n[ \t]*```/g

// T-AI-5 by rejection, not stripping (09 D-58). Every Unicode format character (\p{Cf}: U+00AD soft
// hyphen, U+200B-U+200D zero-width, U+2060 word joiner, U+FEFF and the rest) is invisible, so the
// signs are checked on several copies of the text and any one matching discards it:
//   - LISTED: D-58 as written. Only its six characters are deleted; every other format character
//     becomes a space (a separator either way, since a format character is not a letter or digit;
//     the space also lets a "```\u2063sql" fence match). Checked raw and NFKC-folded. The raw copy
//     makes the whole check a true superset of D-58: NFKC can turn a separator into letters
//     ("\u338F", the kg square, becomes "kg") and so glue it to a keyword.
//   - DELETED, NFKC: every format character removed, so an unlisted one inside a keyword cannot
//     split it ("sel\u2063ect").
//   - SPACED, NFKC: every format character turned into a space, so a listed one between a keyword
//     and the next word cannot glue them out of a whole-word match ("SELECT\u200Bemail").
// A word boundary is a letter or digit boundary, not \b, so "_" (markdown emphasis or an
// identifier) cannot hide a keyword: "_select_ email _from_ users" and "select_email from users"
// are discarded. Any one sign discards the whole text; there is no English exemption, so
// "select a segment from the builder" is discarded too (accepted by D-58). Wider than D-58's
// wording in the safe direction only: the LISTED raw copy is D-58 itself, and the other copies,
// NFKC, "_", and any non-letter prefix before a line-start SELECT (list markers, emphasis, digits
// as well as indentation, blockquote marks and backticks) can only add discards.
const LISTED_FORMAT_CHARS = /[\u00AD\u200B-\u200D\u2060\uFEFF]/gu
const FORMAT_CHARS = /\p{Cf}/gu
export type SqlSign = 'sql_fence' | 'select_line' | 'select_from'
const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}])'
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}])'
const SQL_SIGNS: ReadonlyArray<[SqlSign, RegExp]> = [
  // A ```sql or ~~~sql fence, any fence length, any case.
  ['sql_fence', new RegExp(`(?:\`{3,}|~{3,})[ \\t]*sql${NOT_WORD_AFTER}`, 'iu')],
  // A line whose first word is SELECT, after any characters that are not letters.
  ['select_line', new RegExp(`^[^\\p{L}\\r\\n]*select${NOT_WORD_AFTER}`, 'imu')],
  // The word select followed anywhere later, across lines, by the word from.
  ['select_from', new RegExp(`${NOT_WORD_BEFORE}select${NOT_WORD_AFTER}[\\s\\S]*${NOT_WORD_BEFORE}from${NOT_WORD_AFTER}`, 'iu')],
]

/** The first D-58 sign of SQL in `text`, or null. Pure; exported for tests. */
export function sqlSign(text: string): SqlSign | null {
  const listed = text.replace(LISTED_FORMAT_CHARS, '').replace(FORMAT_CHARS, ' ')
  const copies = [
    listed,
    listed.normalize('NFKC'),
    text.replace(FORMAT_CHARS, '').normalize('NFKC'),
    text.replace(FORMAT_CHARS, ' ').normalize('NFKC'),
  ]
  for (const [sign, pattern] of SQL_SIGNS) if (copies.some((copy) => pattern.test(copy))) return sign
  return null
}

/** The server's own sentence for a discarded text, built from the typed result (09 D-58). D-58 gives
 * "177 readers match." as an example; a count of 1 reads "1 reader matches." so the sentence stays
 * grammatical. A table result with no table gets the answer sentence (see respond()). */
export function discardSentence(type: OutputType, count: number | null): string {
  if (type === 'segment') {
    if (count === null) throw new Error('discardSentence: a segment result has a count')
    return count === 1 ? '1 reader matches.' : `${count} readers match.`
  }
  if (type === 'table') return 'Here is the table you asked for.'
  return "I couldn't phrase that answer safely — see Technical details for the steps."
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

/** The model's text, or the server sentence when it shows a sign of SQL (09 D-58). */
function screened(text: string, type: OutputType, count: number | null): { text: string; sqlDiscarded: SqlSign | null } {
  const sign = sqlSign(text)
  if (sign !== null) return { text: discardSentence(type, count), sqlDiscarded: sign }
  return { text: text.trim() === '' ? EMPTY_TEXT : text.trim(), sqlDiscarded: null }
}

export function respond(input: RespondInput): Responded {
  const last = input.outputs.at(-1)
  // A partial result is always type answer with no counted segment (09 D-42), so its discard
  // sentence is the answer one, even when the model meant a segment or table.
  const partialResult = (text: string, malformed: string): Responded => {
    const shown = screened(text.replace(JSON_FENCE, ' '), 'answer', null)
    return {
      result: {
        type: 'answer',
        text: shown.text,
        table: tableOf(last),
        segment: null,
        window: null,
        filters_applied: {},
        definitions_used: [],
        partial: true,
      },
      notes: { malformed, sqlDiscarded: shown.sqlDiscarded },
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

  const table = block.type === 'answer' ? null : tableOf(last)
  // "Here is the table you asked for." would be false with no table, so that case gets the answer sentence.
  const sentenceType: OutputType = block.type === 'table' && table === null ? 'answer' : block.type
  const shown = screened(block.text, sentenceType, segment?.count ?? null)
  return {
    result: {
      type: block.type,
      text: shown.text,
      table,
      segment,
      window: block.window,
      filters_applied: block.filters_applied,
      definitions_used: [...new Set(block.definitions_used)],
      partial: false,
    },
    notes: { malformed: null, sqlDiscarded: shown.sqlDiscarded },
  }
}
