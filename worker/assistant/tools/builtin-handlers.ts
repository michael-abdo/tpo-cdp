// The static registry of builtin tool handlers (design 03 §Gateway layers row 9; 14 §2.3, §4
// "builtin-handlers.ts: replace"). An assistant_tools row with handler_type `builtin` names one
// of these by `execution_config.handler_name`; the loader refuses a row that names anything else
// (tool-loader.ts, 09 D-41). The rows themselves are data (scripts/tool-seeds.ts); this file only
// holds the code they may point at. The executor has already passed every call through Gate 2's
// authorizeToolCall (input_schema) before a handler runs (tool-executor.ts, 03 row 7).
//
// Every handler returns pk_ keys, never an email or a raw id (05 §Strategy). The executor scans
// each result before the model sees it (tool-executor.ts, 03 row 9).
//
// - `segment` takes exactly the 04 §/api/segments/preview filters object, parsed by the builder's
//   parseFilters and compiled by the builder's WHERE translation (compileModelSegment in
//   worker/segments/compile.ts) over v_profiles, so it reads only a PII-free view (05 §Exactly
//   what the model receives, "Structural"; 07 §H) and applies the builder's rules. Its count and
//   hidden-unsubscribed count equal the builder's (T-AI-3 pins 177 / 55). Rows come out most
//   engaged first (stored engagement_score descending, then pkey; 09 D-56), the path for "our
//   most engaged readers" (R5.2).
// - `aggregate` also reads only v_* views. Every value is a bound parameter; every SQL fragment
//   comes from the fixed METRICS table below, never from the input. Cold comparisons use the
//   `DEFINITIONS.cold.sql` fragment from shared/derive.ts, the one runtime source (02 §Derived).
// - `query_sql` runs one SELECT the model wrote (the origin's query_data, 14 §1.2, §4.2): Gate 2's
//   validateSqlAgainstViews (views only, no write keywords, PRAGMA-checked columns), then Gate 3's
//   runReadOnlySelect (SELECT only, one statement, LIMIT ≤ 100, one attempt). It can read only
//   the v_* views, which select pkey and visitor_hash (both pk_ keys, 05 §Pseudonymous key) and
//   no PII column (01 §PII denylist), so its rows reference subjects by pk_ keys only (T-AI-2);
//   the executor's scan is the second, independent check (05 §Scanner).
//
// - `describe_schema` (14 §4.2 draft, the origin's explain_database_schema; 16 §If time remains
//   item 1) returns the v_* view names and their PRAGMA columns with declared types, as
//   schema-context.ts discovered them (it refuses any view that selects a 01 §PII denylist
//   column). It reads no row of any view or table, so the result holds names and types only; the
//   executor's scan still runs on it. The same lists are in the system prompt (05 §What the model
//   receives item 1); the tool lets the model re-read one view's exact columns before query_sql.
//
// `queryHandler` is not in the registry: it runs an assistant_tools row of handler_type `query`
// (03 row 9, 09 D-41), the way Growth adds a question type as a row with no deploy. The loader
// has already checked the row's template and rewritten its `:name` placeholders to `?`
// (tool-loader.ts); here each `?` is bound from the input field mapped to it, never spliced into
// the text, and the SQL goes through Gate 2's validateSqlAgainstViews and Gate 3's
// runReadOnlySelect exactly like query_sql. Like query_sql it reads only the v_* views, so its
// rows reference subjects by pk_ keys only (T-AI-8), and the executor scans the result.

import { z } from 'zod'
import { TODAY } from '../../../shared/config'
import { DEFINITIONS, type DefinitionKey } from '../../../shared/derive'
import { canonicalSource } from '../../../shared/normalize'
import { ApiError } from '../../auth/middleware'
import { isIsoDate, SUBSCRIBER_STATUSES, type SubscriberStatus } from '../../ingest/quarantine'
import type { SqlValue } from '../../ingest/sql'
import { PREVIEW_DEFAULT_LIMIT } from '../../routes/segments'
import { validateSqlAgainstViews } from '../gates/gate2-tool-authorizer'
import { type ReadOnlyResult, runReadOnlySelect, SqlRunError } from '../gates/gate3-readonly-sql'
import { viewSchemas } from '../schema-context'
import {
  type CompiledModelSegment,
  compileModelSegment,
  FILTER_KEYS,
  hiddenUnsubscribedFilters,
  MODEL_SEGMENT_COLUMNS,
  parseFilters,
  type SegmentFilters,
} from '../../segments/compile'

export type Cell = string | number | boolean | null
export type ResultRow = Record<string, Cell>

/** One tool's result: the full rows kept server-side for the UI table (04, 09 D-42) and a summary for the model. */
export interface ToolOutput {
  tool: string
  columns: string[]
  rows: ResultRow[]
  /** How many rows the result describes; for a segment, its count, of which `rows` holds the first ones. */
  total_rows: number
  /** Shown to the model as JSON: counts, the filters and window applied, the definitions used. */
  summary: Record<string, unknown>
  /** Set by the segment handler: the filters as validated and the builder's count. */
  segment?: { filters: SegmentFilters; count: number }
  /** Set by query_sql: the SQL that ran, LIMIT forced (ai_audit.sql, 01). */
  sql?: string
}

/**
 * Input the model sent that the handler cannot run, or a query the database refused. Goes back
 * to the model once as an error result, not a 500. `code` heads the ai_audit error.
 */
export class ToolInputError extends Error {
  readonly problems: readonly string[]
  readonly code: 'invalid_input' | 'query_failed'
  /** The SQL concerned, for ai_audit.sql; null when the call ran none. */
  readonly sql: string | null
  constructor(problems: readonly string[], options: { code?: 'invalid_input' | 'query_failed'; sql?: string } = {}) {
    super(`invalid tool input: ${problems.join('; ')}`)
    this.name = 'ToolInputError'
    this.problems = problems
    this.code = options.code ?? 'invalid_input'
    this.sql = options.sql ?? null
  }
}

export interface BuiltinHandler {
  /** The only input keys the handler reads; a row's input_schema may declare no others (tool-loader.ts). */
  inputKeys: readonly string[]
  run(db: D1Database, input: Record<string, unknown>): Promise<ToolOutput>
}

/** `DEFINITIONS.cold.sql` with its `:today` turned into a positional `?`; fails at load if derive.ts changes shape. */
const COLD_SQL = (() => {
  const parts = DEFINITIONS.cold.sql.split(':today')
  if (parts.length !== 2) throw new Error(`builtin-handlers: DEFINITIONS.cold.sql must hold exactly one :today, got ${JSON.stringify(DEFINITIONS.cold.sql)}`)
  return parts.join('?')
})()

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

// ── segment ──────────────────────────────────────────────────────────────────────────────

interface SegmentKeyRow {
  pkey: string
  status: string
  source: string | null
  signup_date: string
  last_open_date: string | null
  engagement_score: number
  has_app: number
}

async function countModelSegment(db: D1Database, segment: CompiledModelSegment): Promise<number> {
  const n = await db.prepare(segment.countSql).bind(...segment.params).first<number>('n')
  if (n === null) throw new Error('segment tool: count(*) returned no row')
  return n
}

function segmentDefinitions(filters: SegmentFilters): DefinitionKey[] {
  const used: DefinitionKey[] = []
  if (filters.days_since_open_gte !== undefined) used.push('no_open_in_days', 'days_since_open')
  if (filters.has_app !== null) used.push('has_app')
  return used
}

const segmentHandler: BuiltinHandler = {
  inputKeys: FILTER_KEYS,
  async run(db, input) {
    let filters: SegmentFilters
    try {
      filters = parseFilters(input)
    } catch (err) {
      if (err instanceof ApiError) throw new ToolInputError((err.details ?? [err.message]).map(String))
      throw err
    }
    const segment = compileModelSegment(filters)
    const hiddenFilters = hiddenUnsubscribedFilters(filters)
    const [count, hidden, { results }] = await Promise.all([
      countModelSegment(db, segment),
      hiddenFilters === null ? 0 : countModelSegment(db, compileModelSegment(hiddenFilters)),
      db.prepare(`${segment.rowsSql} LIMIT ?`).bind(...segment.params, PREVIEW_DEFAULT_LIMIT).all<SegmentKeyRow>(),
    ])
    const rows = results.map((row): ResultRow => {
      if (row.has_app !== 0 && row.has_app !== 1) throw new Error(`segment tool: has_app must be 0 or 1, got ${JSON.stringify(row.has_app)}`)
      return { ...row, has_app: row.has_app === 1 }
    })
    return {
      tool: 'segment',
      columns: [...MODEL_SEGMENT_COLUMNS],
      rows,
      total_rows: count,
      summary: {
        count,
        hidden_unsubscribed: hidden,
        filters,
        rows_listed: rows.length,
        definitions_used: segmentDefinitions(filters),
      },
      segment: { filters, count },
    }
  },
}

// ── aggregate ────────────────────────────────────────────────────────────────────────────

const METRIC_NAMES = ['subscribers', 'cold', 'went_cold', 'source_to_app', 'visitor_to_subscriber', 'app_events'] as const
const GROUP_NAMES = ['none', 'source', 'signup_month', 'cold_month', 'first_page', 'utm_source', 'event'] as const
type MetricName = (typeof METRIC_NAMES)[number]
type GroupName = (typeof GROUP_NAMES)[number]

interface MetricSpec {
  relation: 'v_profiles' | 'v_funnel' | 'v_app_events'
  /** Subscriber metrics take status (default active, 02 §Defaults) and source; the others take neither. */
  subscriberFilters: boolean
  /** The aggregate columns, fixed SQL. */
  select: string
  /** group_by value → the SQL expression it groups on. `none` is always allowed. */
  groups: Partial<Record<Exclude<GroupName, 'none'>, string>>
  /** The date the window applies to; null = the metric takes no window. */
  windowOn: string | null
  windowRequired: boolean
  /** Applies the `cold` definition as of TODAY. */
  coldOnly: boolean
  definitions: DefinitionKey[]
}

const METRICS: Record<MetricName, MetricSpec> = {
  subscribers: {
    relation: 'v_profiles',
    subscriberFilters: true,
    select: 'count(*) AS subscribers',
    groups: { source: 'source', signup_month: 'substr(signup_date, 1, 7)' },
    windowOn: 'signup_date',
    windowRequired: false,
    coldOnly: false,
    definitions: [],
  },
  cold: {
    relation: 'v_profiles',
    subscriberFilters: true,
    select: 'count(*) AS cold',
    groups: { source: 'source', cold_month: 'substr(cold_since, 1, 7)' },
    windowOn: null,
    windowRequired: false,
    coldOnly: true,
    definitions: ['cold', 'cold_since'],
  },
  went_cold: {
    relation: 'v_profiles',
    subscriberFilters: true,
    select: 'count(*) AS went_cold',
    groups: { source: 'source', cold_month: 'substr(cold_since, 1, 7)' },
    windowOn: 'cold_since',
    windowRequired: true,
    coldOnly: true,
    definitions: ['went_cold_in', 'cold_since'],
  },
  source_to_app: {
    relation: 'v_profiles',
    subscriberFilters: true,
    select:
      'count(*) AS subscribers, sum(app_after_signup) AS with_app_after_signup, ' +
      'round(CAST(sum(app_after_signup) AS REAL) / count(*), 4) AS rate',
    groups: { source: 'source', signup_month: 'substr(signup_date, 1, 7)' },
    windowOn: 'signup_date',
    windowRequired: false,
    coldOnly: false,
    definitions: ['app_after_signup'],
  },
  visitor_to_subscriber: {
    relation: 'v_funnel',
    subscriberFilters: false,
    select: 'sum(visitors) AS visitors, sum(subscribed) AS subscribed, round(CAST(sum(subscribed) AS REAL) / sum(visitors), 4) AS rate',
    groups: { first_page: 'first_page', utm_source: 'first_utm_source' },
    windowOn: null,
    windowRequired: false,
    coldOnly: false,
    definitions: [],
  },
  app_events: {
    relation: 'v_app_events',
    subscriberFilters: false,
    select: 'count(*) AS events',
    groups: { event: 'event' },
    windowOn: 'substr(event_ts, 1, 10)',
    windowRequired: false,
    coldOnly: false,
    definitions: [],
  },
}

const isoDate = z.string().refine(isIsoDate, 'must be a YYYY-MM-DD calendar date')

const AggregateInput = z
  .object({
    metric: z.enum(METRIC_NAMES),
    group_by: z.enum(GROUP_NAMES).optional(),
    status: z.array(z.enum(SUBSCRIBER_STATUSES)).min(1).optional(),
    source: z.array(z.string()).min(1).optional(),
    window_from: isoDate.optional(),
    window_to: isoDate.optional(),
  })
  .strict()

type AggregateArgs = z.infer<typeof AggregateInput>

interface AggregatePlan {
  sql: string
  params: SqlValue[]
  group: GroupName
  status: SubscriberStatus[] | null
  source: string[] | null
  window: { from: string; to: string } | null
  spec: MetricSpec
}

/** Validates the input against the metric and builds one bound SELECT. Pure; exported for tests. */
export function planAggregate(input: unknown): AggregatePlan {
  const parsed = AggregateInput.safeParse(input)
  if (!parsed.success) {
    throw new ToolInputError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`))
  }
  const args: AggregateArgs = parsed.data
  const spec = METRICS[args.metric]
  const problems: string[] = []
  const group = args.group_by ?? 'none'
  const groupExpr = group === 'none' ? null : (spec.groups[group] ?? null)
  if (group !== 'none' && groupExpr === null) {
    problems.push(`group_by ${group} does not apply to ${args.metric}; use ${['none', ...Object.keys(spec.groups)].join(', ')}`)
  }
  if (!spec.subscriberFilters && (args.status !== undefined || args.source !== undefined)) {
    problems.push(`status and source do not apply to ${args.metric}`)
  }
  let source: string[] | null = null
  if (args.source !== undefined) {
    const canonical = args.source.map(canonicalSource)
    if (canonical.some((s) => s === null)) problems.push('source values must not be blank')
    else source = [...new Set(canonical as string[])]
  }
  const hasFrom = args.window_from !== undefined
  if (hasFrom !== (args.window_to !== undefined)) problems.push('give both window_from and window_to, or neither')
  if (hasFrom && spec.windowOn === null) problems.push(`${args.metric} takes no window`)
  if (!hasFrom && spec.windowRequired) problems.push(`${args.metric} needs window_from and window_to`)
  if (hasFrom && args.window_to !== undefined && args.window_from! > args.window_to) problems.push('window_from is after window_to')
  if (problems.length > 0) throw new ToolInputError(problems)

  const where: string[] = []
  const params: SqlValue[] = []
  const status = spec.subscriberFilters ? [...new Set(args.status ?? (['active'] as SubscriberStatus[]))] : null
  if (status !== null) {
    where.push(`status IN (${placeholders(status.length)})`)
    params.push(...status)
  }
  if (source !== null) {
    where.push(`source IN (${placeholders(source.length)})`)
    params.push(...source)
  }
  const window = hasFrom ? { from: args.window_from!, to: args.window_to! } : null
  if (window !== null && spec.windowOn !== null) {
    where.push(`${spec.windowOn} BETWEEN ? AND ?`)
    params.push(window.from, window.to)
  }
  if (spec.coldOnly) {
    where.push(COLD_SQL)
    params.push(TODAY)
  }
  const whereSql = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
  const sql =
    groupExpr === null
      ? `SELECT ${spec.select} FROM ${spec.relation}${whereSql}`
      : `SELECT ${groupExpr} AS ${group}, ${spec.select} FROM ${spec.relation}${whereSql} GROUP BY 1 ORDER BY 1`
  return { sql, params, group, status, source, window, spec }
}

const aggregateHandler: BuiltinHandler = {
  inputKeys: Object.keys(AggregateInput.shape),
  async run(db, input) {
    const plan = planAggregate(input)
    const { results } = await db.prepare(plan.sql).bind(...plan.params).all<ResultRow>()
    const columns = results.length > 0 ? Object.keys(results[0]) : []
    const metric = (input as { metric: MetricName }).metric
    return {
      tool: 'aggregate',
      columns,
      rows: results,
      total_rows: results.length,
      summary: {
        metric,
        group_by: plan.group,
        ...(plan.status === null ? {} : { status: plan.status }),
        ...(plan.source === null ? {} : { source: plan.source }),
        window: plan.window,
        ...(plan.spec.coldOnly ? { today: TODAY } : {}),
        definitions_used: plan.spec.definitions,
        rows: results.length,
      },
    }
  },
}

// ── query_sql ────────────────────────────────────────────────────────────────────────────

const QuerySqlInput = z.object({ sql: z.string().min(1), explanation: z.string().min(1) }).strict()

/** Rows keyed by column name; a query naming two columns alike goes back to the model to fix. */
function namedRows(result: ReadOnlyResult): ResultRow[] {
  const duplicates = result.columns.filter((c, i) => result.columns.indexOf(c) !== i)
  if (duplicates.length > 0) {
    throw new ToolInputError([`two result columns are named ${[...new Set(duplicates)].join(', ')}; give each column its own name with AS`], {
      sql: result.sql,
    })
  }
  return result.rows.map((cells) => Object.fromEntries(result.columns.map((c, i) => [c, cells[i]])) as ResultRow)
}

/** Gate 3 runs the SQL once; a database refusal goes back to the model as query_failed. */
async function runChecked(db: D1Database, sql: string, params: readonly SqlValue[] = []): Promise<ReadOnlyResult> {
  try {
    return await runReadOnlySelect(db, sql, params)
  } catch (err) {
    if (err instanceof SqlRunError) throw new ToolInputError([err.message], { code: 'query_failed', sql: err.sql })
    throw err
  }
}

const querySqlHandler: BuiltinHandler = {
  inputKeys: Object.keys(QuerySqlInput.shape),
  async run(db, input) {
    const parsed = QuerySqlInput.safeParse(input)
    if (!parsed.success) {
      throw new ToolInputError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`))
    }
    const { sql, explanation } = parsed.data
    // Gate 2 (throws GateDenied) against the views' PRAGMA columns, then Gate 3, which runs it once.
    validateSqlAgainstViews(sql, await viewSchemas(db))
    const result = await runChecked(db, sql)
    const rows = namedRows(result)
    return {
      tool: 'query_sql',
      columns: result.columns,
      rows,
      total_rows: rows.length,
      summary: {
        explanation,
        rows: rows.length,
        row_limit: result.limit,
        // At the limit the query may have matched more rows than it returned.
        may_have_more_rows: rows.length === result.limit,
      },
      sql: result.sql,
    }
  },
}

// ── describe_schema ──────────────────────────────────────────────────────────────────────

const DescribeSchemaInput = z.object({ view: z.string().min(1).optional() }).strict()

/** Result columns of describe_schema: one row per view column. */
export const DESCRIBE_SCHEMA_COLUMNS = ['view', 'column', 'type'] as const

const describeSchemaHandler: BuiltinHandler = {
  inputKeys: Object.keys(DescribeSchemaInput.shape),
  async run(db, input) {
    const parsed = DescribeSchemaInput.safeParse(input)
    if (!parsed.success) {
      throw new ToolInputError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`))
    }
    const all = await viewSchemas(db)
    const wanted = parsed.data.view
    const views = wanted === undefined ? all : all.filter((v) => v.name === wanted)
    // The problem names the views that exist, never echoes what the model sent.
    if (views.length === 0) throw new ToolInputError([`view must be one of ${all.map((v) => v.name).join(', ')}, or absent for all of them`])
    const rows = views.flatMap((v) => v.columns.map((c): ResultRow => ({ view: v.name, column: c.name, type: c.type })))
    return {
      tool: 'describe_schema',
      columns: [...DESCRIBE_SCHEMA_COLUMNS],
      rows,
      total_rows: rows.length,
      summary: {
        // The full answer for the model: the table below shows it only the first rows (format-results.ts).
        views: Object.fromEntries(views.map((v) => [v.name, v.columns.map((c) => (c.type === '' ? c.name : `${c.name} ${c.type}`))])),
        note: 'Names and declared types only; computed columns have no declared type. No rows were read.',
      },
    }
  },
}

// ── query rows ───────────────────────────────────────────────────────────────────────────

/** A query row's template as the loader checked it (tool-loader.ts). */
export interface QueryTemplate {
  /** The row's SQL with every `:name` placeholder rewritten to `?` (09 D-45). */
  sql: string
  /** The input field bound to each `?`, in order; a field used twice appears twice. */
  inputs: readonly string[]
}

/** One input value as D1 binds it: absent → NULL, a boolean → 1 or 0 (SQLite has no boolean). */
function boundValue(field: string, value: unknown): SqlValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' || typeof value === 'number') return value
  // The loader allows only scalar properties and Gate 2 checked the input against them.
  throw new Error(`query row: input ${field} is ${typeof value}, which no placeholder can take`)
}

/**
 * The handler for one `query` row (03 row 9): binds the mapped inputs to the template's `?`
 * markers and runs it through Gate 2 and Gate 3. `name` is the row's name.
 */
export function queryHandler(name: string, template: QueryTemplate): BuiltinHandler {
  const inputKeys = [...new Set(template.inputs)]
  return {
    inputKeys,
    async run(db, input) {
      const params = template.inputs.map((field) => boundValue(field, input[field]))
      // The loader ran Gate 2 on this text already; it runs again here so a query row's SQL
      // never reaches D1 without both gates in the same call (03 rows 7-8).
      validateSqlAgainstViews(template.sql, await viewSchemas(db))
      const result = await runChecked(db, template.sql, params)
      const rows = namedRows(result)
      return {
        tool: name,
        columns: result.columns,
        rows,
        total_rows: rows.length,
        summary: {
          inputs: Object.fromEntries(inputKeys.map((field) => [field, input[field] ?? null])),
          rows: rows.length,
          row_limit: result.limit,
          may_have_more_rows: rows.length === result.limit,
        },
        sql: result.sql,
      }
    },
  }
}

/** Handler names an assistant_tools `builtin` row may use (03 row 9). */
export const BUILTIN_HANDLERS: Readonly<Record<string, BuiltinHandler>> = {
  segment: segmentHandler,
  aggregate: aggregateHandler,
  query_sql: querySqlHandler,
  describe_schema: describeSchemaHandler,
}
