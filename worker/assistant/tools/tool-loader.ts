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
//   - `query` and `passthrough` rows are refused by name: their executors are not built yet
//     (`query` comes with Gate 2/3, 16 Friday; `passthrough` is parked, 16)
// No enabled row → 500 `no_tools` (04).
//
// Cache (03 §No-restart): the enabled rows are read on every request, a few small rows; the
// validated tool set is cached per isolate, keyed by those rows' exact contents. An inserted,
// edited or disabled row therefore takes effect on the next request with no deploy (D-41),
// while an unchanged table is not validated again. Nothing about subscribers is cached.

import { ApiError } from '../../auth/middleware'
import type { ModelTool } from '../build-request'
import { BUILTIN_HANDLERS, type BuiltinHandler } from './builtin-handlers'

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
  handlerType: 'builtin'
  handlerName: string
  handler: BuiltinHandler
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
  'additionalProperties',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** Validates one enabled row; throws ToolConfigError listing every problem. Pure. */
export function validateToolRow(row: ToolRow): LoadedTool {
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
  } else if (row.handler_type === 'query' || row.handler_type === 'passthrough') {
    problems.push(`handler_type ${row.handler_type} has no executor in this build`)
  } else {
    problems.push(`handler_type ${JSON.stringify(row.handler_type)} is not builtin, query or passthrough`)
  }

  if (problems.length > 0 || handler === undefined || !isObject(schema)) throw new ToolConfigError(label, problems)
  return {
    id: row.id,
    name: row.name,
    definition: { name: row.name, description: row.description, input_schema: schema as ModelTool['input_schema'] },
    handlerType: 'builtin',
    handlerName,
    handler,
  }
}

/** Validates the enabled rows in order; the first failing row stops the load. Pure. */
export function toLoadedTools(rows: readonly ToolRow[]): LoadedTools {
  if (rows.length === 0) throw new ApiError(500, 'no_tools', 'The assistant has no enabled tools, so it cannot answer. Run `npm run tools:seed`.')
  const tools = rows.map(validateToolRow)
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
  const tools = toLoadedTools(results)
  cached = { key, tools }
  return tools
}
