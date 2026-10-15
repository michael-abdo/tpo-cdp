// Gate 2, the tool authorizer. Every tool call the model makes passes
// here first (tool-executor.ts):
//   - authorizeToolCall: a name that is not a loaded tool is denied; the input is validated
//     server-side against the row's `input_schema`, so the model cannot send fields or values
//     the tool never declared
//   - validateSqlAgainstViews: every relation the SQL reads must be one of the PII-free `v_*`
//     views (discovered by schema-context.ts); write and statement keywords are
//     denied; every column is checked against the views' `PRAGMA table_info` columns
//   - a relation is a view named by a bare word or a `(SELECT …)` subquery; a parenthesized
//     table or join (`FROM (subscribers)`) and a string used as a table name (`FROM 'subscribers'`,
//     which SQLite accepts) are denied, so no hidden table is read under a subquery's alias
//   - a relation position is found from the SQL's shape, never from an alias: every JOIN starts a
//     relation, a FROM list ends only at a keyword that cannot be an alias, and `IN <name>` (SQLite
//     reads a table there) is denied, so the model writes `IN (…)`; WINDOW is denied, since a
//     named window's name is no view column and `AS window` would otherwise look like a clause
//   - the wall clock is denied (business dates use the fixed TODAY): 'now', CURRENT_DATE/TIME/TIMESTAMP, and any date
//     function whose time value is missing or computed (`date()`, `strftime('%Y')`,
//     `date('n'||'ow')`), since SQLite reads the clock for those; the time value must be a date
//     literal or a stored date column of a view (dateTimeValueProblems)
//
// Gate 2 is stricter than JSON Schema in one way: a property the schema does not declare is
// denied unless the schema sets `additionalProperties`. Tool rows are data anyone can add; the loader
// already refuses a schema that declares a property its handler does not read (tool-loader.ts),
// so an undeclared property is never one a handler would use.
//
// Both checks are pure. A refusal is a GateDenied (gate3-readonly-sql.ts, which also holds the
// shared lexer): the executor audits it as `kind=blocked` and sends the problems to the model.
// Problems may quote a property name or an identifier the model wrote; the executor scans the
// error with the PII guard before the model, a log line or the audit row sees it.

import { TODAY } from '../../../shared/config'
import { PII_COLUMNS } from '../../../shared/pii'
import type { ViewSchema } from '../schema-context'
import type { LoadedTool, LoadedTools } from '../tools/tool-loader'
import { GateDenied, lexSql, SqlLexError, type SqlToken } from './gate3-readonly-sql'

// ── authorizeToolCall ────────────────────────────────────────────────────────────────────

/** The subset of JSON Schema a tool row may use (tool-loader.ts SCHEMA_KEYWORDS). */
interface JsonSchema {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  /** ECMA-262, unanchored as JSON Schema defines it; the loader refused any pattern that does not compile. */
  pattern?: string
  additionalProperties?: boolean | JsonSchema
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isObject(value)
    default:
      // The loader refuses any other type name, so a loaded schema never reaches here.
      throw new Error(`gate2: unsupported JSON Schema type ${JSON.stringify(type)}`)
  }
}

/** Problems with `value` against `schema`, each prefixed with its path. Pure. */
export function inputSchemaProblems(schema: JsonSchema, value: unknown, path = 'input'): string[] {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => hasType(t, value))) return [`${path} must be ${types.join(' or ')}`]
  }
  const problems: string[] = []
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    problems.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path} must be at least ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path} must be at most ${schema.maximum}`)
  }
  if (typeof value === 'string') {
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength) problems.push(`${path} must be at least ${schema.minLength} characters`)
    if (schema.maxLength !== undefined && length > schema.maxLength) problems.push(`${path} must be at most ${schema.maxLength} characters`)
    // The problem names the pattern, never the value: the value is the model's untrusted input.
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) problems.push(`${path} must match ${schema.pattern}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${path} must have at least ${schema.minItems} item(s)`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${path} must have at most ${schema.maxItems} item(s)`)
    if (schema.items !== undefined) value.forEach((item, i) => problems.push(...inputSchemaProblems(schema.items!, item, `${path}[${i}]`)))
  }
  const declaresObject = schema.properties !== undefined || schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))
  if (isObject(value) && declaresObject) {
    const properties = schema.properties ?? {}
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) problems.push(`${path}.${name} is required`)
    }
    for (const [name, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) problems.push(...inputSchemaProblems(properties[name], item, `${path}.${name}`))
      else if (isObject(schema.additionalProperties)) problems.push(...inputSchemaProblems(schema.additionalProperties, item, `${path}.${name}`))
      else if (schema.additionalProperties !== true) problems.push(`${path} has unknown property ${JSON.stringify(name)}`)
    }
  }
  return problems
}

export type Authorization =
  | { allowed: true; tool: LoadedTool; input: Record<string, unknown> }
  | { allowed: false; reason: 'unknown_tool' }
  | { allowed: false; reason: 'input_schema'; tool: LoadedTool; problems: string[] }

/** Gate 2 for one tool_use block. Pure. */
export function authorizeToolCall(tools: LoadedTools, call: { name: string; input: unknown }): Authorization {
  const tool = tools.byName.get(call.name)
  if (tool === undefined) return { allowed: false, reason: 'unknown_tool' }
  const problems = inputSchemaProblems(tool.definition.input_schema as JsonSchema, call.input)
  if (problems.length > 0) return { allowed: false, reason: 'input_schema', tool, problems }
  return { allowed: true, tool, input: call.input as Record<string, unknown> }
}

// ── validateSqlAgainstViews ──────────────────────────────────────────────────────────────

/**
 * Write and statement keywords; Gate 3 refuses PRAGMA, ATTACH, DETACH and WITH again on
 * its own. Plus WINDOW: a named window's name is no view column, so a WINDOW clause never passes
 * the column check, and as an alias (`FROM v_funnel AS window`) it would end the FROM list
 * early and hide the next JOIN or comma relation from the view check.
 */
const DENIED_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'RENAME',
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'ANALYZE', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'SAVEPOINT', 'RELEASE', 'GRANT', 'REVOKE', 'WITH', 'RECURSIVE', 'TRIGGER', 'INDEX', 'VALUES', 'WINDOW',
])

/** The wall clock; business dates use TODAY, which the system prompt gives the model. */
const WALL_CLOCK_WORDS = new Set(['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP'])

/** Words of a read-only SELECT. A word not here, not a function call and not a name is denied. */
const KEYWORDS = new Set([
  'SELECT', 'DISTINCT', 'ALL', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'LIMIT', 'OFFSET',
  'AS', 'ON', 'USING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL',
  'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'ISNULL', 'NOTNULL', 'LIKE', 'GLOB', 'BETWEEN', 'ESCAPE',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS', 'UNION', 'INTERSECT', 'EXCEPT', 'TRUE', 'FALSE',
  'CAST', 'INTEGER', 'INT', 'REAL', 'TEXT', 'NUMERIC', 'COLLATE', 'NOCASE', 'BINARY', 'NULLS', 'FIRST', 'LAST',
  'OVER', 'PARTITION', 'FILTER', 'ROWS', 'RANGE', 'GROUPS', 'PRECEDING', 'FOLLOWING', 'UNBOUNDED', 'CURRENT', 'ROW',
  'EXCLUDE', 'TIES', 'OTHERS', 'NO',
])

/** Functions a query may call: aggregates, window functions, text, numbers and date arithmetic. */
const FUNCTIONS = new Set([
  'count', 'sum', 'total', 'avg', 'min', 'max', 'group_concat',
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value', 'last_value',
  'abs', 'round', 'coalesce', 'ifnull', 'nullif', 'iif', 'typeof',
  'length', 'lower', 'upper', 'substr', 'substring', 'trim', 'ltrim', 'rtrim', 'instr',
  'date', 'datetime', 'julianday', 'strftime',
])

/**
 * The date functions FUNCTIONS allows, with the index of their time-value argument. SQLite reads
 * the wall clock when that argument is missing or evaluates to 'now', so it must be a date
 * literal or a stored date column (dateTimeValueProblems). time() and unixepoch() are not allowed.
 */
const TIME_VALUE_ARGUMENT = new Map([
  ['date', 0],
  ['datetime', 0],
  ['julianday', 0],
  ['strftime', 1],
])

/** A date or UTC timestamp literal, as stored: `YYYY-MM-DD`, optionally with a time and zone. */
const ISO_DATE_LITERAL = /^'\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?'$/

/**
 * A view column that stores a date or timestamp, by the schema's naming (signup_date, last_open_date,
 * cold_since, app_created_at, event_ts). These hold normalized ISO values written by the seed,
 * shared/derive.ts or the webhook (all stored in UTC), never 'now'; a free-text column
 * (page, utm_source, story) can hold anything a webhook sent, so it is no time value.
 * T-GATE-2 checks every such column's seeded values are ISO dates.
 */
export const DATE_COLUMN = /_(?:date|ts|at|since)$/

/** Keywords that end an expression, so a name right after one is an alias (`CASE … END x`). */
const EXPRESSION_END_KEYWORDS = new Set(['END', 'NULL', 'TRUE', 'FALSE', 'ISNULL', 'NOTNULL', 'NOCASE', 'BINARY'])

const COMPOUND = new Set(['UNION', 'INTERSECT', 'EXCEPT'])

/** After FROM at the same depth, these words end the list of relations. All are KEYWORDS, so none can be an alias. */
const FROM_LIST_END = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT'])

const PII = new Set<string>(PII_COLUMNS)

/** The views a query reads, as found by validateSqlAgainstViews. */
export interface ValidatedSql {
  views: string[]
}

const isWord = (t: SqlToken | undefined, word?: string): t is SqlToken =>
  t !== undefined && t.kind === 'word' && (word === undefined || t.text.toUpperCase() === word)
const isPunct = (t: SqlToken | undefined, text: string): boolean => t !== undefined && t.kind === 'punct' && t.text === text
/** A word that can name a column, view or alias: not a keyword, a denied word or the wall clock. */
const isName = (t: SqlToken | undefined): t is SqlToken => {
  if (!isWord(t)) return false
  const upper = t.text.toUpperCase()
  return !KEYWORDS.has(upper) && !DENIED_WORDS.has(upper) && !WALL_CLOCK_WORDS.has(upper)
}

/**
 * Gate 2's SQL check. Pure: `views` are the `v_*` views with their PRAGMA columns
 * (schema-context.ts). Returns the views read, or throws GateDenied('gate2') listing every problem.
 */
export function validateSqlAgainstViews(sql: string, views: readonly ViewSchema[]): ValidatedSql {
  let tokens: SqlToken[]
  try {
    tokens = lexSql(sql)
  } catch (err) {
    if (err instanceof SqlLexError) throw new GateDenied('gate2', [err.message], sql)
    throw err
  }
  const problems: string[] = []
  const viewByName = new Map(views.map((v) => [v.name.toLowerCase(), v]))
  const allowed = views.map((v) => v.name).join(', ')

  // The matching ")" of every "(".
  const closing = new Map<number, number>()
  const open: number[] = []
  tokens.forEach((t, i) => {
    if (isPunct(t, '(')) open.push(i)
    else if (isPunct(t, ')')) closing.set(open.pop()!, i)
  })

  // Pass 1: relations (after FROM, JOIN, or a comma in a FROM list), their aliases, and column
  // aliases; `IN <name>`, which SQLite reads as a table, is denied here.
  /** Name or alias → the view it reads; null for a subquery's alias. */
  const relations = new Map<string, ViewSchema | null>()
  const read = new Set<ViewSchema>()
  const columnAliases = new Set<string>()
  const named = new Set<number>() // token indexes already accounted for (relations and aliases)
  const inFrom = new Set<number>() // depths currently inside a FROM list

  /** Records the alias at `i` (after `AS`, or a bare name), if there is one, as a name for `target`. */
  const aliasAt = (i: number, target: ViewSchema | null): void => {
    const at = isWord(tokens[i], 'AS') ? i + 1 : i
    if (isName(tokens[at])) {
      named.add(at)
      relations.set(tokens[at].text.toLowerCase(), target)
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (isPunct(t, ')')) inFrom.delete(t.depth + 1)
    if (t.kind !== 'word' && !isPunct(t, ',')) continue
    const upper = t.text.toUpperCase()
    if (t.kind === 'word' && !named.has(i) && FROM_LIST_END.has(upper)) inFrom.delete(t.depth)
    // Every JOIN is inside a FROM list, whatever came before it.
    if (t.kind === 'word' && (upper === 'FROM' || upper === 'JOIN')) inFrom.add(t.depth)
    if (t.kind === 'word' && upper === 'IN' && !isPunct(tokens[i + 1], '(')) {
      // `x IN subscribers` (or IN an alias named after a table) reads that table in SQLite.
      problems.push(`IN must be followed by "(": write IN (value, …) or IN (SELECT … FROM a view), never IN a table or alias; only these views may be read: ${allowed}`)
      if (isWord(tokens[i + 1])) named.add(i + 1)
    }
    const startsRelation = upper === 'FROM' || upper === 'JOIN' || (t.text === ',' && inFrom.has(t.depth))
    if (startsRelation) {
      const next = tokens[i + 1]
      const where = t.text === ',' ? 'after a comma in FROM' : `after ${upper}`
      if (isPunct(next, '(')) {
        // Only a subquery may be parenthesized. SQLite also reads `(subscribers)` and
        // `(a JOIN b)` here, which would put a hidden table under the alias (T-GATE-2).
        if (isWord(tokens[i + 2], 'SELECT')) aliasAt(closing.get(i + 1)! + 1, null)
        else problems.push(`a parenthesized table or join is not allowed ${where}; name a view directly or write (SELECT …); only these views may be read: ${allowed}`)
      } else if (!isWord(next)) {
        // SQLite takes a string as a table name here (`FROM 'subscribers'`).
        problems.push(`${where}, write a view name plainly or (SELECT …), not a string or quoted name; only these views may be read: ${allowed}`)
      } else {
        named.add(i + 1)
        if (isPunct(tokens[i + 2], '(')) {
          problems.push(`${next.text}() is not a view; only these views may be read: ${allowed}`)
        } else if (isPunct(tokens[i + 2], '.')) {
          problems.push(`${next.text}.${tokens[i + 3]?.text ?? ''}: name a view directly, without a schema; only these views may be read: ${allowed}`)
          if (tokens[i + 3] !== undefined) named.add(i + 3)
        } else {
          const view = viewByName.get(next.text.toLowerCase())
          if (view === undefined) {
            problems.push(`${next.text} is not one of the views; only these views may be read: ${allowed}`)
          } else {
            read.add(view)
            relations.set(view.name.toLowerCase(), view)
            aliasAt(i + 2, view)
          }
        }
      }
    }
    if (t.kind === 'word' && upper === 'AS' && isName(tokens[i + 1]) && !named.has(i + 1)) {
      named.add(i + 1)
      columnAliases.add(tokens[i + 1].text.toLowerCase())
    }
  }

  // Pass 2: every other word is a keyword, an allowed function, a qualifier or a known column.
  const readColumns = new Set([...read].flatMap((v) => v.columns.map((c) => c.name.toLowerCase())))
  const readNames = read.size === 0 ? null : [...read].map((v) => v.name).join(', ')
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t.kind === 'quoted') {
      problems.push(`quoted names (${t.text.slice(0, 1)}…) are not allowed; write view and column names plainly`)
      continue
    }
    if (t.kind === 'string' && t.text.slice(1, -1).trim().toLowerCase() === 'now') {
      problems.push("the wall clock ('now') is not allowed; use TODAY from the system prompt as a date literal")
      continue
    }
    if (t.kind !== 'word' || named.has(i)) continue
    const upper = t.text.toUpperCase()
    const lower = t.text.toLowerCase()
    if (DENIED_WORDS.has(upper)) {
      problems.push(`${upper} is not allowed: only a read-only SELECT over the views`)
    } else if (WALL_CLOCK_WORDS.has(upper)) {
      problems.push(`${upper} is the wall clock and is not allowed; use TODAY from the system prompt as a date literal`)
    } else if (KEYWORDS.has(upper)) {
      continue
    } else if (isPunct(tokens[i + 1], '(')) {
      if (!FUNCTIONS.has(lower)) problems.push(`the function ${t.text}() is not allowed`)
    } else if (isPunct(tokens[i - 1], '.') && isWord(tokens[i - 2])) {
      const qualifier = tokens[i - 2].text.toLowerCase()
      if (!relations.has(qualifier)) continue // the qualifier itself is reported below
      const target = relations.get(qualifier)!
      const known = target === null ? readColumns.has(lower) || columnAliases.has(lower) : target.columns.some((c) => c.name.toLowerCase() === lower)
      if (PII.has(lower)) problems.push(`${t.text} is personal data; no view exposes it`)
      else if (!known) problems.push(`unknown column ${tokens[i - 2].text}.${t.text}${target === null ? '' : `: ${target.name} has no column ${t.text}`}`)
    } else if (isPunct(tokens[i + 1], '.')) {
      if (!relations.has(lower)) problems.push(`${t.text} is not a view or alias read by this query`)
    } else if (PII.has(lower)) {
      problems.push(`${t.text} is personal data; no view exposes it`)
    } else if (!readColumns.has(lower) && !columnAliases.has(lower) && !relations.has(lower)) {
      problems.push(`unknown column ${t.text}: ${readNames === null ? 'the query reads no view' : `not a column of ${readNames}`}`)
    }
  }

  problems.push(...dateTimeValueProblems(tokens, closing, relations, read, columnAliases))

  if (problems.length > 0) throw new GateDenied('gate2', [...new Set(problems)], sql)
  return { views: [...read].map((v) => v.name) }
}

/**
 * The wall clock through a date function: every date(), datetime(), julianday() and
 * strftime() call needs its time value, and that value must be a date literal or a stored date
 * column of a view the query reads, named so it cannot be a renamed expression: not an alias
 * anywhere in the query, and not in a query with UNION/INTERSECT/EXCEPT (a compound subquery
 * names its columns after its first SELECT, so `signup_date` could carry another branch's text).
 */
function dateTimeValueProblems(
  tokens: readonly SqlToken[],
  closing: ReadonlyMap<number, number>,
  relations: ReadonlyMap<string, ViewSchema | null>,
  read: ReadonlySet<ViewSchema>,
  columnAliases: ReadonlySet<string>,
): string[] {
  const problems: string[] = []
  const dateColumns = (view: ViewSchema) => view.columns.map((c) => c.name.toLowerCase()).filter((c) => DATE_COLUMN.test(c))
  const readDateColumns = new Set([...read].flatMap(dateColumns))
  const listed = [...readDateColumns].join(', ') || 'none in the views this query reads'
  const compound = tokens.some((t) => isWord(t) && COMPOUND.has(t.text.toUpperCase()))

  // Every name that is an alias somewhere: after AS, a relation alias, or a name right after an
  // expression (`'x' signup_date`, `count(*) n`, `CASE … END d`).
  const aliases = new Set(columnAliases)
  for (const [name, target] of relations) if (target === null || target.name.toLowerCase() !== name) aliases.add(name)
  tokens.forEach((t, i) => {
    if (!isName(t) || isPunct(tokens[i + 1], '(') || isPunct(tokens[i + 1], '.')) return
    const before = tokens[i - 1]
    if (before === undefined) return
    const endsExpression =
      before.kind === 'number' ||
      before.kind === 'string' ||
      before.kind === 'quoted' ||
      isPunct(before, ')') ||
      (isWord(before) && (!KEYWORDS.has(before.text.toUpperCase()) || EXPRESSION_END_KEYWORDS.has(before.text.toUpperCase())))
    if (endsExpression) aliases.add(t.text.toLowerCase())
  })

  tokens.forEach((t, i) => {
    if (!isWord(t) || !isPunct(tokens[i + 1], '(')) return
    const fn = t.text.toLowerCase()
    const position = TIME_VALUE_ARGUMENT.get(fn)
    if (position === undefined) return
    const call = `${fn}()`
    const close = closing.get(i + 1)!
    const argDepth = tokens[i + 1].depth + 1
    const args: SqlToken[][] = [[]]
    for (let j = i + 2; j < close; j += 1) {
      if (isPunct(tokens[j], ',') && tokens[j].depth === argDepth) args.push([])
      else args.at(-1)!.push(tokens[j])
    }
    const arg = args[position]
    const need = `use a date literal counted from TODAY (e.g. '${TODAY}') or a stored date column (${listed})`
    if (arg === undefined || arg.length === 0) {
      problems.push(`${call} without a time value reads the wall clock; ${need}`)
      return
    }
    if (arg.length === 1 && arg[0].kind === 'string') {
      if (arg[0].text.slice(1, -1).trim().toLowerCase() === 'now') return // reported as 'now' already
      if (!ISO_DATE_LITERAL.test(arg[0].text)) problems.push(`the time value of ${call} must be a date literal 'YYYY-MM-DD'; ${need}`)
      return
    }
    let column: string | null = null
    let ok = false
    if (arg.length === 1 && isName(arg[0])) {
      column = arg[0].text.toLowerCase()
      ok = readDateColumns.has(column) && !aliases.has(column)
    } else if (arg.length === 3 && isWord(arg[0]) && isPunct(arg[1], '.') && isName(arg[2])) {
      column = arg[2].text.toLowerCase()
      const target = relations.get(arg[0].text.toLowerCase())
      ok = target !== undefined && target !== null && dateColumns(target).includes(column)
    }
    if (column !== null && arg.length === 3 && relations.get(arg[0].text.toLowerCase()) === null) {
      problems.push(`${arg[0].text}.${arg[2].text}: ${call} must read its date column from a view or a view's alias, not through a subquery; ${need}`)
    } else if (column === null) {
      problems.push(`the time value of ${call} must be a single date literal or date column, not an expression (an expression could be 'now'); ${need}`)
    } else if (!ok) {
      problems.push(`${column} is not a stored date column of a view this query reads, so ${call} cannot use it as a time value; ${need}`)
    } else if (compound) {
      problems.push(`${call} over a column cannot be combined with UNION, INTERSECT or EXCEPT (a compound names its columns after its first SELECT); ${need}`)
    }
  })
  return problems
}
