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
//     any form (multi-line, split by blank lines, indented, any case, any table, inline code) are
//     cut from `text`, belt and braces with the system-prompt rule (T-AI-5; removeSql below)
//   - the iteration cap → `partial: true` with whatever table exists and a sentence saying so
//
// Pure: the model text, the request's tool outputs and the database's relation names in, the
// result out. Re-hydration of pk_ keys is a separate step (rehydrate.ts), after this and after
// the output scan.

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
  /** Every table and view name in the database, for the T-AI-5 cut (removeSql). */
  relations: readonly string[]
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

const FENCED = /(`{3,})[^\n`]*\n?[\s\S]*?\1`*|(~{3,})[^\n~]*\n?[\s\S]*?\2~*/g
/** A fence that never closes: everything from it to the end of the text is code. */
const UNCLOSED_FENCE = /(?:```|~~~)[\s\S]*$/
// The closing fence must start a line: a JSON string cannot hold a raw line break, so a ``` inside
// the block's own "text" value (an SQL fence the model quoted) cannot end the block early.
const JSON_FENCE = /```json[ \t]*\n([\s\S]*?)\n[ \t]*```/g

// T-AI-5: no SELECT statement in any form. A statement is a standalone SELECT keyword followed,
// anywhere later in the text, by a FROM keyword. The search runs over the whole text, so neither a
// line break, a blank line, indentation nor case can split a statement from its FROM. Invisible
// characters (soft hyphen, zero-width) are dropped first, so they cannot split a keyword.
// A SELECT … FROM pair is SQL when any of these holds:
//   - either keyword is written in any case but plain lower case or one leading capital
//     ("SELECT", "sElEcT", "FrOm"): English never writes them that way
//   - the select list holds an SQL mark: `*()=;'"`, a backtick, an underscore, or a word.word
//   - FROM's object names a real table or view of this database (`relations`, read from
//     sqlite_master by the caller, so the schema keeps one home), directly or after a determiner
//     ("from subscribers.", "from the profiles"), in any case and whatever follows it
//   - FROM's object is a word only SQL writes (`_`, a digit or a dot: v_x, t1, s.email), an SQL
//     keyword or a bracket, or a plain word that the text does not continue as English: followed
//     (after at most one alias word) by the end of the text, a line break, `;`, `)` or a clause
//     keyword (WHERE, GROUP, ORDER, LIMIT, JOIN …)
// Otherwise the pair reads as English and is kept ("select subscribers from Instagram who …",
// "select readers from the builder"). A select list that ends a sentence ("Select a segment. Most
// came from …") is prose unless it holds a quote or `--`, where a ". X" could be SQL text; no
// select list in SQL holds a full stop followed by a space outside a string.
// A SELECT with no FROM is a statement too when it opens with `*` or a function call
// ("SELECT COUNT(*) AS n").
// A statement is cut from its SELECT (or a `WITH x AS (` before it) to its first `;` outside a
// quoted string, else to the end of its last line: the line holding FROM (or SELECT, with no FROM)
// and each following line that carries the statement on — one that opens with a clause keyword
// (in lower or leading-capital case only with an SQL mark in the line), or, with no blank line
// before it, any line holding an SQL mark. Over-cutting prose is the safe direction; every cut is
// logged (route.ts).
const INVISIBLE = /[­​-‍⁠﻿]/g
const SELECT_WORD = /\bselect\b/gi
const FROM_WORD = /\bfrom\b/gi
const SQL_LIST_MARK = /[*()=;'"`_]|\w\.\w/
/** A line that carries a statement on: an SQL list mark or a comparison. */
const SQL_LINE_MARK = /[*()=<>;'"`_]|\w\.\w/
/** Text that may hold SQL string literals or comments, where ". X" is not a sentence end. */
const LITERAL_MARK = /['"]|--/
const SENTENCE_END = /[.!?]\s+[A-Z]/
/** A SELECT that is a statement even with no FROM: its list opens with `*` or a function call. */
const SELECT_HEAD = /^\s*(?:\*|[A-Za-z_]\w*\s*\()/
const DETERMINER =
  /^(?:the|a|an|this|that|these|those|our|your|my|their|his|her|its|each|every|any|some|all|one)$/i
/** Words that, right after FROM's object, carry on an SQL statement rather than a sentence. */
const SQL_KEYWORD = /^(?:select|from|where|group|order|limit|offset|join|union|having|as|values)$/i
/** A word only SQL writes: an underscore, a digit, or a dot inside it (v_profiles, t1, s.email). */
const IDENTIFIER = /[_\d]|\w\.\w/
/** A line that goes on with the statement: optional list marker, then a clause keyword. */
const CLAUSE_START =
  /^(?:(?:[-*+>]|\d+[.)])[ \t]+)?(where|group|order|limit|offset|join|inner|left|right|outer|cross|on|using|union|having|and|or)\b/i
const LIST_MARKER = /^(?:[-*+>]|\d+[.)])[ \t]+/
const CTE_BEFORE = /\bwith\s+[a-z_][a-z0-9_]*\s+as\s*\(\s*$/i
const INLINE_CODE = /`[^`]*`|<code>[\s\S]*?<\/code>/gi
const MARKER_ONLY_LINE = /^[ \t]*(?:[-*+>]|\d+[.)])[ \t]*$/gm

/** Plain lower case or one leading capital: the only ways English writes "select" and "from". */
function isEnglishCase(word: string): boolean {
  const lower = word.toLowerCase()
  return word === lower || word === lower.charAt(0).toUpperCase() + lower.slice(1)
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
function fromObjectIsSql(text: string, at: number, relations: ReadonlySet<string>): boolean {
  const object = nextToken(text, at)
  if (object.token === null || !isWord(object.token)) return true
  const sqlWord = (token: string) => IDENTIFIER.test(token) || SQL_KEYWORD.test(token) || relations.has(token.toLowerCase())
  if (sqlWord(object.token)) return true
  if (DETERMINER.test(object.token)) {
    const noun = nextToken(text, object.end)
    return noun.token === null || !isWord(noun.token) || sqlWord(noun.token)
  }
  let after = nextToken(text, object.end)
  if (after.token !== null && isWord(after.token) && !after.newline && !SQL_KEYWORD.test(after.token)) {
    after = nextToken(text, after.end) // one alias word: "from subscribers s where"
  }
  return after.token === null || after.newline || after.token === ';' || after.token === ')' || SQL_KEYWORD.test(after.token)
}

/** Whether `line` carries a statement on; `afterBlank`: a blank line comes before it. */
function continuesStatement(line: string, afterBlank: boolean): boolean {
  const trimmed = line.trim()
  const clause = CLAUSE_START.exec(trimmed)
  if (clause !== null) return !isEnglishCase(clause[1]) || SQL_LINE_MARK.test(trimmed.replace(LIST_MARKER, ''))
  return !afterBlank && SQL_LINE_MARK.test(trimmed.replace(LIST_MARKER, ''))
}

/** The index of the line break that ends the line holding `at`, or the text's end. */
function lineEnd(text: string, at: number): number {
  const found = text.indexOf('\n', at)
  return found === -1 ? text.length : found
}

/** Where the statement whose last keyword (FROM, or SELECT with no FROM) starts at `at` ends (exclusive). */
function statementEnd(text: string, at: number): number {
  let end = lineEnd(text, at)
  for (;;) {
    let next = end + 1
    let afterBlank = false
    while (next < text.length && text.slice(next, lineEnd(text, next)).trim() === '') {
      afterBlank = true
      next = lineEnd(text, next) + 1
    }
    if (next >= text.length) break
    const nextEnd = lineEnd(text, next)
    if (!continuesStatement(text.slice(next, nextEnd), afterBlank)) break
    end = nextEnd
  }
  let quoted = false
  for (let i = at; i < end; i++) {
    if (text[i] === "'") quoted = !quoted
    else if (text[i] === ';' && !quoted) return i + 1
  }
  return end
}

/** The [start, end) span of a statement whose SELECT starts at `selectAt` and whose cut runs from `at`. */
function span(text: string, selectAt: number, at: number): [number, number] {
  const cte = CTE_BEFORE.exec(text.slice(0, selectAt))
  let start = cte === null ? selectAt : cte.index
  let end = statementEnd(text, at)
  // A statement split over adjacent inline spans takes their backticks with it.
  if (text[start - 1] === '`') start -= 1
  if (text[end] === '`') end += 1
  return [start, end]
}

/**
 * The first SELECT statement in `text`, as a [start, end) span, or null. `requireFrom`: count only
 * SELECT … FROM pairs (an inline code span alone may hold just the SELECT half of a statement).
 */
function findStatement(text: string, relations: ReadonlySet<string>, requireFrom: boolean): [number, number] | null {
  for (const select of text.matchAll(SELECT_WORD)) {
    const listStart = select.index + select[0].length
    for (const from of text.slice(listStart).matchAll(FROM_WORD)) {
      const fromAt = listStart + from.index
      const list = text.slice(listStart, fromAt)
      if (SENTENCE_END.test(list) && !LITERAL_MARK.test(list)) break
      const sure = !isEnglishCase(select[0]) || !isEnglishCase(from[0]) || SQL_LIST_MARK.test(list)
      if (!sure && !fromObjectIsSql(text, fromAt + from[0].length, relations)) continue
      return span(text, select.index, fromAt)
    }
    if (!requireFrom && SELECT_HEAD.test(text.slice(listStart))) return span(text, select.index, listStart)
  }
  return null
}

/** `text` with every SELECT statement in it cut out. */
function cutStatements(text: string, relations: ReadonlySet<string>): { text: string; removed: boolean } {
  let out = text
  let removed = false
  for (let found = findStatement(out, relations, false); found !== null; found = findStatement(out, relations, false)) {
    out = `${out.slice(0, found[0])} ${out.slice(found[1])}`
    removed = true
  }
  return { text: out, removed }
}

/** The code inside a `…` or <code>…</code> span. */
function codeOf(spanText: string): string {
  return spanText.startsWith('`') ? spanText.slice(1, -1) : spanText.slice('<code>'.length, -'</code>'.length)
}

/**
 * `text` with fenced code blocks and SQL statements removed. Pure; exported for tests.
 * `relations`: every table and view name in the database (route.ts reads them from sqlite_master).
 */
export function removeSql(text: string, relations: readonly string[]): { text: string; removed: boolean } {
  if (relations.length === 0) throw new Error('removeSql: no table or view names given; T-AI-5 needs the real relations')
  const known = new Set(relations.map((name) => name.toLowerCase()))
  const visible = text.replace(INVISIBLE, '')
  let removed = false
  const cut = () => {
    removed = true
    return ' '
  }
  let out = visible.replace(FENCED, cut).replace(UNCLOSED_FENCE, cut)
  // An inline code span is its own unit first: one holding a whole statement goes, its marks too.
  out = out.replace(INLINE_CODE, (code) => (findStatement(codeOf(code), known, true) === null ? code : cut()))
  const cleaned = cutStatements(out, known)
  if (cleaned.removed) removed = true
  if (!removed) return { text: visible.trim(), removed }
  out = cleaned.text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(MARKER_ONLY_LINE, '')
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
    const cleaned = removeSql(text.replace(JSON_FENCE, ' '), input.relations)
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

  const cleaned = removeSql(block.text, input.relations)
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
