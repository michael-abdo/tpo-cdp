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
//      else runs) when it shows a cartesian/unindexed nested scan, at any nesting level; an
//      EXPLAIN that itself fails is logged (`plan_check_unavailable`), never swallowed silently,
//      and lets the real run report its own failure normally — see `cartesianScans`' doc comment
//      for the scan rule and how it was checked against every legitimate query.
//   2. a time limit (SQL_TIME_LIMIT_MS): the real run races a timer. D1 has no server-side
//      statement timeout, so losing the race only stops this Worker's wait for the query — D1
//      keeps running it to its own limits in the background (docs/notes.md "Known gaps").
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

/** The timer side of the race in runReadOnlySelect; exported only so a test can race it directly against a real pending promise (09 D-81 #2), never thrown past raceTimeout itself. */
export class SqlTimeoutError extends Error {}

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

/** Words that end a FROM clause at its own depth. */
const FROM_CLAUSE_END = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'WINDOW', 'UNION', 'INTERSECT', 'EXCEPT'])

/**
 * The join-shape rule (09 D-81 #1, live finding 2026-10-14): two views may be read together only
 * through an explicit `JOIN … ON a.col = b.col` (or `USING (col)`). A comma list, a JOIN with no
 * ON/USING (so `CROSS JOIN` and `NATURAL JOIN` too), or an ON with no column equality between two
 * different views is refused before anything runs. The plan check cannot catch every cross join (a filter on
 * one side turns its scan into an indexed search), and a timed-out D1 query is never cancelled: on
 * the live database `SELECT COUNT(*) FROM v_profiles, v_web_events WHERE v_profiles.status =
 * 'active'` ran past D1's own CPU limit and reset the database. Pure; checked at every depth.
 */
function joinShapeProblems(tokens: readonly SqlToken[]): string[] {
  const problems = new Set<string>()
  const word = (t: SqlToken | undefined) => (t !== undefined && t.kind === 'word' ? t.text.toUpperCase() : '')
  tokens.forEach((from, at) => {
    if (word(from) !== 'FROM') return
    const depth = from.depth
    let end = tokens.length
    let open = 0 // "(" … ")" opened inside this clause (they carry this clause's depth)
    for (let i = at + 1; i < tokens.length; i += 1) {
      const t = tokens[i]
      if (t.depth === depth && t.kind === 'punct' && t.text === '(') open += 1
      else if (t.depth === depth && t.kind === 'punct' && t.text === ')') {
        if (open === 0) { end = i; break }
        open -= 1
      } else if (t.depth < depth) { end = i; break }
      else if (t.depth === depth && FROM_CLAUSE_END.has(word(t))) { end = i; break }
    }
    const clause = tokens.slice(at + 1, end).filter((t) => t.depth === depth)
    if (clause.some((t) => t.kind === 'punct' && t.text === ',')) {
      problems.add('read two views together only with JOIN … ON a.column = b.column, never a comma list (a cross join)')
    }
    clause.forEach((t, i) => {
      if (word(t) !== 'JOIN') return
      let next = clause.length
      for (let j = i + 1; j < clause.length; j += 1) if (word(clause[j]) === 'JOIN') { next = j; break }
      const condition = clause.slice(i + 1, next)
      const kind = condition.find((c) => word(c) === 'ON' || word(c) === 'USING')
      if (kind === undefined) { problems.add('every JOIN needs ON a.column = b.column or USING (column)'); return }
      if (word(kind) === 'USING') return
      const onAt = tokens.indexOf(kind)
      const onEnd = next < clause.length ? tokens.indexOf(clause[next]) : end
      const on = tokens.slice(onAt + 1, onEnd)
      // The ON's top-level AND-parts; at least one must be exactly `a.col = b.col` between two
      // different views. An OR at the top level or around that equality (`ON p.pkey = w.pkey OR
      // 1 = 1`, the self-audit's 2026-10-14 probe) leaves no such part, so it is refused here,
      // not only by the plan check. An OR inside a separate filter part stays allowed.
      const conjuncts: SqlToken[][] = [[]]
      for (const c of on) {
        if (c.depth === kind.depth && word(c) === 'AND') conjuncts.push([])
        else conjuncts[conjuncts.length - 1]!.push(c)
      }
      const isColumnEquality = (part: readonly SqlToken[]) => {
        let x = part
        while (x.length >= 2 && x[0]!.text === '(' && x[x.length - 1]!.text === ')') x = x.slice(1, -1)
        if (x.length !== 7) return false
        const [a, d1, c1, eq, b, d2, c2] = x
        return (
          a!.kind === 'word' && d1!.text === '.' && c1!.kind === 'word' && eq!.text === '=' &&
          b!.kind === 'word' && d2!.text === '.' && c2!.kind === 'word' && a!.text.toUpperCase() !== b!.text.toUpperCase()
        )
      }
      if (!conjuncts.some(isColumnEquality)) {
        problems.add('a JOIN must link the two views on a column equality joined with AND (never OR), e.g. ON p.pkey = w.pkey')
      }
    })
  })
  return [...problems]
}

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
  problems.push(...joinShapeProblems(tokens))
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

/** One row of `EXPLAIN QUERY PLAN`'s result (SQLite's own shape; `id` is the row's own plan-node id). */
interface PlanRow {
  id: number
  parent: number
  detail: string
}

/** `SCAN CONSTANT ROW` never reads a real relation (a UNION branch's literal row, 09 D-81 #1). */
const SCAN_CONSTANT_ROW = 'SCAN CONSTANT ROW'

/** True for a plan row that scans a real relation: `SCAN …` but not the constant-row placeholder. */
function isRealScan(row: PlanRow): boolean {
  return /^SCAN\b/.test(row.detail) && row.detail !== SCAN_CONSTANT_ROW
}

/** The constraint list inside a SEARCH/SCAN row's one parenthesized detail, when it has one. */
const SEARCH_CONSTRAINT = /\(([^()]*)\)/
/** One ANDed constraint that bounds, never pins, a column: `col>?` or `col<?` (SQLite prints `>=`/`<=` the same way). */
const RANGE_CONDITION = /^[\w.]+\s*[<>]\?$/

/**
 * True for a `SEARCH` row whose entire constraint list is range-only: every condition inside its
 * one parenthesized detail bounds a column with `<`/`>` against `?`, never pins one with `=`
 * (09 D-81 #1's self-audit: a cartesian with one indexed range filter added — `w.page > ''`,
 * `w.page >= ''`, a `CROSS JOIN … WHERE` with the same filter, or a correlated subquery's own
 * unindexed-looking column reached only by a range bound — answers with a `SEARCH` instead of a
 * `SCAN` on that side, so the plan check's SCAN-only rule missed it even though a range-bound
 * index walk over an otherwise-unjoined relation pays almost the same full cost). A constraint
 * list holding even one `=?` term — alone (`page=?`, a constant equality filter) or mixed with a
 * range one (`email_norm=? AND created_at>?`, the shape a real equality-joined or
 * equality-correlated relation shows, e.g. `v_source_app_conversion`'s own correlated subquery) —
 * is never range-only, so neither shape is flagged: the constant-equality one is a known,
 * disclosed gap (docs/notes.md "Known gaps"), and the equality-joined/correlated one is the cheap,
 * legitimate indexed access this check must not refuse.
 */
function isRangeOnlySearch(row: PlanRow): boolean {
  if (!/^SEARCH\b/.test(row.detail)) return false
  const constraint = SEARCH_CONSTRAINT.exec(row.detail)
  if (constraint === null) return false
  const conditions = constraint[1].split(/\s+AND\s+/)
  return conditions.length > 0 && conditions.every((c) => RANGE_CONDITION.test(c.trim()))
}

/** A plan row this check treats as paying for a whole, otherwise-unjoined relation (09 D-81 #1): a real SCAN or a range-only SEARCH. */
function isUnjoinedRelationScan(row: PlanRow): boolean {
  return isRealScan(row) || isRangeOnlySearch(row)
}

/**
 * True when `row`'s own plan scope — walking its `parent` chain up through EXPLAIN QUERY PLAN's
 * own tree — sits inside a `CORRELATED …` node (09 D-81 #1, the self-audit's case A: a scalar
 * subquery run once per outer row). `seen` guards a cycle EXPLAIN never actually produces; it
 * only keeps this loop from looping forever if one somehow did.
 */
function hasCorrelatedAncestor(row: PlanRow, byId: ReadonlyMap<number, PlanRow>): boolean {
  const seen = new Set<number>()
  let parentId = row.parent
  while (parentId !== 0 && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (parent === undefined) return false
    if (/^CORRELATED\b/.test(parent.detail)) return true
    parentId = parent.parent
  }
  return false
}

/**
 * The plan rows that make this SQL a cartesian/unindexed-nested-scan refusal (09 D-81 #1), or an
 * empty array when none do. Two shapes, both found live against the real seed (D1 EXPLAIN QUERY
 * PLAN, 2026-10-14) and both missed by an earlier version of this function that only ever looked
 * at `parent = 0`. Each `v_*` view's own main join is flattened into the scope that uses it, so
 * its base tables appear at that scope's own `parent = 0`, not nested under it: `v_profiles`
 * alone puts `SCAN p` plus several SEARCHes (`s`, `abe`, `stub_au`, `fv`) directly at `parent = 0`,
 * and only its two CTEs (`app_by_email`, `first_visit`) sit under their own MATERIALIZE id;
 * `v_web_events` is fully flattened too — `SCAN we`, `SEARCH wv`, `SEARCH p`, all at `parent = 0`.
 * So "more than one SCAN at parent = 0" was both too strict in spirit (a real join already shows
 * one driving SCAN there, with every other relation reached by an indexed SEARCH) and, for a
 * cartesian moved one level down (into a UNION branch or a FROM/IN/scalar subquery), not strict
 * enough: that shape leaves exactly one SCAN at `parent = 0` and puts a second one under some
 * other, non-zero parent, which the old rule never looked at):
 *   1. Two or more rows that each pay for a whole, otherwise-unjoined relation (`isUnjoinedRelationScan`:
 *      a real SCAN, or a SEARCH whose constraint is range-only) sharing one immediate parent
 *      scope — a comma join or `JOIN … ON 1 = 1` of two views, wherever it sits: at the outer
 *      query's own level, inside a UNION branch, inside a `FROM (SELECT …)`, inside `IN (SELECT
 *      …)`, or inside a scalar `(SELECT …)` — and whether each side shows as a plain SCAN or as a
 *      SEARCH an added indexed range filter (`w.page > ''`, `w.page >= ''`, a `CROSS JOIN …
 *      WHERE` with the same filter) turns it into: one token's difference from the comma/`ON 1 =
 *      1` shape, measured to pass the SCAN-only version of this check while still reading
 *      hundreds of millions of rows (09 D-81 #1's self-audit). A normal nested-loop join (one
 *      driving SCAN, every other relation reached by an indexed SEARCH *on the join's own
 *      column*) only ever puts one such row in any one scope; a second one there means a second
 *      relation is driven independently with nothing joining it to the first.
 *   2. A full scan of a real relation, or a range-only SEARCH, whose enclosing scope is a
 *      `CORRELATED …` subquery: run once per outer row, the same cost as a cartesian even though
 *      it is only ever one such row in its own scope.
 * Checked live against every legitimate query_sql/query-row SQL this repo runs (the brief's query
 * row, every grammar-pin SQL test/insights-board.test.ts runs, every T-AI-2/"query_sql through
 * Gates 2 and 3" probe in test/gate2.test.ts including the real `v_profiles JOIN v_web_events ON
 * w.pkey = p.pkey`, a UNION of two single-view counts, a `pkey IN (SELECT … FROM v_app_events)`
 * subquery, a `FROM (SELECT … FROM v_funnel)` subquery, the row_number() grammar-pin SQL, and
 * `v_source_app_conversion`'s own CORRELATED SCALAR SUBQUERY, which reaches its relation by an
 * equality-constrained SEARCH, never a SCAN and never a range-only one): none is refused. A
 * comma/`ON 1 = 1` cartesian of two views is refused the same way wherever it is nested (a UNION
 * branch, a FROM/IN/scalar subquery), and a correlated scalar subquery that scans its relation
 * (`SELECT p.pkey, (SELECT count(*) FROM v_web_events w WHERE w.utm_source = p.source) FROM
 * v_profiles p`, which read 1,096,962 rows before the self-audit's forced-run measurement) is
 * refused by rule 2, as is the same shape with an indexed range bound instead of an unindexed
 * equality one (`WHERE w.page >= p.first_page`, a `SEARCH … (page>?)` under a `CORRELATED SCALAR
 * SUBQUERY` node, read 28,891,129 rows and was not flagged before this rule covered SEARCH too).
 * A cartesian with one side filtered by a *constant equality* (`w.page = '/'`) is not caught by
 * either rule — see "Known, accepted gaps" below.
 *
 * Known, accepted gaps this still misses (docs/notes.md "Known gaps"): a low-cardinality equi-join
 * SQLite answers with `SEARCH … USING AUTOMATIC COVERING INDEX` instead of a second SCAN; and a
 * cartesian where one side's own driving access becomes an indexed SEARCH on a *constant
 * equality* filter (`w.page = '/'`, `SEARCH we USING INDEX web_events_page (page=?)`) instead of
 * a SCAN — `isRangeOnlySearch` deliberately excludes any `=?` term so it does not also refuse a
 * genuine equality join or equality-correlated subquery, and that same exclusion is why this one
 * constant-filter shape still passes uncaught. Both are still capped only by the after-the-fact
 * row-scan cap (#3). This also refuses one legitimate pattern no query here uses: a share-of-total
 * comma join against a scalar subquery total (`FROM v_profiles p, (SELECT count(*) FROM
 * v_profiles) t`), which plans as two top-level SCANs; it is over-refusal, not a parity break,
 * since nothing seeded or tested writes that shape.
 */
function cartesianScans(rows: readonly PlanRow[]): PlanRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const scans = rows.filter(isUnjoinedRelationScan)
  const byParent = new Map<number, PlanRow[]>()
  for (const scan of scans) byParent.set(scan.parent, [...(byParent.get(scan.parent) ?? []), scan])
  const flagged = new Set<PlanRow>()
  for (const group of byParent.values()) if (group.length > 1) for (const scan of group) flagged.add(scan)
  for (const scan of scans) if (hasCorrelatedAncestor(scan, byId)) flagged.add(scan)
  return [...flagged]
}

/** `plan_check_unavailable` (09 D-81 #1; CLAUDE.md "no empty catch {}"): logged, never swallowed. */
function logPlanCheckUnavailable(sql: string, err: unknown): void {
  console.error(JSON.stringify({ at: 'gate3-readonly-sql', outcome: 'plan_check_unavailable', reason: sanitizeSqlError(err), sql }))
}

/**
 * EXPLAIN QUERY PLAN on the checked SQL (09 D-81 #1); throws GateDenied('gate3') before the real
 * query runs when `cartesianScans` flags any plan row. When EXPLAIN itself throws, this never
 * swallows it silently (CLAUDE.md "no empty catch {}"): the structured reason is logged
 * (`plan_check_unavailable`) first. It then lets the real run below happen rather than deny the
 * call, because EXPLAIN QUERY PLAN fails on exactly the SQL shapes the real run would also fail
 * on (a genuine syntax/semantic error the lexer's own checks did not catch, e.g. `GROUP BY` with
 * nothing after it) — denying here would turn that failure from the database's own sanitized
 * SqlRunError/`query_failed` (what the model needs to fix its SQL) into an opaque `gate3_denied`.
 * The log line is this function's signal that the plan check did not run for a call that still
 * ran (or still failed) the ordinary way; it is not itself a refusal.
 */
async function checkPlan(db: D1Database, sql: string, params: readonly SqlValue[]): Promise<void> {
  let rows: PlanRow[]
  try {
    const result = await db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<PlanRow>()
    rows = result.results
  } catch (err) {
    logPlanCheckUnavailable(sql, err)
    return
  }
  const scans = cartesianScans(rows)
  if (scans.length > 0) {
    throw new GateDenied(
      'gate3',
      [
        `the query plan shows ${scans.length} unindexed table scans with nothing indexed joining them (a cartesian/cross join, or a correlated subquery scanning once per outer row): ${scans
          .map((s) => s.detail)
          .join('; ')}; add a join condition or a correlated lookup an index can use, or narrow the WHERE clause`,
      ],
      sql,
    )
  }
}

/**
 * Rejects `promise` with SqlTimeoutError after `ms` if it has not settled by then. `ms <= 0`
 * rejects immediately with no timer at all (there is nothing to wait for): one way a test can
 * inject a timeout that reliably beats a real query without mocking D1; the other, for exercising
 * the real `ms > 0` timer path (09 D-81 #2), is racing this function directly against a promise
 * that is genuinely still pending (test/sql-limits.test.ts). `promise` itself is never cancelled
 * either way (D1 has no cancel; it keeps running in the background, docs/notes.md "Known gaps") — and,
 * measured live in workerd against this seed's local D1, a long real query blocks the isolate so
 * completely that the timer below has never been seen to win against one (docs/notes.md "Known gaps");
 * it is exercised here only against an ordinary pending promise, not a real heavy D1 call.
 */
export async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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
    // costs an extra D1 read, not extra serial wait (docs/notes.md "Known gaps" notes the doubled read).
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
