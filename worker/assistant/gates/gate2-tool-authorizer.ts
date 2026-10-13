// Gate 2, the tool authorizer (design 03 §Gateway layers row 7; 14 §3.5, §7 "gate2-tool-authorizer.ts
// ← gateway/gate2-tool-authorizer.ts L157-191, L321-373"). Every tool call the model makes passes
// here first (tool-executor.ts):
//   - authorizeToolCall: a name that is not a loaded tool is denied (origin L157-191); the input
//     is validated server-side against the row's `input_schema`, which the origin never did
//     (09 D-24 "missing server-side input_schema validation → added")
//   - validateSqlAgainstViews: every relation the SQL reads must be one of the `v_*` views
//     (01 §PII-free views, discovered by schema-context.ts); write and statement keywords are
//     denied; every column is checked against the views' `PRAGMA table_info` columns, which the
//     origin advertised but never did (`knownColumns` unused, 14 §3.5; D-24 "→ implemented")
//
// Gate 2 is stricter than JSON Schema in one way: a property the schema does not declare is
// denied unless the schema sets `additionalProperties`. Tool rows are data (09 D-41); the loader
// already refuses a schema that declares a property its handler does not read (tool-loader.ts),
// so an undeclared property is never one a handler would use.
//
// Both checks are pure. A refusal is a GateDenied (gate3-readonly-sql.ts, which also holds the
// shared lexer): the executor audits it as `kind=blocked` and sends the problems to the model.
// Problems may quote a property name or an identifier the model wrote; the executor scans the
// error with the PII guard before the model, a log line or the audit row sees it.

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

/** Gate 2 for one tool_use block (03 row 7). Pure. */
export function authorizeToolCall(tools: LoadedTools, call: { name: string; input: unknown }): Authorization {
  const tool = tools.byName.get(call.name)
  if (tool === undefined) return { allowed: false, reason: 'unknown_tool' }
  const problems = inputSchemaProblems(tool.definition.input_schema as JsonSchema, call.input)
  if (problems.length > 0) return { allowed: false, reason: 'input_schema', tool, problems }
  return { allowed: true, tool, input: call.input as Record<string, unknown> }
}

// ── validateSqlAgainstViews ──────────────────────────────────────────────────────────────

/** Write and statement keywords (03 row 7); Gate 3 refuses PRAGMA, ATTACH, DETACH and WITH again on its own. */
const DENIED_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'RENAME',
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'ANALYZE', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'SAVEPOINT', 'RELEASE', 'GRANT', 'REVOKE', 'WITH', 'RECURSIVE', 'TRIGGER', 'INDEX', 'VALUES',
])

/** The wall clock; business dates use TODAY (02 §Time), which the system prompt gives the model. */
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

/** After FROM at the same depth, these words end the list of relations. */
const FROM_LIST_END = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW'])

const PII = new Set<string>(PII_COLUMNS)

/** The views a query reads, as found by validateSqlAgainstViews. */
export interface ValidatedSql {
  views: string[]
}

const isWord = (t: SqlToken | undefined, word?: string): t is SqlToken =>
  t !== undefined && t.kind === 'word' && (word === undefined || t.text.toUpperCase() === word)
const isPunct = (t: SqlToken | undefined, text: string): boolean => t !== undefined && t.kind === 'punct' && t.text === text
const isName = (t: SqlToken | undefined): t is SqlToken => isWord(t) && !KEYWORDS.has(t.text.toUpperCase())

/**
 * Gate 2's SQL check (03 row 7). Pure: `views` are the `v_*` views with their PRAGMA columns
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

  // Pass 1: relations (after FROM, JOIN, or a comma in a FROM list), their aliases, and column aliases.
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
    if (t.kind === 'word' && FROM_LIST_END.has(upper)) inFrom.delete(t.depth)
    if (t.kind === 'word' && upper === 'FROM') inFrom.add(t.depth)
    const startsRelation = upper === 'FROM' || upper === 'JOIN' || (t.text === ',' && inFrom.has(t.depth))
    if (startsRelation && inFrom.has(t.depth)) {
      const next = tokens[i + 1]
      if (isPunct(next, '(')) {
        const close = closing.get(i + 1)!
        aliasAt(close + 1, null)
      } else if (isName(next)) {
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

  if (problems.length > 0) throw new GateDenied('gate2', [...new Set(problems)], sql)
  return { views: [...read].map((v) => v.name) }
}
