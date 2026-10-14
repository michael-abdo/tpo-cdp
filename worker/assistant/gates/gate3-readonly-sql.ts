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
//
// Three limits on model-run SQL (09 D-81), all enforced inside `runReadOnlySelect` so every
// caller gets all three with no second copy: the `query_sql` and `query`-row builtin handlers
// (builtin-handlers.ts) both call it, and the insight board's re-runs and pins reach D1 only
// through those same handlers (board.ts → tool-executor.ts → builtin-handlers.ts). Fixed-SQL
// builtins (segment, aggregate, describe_schema) never call this function and are unaffected:
//   1. `checkPlan`: EXPLAIN QUERY PLAN on the already Gate-2/Gate-3-checked SQL, refused (nothing
//      else runs) when it shows a cartesian/unindexed nested scan — see `isTopLevelFullScan`'s
//      doc comment for the rule and how it was checked against every legitimate query.
//   2. a time limit (SQL_TIME_LIMIT_MS): the real run races a timer. D1 has no server-side
//      statement timeout, so losing the race only stops this Worker's wait for the query — D1
//      keeps running it to its own limits in the background (README "Known gaps").
//   3. a row-scan cap (SQL_ROWS_READ_CAP) read from D1's own `meta.rows_read`, checked after the
//      query returns (same gap: the cost is already paid by the time this refuses it).
// `timeoutMs`/`rowsReadCap` are parameters (default to the constants below) so a test can inject
// a tiny value against a real query, never by mocking D1.

import type { SqlValue } from '../../ingest/sql'

/** The most rows one query may return (03 row 8). */
export const SQL_ROW_LIMIT = 100

/** "about 3000 ms" (09 D-81 #2): one named constant, one home. */
export const SQL_TIME_LIMIT_MS = 3_000

/**
 * 10x the largest `meta.rows_read` D1 reported for any legitimate model-run SQL, measured against
 * the real seed (09 D-81 #3; one named constant, this comment is the measurement). Every query
 * below ran as `db.prepare(sql).run()` (D1's own `meta.rows_read`) with Gate 3's forced LIMIT 100
 * applied where the query had none, against the seeded D1 (data/*.csv):
 *   - the brief's "which pages do new subscribers hit first?" query row
 *     (`pages_new_subscribers_hit_first`, scripts/tool-seeds.ts): 19,468
 *   - the went-cold-Instagram-August pin SQL (WENT_COLD_AUGUST_SQL, test/insights-board.test.ts): 11,289
 *   - every query_sql probe test/gate2.test.ts actually runs ("query_sql through Gates 2 and 3",
 *     T-AI-2): subscribers by status 27,089; a pkey lookup 0; v_web_events by page 12,452;
 *     v_web_events ordered by event_ts with no WHERE 45,323 (the largest); profiles ordered by
 *     engagement_score 15,750; the pkey=pkey join (duplicate-column probe) 11,124
 *   - every grammar-pin SQL test/insights-board.test.ts actually runs: by source 25,395; by
 *     status 27,209 (two tests); by source/status/signup month 27,209 (two tests); row_number()
 *     27,226; Instagram active list 10,842; the LIMIT-3 list 10,277
 * Largest = 45,323 → cap = 453,230. Measured 2026-10-14; re-measure if the seed data changes size.
 */
export const SQL_ROWS_READ_CAP = 453_230

/** The plain sentence for a query that times out or reads too many rows (09 D-81 #2, #3). */
export const SQL_TOO_HEAVY_MESSAGE = 'This question is too heavy for the database to run directly; ask a narrower question.'

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

/**
 * A query that passed both gates and the plan check, but ran out the time limit or read more
 * rows than the cap (09 D-81 #2, #3). Distinct from SqlRunError (a genuine database failure) so
 * callers can log a distinguishable reason code; the model/UI message is the same plain sentence
 * either way (SQL_TOO_HEAVY_MESSAGE).
 */
export class SqlTooHeavyError extends Error {
  readonly reasonCode: 'sql_timeout' | 'sql_rows_cap'
  readonly sql: string
  constructor(reasonCode: SqlTooHeavyError['reasonCode'], sql: string) {
    super(SQL_TOO_HEAVY_MESSAGE)
    this.name = 'SqlTooHeavyError'
    this.reasonCode = reasonCode
    this.sql = sql
  }
}

/** Internal: the timer side of the race in runReadOnlySelect; never escapes this module. */
class SqlTimeoutError extends Error {}

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

/** One row of `EXPLAIN QUERY PLAN`'s result (SQLite's own shape; `id` is unused here). */
interface PlanRow {
  parent: number
  detail: string
}

/**
 * True for a plan row that is a full, unindexed scan of a real relation at the outer query's own
 * level (09 D-81 #1). `parent = 0` is EXPLAIN QUERY PLAN's own marker for "belongs to the outer
 * SELECT, not inside a nested thing": a view's internal joins (every v_* view here is a JOIN of
 * several tables) run under their own MATERIALIZE/CO-ROUTINE node, and so does every branch of a
 * UNION/INTERSECT/EXCEPT and every IN/EXISTS subquery — none of those ever carries `parent = 0`.
 * `SCAN` (as opposed to `SEARCH … (col=?)`) means SQLite visits every row of that relation with no
 * key from elsewhere narrowing it: the normal, single way a nested-loop join starts (one driving
 * SCAN, then every other relation reached by an indexed SEARCH on the join's own column) stays
 * at exactly one top-level SCAN; a second one means a second relation is driven independently,
 * with nothing searching it by a key the first relation supplies — a comma join or `JOIN … ON 1 =
 * 1` of two views, the cartesian the self-audit found, and the only way this codebase's own
 * query_sql/query-row SQL ever produces two.
 *
 * Checked live against the real seed (D1 EXPLAIN QUERY PLAN, 2026-10-14): every legitimate
 * query_sql/query-row SQL this repo runs (the brief's query row, every T-AI-2/"query_sql through
 * Gates 2 and 3" probe in test/gate2.test.ts including the real `v_profiles JOIN v_web_events ON
 * w.pkey = p.pkey`, every grammar-pin SQL test/insights-board.test.ts runs, a UNION of two
 * single-view counts, and a `pkey IN (SELECT … FROM v_web_events …)` subquery) shows at most one;
 * both `v_profiles p, v_web_events w` (comma join) and `v_profiles p JOIN v_web_events w ON 1 =
 * 1` show two, and ran a 151M-row, 23-second aggregate scan on this same small seed before Gate
 * 3's forced LIMIT could help (count(*) cannot short-circuit on a LIMIT) — the exact risk D-81
 * exists for.
 */
function isTopLevelFullScan(row: PlanRow): boolean {
  return row.parent === 0 && /^SCAN\b/.test(row.detail)
}

/**
 * EXPLAIN QUERY PLAN on the checked SQL (09 D-81 #1); throws GateDenied('gate3') before the real
 * query runs when it shows more than one top-level full scan (isTopLevelFullScan). A plan EXPLAIN
 * itself cannot produce (a genuine syntax or semantic error the lexer's own checks did not catch)
 * is not this function's problem: it returns normally and the real run below reports the same
 * failure it always has, sanitized, as SqlRunError — this function only ever adds a refusal, never
 * swallows one.
 */
async function checkPlan(db: D1Database, sql: string, params: readonly SqlValue[]): Promise<void> {
  let rows: PlanRow[]
  try {
    const result = await db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<PlanRow>()
    rows = result.results
  } catch {
    return
  }
  const scans = rows.filter(isTopLevelFullScan)
  if (scans.length > 1) {
    throw new GateDenied(
      'gate3',
      [
        `the query plan shows ${scans.length} unindexed table scans with nothing joining them (a cartesian/cross join): ${scans
          .map((s) => s.detail)
          .join('; ')}; add a join condition an index can use, or narrow the WHERE clause`,
      ],
      sql,
    )
  }
}

/**
 * Rejects `promise` with SqlTimeoutError after `ms` if it has not settled by then. `ms <= 0`
 * rejects immediately with no timer at all (there is nothing to wait for): the one way a test can
 * inject a timeout that reliably beats a real query without mocking D1, since a local D1 call
 * can resolve inside the same tick a `setTimeout(fn, 0)` is still queued behind. `promise` itself
 * is never cancelled either way (D1 has no cancel; it keeps running in the background, README
 * "Known gaps").
 */
async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) throw new SqlTimeoutError()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SqlTimeoutError()), ms)
  })
  try {
    return await Promise.race([promise, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Runs one checked SELECT, once. Throws GateDenied('gate3') before running anything it refuses
 * (readOnlySelect's own checks, then the plan check, 09 D-81 #1), SqlTooHeavyError when it times
 * out or reads too many rows (#2, #3), and SqlRunError (sanitized) when the database refuses the
 * query; no retry. `timeoutMs`/`rowsReadCap` default to SQL_TIME_LIMIT_MS/SQL_ROWS_READ_CAP and
 * exist as parameters only so a test can inject a tiny value against a real query.
 */
export async function runReadOnlySelect(
  db: D1Database,
  sql: string,
  params: readonly SqlValue[] = [],
  options: { timeoutMs?: number; rowsReadCap?: number } = {},
): Promise<ReadOnlyResult> {
  const checked = readOnlySelect(sql, params.length)
  await checkPlan(db, checked.sql, params)
  const timeoutMs = options.timeoutMs ?? SQL_TIME_LIMIT_MS
  const rowsReadCap = options.rowsReadCap ?? SQL_ROWS_READ_CAP

  let raw: [string[], ...unknown[][]]
  let rowsRead: number
  try {
    // D1's meta (rows_read, #3) is not on raw()'s return value (checked live: it is a plain
    // 2-element array with no extra property); only run()/all() carry it, but both collapse a
    // duplicate output column name to one key and, on a 0-row result, carry no column names at
    // all, which namedRows()'s own duplicate check and T-AI-2's "a query that matches nothing
    // still returns its columns" rely on. So the shaped data still comes from raw(), as before,
    // and the row-scan measurement is a second read off the *same* prepared, bound statement
    // (one db.prepare/bind call, as "one attempt" always meant here) via run() — the only way the
    // public D1 API gives both; the two terminal calls race the same timeout together, so this
    // costs an extra D1 read, not extra serial wait (README "Known gaps" notes the doubled read).
    const stmt = db.prepare(checked.sql).bind(...params)
    const [rawResult, metaResult] = await raceTimeout(Promise.all([stmt.raw<unknown[]>({ columnNames: true }), stmt.run()]), timeoutMs)
    raw = rawResult
    rowsRead = metaResult.meta.rows_read
  } catch (err) {
    if (err instanceof SqlTimeoutError) throw new SqlTooHeavyError('sql_timeout', checked.sql)
    // Not logged here: the reason may quote the model's SQL, so the executor logs it after the PII scan.
    throw new SqlRunError(sanitizeSqlError(err), checked.sql)
  }
  if (rowsRead > rowsReadCap) throw new SqlTooHeavyError('sql_rows_cap', checked.sql)

  const [columns, ...rows] = raw
  const cells = rows.map((row) =>
    row.map((value): SqlCell => {
      if (value === null || typeof value === 'string' || typeof value === 'number') return value
      throw new SqlRunError('the query returned a binary value; select text or numbers only', checked.sql)
    }),
  )
  return { sql: checked.sql, limit: checked.limit, columns, rows: cells }
}
