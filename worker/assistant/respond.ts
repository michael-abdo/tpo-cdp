// The typed result (design 03 §Gateway layers row 10; 04 §POST /api/assistant; 09 D-42).
// The model picks the shape in a final fenced json block (system-prompt.ts "Output"); the server
// supplies the data:
//   - the block is zod-validated; a missing or malformed block → `type: answer` with the model's
//     text and `partial: true` (D-42)
//   - `table.rows` are always the server-held rows of the last tool result, never model text
//   - a `segment` answer must name filters that a segment tool call of this request ran with;
//     its count is that call's count, which is the segment builder's (T-AI-3). Filters the
//     server never counted make the block malformed, so no count can be invented
//   - SQL never reaches the teammate (04, 14 §6 #6): fenced code blocks and SELECT statements in
//     any form (multi-line, split by blank lines, indented, any case, inline code) are cut from
//     `text`, belt and braces with the system-prompt rule (T-AI-5; removeSql below)
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

const FENCED = /```[^\n`]*\n?[\s\S]*?```|~~~[^\n~]*\n?[\s\S]*?~~~/g
/** A fence that never closes: everything from it to the end of the text is code. */
const UNCLOSED_FENCE = /(?:```|~~~)[\s\S]*$/
// The closing fence must start a line: a JSON string cannot hold a raw line break, so a ``` inside
// the block's own "text" value (an SQL fence the model quoted) cannot end the block early.
const JSON_FENCE = /```json[ \t]*\n([\s\S]*?)\n[ \t]*```/g

// T-AI-5: no SELECT statement in any form. A statement is a standalone SELECT keyword followed,
// anywhere later in the text, by a FROM keyword. The search runs over the whole text, so neither a
// line break, a blank line, indentation nor case can split a statement from its FROM. A
// SELECT … FROM pair is kept as English only when all of these hold:
//   - neither keyword is written in capitals (an all-caps SELECT or FROM is always SQL)
//   - the select list holds no SQL mark: `*()=;'"`, a backtick, an underscore, or a word.word
//   - FROM's object reads as English: a determiner then a plain word ("from the builder"), or a
//     plain word that the text does not continue as SQL ("from Instagram who …", "from Instagram,
//     then …"). A word with `_`, `.` or a digit (v_profiles, s.email, t1), an SQL keyword, a
//     bracket, or a plain word followed (after at most one alias word) by the end of the text, a
//     line break, `;`, `)` or a clause keyword (WHERE, GROUP, ORDER, LIMIT, JOIN …) is SQL.
// A select list that ends a sentence ("Select a segment. Most came from …") is prose; the search
// for that SELECT stops there.
// A statement is cut from its SELECT (or a `WITH x AS (` before it) to its first `;` outside a
// quoted string, else to the end of the paragraph holding FROM, plus any following paragraphs that
// open with a clause keyword in capitals or carry SQL marks ("\n\n    WHERE source = 'x'").
// Over-cutting prose is the safe direction; every cut is logged (route.ts). Known residual: a
// lower-case statement whose words all read as English ("select email from subscribers." with a
// full stop, or "select pkey from the profiles") is kept, because no table name is known here.
const SELECT_WORD = /\bselect\b/gi
const FROM_WORD = /\bfrom\b/gi
const SQL_LIST_MARK = /[*()=;'"`_]|\w\.\w/
const SENTENCE_END = /[.!?]\s+[A-Z]/
const DETERMINER =
  /^(?:the|a|an|this|that|these|those|our|your|my|their|his|her|its|each|every|any|some|all|one)$/i
/** Words that, right after FROM's object, carry on an SQL statement rather than a sentence. */
const SQL_KEYWORD = /^(?:select|from|where|group|order|limit|offset|join|union|having|as|values)$/i
/** A word only SQL writes: an underscore, a digit, or a dot inside it (v_profiles, t1, s.email). */
const IDENTIFIER = /[_\d]|\w\.\w/
/** A paragraph that goes on with the statement: optional list marker, then a clause keyword. */
const CLAUSE_START = /^(?:(?:[-*+]|\d+[.)])[ \t]+)?(where|group|order|limit|offset|join|inner|left|right|outer|cross|union|having|and|or)\b/i
const CTE_BEFORE = /\bwith\s+[a-z_][a-z0-9_]*\s+as\s*\(\s*$/i
const INLINE_CODE = /`[^`]*`/g
const PARAGRAPH_BREAK = /\n[ \t]*\n\s*/g
const LIST_MARKER_LINE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]*$/gm

function isUpper(word: string): boolean {
  return word === word.toUpperCase()
}

function isWord(token: string): boolean {
  return /^[A-Za-z]/.test(token)
}

interface Token {
  /** A word (letters, digits, `_`, inner dots), one other character, or null at the end. */
  token: string | null
  end: number
  /** A line break came before the token. */
  newline: boolean
}

function nextToken(text: string, at: number): Token {
  const space = /\s*/y
  space.lastIndex = at
  space.exec(text)
  const word = /[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*|\S/y
  word.lastIndex = space.lastIndex
  const found = word.exec(text)
  return {
    token: found === null ? null : found[0],
    end: found === null ? text.length : word.lastIndex,
    newline: text.slice(at, space.lastIndex).includes('\n'),
  }
}

/** Whether what follows a FROM keyword (from `at`) is a table reference rather than English. */
function fromObjectIsSql(text: string, at: number): boolean {
  const object = nextToken(text, at)
  if (object.token === null || !isWord(object.token)) return true
  if (IDENTIFIER.test(object.token) || SQL_KEYWORD.test(object.token)) return true
  if (DETERMINER.test(object.token)) {
    const noun = nextToken(text, object.end)
    return noun.token === null || !isWord(noun.token) || IDENTIFIER.test(noun.token) || SQL_KEYWORD.test(noun.token)
  }
  let after = nextToken(text, object.end)
  if (after.token !== null && isWord(after.token) && !after.newline && !SQL_KEYWORD.test(after.token)) {
    after = nextToken(text, after.end) // one alias word: "from subscribers s where"
  }
  return after.token === null || after.newline || after.token === ';' || after.token === ')' || SQL_KEYWORD.test(after.token)
}

/** The end of the paragraph holding `at`: the index of the next blank line, or the text's end. */
function paragraphEnd(text: string, at: number): number {
  PARAGRAPH_BREAK.lastIndex = at
  const found = PARAGRAPH_BREAK.exec(text)
  return found === null ? text.length : found.index
}

/** Where the statement whose FROM keyword starts at `fromAt` ends (exclusive). */
function statementEnd(text: string, fromAt: number): number {
  let end = paragraphEnd(text, fromAt)
  for (;;) {
    PARAGRAPH_BREAK.lastIndex = end
    const brk = PARAGRAPH_BREAK.exec(text)
    if (brk === null || brk.index !== end) break
    const nextStart = brk.index + brk[0].length
    const nextEnd = paragraphEnd(text, nextStart)
    const paragraph = text.slice(nextStart, nextEnd)
    const clause = CLAUSE_START.exec(paragraph)
    if (clause === null || (!isUpper(clause[1]) && !SQL_LIST_MARK.test(paragraph))) break
    end = nextEnd
  }
  let quoted = false
  for (let i = fromAt; i < end; i++) {
    if (text[i] === "'") quoted = !quoted
    else if (text[i] === ';' && !quoted) return i + 1
  }
  return end
}

/** The first SELECT statement in `text`, as a [start, end) span, or null. */
function findStatement(text: string): [number, number] | null {
  for (const select of text.matchAll(SELECT_WORD)) {
    const listStart = select.index + select[0].length
    for (const from of text.slice(listStart).matchAll(FROM_WORD)) {
      const fromAt = listStart + from.index
      const list = text.slice(listStart, fromAt)
      const sure = isUpper(select[0]) || isUpper(from[0]) || SQL_LIST_MARK.test(list)
      if (!sure && SENTENCE_END.test(list)) break
      if (!sure && !fromObjectIsSql(text, fromAt + from[0].length)) continue
      const cte = CTE_BEFORE.exec(text.slice(0, select.index))
      let start = cte === null ? select.index : cte.index
      let end = statementEnd(text, fromAt)
      // A statement split over adjacent inline spans takes their backticks with it.
      if (text[start - 1] === '`') start -= 1
      if (text[end] === '`') end += 1
      return [start, end]
    }
  }
  return null
}

/** `text` with every SELECT statement in it cut out. */
function cutStatements(text: string): { text: string; removed: boolean } {
  let out = text
  let removed = false
  for (let span = findStatement(out); span !== null; span = findStatement(out)) {
    out = `${out.slice(0, span[0])} ${out.slice(span[1])}`
    removed = true
  }
  return { text: out, removed }
}

/** `text` with fenced code blocks and SQL statements removed. Pure; exported for tests. */
export function removeSql(text: string): { text: string; removed: boolean } {
  let removed = false
  const cut = () => {
    removed = true
    return ' '
  }
  let out = text.replace(FENCED, cut).replace(UNCLOSED_FENCE, cut)
  // An inline code span is its own unit first: one holding a whole statement goes, backticks too.
  out = out.replace(INLINE_CODE, (span) => (findStatement(span.slice(1, -1)) === null ? span : cut()))
  const cleaned = cutStatements(out)
  if (cleaned.removed) removed = true
  if (!removed) return { text: text.trim(), removed }
  out = cleaned.text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(LIST_MARKER_LINE, '')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
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
