/**
 * The assistant_tools rows the seed writes: the MVP's four and the parked describe_schema (03
 * §Gateway layers row 9; 09 D-41; 16 §If time remains item 1; drafts in 14 §4.2, same
 * `ToolSeed` shape as the origin's seed-chatbot-tools.ts L31-38). Data only: the Worker
 * never imports this file. Tools are rows (CLAUDE.md "Tools are data"): the loader
 * (worker/assistant/tools/tool-loader.ts) reads them from D1 and validates every enabled row.
 * `npm run tools:seed` (scripts/seed-assistant-tools.ts) writes them; tests insert the same rows
 * through `toolSeedInsert`.
 *
 * Changes from the 14 §4.2 drafts:
 * - `segment` takes exactly the 04 §/api/segments/preview `filters` object (04: "the assistant's
 *   segment tool takes exactly this filters object"), not the draft's own field set. Its
 *   properties are the contract fragment of shared/segment-filters.ts (19 §5.5, 09 D-69), so
 *   `source` is the canonical enum and every string key has an enum or a pattern.
 * - `aggregate` takes `status` and `source` lists like the segment filters, so "Instagram signups"
 *   and the unsubscribed default (02 §Defaults) mean the same thing in both tools. Its metrics
 *   are the ones builtin-handlers.ts computes over the v_* views. The draft's
 *   `engagement_buckets` is not seeded (09 D-56): 02 §Derived defines no buckets, and bucket
 *   edges in SQL would be a second formula (D-46). "Most engaged" is the segment tool's
 *   ranking instead: its rows come out by stored engagement_score, highest first.
 * - `query_sql` names only the views 01 §PII-free views defines (the draft listed views that do not
 *   exist) and states the rules Gates 2 and 3 enforce, so the model can write a query that passes
 *   them the first time (03 rows 7-8). Its input is exactly the draft's `sql` and `explanation`.
 * - `pages_new_subscribers_hit_first` is the one `query` row (03 row 9, 09 D-41, 16 §MVP scope):
 *   the live proof that a question type is a row, not a deploy. It answers the brief's "which
 *   pages do new subscribers hit first?" (R5.2): the first page of each new subscriber (02
 *   §Derived `new_subscriber`, 09 D-36), counted by page. Its window is rendered from TODAY when
 *   this file loads (`NEW_SUBSCRIBER_WINDOW`) and checked against `DEFINITIONS.new_subscriber.fn`,
 *   so the row's dates cannot drift from the definition. Its one input,
 *   `include_unsubscribed`, is bound through param_mapping; absent, the template keeps the
 *   unsubscribed default (02 §Defaults).
 * - `describe_schema` (16 §If time remains item 1) keeps the draft's optional `view` input. It
 *   returns the v_* view names and their PRAGMA columns with declared types (01 §PII-free views),
 *   never a row, so the description says "columns" where the draft said "columns and meaning":
 *   meanings live in DEFINITIONS, which the system prompt renders (02 §Derived).
 * - `open_segment` is not seeded: it and the `passthrough` type are parked (16 §If time remains).
 */

import { TODAY } from '../shared/config'
import { addDays, DEFINITIONS, type DateWindow, lastNDays } from '../shared/derive'
import { FILTER_KEYS, FILTER_SCHEMA, type FilterKey } from '../shared/segment-filters'
import type { SqlValue } from '../worker/ingest/sql'

export interface ToolSeed {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handlerType: 'builtin' | 'query' | 'passthrough'
  executionConfig: Record<string, unknown>
  sortOrder: number
}

/**
 * The `new_subscriber` window as dates (02 §Derived: TODAY − 30 .. TODAY). Fails at load unless
 * `DEFINITIONS.new_subscriber.fn` holds both ends and neither day outside them.
 */
export const NEW_SUBSCRIBER_WINDOW: DateWindow = (() => {
  const window = lastNDays(30)
  const isNew = DEFINITIONS.new_subscriber.fn
  if (!isNew(window.from) || !isNew(window.to) || isNew(addDays(window.from, -1)) || isNew(addDays(window.to, 1))) {
    throw new Error(`tool-seeds: ${window.from}..${window.to} is not the new_subscriber window of shared/derive.ts`)
  }
  return window
})()

/** What each filter means to the model; the limits and patterns come from FILTER_SCHEMA. */
const FILTER_DESCRIPTIONS: { readonly [K in FilterKey]: string } = {
  status: 'Default ["active"]. Add "unsubscribed" only when the teammate asks for them.',
  source: 'Acquisition sources, e.g. ["instagram"]. Absent = any source.',
  days_since_open_gte: 'No email open in at least this many days (the "no open in N days" definition).',
  include_never_opened: 'With days_since_open_gte, also include everyone who never opened. Default false.',
  went_cold: `"any" = cold now (the cold definition); "YYYY-MM" = went cold in that month (went_cold_in), no month after ${TODAY.slice(0, 7)}.`,
  signed_up_within_days: 'Signed up in the last N days including today (30 = the new_subscriber definition).',
  engagement_gte: 'Stored engagement_score at least this (0–100).',
  engagement_lte: 'Stored engagement_score at most this (0–100); not below engagement_gte.',
  has_app: 'true = has an app account, false = has none, null or absent = either.',
  site_visit_within_days: 'Visited the site in the last N days.',
  site_visit_page: 'Visited this page path, e.g. "/shadrachs-picks"; with site_visit_within_days, inside that window.',
  app_active_within_days: 'Sent any app event in the last N days.',
  app_event: 'Sent this app event; with app_active_within_days, inside that window.',
}

/**
 * The segment tool's input_schema properties: exactly the filter contract (shared/segment-filters.ts
 * FILTER_SCHEMA, 19 §5.5), in FILTER_KEYS order, each with its description.
 */
export const SEGMENT_PROPERTIES: Record<string, Record<string, unknown>> = Object.fromEntries(
  FILTER_KEYS.map((key) => [key, { ...FILTER_SCHEMA[key], description: FILTER_DESCRIPTIONS[key] }]),
)

export const TOOL_SEEDS: readonly ToolSeed[] = [
  {
    name: 'segment',
    description:
      'Count and list a subscriber segment, exactly as the segment builder does. Returns the count, how many ' +
      'unsubscribed profiles the status filter hides, and up to 10 rows referenced by pseudonymous keys (pk_…), ' +
      'listed most engaged first (the stored engagement_score, highest first). ' +
      'Use for "who/which subscribers…" questions, for "most engaged readers" (no extra filters; the rows are the ' +
      'ranking), and whenever the teammate may want to open or export the list. ' +
      'Status defaults to ["active"]. days_since_open_gte is the brief\'s "no open in N days" filter, not "cold"; ' +
      'to list subscribers who went cold use went_cold ("any" = cold now, or a month "YYYY-MM"); for a month it ' +
      'matches the count aggregate went_cold gives over that month. ' +
      'Every filter given must hold (AND). Never invent filters the user did not ask for.',
    inputSchema: {
      type: 'object',
      properties: SEGMENT_PROPERTIES,
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
  {
    name: 'query_sql',
    description:
      'Run ONE read-only SQLite SELECT over the PII-free views v_profiles, v_web_events, v_app_events, v_funnel and ' +
      'v_source_app_conversion (columns in the system prompt). Subjects appear only as pk_… keys. Use only when ' +
      'segment and aggregate cannot answer. The server refuses the query unless: it starts with SELECT; it is one ' +
      'statement with no ";"; it has no WITH, PRAGMA, ATTACH or comments; it reads only those views and their columns, ' +
      'written plainly without quotes; every computed column is named with AS; dates are literals counted from TODAY ' +
      '(never \'now\' or CURRENT_DATE); date(), datetime(), julianday() and strftime() take a \'YYYY-MM-DD\' literal or a ' +
      'date column (signup_date, last_open_date, cold_since, app_created_at, event_ts) as their time value, never ' +
      `nothing or an expression. "Cold" is the stored ${DEFINITIONS.cold.formula} and engagement is the stored ` +
      'engagement_score; never re-derive them. At most 100 rows come back: a missing or larger LIMIT becomes LIMIT 100. ' +
      'Exclude unsubscribed profiles (status = \'active\') unless the teammate asks for them. Never show the SQL to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', minLength: 1, description: 'A single read-only SELECT over the v_* views above.' },
        explanation: { type: 'string', minLength: 1, description: 'One line: what the query answers.' },
      },
      required: ['sql', 'explanation'],
    },
    handlerType: 'builtin',
    executionConfig: { handler_name: 'query_sql' },
    sortOrder: 30,
  },
  {
    name: 'pages_new_subscribers_hit_first',
    description:
      'Which pages new subscribers hit first: for every new subscriber, the first page of their first tracked site ' +
      'visit, counted by page, most common first. ' +
      `New subscriber (signup_date ${NEW_SUBSCRIBER_WINDOW.from} to ${NEW_SUBSCRIBER_WINDOW.to}): ${DEFINITIONS.new_subscriber.doc} ` +
      'A row with an empty first_page counts the new subscribers with no tracked site visit. ' +
      'Active subscribers only unless include_unsubscribed is true. Say the window and the definition in the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        include_unsubscribed: {
          type: 'boolean',
          description: 'Default false. true only when the teammate asks to include unsubscribed subscribers.',
        },
      },
    },
    handlerType: 'query',
    executionConfig: {
      sql:
        'SELECT first_page, count(*) AS new_subscribers FROM v_profiles ' +
        `WHERE signup_date BETWEEN '${NEW_SUBSCRIBER_WINDOW.from}' AND '${NEW_SUBSCRIBER_WINDOW.to}' ` +
        "AND (status = 'active' OR :include_unsubscribed = 1) " +
        'GROUP BY first_page ORDER BY new_subscribers DESC, first_page',
      param_mapping: { include_unsubscribed: ':include_unsubscribed' },
      format: 'markdown_table',
    },
    sortOrder: 40,
  },
  {
    name: 'describe_schema',
    description:
      'List the PII-free views (v_*) and their columns with declared types, read from the database. Returns names ' +
      'and types only, never rows. Give view to describe one view; leave it out for all of them. Use it to check a ' +
      "view's exact column names before writing query_sql; it answers no data question by itself.",
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', minLength: 1, description: 'One view name, e.g. v_profiles. Absent = every view.' },
      },
    },
    handlerType: 'builtin',
    executionConfig: { handler_name: 'describe_schema' },
    sortOrder: 50,
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

/**
 * The columns a seed defines and a re-seed compares (09 D-69: a schema change must reach a row that
 * already exists). `enabled` and `sort_order` are left out: a teammate may disable or reorder a row.
 */
export const SEEDED_FIELDS = ['description', 'input_schema', 'handler_type', 'execution_config'] as const
export type SeededField = (typeof SEEDED_FIELDS)[number]

/** An assistant_tools row as read back: its name and the seeded columns, as stored. */
export type StoredToolRow = { name: string } & { [F in SeededField]: string }

/** JSON with every object's keys sorted, so two equal schemas compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}


/**
 * The seeded rows whose stored columns differ from TOOL_SEEDS, each with the fields that differ, in
 * TOOL_SEEDS order. Pure. A row the table lacks is not listed here (the read-back names it as
 * missing). The insert never overwrites (`toolSeedSql`), so `npm run tools:seed` uses this to fail
 * loud on a row a newer seed changed, such as the `segment` row before D-69's keys.
 */
export function staleToolRows(rows: readonly StoredToolRow[]): { name: string; fields: SeededField[] }[] {
  const byName = new Map(rows.map((r) => [r.name, r]))
  const stale: { name: string; fields: SeededField[] }[] = []
  for (const seed of TOOL_SEEDS) {
    const row = byName.get(seed.name)
    if (row === undefined) continue
    const want: { [F in SeededField]: string } = {
      description: seed.description,
      input_schema: canonicalJson(seed.inputSchema),
      handler_type: seed.handlerType,
      execution_config: canonicalJson(seed.executionConfig),
    }
    // assistant_tools CHECKs json_valid on both JSON columns (0001_core.sql), so the parse cannot fail on a stored row.
    const have: { [F in SeededField]: string } = {
      description: row.description,
      input_schema: canonicalJson(JSON.parse(row.input_schema)),
      handler_type: row.handler_type,
      execution_config: canonicalJson(JSON.parse(row.execution_config)),
    }
    const fields = SEEDED_FIELDS.filter((f) => have[f] !== want[f])
    if (fields.length > 0) stale.push({ name: seed.name, fields })
  }
  return stale
}

/** The UPDATE values of one seed, in `toolSeedUpdateSql` order: the seeded columns, then the name. */
export function toolSeedUpdateValues(seed: ToolSeed): SqlValue[] {
  return [seed.description, JSON.stringify(seed.inputSchema), seed.handlerType, JSON.stringify(seed.executionConfig), seed.name]
}

/**
 * Overwrites one existing row's seeded columns with its seed (`npm run tools:seed -- … --update
 * <name>`, the explicit opt-in). `enabled` and `sort_order` stay as they are; updated_at is the
 * write time, as in `toolSeedSql`.
 */
export function toolSeedUpdateSql(values: readonly string[]): string {
  if (values.length !== SEEDED_FIELDS.length + 1) throw new Error(`tool-seeds: expected ${SEEDED_FIELDS.length + 1} values, got ${values.length}`)
  const set = SEEDED_FIELDS.map((f, i) => `${f} = ${values[i]}`).join(', ')
  return `UPDATE assistant_tools SET ${set}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ${values[SEEDED_FIELDS.length]}`
}

/** The bound form of one seed's update. */
export function toolSeedUpdate(seed: ToolSeed): { sql: string; params: SqlValue[] } {
  return { sql: toolSeedUpdateSql([...SEEDED_FIELDS, 'name'].map(() => '?')), params: toolSeedUpdateValues(seed) }
}
