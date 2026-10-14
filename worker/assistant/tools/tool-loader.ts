// Tool loading (design 03 §Gateway layers row 3; 09 D-41). Origin: palisade
// lib/chat/tool-loader.ts L28-118 (14 §2.2, §4 "copy nearly verbatim"): enabled rows ordered by
// sort_order become the Anthropic `tools[]` (name, description, input_schema) verbatim.
//
// Added (09 D-41, D-24 "missing validation → added"): every enabled row is validated at load and
// a failing row is a 500 `tool_config_error` that names it, never a silently missing tool:
//   - name: an Anthropic tool name (letters, digits, _ and -, at most 64), description non-empty
//   - input_schema: a JSON Schema object (`type: "object"`), checked keyword by keyword
//     (unknown keywords are refused, so a typo such as "requred" fails here, not at call time)
//   - builtin rows: `execution_config.handler_name` names a handler in the registry
//     (builtin-handlers.ts), and the schema declares no property the handler does not read
//   - query rows (03 row 9, "a question type as a row without a deploy"): `execution_config` is
//     `{ sql, param_mapping, format? }`. `sql` is a SELECT template over the v_* views with
//     `:name` placeholders; `param_mapping` maps each input field to one placeholder (01: "input
//     field → :param"). The template's placeholders become positional `?` in the order they
//     appear (09 D-45), each bound from the input field mapped to it. Checked here: every
//     placeholder is mapped, every mapping is used, every mapped field is a declared property
//     with a scalar type, every declared property is mapped, and the rewritten SQL passes Gate 2's
//     validateSqlAgainstViews against the views' PRAGMA columns and Gate 3's read-only checks with
//     that many bound values. A broken row therefore fails at load, not when the model calls it
//   - `passthrough` rows are refused by name: their executor is parked (16)
// No enabled row → 500 `no_tools` (04).
//
// Cache (03 §No-restart): the enabled rows are read on every request, a few small rows; the
// validated tool set is cached per isolate, keyed by those rows' exact contents. An inserted,
// edited or disabled row therefore takes effect on the next request with no deploy (D-41),
// while an unchanged table is not validated again. Nothing about subscribers is cached.

import { ApiError } from '../../auth/middleware'
import type { ModelTool } from '../build-request'
import { validateSqlAgainstViews } from '../gates/gate2-tool-authorizer'
import { GateDenied, readOnlySelect } from '../gates/gate3-readonly-sql'
import { type ViewSchema, viewSchemas } from '../schema-context'
import { BUILTIN_HANDLERS, type BuiltinHandler, queryHandler, type QueryTemplate } from './builtin-handlers'

/** An assistant_tools row as D1 returns it (01; JSON columns still text). */
export interface ToolRow {
  id: string
  name: string
  description: string
  input_schema: string
  handler_type: string
  execution_config: string
  sort_order: number
}

/** One validated, enabled tool. */
export interface LoadedTool {
  id: string
  name: string
  definition: ModelTool
  handlerType: 'builtin' | 'query'
  /** The registry name for a builtin row; the row's own name for a query row. */
  handlerName: string
  handler: BuiltinHandler
  /** Set for a query row: its template rewritten to positional `?` and the input field bound to each. */
  query?: QueryTemplate
}

export interface LoadedTools {
  tools: readonly LoadedTool[]
  /** The Anthropic `tools[]`, in sort_order. */
  definitions: readonly ModelTool[]
  byName: ReadonlyMap<string, LoadedTool>
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

/** The JSON Schema keywords a tool input_schema may use; anything else is refused as a likely typo. */
const SCHEMA_KEYWORDS = new Set([
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'items',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'additionalProperties',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCompilablePattern(pattern: string): boolean {
  try {
    new RegExp(pattern, 'u')
    return true
  } catch (err) {
    if (err instanceof SyntaxError) return false
    throw err
  }
}

/** Problems with one (sub)schema, each prefixed with its JSON path. Pure. */
export function schemaProblems(schema: unknown, path: string): string[] {
  if (!isObject(schema)) return [`${path} must be a JSON Schema object`]
  const problems: string[] = []
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) problems.push(`${path} uses unsupported keyword "${key}"`)
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]
  if (schema.type === undefined && schema.enum === undefined) problems.push(`${path} needs "type" or "enum"`)
  if (types.length === 0 && schema.type !== undefined) problems.push(`${path}.type must not be empty`)
  for (const t of types) {
    if (typeof t !== 'string' || !JSON_TYPES.has(t)) problems.push(`${path}.type ${JSON.stringify(t)} is not a JSON Schema type`)
  }
  if (schema.description !== undefined && typeof schema.description !== 'string') problems.push(`${path}.description must be a string`)
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    problems.push(`${path}.enum must be a non-empty array`)
  }
  for (const key of ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']) {
    if (schema[key] !== undefined && typeof schema[key] !== 'number') problems.push(`${path}.${key} must be a number`)
  }
  if (schema.pattern !== undefined) {
    // Gate 2 compiles it with the u flag, as JSON Schema's ECMA-262 patterns; refuse one it could not run.
    if (typeof schema.pattern !== 'string') problems.push(`${path}.pattern must be a string`)
    else if (!isCompilablePattern(schema.pattern)) problems.push(`${path}.pattern is not a valid regular expression`)
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) problems.push(`${path}.properties must be an object`)
    else for (const [name, sub] of Object.entries(schema.properties)) problems.push(...schemaProblems(sub, `${path}.properties.${name}`))
  }
  if (schema.required !== undefined) {
    const declared = isObject(schema.properties) ? Object.keys(schema.properties) : []
    if (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === 'string')) {
      problems.push(`${path}.required must be an array of property names`)
    } else {
      for (const r of schema.required) if (!declared.includes(r)) problems.push(`${path}.required names undeclared property "${r}"`)
    }
  }
  if (schema.items !== undefined) problems.push(...schemaProblems(schema.items, `${path}.items`))
  if (types.includes('array') && schema.items === undefined) problems.push(`${path} is an array without "items"`)
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    problems.push(...schemaProblems(schema.additionalProperties, `${path}.additionalProperties`))
  }
  return problems
}

function parseJson(text: string, column: string, problems: string[]): unknown {
  try {
    return JSON.parse(text)
  } catch (err) {
    problems.push(`${column} is not JSON (${err instanceof Error ? err.name : 'unknown'})`)
    return undefined
  }
}

// ── query rows ───────────────────────────────────────────────────────────────────────────

/** The execution_config keys a query row may use (01; `format` is documented only, as in the origin). */
const QUERY_CONFIG_KEYS = new Set(['sql', 'param_mapping', 'format'])

/** A placeholder as written in a template and in param_mapping's values: a colon and a name. */
const PLACEHOLDER = /^:[A-Za-z_][A-Za-z0-9_]*$/

/** JSON Schema types a bound value may have: D1 binds text, numbers and null (booleans as 1/0). */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

/**
 * The template with every `:name` outside a string, quoted name or comment replaced by `?`, and
 * the names in the order they appear (09 D-45). Any other text is left as written, so whatever
 * Gate 2 and Gate 3 refuse in a model's SQL they refuse here too. Pure.
 */
export function rewritePlaceholders(sql: string): { sql: string; placeholders: string[] } {
  const placeholders: string[] = []
  let out = ''
  let i = 0
  /** Copies up to and including `close`, or to the end when it is missing (the lexer then refuses it). */
  const copyThrough = (close: string, from: number) => {
    const at = sql.indexOf(close, from)
    const end = at === -1 ? sql.length : at + close.length
    out += sql.slice(i, end)
    i = end
  }
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'") {
      // '' inside a string is an escaped quote: the string goes on.
      let end = i + 1
      for (;;) {
        const at = sql.indexOf("'", end)
        if (at === -1) {
          end = sql.length
          break
        }
        if (sql[at + 1] === "'") {
          end = at + 2
          continue
        }
        end = at + 1
        break
      }
      out += sql.slice(i, end)
      i = end
    } else if (ch === '"' || ch === '`') {
      copyThrough(ch, i + 1)
    } else if (ch === '[') {
      copyThrough(']', i + 1)
    } else if (ch === '-' && sql[i + 1] === '-') {
      copyThrough('\n', i + 2)
    } else if (ch === '/' && sql[i + 1] === '*') {
      copyThrough('*/', i + 2)
    } else if (ch === ':' && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      const name = /^:[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))![0]
      placeholders.push(name)
      out += '?'
      i += name.length
    } else {
      out += ch
      i += 1
    }
  }
  return { sql: out, placeholders }
}

/** True when a property's schema allows only scalars, which a placeholder can be bound to. */
function scalarProperty(schema: unknown): boolean {
  if (!isObject(schema)) return false
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.every((t) => typeof t === 'string' && SCALAR_TYPES.has(t))) return false
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.every((v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
  }
  return schema.type !== undefined
}

/** A query row's template, checked (03 row 3); undefined with `problems` filled when it is broken. */
function queryTemplate(
  config: Record<string, unknown>,
  schema: Record<string, unknown>,
  views: readonly ViewSchema[],
  problems: string[],
): QueryTemplate | undefined {
  const before = problems.length
  for (const key of Object.keys(config)) {
    if (!QUERY_CONFIG_KEYS.has(key)) problems.push(`execution_config uses unsupported key "${key}" (a query row takes sql, param_mapping, format)`)
  }
  const sql = config.sql
  if (typeof sql !== 'string' || sql.trim() === '') problems.push('execution_config.sql must be a non-empty SELECT template')
  const mapping = config.param_mapping
  if (!isObject(mapping)) problems.push('execution_config.param_mapping must be an object of input field → :param ({} when the template has none)')
  if (typeof sql !== 'string' || sql.trim() === '' || !isObject(mapping)) return undefined

  const properties = isObject(schema.properties) ? schema.properties : {}
  const fieldByPlaceholder = new Map<string, string>()
  for (const [field, placeholder] of Object.entries(mapping)) {
    if (typeof placeholder !== 'string' || !PLACEHOLDER.test(placeholder)) {
      problems.push(`execution_config.param_mapping.${field} must be a placeholder such as ":${field}", got ${JSON.stringify(placeholder)}`)
      continue
    }
    if (fieldByPlaceholder.has(placeholder)) {
      problems.push(`execution_config.param_mapping maps both ${fieldByPlaceholder.get(placeholder)} and ${field} to ${placeholder}`)
      continue
    }
    fieldByPlaceholder.set(placeholder, field)
    if (!Object.hasOwn(properties, field)) problems.push(`execution_config.param_mapping maps ${field}, which input_schema does not declare`)
    else if (!scalarProperty(properties[field])) {
      problems.push(`input_schema.properties.${field} must be a string, number, integer, boolean or null to be bound to ${placeholder}`)
    }
  }
  const unmapped = Object.keys(properties).filter((p) => !Object.hasOwn(mapping, p))
  if (unmapped.length > 0) problems.push(`input_schema declares ${unmapped.join(', ')}, which param_mapping does not bind`)

  const rewritten = rewritePlaceholders(sql)
  const used = new Set(rewritten.placeholders)
  for (const placeholder of used) {
    if (!fieldByPlaceholder.has(placeholder)) problems.push(`execution_config.sql uses ${placeholder}, which param_mapping does not map to an input field`)
  }
  for (const [placeholder, field] of fieldByPlaceholder) {
    if (!used.has(placeholder)) problems.push(`execution_config.param_mapping maps ${field} to ${placeholder}, which execution_config.sql never uses`)
  }
  // Gate 2 (views, columns, write words, the wall clock) and Gate 3 (read-only, one statement,
  // LIMIT, one bound value per `?`), the same checks a model's query_sql passes (03 rows 7-8).
  // Both run, so the error lists every problem of the row at once.
  const gates = [() => validateSqlAgainstViews(rewritten.sql, views), () => readOnlySelect(rewritten.sql, rewritten.placeholders.length)]
  for (const gate of gates) {
    try {
      gate()
    } catch (err) {
      if (!(err instanceof GateDenied)) throw err
      problems.push(...err.problems.map((p) => `execution_config.sql fails ${err.gate}: ${p}`))
    }
  }
  if (problems.length > before) return undefined
  return { sql: rewritten.sql, inputs: rewritten.placeholders.map((p) => fieldByPlaceholder.get(p)!) }
}

/** 500 tool_config_error naming the row (03 row 3, 04). */
export class ToolConfigError extends ApiError {
  readonly row: string
  readonly problems: readonly string[]
  constructor(row: string, problems: readonly string[]) {
    super(500, 'tool_config_error', `The assistant tool "${row}" is misconfigured: ${problems.join('; ')}.`, [{ tool: row, problems }])
    this.name = 'ToolConfigError'
    this.row = row
    this.problems = problems
  }
}

/**
 * Validates one enabled row; throws ToolConfigError listing every problem. Pure: `views` are the
 * v_* views with their PRAGMA columns (schema-context.ts), which a query row's SQL is checked against.
 */
export function validateToolRow(row: ToolRow, views: readonly ViewSchema[]): LoadedTool {
  const label = typeof row.name === 'string' && row.name !== '' ? row.name : `id ${row.id}`
  const problems: string[] = []
  if (!TOOL_NAME.test(row.name)) problems.push('name must be 1-64 letters, digits, "_" or "-"')
  if (typeof row.description !== 'string' || row.description.trim() === '') problems.push('description must not be empty')

  const schema = parseJson(row.input_schema, 'input_schema', problems)
  if (schema !== undefined) {
    if (!isObject(schema) || schema.type !== 'object') problems.push('input_schema must be a JSON Schema with "type": "object"')
    problems.push(...schemaProblems(schema, 'input_schema'))
  }
  const config = parseJson(row.execution_config, 'execution_config', problems)
  if (config !== undefined && !isObject(config)) problems.push('execution_config must be a JSON object')

  let handlerName = ''
  let handler: BuiltinHandler | undefined
  let query: QueryTemplate | undefined
  if (row.handler_type === 'builtin') {
    const name = isObject(config) ? config.handler_name : undefined
    if (typeof name !== 'string' || !Object.hasOwn(BUILTIN_HANDLERS, name)) {
      problems.push(`execution_config.handler_name ${JSON.stringify(name)} is not a builtin handler (${Object.keys(BUILTIN_HANDLERS).join(', ')})`)
    } else {
      handlerName = name
      handler = BUILTIN_HANDLERS[name]
      const properties = isObject(schema) && isObject(schema.properties) ? Object.keys(schema.properties) : []
      const unread = properties.filter((p) => !handler!.inputKeys.includes(p))
      if (unread.length > 0) problems.push(`input_schema declares ${unread.join(', ')}, which handler ${name} does not read`)
    }
  } else if (row.handler_type === 'query') {
    if (isObject(config)) {
      query = queryTemplate(config, isObject(schema) ? schema : {}, views, problems)
      if (query !== undefined) {
        handlerName = row.name
        handler = queryHandler(row.name, query)
      }
    }
  } else if (row.handler_type === 'passthrough') {
    problems.push('handler_type passthrough has no executor in this build')
  } else {
    problems.push(`handler_type ${JSON.stringify(row.handler_type)} is not builtin, query or passthrough`)
  }

  if (problems.length > 0 || handler === undefined || !isObject(schema)) throw new ToolConfigError(label, problems)
  return {
    id: row.id,
    name: row.name,
    definition: { name: row.name, description: row.description, input_schema: schema as ModelTool['input_schema'] },
    handlerType: row.handler_type === 'query' ? 'query' : 'builtin',
    handlerName,
    handler,
    ...(query === undefined ? {} : { query }),
  }
}

/** Validates the enabled rows in order; the first failing row stops the load. Pure. */
export function toLoadedTools(rows: readonly ToolRow[], views: readonly ViewSchema[]): LoadedTools {
  if (rows.length === 0) throw new ApiError(500, 'no_tools', 'The assistant has no enabled tools, so it cannot answer. Run `npm run tools:seed`.')
  const tools = rows.map((row) => validateToolRow(row, views))
  return { tools, definitions: tools.map((t) => t.definition), byName: new Map(tools.map((t) => [t.name, t])) }
}

let cached: { key: string; tools: LoadedTools } | undefined

/** The enabled assistant_tools rows, validated (03 row 3). Throws 500 no_tools or tool_config_error. */
export async function loadTools(db: D1Database): Promise<LoadedTools> {
  const { results } = await db
    .prepare(
      `SELECT id, name, description, input_schema, handler_type, execution_config, sort_order
       FROM assistant_tools WHERE enabled = 1 ORDER BY sort_order, name`,
    )
    .all<ToolRow>()
  const key = JSON.stringify(results)
  if (cached !== undefined && cached.key === key) return cached.tools
  // The views are read only when a row needs them; their columns are cached per isolate (03 row 4).
  const views = results.some((row) => row.handler_type === 'query') ? await viewSchemas(db) : []
  const tools = toLoadedTools(results, views)
  cached = { key, tools }
  return tools
}
