// Gate 3, the read-only SQL floor (design 03 §Gateway layers row 8; 14 §3.5, §7 "gate3-readonly-sql.ts
// ← gateway/query-data.ts L45-136"). Origin: palisade query-data.ts: `^SELECT` only, a single
// statement, a forced LIMIT 100, the error string to the model. Changes (09 D-24):
//   - one attempt: a failed query goes back to the model once as a sanitized error, never the
//     origin's silent 3× retry
//   - `;` is refused anywhere outside a string, so even a trailing `;` is a second statement
//   - PRAGMA, ATTACH, DETACH and WITH are refused as words anywhere outside a string
//   - comments are refused: a `--` at the end would comment out the LIMIT this gate appends
//   - the LIMIT is an integer ≤ 100: a top-level `LIMIT n` is capped, a non-integer or negative
//     one (`LIMIT -1` means "no limit" in SQLite) is refused, and a query without one gets
//     `LIMIT 100` appended
//   - the D1 role/RLS floor of the origin has no SQLite equivalent; the floor here is this file
//     plus Gate 2's view allowlist (gate2-tool-authorizer.ts) over views that select no PII (01)
//
// This is the only path in the codebase that runs SQL text it did not write itself (CLAUDE.md
// "bound params everywhere except Gate 3"): the text comes from the model (query_sql) and is
// executed as given, after Gate 2 and these checks. Values are still bound when the caller has
// any (`?` markers, counted here).
//
// `lexSql` is shared with Gate 2 so both gates read the same tokens: strings, quoted names and
// comments are recognised once, here.

import type { SqlValue } from '../../ingest/sql'

/** The most rows one query may return (03 row 8). */
export const SQL_ROW_LIMIT = 100

export type SqlTokenKind = 'word' | 'number' | 'string' | 'quoted' | 'param' | 'punct' | 'comment'

export interface SqlToken {
  kind: SqlTokenKind
  /** The token's source text (a string keeps its quotes). */
  text: string
  /** Offsets into the SQL: text = sql.slice(start, end). */
  start: number
  end: number
  /** Parenthesis depth; a `(` and its `)` carry the depth outside them. */
  depth: number
}

/** SQL the lexer cannot read: an unterminated string, unbalanced parentheses, a stray character. */
export class SqlLexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SqlLexError'
  }
}

/**
 * A gate refused a tool call. Goes back to the model once as an error result and is audited as
 * `kind=blocked` naming the gate (03 row 11); the request goes on (tool-executor.ts).
 */
export class GateDenied extends Error {
  readonly gate: 'gate2' | 'gate3'
  readonly problems: readonly string[]
  /** The SQL as the model sent it, for ai_audit.sql; null when the call carried none. */
  readonly sql: string | null
  constructor(gate: 'gate2' | 'gate3', problems: readonly string[], sql: string | null = null) {
    super(`${gate} denied the tool call: ${problems.join('; ')}`)
    this.name = 'GateDenied'
    this.gate = gate
    this.problems = problems
    this.sql = sql
  }
}

/** The database refused a query that passed both gates. Sent to the model once, never retried. */
export class SqlRunError extends Error {
  /** The sanitized reason: the database's message without codes, prefixes or anything past the first line. */
  readonly reason: string
  readonly sql: string
  constructor(reason: string, sql: string) {
    super(`the query failed: ${reason}`)
    this.name = 'SqlRunError'
    this.reason = reason
    this.sql = sql
  }
}

const PUNCT = new Set(['(', ')', ',', '.', ';', '+', '-', '*', '/', '%', '<', '>', '=', '!', '|', '&', '~'])
const WORD = /[A-Za-z_][A-Za-z0-9_$]*/y
const NUMBER = /0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y

function sticky(pattern: RegExp, sql: string, at: number): string | null {
  pattern.lastIndex = at
  const match = pattern.exec(sql)
  return match === null ? null : match[0]
}

/** Splits SQL into tokens, skipping whitespace. Pure; throws SqlLexError. */
export function lexSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let depth = 0
  let i = 0
  const push = (kind: SqlTokenKind, start: number, end: number) => {
    tokens.push({ kind, text: sql.slice(start, end), start, end, depth })
  }
  while (i < sql.length) {
    const ch = sql[i]
    const start = i
    if (/\s/.test(ch)) {
      i += 1
    } else if (ch === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i)
      i = newline === -1 ? sql.length : newline
      push('comment', start, i)
    } else if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      if (close === -1) throw new SqlLexError('a /* comment is not closed')
      i = close + 2
      push('comment', start, i)
    } else if (ch === "'") {
      i += 1
      for (;;) {
        if (i >= sql.length) throw new SqlLexError('a string is not closed')
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      push('string', start, i)
    } else if (ch === '"' || ch === '`' || ch === '[') {
      const close = sql.indexOf(ch === '[' ? ']' : ch, i + 1)
      if (close === -1) throw new SqlLexError('a quoted name is not closed')
      i = close + 1
      push('quoted', start, i)
    } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      i += sticky(NUMBER, sql, i)!.length
      push('number', start, i)
    } else if (/[A-Za-z_]/.test(ch)) {
      i += sticky(WORD, sql, i)!.length
      push('word', start, i)
    } else if (ch === '?') {
      if (/[0-9]/.test(sql[i + 1] ?? '')) throw new SqlLexError('numbered parameters (?1) are not allowed')
      i += 1
      push('param', start, i)
    } else if (PUNCT.has(ch)) {
      i += 1
      if (ch === '(') {
        push('punct', start, i)
        depth += 1
      } else if (ch === ')') {
        depth -= 1
        if (depth < 0) throw new SqlLexError('a ")" has no matching "("')
        push('punct', start, i)
      } else {
        push('punct', start, i)
      }
    } else {
      throw new SqlLexError(`the character ${JSON.stringify(ch)} is not allowed outside a string`)
    }
  }
  if (depth !== 0) throw new SqlLexError('a "(" is not closed')
  return tokens
}

/** Statement words refused anywhere outside a string (03 row 8). */
const FORBIDDEN_WORDS = new Set(['PRAGMA', 'ATTACH', 'DETACH', 'WITH'])

const INTEGER = /^\d+$/

export interface ReadOnlySelect {
  /** The SQL that runs: the input with its top-level LIMIT capped, or `LIMIT 100` appended. */
  sql: string
  /** The row limit applied. */
  limit: number
}

/** The top-level LIMIT clause, rewritten with its count capped; problems when it is not integers. */
function forceLimit(sql: string, tokens: readonly SqlToken[], problems: string[]): ReadOnlySelect {
  let at = -1
  tokens.forEach((t, i) => {
    if (t.kind === 'word' && t.depth === 0 && t.text.toUpperCase() === 'LIMIT') at = i
  })
  if (at === -1) return { sql: `${sql.trimEnd()} LIMIT ${SQL_ROW_LIMIT}`, limit: SQL_ROW_LIMIT }

  const tail = tokens.slice(at + 1)
  const isInt = (t: SqlToken | undefined) => t !== undefined && t.kind === 'number' && INTEGER.test(t.text)
  let count: string | undefined
  let offset: string | undefined
  if (tail.length === 1 && isInt(tail[0])) {
    count = tail[0].text
  } else if (tail.length === 3 && isInt(tail[0]) && isInt(tail[2]) && tail[1].text.toUpperCase() === 'OFFSET') {
    count = tail[0].text
    offset = tail[2].text
  } else if (tail.length === 3 && isInt(tail[0]) && isInt(tail[2]) && tail[1].text === ',') {
    // SQLite's `LIMIT offset, count`
    offset = tail[0].text
    count = tail[2].text
  }
  if (count === undefined) {
    problems.push(`LIMIT must be a whole number up to ${SQL_ROW_LIMIT} (optionally with OFFSET and a whole number), at the end of the query`)
    return { sql, limit: SQL_ROW_LIMIT }
  }
  const limit = Math.min(Number(count), SQL_ROW_LIMIT)
  const clause = offset === undefined ? `LIMIT ${limit}` : `LIMIT ${limit} OFFSET ${offset}`
  return { sql: `${sql.slice(0, tokens[at].start)}${clause}`, limit }
}

/**
 * Gate 3's checks (03 row 8). Pure: returns the SQL to run with its LIMIT forced, or throws
 * GateDenied('gate3') listing every problem. `paramCount` is the number of values the caller
 * binds; the SQL must hold exactly that many `?` markers.
 */
export function readOnlySelect(sql: string, paramCount = 0): ReadOnlySelect {
  let tokens: SqlToken[]
  try {
    tokens = lexSql(sql)
  } catch (err) {
    if (err instanceof SqlLexError) throw new GateDenied('gate3', [err.message], sql)
    throw err
  }
  const problems: string[] = []
  if (!/^\s*SELECT\b/i.test(sql)) problems.push('the query must start with SELECT')
  if (tokens.some((t) => t.kind === 'punct' && t.text === ';')) problems.push('one statement only: ";" is not allowed outside a string')
  if (tokens.some((t) => t.kind === 'comment')) problems.push('comments are not allowed')
  const forbidden = [...new Set(tokens.filter((t) => t.kind === 'word' && FORBIDDEN_WORDS.has(t.text.toUpperCase())).map((t) => t.text.toUpperCase()))]
  for (const word of forbidden) problems.push(`${word} is not allowed`)
  const markers = tokens.filter((t) => t.kind === 'param').length
  if (markers !== paramCount) problems.push(`the query has ${markers} "?" marker(s) but ${paramCount} value(s) are bound`)
  const forced = forceLimit(sql, tokens, problems)
  if (problems.length > 0) throw new GateDenied('gate3', problems, sql)
  return forced
}

/** The database's message, fit for the model: first line, no D1/SQLite codes, at most 200 characters. */
export function sanitizeSqlError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const reason = (message.split('\n')[0] ?? '')
    .replace(/^(D1_[A-Z_]+:\s*)+/, '')
    .replace(/(:\s*SQLITE_[A-Z_]+)+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return reason === '' ? 'the database refused the query' : reason
}

export type SqlCell = string | number | null

export interface ReadOnlyResult {
  /** The SQL that ran (LIMIT forced), for ai_audit.sql. */
  sql: string
  limit: number
  columns: string[]
  rows: SqlCell[][]
}

/**
 * Runs one checked SELECT, once. Throws GateDenied('gate3') before running anything it refuses,
 * and SqlRunError (sanitized) when the database refuses the query; no retry.
 */
export async function runReadOnlySelect(db: D1Database, sql: string, params: readonly SqlValue[] = []): Promise<ReadOnlyResult> {
  const checked = readOnlySelect(sql, params.length)
  let raw: [string[], ...unknown[][]]
  try {
    raw = await db
      .prepare(checked.sql)
      .bind(...params)
      .raw<unknown[]>({ columnNames: true })
  } catch (err) {
    // Not logged here: the reason may quote the model's SQL, so the executor logs it after the PII scan.
    throw new SqlRunError(sanitizeSqlError(err), checked.sql)
  }
  const [columns, ...rows] = raw
  const cells = rows.map((row) =>
    row.map((value): SqlCell => {
      if (value === null || typeof value === 'string' || typeof value === 'number') return value
      throw new SqlRunError('the query returned a binary value; select text or numbers only', checked.sql)
    }),
  )
  return { sql: checked.sql, limit: checked.limit, columns, rows: cells }
}
