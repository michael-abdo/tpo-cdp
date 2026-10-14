// The D-64b positive grammar: whether one query_sql answer's SQL may be pinned to the board
// (design 09 D-64b, amending D-64a; 01 §insights; 04 §/api/insights; 06 §/insights). Checked at
// pin time (worker/insights/board.ts `pin`) and again on every board run (`runTile`), on the
// lexed SQL Gate 2 and Gate 3 have already passed (views only, read-only, one statement, LIMIT
// ≤ 100): this file is strictly additional, never a substitute for those gates.
//
// D-64a's finding was an output denylist on free-form SQL: a cut of a key (substr(pkey, …))
// slipped a key fragment onto the board. D-64b replaces the denylist with an allow-list checked
// on the query's SHAPE, not its output: every SELECT-list expression must be one of a short list
// of known shapes, and every occurrence of an identifier column (pkey, visitor_hash) anywhere in
// the query — not just the SELECT list — must be one of exactly two allowed positions. Anything
// the shapes below do not recognise is refused, never guessed at (fail safe): a query that is
// "probably fine" is exactly the class D-64a's denylist got wrong.
//
// Two shapes pin:
//   - totals (A): every output column is count(*), count(DISTINCT pkey|visitor_hash), an
//     aggregate (sum/avg/min/max) of an approved numeric column, or an approved dimension column
//     (optionally a date bucket, substr(date_col, 1, n)) that also appears in GROUP BY, with at
//     least one count(*)/count(DISTINCT …) column to anchor the small-group check (B, in board.ts
//     maskSmallGroups). No HAVING: a crafted HAVING cannot be used to wave a small group through,
//     because B re-checks every row at every run regardless of HAVING; disallowing it outright
//     removes the whole bypass class instead of trying to read a safe HAVING from an unsafe one.
//   - list: exactly one identifier column, written bare (the whole, unmodified key, never DISTINCT
//     or wrapped), plus zero or more approved columns; no count, no GROUP BY (an ungrouped row
//     list is already what it looks like). board.ts caps it at 10 rows and re-hydrates the key to
//     an email for the UI only (worker/assistant/rehydrate.ts); never sent to the model.
//
// Refused outright, before any shape is considered: a second SELECT anywhere (bans subqueries,
// CTEs — WITH is already a Gate 2/3 denied word — and UNION/INTERSECT/EXCEPT, whose compound
// result could show one shape on its first branch and another on a later one); any window
// function (OVER); any HAVING. Every other check is the identifier-position sweep and the
// per-expression classifier below.

import { lexSql, SqlLexError, type SqlToken } from '../assistant/gates/gate3-readonly-sql'

/** 01 §Pseudonymous key: the two columns a v_* view uses to name a subject. */
export const IDENTIFIER_COLUMNS: ReadonlySet<string> = new Set(['pkey', 'visitor_hash'])

/**
 * Approved dimension columns (09 D-64b "acquisition source, status, page, utm_source, event"):
 * low-cardinality, non-identifying columns of the v_* views that may be a GROUP BY key (totals)
 * or a plain output column (a list). first_page/first_utm_source are v_profiles' and v_funnel's
 * own names for "page"/"utm_source" on a subscriber or a funnel row.
 */
export const APPROVED_DIMENSION_COLUMNS: ReadonlySet<string> = new Set([
  'source',
  'status',
  'page',
  'utm_source',
  'event',
  'first_page',
  'first_utm_source',
])

/** Approved numeric columns a totals query may sum/avg/min/max, or a list may show plainly. */
export const APPROVED_NUMERIC_COLUMNS: ReadonlySet<string> = new Set(['engagement_score', 'has_app', 'app_after_signup', 'visitors', 'subscribed'])

/** Approved date columns (the query_sql tool's own list, scripts/tool-seeds.ts) a date bucket may read. */
export const APPROVED_DATE_COLUMNS: ReadonlySet<string> = new Set(['signup_date', 'last_open_date', 'cold_since', 'app_created_at', 'event_ts'])

export type PinnableShape =
  | { shape: 'totals'; countColumns: readonly string[]; dimensionColumns: readonly string[] }
  | { shape: 'list'; identifierColumn: 'pkey' }

export type PinGrammarResult = ({ ok: true } & PinnableShape) | { ok: false; problems: readonly string[] }

const isWord = (t: SqlToken | undefined, word?: string): boolean => t !== undefined && t.kind === 'word' && (word === undefined || t.text.toUpperCase() === word)
const isPunct = (t: SqlToken | undefined, text: string): boolean => t !== undefined && t.kind === 'punct' && t.text === text

/** Words that end a clause at its own depth (board.ts SELECT_LIST_END, duplicated: this file must stay pure of board.ts). */
const CLAUSE_END = new Set(['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT'])

/** Splits `tokens` on commas at `depth`. Pure. */
function splitOn(tokens: readonly SqlToken[], depth: number): SqlToken[][] {
  const groups: SqlToken[][] = [[]]
  for (const t of tokens) {
    if (isPunct(t, ',') && t.depth === depth) groups.push([])
    else groups.at(-1)!.push(t)
  }
  return groups.filter((g) => g.length > 0)
}

/** The bare `col` or `alias.col` column name an expression's tokens name, lowercase; null otherwise. */
function bareColumn(tokens: readonly SqlToken[]): string | null {
  if (tokens.length === 1 && tokens[0].kind === 'word') return tokens[0].text.toLowerCase()
  if (tokens.length === 3 && tokens[0].kind === 'word' && isPunct(tokens[1], '.') && tokens[2].kind === 'word') return tokens[2].text.toLowerCase()
  return null
}

/** `fn(args, …)` as a name and its comma-split arguments, or null when `tokens` is not one function call. */
function asCall(tokens: readonly SqlToken[]): { fn: string; args: SqlToken[][] } | null {
  if (tokens.length < 3 || tokens[0].kind !== 'word' || !isPunct(tokens[1], '(') || tokens.at(-1)!.text !== ')' || !isPunct(tokens.at(-1), ')')) return null
  const inner = tokens.slice(2, -1)
  return { fn: tokens[0].text.toLowerCase(), args: inner.length === 0 ? [[]] : splitOn(inner, tokens[1].depth + 1) }
}

/** Punctuation that makes an expression arithmetic or a string concatenation (09 D-64b "no string/arithmetic function"). */
const OPERATORS = new Set(['+', '-', '*', '/', '|'])

interface Expr {
  kind: 'count_star' | 'count_distinct' | 'agg' | 'dimension' | 'bare_identifier' | 'plain_approved' | 'invalid'
  name: string
  /** Token indexes (into the whole query) this expression's identifier use occupies, so the final
   *  sweep can tell a cleared use from a stray one; empty for a non-identifier expression. */
  identifierAt: readonly number[]
  problem?: string
}

/**
 * One SELECT-list (or, for a list shape, an output) expression. `all` is the whole query's
 * tokens, so `identifierAt` can be reported as indexes the final sweep (classifyPinnableSql)
 * clears. A computed expression (count, an aggregate, a date bucket) must carry an explicit `AS
 * alias` — the query_sql tool's own rule ("every computed column is named with AS") — so `name`
 * is always the real output column name board.ts will see back from D1, never SQLite's own
 * "count(*)"-shaped default; a bare column keeps its own name unless aliased.
 */
function classifyExpression(tokens: readonly SqlToken[], all: readonly SqlToken[]): Expr {
  let base = tokens
  let alias: string | null = null
  if (base.length >= 2 && isWord(base.at(-2), 'AS') && isWord(base.at(-1))) {
    alias = base.at(-1)!.text.toLowerCase()
    base = base.slice(0, -2)
  }
  const indexOf = (t: SqlToken) => all.indexOf(t)
  const invalid = (problem: string): Expr => ({ kind: 'invalid', name: '', identifierAt: [], problem })
  const named = (kind: Exclude<Expr['kind'], 'invalid'>, fallback: string | null, identifierAt: readonly number[] = []): Expr => {
    const name = alias ?? fallback
    return name === null ? invalid('name this column with AS, e.g. AS subscribers') : { kind, name, identifierAt }
  }

  const call = asCall(base)
  if (call !== null) {
    if (call.fn === 'count') {
      if (call.args.length === 1 && call.args[0].length === 1 && isPunct(call.args[0][0], '*')) return named('count_star', null)
      if (call.args.length === 1 && isWord(call.args[0][0], 'DISTINCT')) {
        const col = bareColumn(call.args[0].slice(1))
        if (col !== null && IDENTIFIER_COLUMNS.has(col)) return named('count_distinct', null, call.args[0].slice(1).map(indexOf))
        return invalid('count(DISTINCT …) is only allowed on pkey or visitor_hash')
      }
      return invalid('count() must be count(*) or count(DISTINCT pkey|visitor_hash)')
    }
    if (call.fn === 'sum' || call.fn === 'avg' || call.fn === 'min' || call.fn === 'max') {
      if (call.args.length !== 1) return invalid(`${call.fn}() takes exactly one column`)
      const col = bareColumn(call.args[0])
      if (col !== null && IDENTIFIER_COLUMNS.has(col)) return invalid(`${call.fn}() cannot read an identifier column`)
      if (col === null || !APPROVED_NUMERIC_COLUMNS.has(col)) return invalid(`${call.fn}() may only read an approved numeric column`)
      return named('agg', null)
    }
    if (call.fn === 'substr' || call.fn === 'substring') {
      const col = bareColumn(call.args[0] ?? [])
      if (col !== null && IDENTIFIER_COLUMNS.has(col)) return invalid('substr() cannot be applied to an identifier column')
      const start = call.args[1]?.[0]
      const length = call.args[2]?.[0]
      const ok =
        call.args.length === 3 &&
        col !== null &&
        APPROVED_DATE_COLUMNS.has(col) &&
        call.args[1].length === 1 &&
        start?.kind === 'number' &&
        start.text === '1' &&
        call.args[2].length === 1 &&
        length?.kind === 'number' &&
        /^\d+$/.test(length.text) &&
        Number(length.text) >= 4 &&
        Number(length.text) <= 10
      return ok ? named('dimension', null) : invalid('substr() is only allowed as a date bucket: substr(<approved date column>, 1, 4-10)')
    }
    return invalid(`${call.fn}() is not allowed in a pinnable query`)
  }

  if (base.some((t) => t.kind === 'punct' && OPERATORS.has(t.text))) {
    return invalid('an arithmetic or string-concatenation expression is not allowed')
  }
  const col = bareColumn(base)
  if (col === null) return invalid('this expression is not one of the allowed shapes')
  if (IDENTIFIER_COLUMNS.has(col)) return alias === null ? named('bare_identifier', col, base.map(indexOf)) : invalid('the identifier column of a person list cannot be aliased')
  if (APPROVED_DIMENSION_COLUMNS.has(col)) return named('dimension', col)
  if (APPROVED_NUMERIC_COLUMNS.has(col) || APPROVED_DATE_COLUMNS.has(col)) return named('plain_approved', col)
  return invalid(`${col} is not an approved column`)
}

/** Every token's canonical text for GROUP BY / expression-set comparison, joined; pure. */
const canon = (tokens: readonly SqlToken[]) => tokens.map((t) => (t.kind === 'word' ? t.text.toUpperCase() : t.text)).join(' ')

/**
 * The D-64b grammar over one query_sql SQL text, already passed through Gate 2 and Gate 3 (03
 * rows 7-8). Pure: no view lookup, since every name here is checked against the fixed allow-lists
 * above, a strict subset of what the views already expose PII-free. Returns the shape or every
 * problem found (never partial: a query failing in two ways reports both).
 */
export function classifyPinnableSql(sql: string): PinGrammarResult {
  let tokens: SqlToken[]
  try {
    tokens = lexSql(sql).filter((t) => t.kind !== 'comment')
  } catch (err) {
    if (err instanceof SqlLexError) return { ok: false, problems: [err.message] }
    throw err
  }
  const problems: string[] = []

  const selectCount = tokens.filter((t) => isWord(t, 'SELECT')).length
  if (selectCount > 1) problems.push('only one SELECT is allowed: no subquery, CTE or UNION/INTERSECT/EXCEPT')
  if (tokens.some((t) => isWord(t, 'UNION') || isWord(t, 'INTERSECT') || isWord(t, 'EXCEPT'))) {
    problems.push('UNION, INTERSECT and EXCEPT are not allowed')
  }
  if (tokens.some((t) => isWord(t, 'OVER'))) problems.push('window functions (OVER) are not allowed')
  if (tokens.some((t) => isWord(t, 'HAVING'))) {
    problems.push('HAVING is not allowed: groups under 5 people are hidden automatically at run time, whatever HAVING says')
  }
  if (problems.length > 0) return { ok: false, problems }

  // The SELECT list: from the first SELECT to the first clause-ending keyword at depth 0.
  const selectAt = tokens.findIndex((t) => isWord(t, 'SELECT'))
  let listEnd = tokens.length
  for (let i = selectAt + 1; i < tokens.length; i += 1) {
    if (tokens[i].depth === 0 && tokens[i].kind === 'word' && CLAUSE_END.has(tokens[i].text.toUpperCase())) {
      listEnd = i
      break
    }
  }
  const selectList = tokens.slice(selectAt + 1, listEnd)
  if (isWord(selectList[0], 'DISTINCT') || isWord(selectList[0], 'ALL')) problems.push('SELECT DISTINCT is not allowed')

  // GROUP BY: from "GROUP BY" to the next clause-ending keyword at depth 0, or [] when absent.
  let groupBy: SqlToken[] = []
  const groupAt = tokens.findIndex((t, i) => t.depth === 0 && isWord(t, 'GROUP') && isWord(tokens[i + 1], 'BY'))
  if (groupAt !== -1) {
    let groupEnd = tokens.length
    for (let i = groupAt + 2; i < tokens.length; i += 1) {
      if (tokens[i].depth === 0 && tokens[i].kind === 'word' && CLAUSE_END.has(tokens[i].text.toUpperCase()) && tokens[i].text.toUpperCase() !== 'GROUP') {
        groupEnd = i
        break
      }
    }
    groupBy = tokens.slice(groupAt + 2, groupEnd)
    for (const t of groupBy) {
      if (t.kind === 'word' && IDENTIFIER_COLUMNS.has(t.text.toLowerCase())) {
        problems.push('GROUP BY must not reference pkey or visitor_hash')
        break
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems }

  const expressions = splitOn(selectList, 0).map((e) => classifyExpression(e, tokens))
  for (const e of expressions) if (e.kind === 'invalid') problems.push(e.problem!)
  if (problems.length > 0) return { ok: false, problems }

  // The identifier-position sweep: every pkey/visitor_hash token anywhere in the query must be
  // one of the positions an expression above already classified as allowed (count(DISTINCT …) or
  // the one bare identifier of a list). Anything else — WHERE, ORDER BY, an alias, a second
  // mention — is refused, whatever it looks like (fail safe, 09 D-64a's own lesson).
  const cleared = new Set(expressions.flatMap((e) => e.identifierAt))
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t.kind === 'word' && IDENTIFIER_COLUMNS.has(t.text.toLowerCase()) && !cleared.has(i)) {
      problems.push(`${t.text} may appear only as count(DISTINCT ${t.text}) or as the one listed identifier column of a person list`)
    }
  }
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] }

  const identifiers = expressions.filter((e) => e.kind === 'bare_identifier')
  if (identifiers.length > 0) {
    if (identifiers.length > 1) return { ok: false, problems: ['a person list may name exactly one identifier column'] }
    if (identifiers[0].name !== 'pkey') return { ok: false, problems: ['a person list must name pkey, not visitor_hash: visitor_hash has no email to re-hydrate for staff'] }
    if (groupBy.length > 0) return { ok: false, problems: ['a person list cannot be grouped (GROUP BY)'] }
    const bad = expressions.find((e) => e.kind === 'count_star' || e.kind === 'count_distinct' || e.kind === 'agg')
    if (bad !== undefined) return { ok: false, problems: ['a person list cannot also select a count or an aggregate'] }
    return { ok: true, shape: 'list', identifierColumn: 'pkey' }
  }

  const counts = expressions.filter((e) => e.kind === 'count_star' || e.kind === 'count_distinct')
  if (counts.length === 0) {
    return { ok: false, problems: ['a totals query needs at least one count(*) or count(DISTINCT pkey|visitor_hash) column to anchor the small-group check'] }
  }
  const dimensions = expressions.filter((e) => e.kind === 'dimension')
  const groupTexts = new Set(splitOn(groupBy, 0).map(canon))
  const dimensionTexts = new Set(dimensions.map((e) => e.name))
  // Every dimension column must be grouped on, by its own expression text (a bucket's canon is
  // its substr(...) call; a plain column's canon is just its name), and GROUP BY must name nothing else.
  const dimensionExprTexts = new Set(
    splitOn(selectList, 0)
      .map((e, i) => ({ e, expr: expressions[i] }))
      .filter(({ expr }) => expr.kind === 'dimension')
      .map(({ e }) => canon(e.length >= 2 && isWord(e.at(-2), 'AS') ? e.slice(0, -2) : e)),
  )
  if (dimensions.length > 0 && groupBy.length === 0) problems.push('a dimension column needs GROUP BY')
  if (groupBy.length > 0) {
    for (const g of groupTexts) if (!dimensionExprTexts.has(g)) problems.push(`GROUP BY ${g} does not match a dimension column in the SELECT list`)
    for (const d of dimensionExprTexts) if (!groupTexts.has(d)) problems.push(`the dimension column ${d} is not in GROUP BY`)
  }
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] }
  return { ok: true, shape: 'totals', countColumns: counts.map((e) => e.name), dimensionColumns: [...dimensionTexts] }
}
