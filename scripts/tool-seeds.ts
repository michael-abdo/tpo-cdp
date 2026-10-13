/**
 * The assistant_tools rows the MVP seeds (03 §Gateway layers row 9; 09 D-41; drafts in 14 §4.2,
 * same `ToolSeed` shape as the origin's seed-chatbot-tools.ts L31-38). Data only: the Worker
 * never imports this file. Tools are rows (CLAUDE.md "Tools are data"): the loader
 * (worker/assistant/tools/tool-loader.ts) reads them from D1 and validates every enabled row.
 * `npm run tools:seed` (scripts/seed-assistant-tools.ts) writes them; tests insert the same rows
 * through `toolSeedInsert`.
 *
 * Changes from the 14 §4.2 drafts:
 * - `segment` takes exactly the 04 §/api/segments/preview `filters` object (04: "the assistant's
 *   segment tool takes exactly this filters object"), not the draft's own field set.
 * - `aggregate` takes `status` and `source` lists like the segment filters, so "Instagram signups"
 *   and the unsubscribed default (02 §Defaults) mean the same thing in both tools. Its metrics
 *   are the ones builtin-handlers.ts computes over the v_* views. The draft's
 *   `engagement_buckets` is not seeded (09 D-56): 02 §Derived defines no buckets, and bucket
 *   edges in SQL would be a second formula (D-46). "Most engaged" is the segment tool's
 *   ranking instead: its rows come out by stored engagement_score, highest first.
 * - `query_sql`, `describe_schema`, the `query` row and `open_segment` are not seeded here:
 *   `query_sql` and the `query` handler type come with Gate 2/3 (16, Friday); `describe_schema`
 *   and the `passthrough` type are not in 16 §MVP scope.
 */

import type { SqlValue } from '../worker/ingest/sql'

export interface ToolSeed {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handlerType: 'builtin' | 'query' | 'passthrough'
  executionConfig: Record<string, unknown>
  sortOrder: number
}

export const TOOL_SEEDS: readonly ToolSeed[] = [
  {
    name: 'segment',
    description:
      'Count and list a subscriber segment, exactly as the segment builder does. Returns the count, how many ' +
      'unsubscribed profiles the status filter hides, and up to 10 rows referenced by pseudonymous keys (pk_…), ' +
      'listed most engaged first (the stored engagement_score, highest first). ' +
      'Use for "who/which subscribers…" questions, for "most engaged readers" (no extra filters; the rows are the ' +
      'ranking), and whenever the teammate may want to open or export the list. ' +
      'Status defaults to ["active"]. days_since_open_gte is the brief\'s "no open in N days" filter, not "cold". ' +
      'Never invent filters the user did not ask for.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'array',
          items: { type: 'string', enum: ['active', 'unsubscribed'] },
          minItems: 1,
          description: 'Default ["active"]. Add "unsubscribed" only when the teammate asks for them.',
        },
        source: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Signup sources, e.g. ["instagram"]. Absent = any source.',
        },
        days_since_open_gte: {
          type: 'integer',
          minimum: 1,
          description: 'No email open in at least this many days (the "no open in N days" definition).',
        },
        include_never_opened: {
          type: 'boolean',
          description: 'With days_since_open_gte, also include everyone who never opened. Default false.',
        },
        has_app: {
          type: ['boolean', 'null'],
          description: 'true = has an app account, false = has none, null or absent = either.',
        },
      },
    },
    handlerType: 'builtin',
    executionConfig: { handler_name: 'segment' },
    sortOrder: 10,
  },
  {
    name: 'aggregate',
    description:
      'Grouped counts over the PII-free views. Metrics: subscribers (by signup date), cold (cold as of today), ' +
      'went_cold (cold_since inside the window, the went_cold_in definition), source_to_app (app account created ' +
      'after signup), visitor_to_subscriber (site visitors by first page or first UTM source), app_events (by event ' +
      'type). States the window, the status filter and the definitions it used. For "went cold last month" use ' +
      'metric went_cold with the last-month window.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          enum: ['subscribers', 'cold', 'went_cold', 'source_to_app', 'visitor_to_subscriber', 'app_events'],
        },
        group_by: {
          type: 'string',
          enum: ['none', 'source', 'signup_month', 'cold_month', 'first_page', 'utm_source', 'event'],
          description: 'Default none. Allowed values depend on the metric.',
        },
        status: {
          type: 'array',
          items: { type: 'string', enum: ['active', 'unsubscribed'] },
          minItems: 1,
          description: 'Subscriber metrics only. Default ["active"].',
        },
        source: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Subscriber metrics only: signup sources, e.g. ["instagram"].',
        },
        window_from: { type: 'string', description: 'ISO date, inclusive. "last month" = the previous calendar month.' },
        window_to: { type: 'string', description: 'ISO date, inclusive. Give both window ends or neither.' },
      },
      required: ['metric'],
    },
    handlerType: 'builtin',
    executionConfig: { handler_name: 'aggregate' },
    sortOrder: 20,
  },
]

/** assistant_tools columns written by the seed, in the order of `toolSeedValues`. */
const COLUMNS = ['id', 'name', 'description', 'input_schema', 'handler_type', 'execution_config', 'enabled', 'sort_order'] as const

/** The row values for one seed; `id` is a fresh uuid (14 §4.1: crypto.randomUUID() from the seed script). */
export function toolSeedValues(seed: ToolSeed, id: string): SqlValue[] {
  return [
    id,
    seed.name,
    seed.description,
    JSON.stringify(seed.inputSchema),
    seed.handlerType,
    JSON.stringify(seed.executionConfig),
    1,
    seed.sortOrder,
  ]
}

/**
 * One INSERT, idempotent by `name` (11 §Scripts): an existing row of that name is left as it is,
 * so a re-seed never overwrites a row a teammate edited (the origin's onConflictDoNothing, 14 §2.4).
 * `values` is either `?` placeholders or rendered literals. created_at/updated_at are the time
 * the row was written, taken in SQL: operational metadata on the 02 §Time wall-clock allow-list.
 */
export function toolSeedSql(values: readonly string[]): string {
  if (values.length !== COLUMNS.length) throw new Error(`tool-seeds: expected ${COLUMNS.length} values, got ${values.length}`)
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
  return (
    `INSERT INTO assistant_tools (${COLUMNS.join(', ')}, created_at, updated_at) ` +
    `VALUES (${values.join(', ')}, ${now}, ${now}) ON CONFLICT(name) DO NOTHING`
  )
}

/** The bound form of one seed row, for D1 `prepare(sql).bind(...params)`. */
export function toolSeedInsert(seed: ToolSeed): { sql: string; params: SqlValue[] } {
  return { sql: toolSeedSql(COLUMNS.map(() => '?')), params: toolSeedValues(seed, crypto.randomUUID()) }
}
