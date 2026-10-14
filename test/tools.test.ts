import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { NEW_SUBSCRIBER_WINDOW, type StoredToolRow, staleToolRows, TOOL_SEEDS, type ToolSeed, toolSeedInsert, toolSeedUpdate } from '../scripts/tool-seeds'
import { TODAY } from '../shared/config'
import { DEFINITIONS } from '../shared/derive'
import { EMAIL_REGEX, PII_COLUMNS } from '../shared/pii'
import { startTrace } from '../worker/assistant/audit/ai-audit'
import { authorizeToolCall } from '../worker/assistant/gates/gate2-tool-authorizer'
import { type ViewSchema, viewSchemas } from '../worker/assistant/schema-context'
import { queryHandler } from '../worker/assistant/tools/builtin-handlers'
import { executeToolCall, UNKNOWN_TOOL_ERROR } from '../worker/assistant/tools/tool-executor'
import { loadTools, rewritePlaceholders, schemaProblems, type ToolRow, ToolConfigError, validateToolRow } from '../worker/assistant/tools/tool-loader'
import { seedDatabase } from './helpers/seed'

// T-AI-1 and T-AI-8 (08, band A Fri). Designs: 03 §Gateway layers rows 3 and 9 ("this is what
// lets Growth add a question type as a row without a deploy"); 09 D-41, D-45; 01 §Tables
// (assistant_tools); 02 §Derived (new_subscriber, 09 D-36); 14 §2, §4.1, §4.2.
//
// Inputs: the seeded D1 (data/*.csv via test/helpers/seed.ts) and the assistant_tools rows from
// scripts/tool-seeds.ts. The extra `query` rows below are tool configuration a Growth teammate
// could insert (01 assistant_tools), not data about people; their bound values are values that
// occur in data/*.csv ('instagram', 'active') and the demo subject's pk_ key. Expected numbers
// come from 02 §Counts: Instagram active `cold` = 147; the demo subject joy.hall830 signed up
// 2026-09-02 with first page "/". The new_subscriber counts by page are not in §Counts, so they
// are checked against `DEFINITIONS.new_subscriber.fn` (02 §Derived "one runtime source") run over
// the view rows in JavaScript, independently of the row's SQL. No test calls the network.

const JOY = 'joy.hall830@protonmail.com'
const PKEY = /^pk_[0-9a-f]{16}$/

let views: readonly ViewSchema[]

beforeAll(async () => {
  await seedDatabase()
  for (const seed of TOOL_SEEDS) {
    const { sql, params } = toolSeedInsert(seed)
    await env.DB.prepare(sql).bind(...params).run()
  }
  views = await viewSchemas(env.DB)
})

/** A query row as a Growth teammate would insert it: input_schema plus a template and param_mapping. */
function queryRow(name: string, inputSchema: Record<string, unknown>, sql: string, paramMapping: Record<string, unknown>): ToolSeed {
  return {
    name,
    description: `Test query row ${name}.`,
    inputSchema,
    handlerType: 'query',
    executionConfig: { sql, param_mapping: paramMapping },
    sortOrder: 90,
  }
}

/** The row as D1 returns it, for the pure validateToolRow. */
function toolRow(seed: ToolSeed): ToolRow {
  return {
    id: `row-${seed.name}`,
    name: seed.name,
    description: seed.description,
    input_schema: JSON.stringify(seed.inputSchema),
    handler_type: seed.handlerType,
    execution_config: JSON.stringify(seed.executionConfig),
    sort_order: seed.sortOrder,
    metadata: null,
  }
}

/** Inserts rows into assistant_tools for the body, then deletes them, so other tests see the seeded set. */
async function withRows<T>(seeds: readonly ToolSeed[], body: () => Promise<T>): Promise<T> {
  for (const seed of seeds) {
    const { sql, params } = toolSeedInsert(seed)
    await env.DB.prepare(sql).bind(...params).run()
  }
  try {
    return await body()
  } finally {
    for (const seed of seeds) await env.DB.prepare('DELETE FROM assistant_tools WHERE name = ?').bind(seed.name).run()
  }
}

/** The ToolConfigError a load or validation threw; fails the test when it threw nothing else. */
async function configError(run: () => unknown): Promise<ToolConfigError> {
  try {
    await run()
  } catch (err) {
    if (err instanceof ToolConfigError) return err
    throw err
  }
  throw new Error('expected a ToolConfigError, but the tools loaded')
}

async function auditRows(traceId: string) {
  return (
    await env.DB.prepare('SELECT kind, status, tool_name, sql, row_count, error FROM ai_audit WHERE trace_id = ? ORDER BY created_at, rowid')
      .bind(traceId)
      .all<{ kind: string; status: string; tool_name: string | null; sql: string | null; row_count: number | null; error: string | null }>()
  ).results
}

async function runTool(name: string, input: unknown, db: D1Database = env.DB) {
  const trace = await startTrace(env.DB)
  const executed = await executeToolCall({ db, trace, tools: await loadTools(env.DB) }, { id: `toolu_${name}`, name, input })
  return { executed, audit: await auditRows(trace.traceId) }
}

/** env.DB, recording every SQL text prepared and every value bound. */
function recordingDb(): { db: D1Database; prepared: string[]; bound: unknown[][] } {
  const prepared: string[] = []
  const bound: unknown[][] = []
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (query: string) => {
          prepared.push(query)
          const statement = target.prepare(query)
          return new Proxy(statement, {
            get(st, key) {
              if (key === 'bind') {
                return (...values: unknown[]) => {
                  bound.push(values)
                  return st.bind(...values)
                }
              }
              const value: unknown = Reflect.get(st, key)
              return typeof value === 'function' ? value.bind(st) : value
            },
          })
        }
      }
      const value: unknown = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { db, prepared, bound }
}

const NEW_PAGES = 'pages_new_subscribers_hit_first'

describe('T-AI-1 assistant_tools rows load into valid Anthropic tools; bad rows fail loud (03 row 3, 09 D-41)', () => {
  it('every seeded row loads verbatim as an Anthropic tool with a valid JSON Schema, the query row included', async () => {
    const loaded = await loadTools(env.DB)
    expect(loaded.definitions.map((d) => d.name)).toEqual(TOOL_SEEDS.map((s) => s.name))
    for (const [i, definition] of loaded.definitions.entries()) {
      expect(definition).toEqual({ name: TOOL_SEEDS[i].name, description: TOOL_SEEDS[i].description, input_schema: TOOL_SEEDS[i].inputSchema })
      expect(definition.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
      expect(definition.input_schema.type).toBe('object')
      expect(schemaProblems(definition.input_schema, 'input_schema')).toEqual([])
    }
    expect(loaded.tools.map((t) => [t.name, t.handlerType])).toEqual([
      ['segment', 'builtin'],
      ['aggregate', 'builtin'],
      ['query_sql', 'builtin'],
      [NEW_PAGES, 'query'],
      ['describe_schema', 'builtin'],
    ])
  })

  it('an unknown tool name is denied by Gate 2 and audited as blocked; no handler runs', async () => {
    const tools = await loadTools(env.DB)
    expect(authorizeToolCall(tools, { name: 'pages_new_subscribers', input: {} })).toEqual({ allowed: false, reason: 'unknown_tool' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db, prepared } = recordingDb()
    const { executed, audit } = await runTool('pages_new_subscribers', {}, db)
    expect(executed.output).toBeNull()
    expect(executed.result.is_error).toBe(true)
    expect(prepared).toEqual([])
    expect(audit).toEqual([expect.objectContaining({ kind: 'blocked', status: 'blocked', error: UNKNOWN_TOOL_ERROR })])
  })

  it('an enabled row with a missing handler, an invalid schema or a template naming a non-view table → 500 tool_config_error naming the row', async () => {
    const broken: Array<[ToolSeed, string]> = [
      [{ ...TOOL_SEEDS[1], name: 'aggregate_typo', executionConfig: { handler_name: 'agregate' } }, 'execution_config.handler_name "agregate" is not a builtin handler'],
      [{ ...TOOL_SEEDS[1], name: 'aggregate_bad_schema', inputSchema: { type: 'object', properties: { metric: { type: 'text' } } } }, 'input_schema.properties.metric.type "text" is not a JSON Schema type'],
      [
        queryRow('subscribers_by_source', { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] }, 'SELECT count(*) AS n FROM subscribers WHERE source = :source', {
          source: ':source',
        }),
        'execution_config.sql fails gate2: subscribers is not one of the views',
      ],
    ]
    for (const [seed, problem] of broken) {
      await withRows([seed], async () => {
        // The whole load fails, so the model never sees a tool set silently missing this row.
        const error = await configError(() => loadTools(env.DB))
        expect(error.status).toBe(500)
        expect(error.code).toBe('tool_config_error')
        expect(error.row).toBe(seed.name)
        expect(error.message).toContain(`The assistant tool "${seed.name}" is misconfigured`)
        expect(error.message).toContain(problem)
      })
    }
    // Removing the broken row restores the seeded set with no deploy.
    expect((await loadTools(env.DB)).definitions.map((d) => d.name)).toEqual(TOOL_SEEDS.map((s) => s.name))
  })

  it('a `pattern` must be a string that compiles with the u flag, or the row is refused at load (09 D-69)', async () => {
    // The segment row's patterns (shared/segment-filters.ts) pass; Gate 2 compiles each with `u`.
    expect(schemaProblems({ type: 'string', pattern: '^/[a-z0-9/-]{0,120}$' }, 'p')).toEqual([])
    expect(schemaProblems({ type: 'string', pattern: '(' }, 'p')).toEqual(['p.pattern is not a valid regular expression'])
    expect(schemaProblems({ type: 'string', pattern: 5 }, 'p')).toEqual(['p.pattern must be a string'])
    // `\-` outside a class compiles without the u flag but not with it, so the check uses the u flag.
    expect(() => new RegExp('\\-')).not.toThrow()
    expect(schemaProblems({ type: 'string', pattern: '\\-' }, 'p')).toEqual(['p.pattern is not a valid regular expression'])
    const segment = TOOL_SEEDS[0]
    expect(segment.name).toBe('segment')
    const properties = segment.inputSchema.properties as Record<string, Record<string, unknown>>
    const broken: Array<[ToolSeed, string]> = [
      [
        { ...segment, name: 'segment_bad_pattern', inputSchema: { ...segment.inputSchema, properties: { ...properties, site_visit_page: { ...properties.site_visit_page, pattern: '(' } } } },
        'input_schema.properties.site_visit_page.pattern is not a valid regular expression',
      ],
      [
        { ...segment, name: 'segment_number_pattern', inputSchema: { ...segment.inputSchema, properties: { ...properties, went_cold: { ...properties.went_cold, pattern: 5 } } } },
        'input_schema.properties.went_cold.pattern must be a string',
      ],
    ]
    for (const [seed, problem] of broken) {
      await withRows([seed], async () => {
        const error = await configError(() => loadTools(env.DB))
        expect(error.status).toBe(500)
        expect(error.code).toBe('tool_config_error')
        expect(error.row).toBe(seed.name)
        expect(error.message).toContain(problem)
      })
    }
  })

  it('tools:seed reports a stale seeded row, which the insert keeps and only --update replaces (09 D-69)', async () => {
    const stored = async () =>
      (await env.DB.prepare('SELECT name, description, input_schema, handler_type, execution_config FROM assistant_tools').all<StoredToolRow>()).results
    expect(staleToolRows(await stored())).toEqual([])
    const segment = TOOL_SEEDS[0]
    expect(segment.name).toBe('segment')
    // The segment row as a D1 seeded before D-69 holds it (scripts/tool-seeds.ts at 16d4d78): no new
    // keys, free-text source.
    const preD69 = {
      type: 'object',
      properties: {
        status: { type: 'array', items: { type: 'string', enum: ['active', 'unsubscribed'] }, minItems: 1, description: 'Default ["active"]. Add "unsubscribed" only when the teammate asks for them.' },
        source: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Signup sources, e.g. ["instagram"]. Absent = any source.' },
        days_since_open_gte: { type: 'integer', minimum: 1, description: 'No email open in at least this many days (the "no open in N days" definition).' },
        include_never_opened: { type: 'boolean', description: 'With days_since_open_gte, also include everyone who never opened. Default false.' },
        has_app: { type: ['boolean', 'null'], description: 'true = has an app account, false = has none, null or absent = either.' },
      },
    }
    const restore = toolSeedUpdate(segment)
    try {
      await env.DB.prepare('UPDATE assistant_tools SET input_schema = ? WHERE name = ?').bind(JSON.stringify(preD69), 'segment').run()
      expect(staleToolRows(await stored())).toEqual([{ name: 'segment', fields: ['input_schema'] }])
      // Re-running the insert keeps the stale row: ON CONFLICT DO NOTHING never overwrites.
      const { sql, params } = toolSeedInsert(segment)
      await env.DB.prepare(sql).bind(...params).run()
      expect(staleToolRows(await stored())).toEqual([{ name: 'segment', fields: ['input_schema'] }])
      // A changed description and another handler are named too.
      await env.DB.prepare('UPDATE assistant_tools SET description = ?, execution_config = ? WHERE name = ?')
        .bind('Count a segment.', JSON.stringify({ handler_name: 'aggregate' }), 'segment')
        .run()
      expect(staleToolRows(await stored())).toEqual([{ name: 'segment', fields: ['description', 'input_schema', 'execution_config'] }])
      // --update's statement puts the seed back; enabled and sort_order are left as they were.
      await env.DB.prepare('UPDATE assistant_tools SET enabled = 0, sort_order = 99 WHERE name = ?').bind('segment').run()
      await env.DB.prepare(restore.sql).bind(...restore.params).run()
      expect(staleToolRows(await stored())).toEqual([])
      const kept = await env.DB.prepare('SELECT enabled, sort_order FROM assistant_tools WHERE name = ?').bind('segment').first()
      expect(kept).toEqual({ enabled: 0, sort_order: 99 })
      // The same schema with its keys in another order is not stale.
      const reordered = Object.fromEntries(Object.entries(segment.inputSchema).reverse())
      await env.DB.prepare('UPDATE assistant_tools SET input_schema = ? WHERE name = ?').bind(JSON.stringify(reordered), 'segment').run()
      expect(staleToolRows(await stored())).toEqual([])
    } finally {
      await env.DB.prepare(restore.sql).bind(...restore.params).run()
      await env.DB.prepare('UPDATE assistant_tools SET enabled = 1, sort_order = ? WHERE name = ?').bind(segment.sortOrder, 'segment').run()
    }
    expect((await loadTools(env.DB)).definitions[0]).toEqual({ name: 'segment', description: segment.description, input_schema: segment.inputSchema })
  })

  it('a query row is checked like a model query and more: PII, write words, the wall clock, raw "?", its config and mapping', async () => {
    const source = { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] }
    const cases: Array<[ToolSeed, string]> = [
      [queryRow('q', source, 'SELECT email_norm FROM v_profiles WHERE source = :source', { source: ':source' }), 'email_norm is personal data'],
      [queryRow('q', source, 'DELETE FROM v_profiles WHERE source = :source', { source: ':source' }), 'fails gate3: the query must start with SELECT'],
      [queryRow('q', source, "SELECT count(*) AS n FROM v_profiles WHERE source = :source AND signup_date > date('now')", { source: ':source' }), "the wall clock ('now') is not allowed"],
      [queryRow('q', source, 'SELECT count(*) AS n FROM v_profiles WHERE source = :source AND status = ?', { source: ':source' }), 'fails gate3: the query has 2 "?" marker(s) but 1 value(s) are bound'],
      [queryRow('q', source, 'SELECT count(*) AS n FROM v_profiles WHERE source = :source; SELECT 1', { source: ':source' }), 'one statement only'],
      [{ ...queryRow('q', source, 'SELECT count(*) AS n FROM v_profiles WHERE source = :source', { source: ':source' }), executionConfig: { sql: 'SELECT count(*) AS n FROM v_profiles WHERE source = :source', param_mapping: { source: ':source' }, handler_name: 'segment' } }, 'unsupported key "handler_name"'],
      [{ ...queryRow('q', source, '', {}), executionConfig: { param_mapping: {} } }, 'execution_config.sql must be a non-empty SELECT template'],
      [{ ...queryRow('q', source, 'SELECT count(*) AS n FROM v_profiles', {}), executionConfig: { sql: 'SELECT count(*) AS n FROM v_profiles' } }, 'execution_config.param_mapping must be an object'],
      [queryRow('q', source, 'SELECT count(*) AS n FROM v_profiles WHERE source = :source', { source: 'source' }), 'param_mapping.source must be a placeholder such as ":source"'],
      [queryRow('q', source, 'SELECT count(*) AS n FROM v_profiles WHERE source = :source', { source: ':source', status: ':status' }), 'param_mapping maps status, which input_schema does not declare'],
      [
        queryRow('q', { type: 'object', properties: { source: { type: 'string' }, status: { type: 'string' } } }, 'SELECT count(*) AS n FROM v_profiles WHERE source = :source', { source: ':source' }),
        'input_schema declares status, which param_mapping does not bind',
      ],
      [
        queryRow('q', { type: 'object', properties: { source: { type: 'array', items: { type: 'string' } } } }, 'SELECT count(*) AS n FROM v_profiles WHERE source = :source', { source: ':source' }),
        'input_schema.properties.source must be a string, number, integer, boolean or null to be bound to :source',
      ],
      [queryRow('q', source, 'SELECT count(*) AS n FROM v_profiles', { source: ':source' }), 'param_mapping maps source to :source, which execution_config.sql never uses'],
      [
        queryRow('q', { type: 'object', properties: { source: { type: 'string' }, status: { type: 'string' } } }, 'SELECT count(*) AS n FROM v_profiles WHERE source = :source AND status = :status', {
          source: ':source',
          status: ':source',
        }),
        'param_mapping maps both source and status to :source',
      ],
    ]
    for (const [seed, problem] of cases) {
      const error = await configError(() => validateToolRow(toolRow(seed), views))
      expect(error.code, problem).toBe('tool_config_error')
      expect(error.row).toBe('q')
      expect(error.problems.join('\n'), problem).toContain(problem)
    }
  })
})

describe('T-AI-8 a query row runs its template with bound params through Gate 2/3 (03 row 9, 09 D-41, D-45)', () => {
  it('placeholders become positional "?" in template order; strings, quoted names and comments are left alone', () => {
    expect(rewritePlaceholders("SELECT pkey FROM v_profiles WHERE source = :source AND (status = :status OR :status IS NULL) AND first_page <> ':page'")).toEqual({
      sql: "SELECT pkey FROM v_profiles WHERE source = ? AND (status = ? OR ? IS NULL) AND first_page <> ':page'",
      placeholders: [':source', ':status', ':status'],
    })
    expect(rewritePlaceholders("SELECT 'it''s :x' AS a, \":y\" FROM v_funnel -- :z\n/* :w */ WHERE first_page = :v").placeholders).toEqual([':v'])
  })

  it('a template with a :param not in param_mapping fails at load, not at call time', async () => {
    const seed = queryRow(
      'active_by_source',
      { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
      'SELECT pkey FROM v_profiles WHERE source = :source AND status = :status',
      { source: ':source' },
    )
    await withRows([seed], async () => {
      const error = await configError(() => loadTools(env.DB))
      expect(error.row).toBe('active_by_source')
      expect(error.problems).toEqual(['execution_config.sql uses :status, which param_mapping does not map to an input field'])
    })
  })

  it('an inserted query row is live on the next load with no deploy; its values are bound, never spliced, and its rows are pk_ keys only', async () => {
    const joy = await env.DB.prepare('SELECT pkey FROM profiles WHERE email_norm = ?').bind(JOY).first<string>('pkey')
    if (joy === null) throw new Error('no profile for the demo subject (02 §Counts)')
    const seed = queryRow(
      'reader_first_page',
      { type: 'object', properties: { reader: { type: 'string', description: 'A pk_ key.' } }, required: ['reader'] },
      'SELECT pkey, source, signup_date, first_page FROM v_profiles WHERE pkey = :reader',
      { reader: ':reader' },
    )
    await withRows([seed], async () => {
      const { db, prepared, bound } = recordingDb()
      const { executed, audit } = await runTool('reader_first_page', { reader: joy }, db)
      // 02 §Counts demo subject: Instagram, signup 2026-09-02, first page "/".
      expect(executed.output?.rows).toEqual([{ pkey: joy, source: 'instagram', signup_date: '2026-09-02', first_page: '/' }])
      const select = 'SELECT pkey, source, signup_date, first_page FROM v_profiles WHERE pkey = ? LIMIT 100'
      expect(prepared.filter((sql) => sql.startsWith('SELECT pkey'))).toEqual([select])
      expect(bound).toContainEqual([joy])
      expect(audit).toEqual([expect.objectContaining({ kind: 'tool_call', status: 'success', tool_name: 'reader_first_page', sql: select, row_count: 1 })])
    })
  })

  it('Instagram active cold = 147 (02 §Counts) through a query row with three bound inputs', async () => {
    const seed = queryRow(
      'cold_count',
      {
        type: 'object',
        properties: { source: { type: 'string' }, status: { type: 'string', enum: ['active', 'unsubscribed'] }, today: { type: 'string' } },
        required: ['source', 'status', 'today'],
      },
      `SELECT count(*) AS cold FROM v_profiles WHERE source = :source AND status = :status AND ${DEFINITIONS.cold.sql}`,
      { source: ':source', status: ':status', today: ':today' },
    )
    await withRows([seed], async () => {
      const { executed } = await runTool('cold_count', { source: 'instagram', status: 'active', today: TODAY })
      expect(executed.output?.rows).toEqual([{ cold: 147 }])
      expect(executed.output?.summary).toMatchObject({ inputs: { source: 'instagram', status: 'active', today: TODAY }, rows: 1 })
    })
  })

  it('values bind in template order, not param_mapping order; a placeholder used twice is bound twice (Instagram active cold = 147, 02 §Counts)', async () => {
    // The mapping lists today, status, source; the template uses source, status, status, today.
    const seed = queryRow(
      'cold_count_reordered',
      {
        type: 'object',
        properties: { today: { type: 'string' }, status: { type: 'string', enum: ['active', 'unsubscribed'] }, source: { type: 'string' } },
        required: ['today', 'source'],
      },
      `SELECT count(*) AS cold FROM v_profiles WHERE source = :source AND (status = :status OR :status IS NULL) AND ${DEFINITIONS.cold.sql}`,
      { today: ':today', status: ':status', source: ':source' },
    )
    await withRows([seed], async () => {
      const { db, prepared, bound } = recordingDb()
      const { executed } = await runTool('cold_count_reordered', { today: TODAY, status: 'active', source: 'instagram' }, db)
      expect(executed.output?.rows).toEqual([{ cold: 147 }])
      const select = 'SELECT count(*) AS cold FROM v_profiles WHERE source = ? AND (status = ? OR ? IS NULL) AND cold_since <= ? LIMIT 100'
      expect(prepared.filter((sql) => sql.startsWith('SELECT count(*) AS cold'))).toEqual([select])
      expect(bound).toContainEqual(['instagram', 'active', 'active', TODAY])
    })
  })

  it('every row of a query row that lists subjects is pk_ keys only: no PII column, no email', async () => {
    const seed = queryRow(
      'readers_by_source',
      { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
      "SELECT p.pkey, w.visitor_hash, w.page FROM v_web_events w JOIN v_profiles p ON p.pkey = w.pkey WHERE p.source = :source AND p.status = 'active' ORDER BY w.event_ts",
      { source: ':source' },
    )
    await withRows([seed], async () => {
      const { executed } = await runTool('readers_by_source', { source: 'instagram' })
      const output = executed.output!
      expect(output.rows).toHaveLength(100) // Gate 3's forced LIMIT (03 row 8)
      expect(output.summary).toMatchObject({ row_limit: 100, may_have_more_rows: true })
      for (const column of output.columns) expect(PII_COLUMNS).not.toContain(column)
      for (const row of output.rows) {
        expect(row.pkey).toMatch(PKEY)
        expect(row.visitor_hash).toMatch(/^pk_/)
      }
      expect(JSON.stringify(output.rows)).not.toMatch(EMAIL_REGEX)
      expect(String(executed.result.content)).not.toMatch(EMAIL_REGEX)
    })
  })

  it('the query handler runs Gate 2 again at call time: a template that skipped the loader never reaches D1', async () => {
    // Defence in depth (03 rows 7-8): build the handler directly, so the load-time check never ran.
    const { db, prepared } = recordingDb()
    const handler = queryHandler('unchecked', { sql: 'SELECT email_norm FROM v_profiles WHERE source = ?', inputs: ['source'] })
    await expect(handler.run(db, { source: 'instagram' })).rejects.toThrow('email_norm is personal data')
    expect(prepared.filter((sql) => sql.includes('email_norm'))).toEqual([])
  })

  it('input failing the row\'s input_schema is denied by Gate 2 before the template runs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, prepared } = recordingDb()
    const { executed, audit } = await runTool(NEW_PAGES, { include_unsubscribed: 'active' }, db)
    expect(executed.output).toBeNull()
    expect(prepared.filter((sql) => sql.includes('new_subscribers'))).toEqual([])
    expect(audit).toEqual([expect.objectContaining({ kind: 'blocked', tool_name: NEW_PAGES, error: 'gate2_denied: input_schema: input.include_unsubscribed must be boolean' })])
  })
})

describe('the seeded query row pages_new_subscribers_hit_first (02 §Derived new_subscriber, 09 D-36)', () => {
  /** First page → new subscribers, computed in JavaScript with DEFINITIONS.new_subscriber.fn. */
  async function expected(includeUnsubscribed: boolean): Promise<Map<string | null, number>> {
    const { results } = await env.DB.prepare('SELECT signup_date, status, first_page FROM v_profiles WHERE signup_date IS NOT NULL').all<{
      signup_date: string
      status: string
      first_page: string | null
    }>()
    const counts = new Map<string | null, number>()
    for (const r of results) {
      if (!DEFINITIONS.new_subscriber.fn(r.signup_date)) continue
      if (!includeUnsubscribed && r.status !== 'active') continue
      counts.set(r.first_page, (counts.get(r.first_page) ?? 0) + 1)
    }
    return counts
  }

  it('its window is TODAY − 30 .. TODAY, rendered from config into the row', () => {
    expect(NEW_SUBSCRIBER_WINDOW).toEqual({ from: '2026-08-29', to: TODAY })
    const row = TOOL_SEEDS.find((s) => s.name === NEW_PAGES)!
    expect(row.executionConfig.sql).toContain(`BETWEEN '2026-08-29' AND '${TODAY}'`)
    expect(row.description).toContain(`signup_date 2026-08-29 to ${TODAY}`)
  })

  it('counts each active new subscriber by first page, as the definition does; include_unsubscribed adds the unsubscribed ones', async () => {
    const { executed, audit } = await runTool(NEW_PAGES, {})
    const active = new Map(executed.output!.rows.map((r) => [r.first_page as string | null, r.new_subscribers as number]))
    expect(active).toEqual(await expected(false))
    expect(active.get('/')).toBeGreaterThanOrEqual(1) // joy.hall830: new (signup 2026-09-02), first page "/" (02 §Counts)
    expect(executed.output!.columns).toEqual(['first_page', 'new_subscribers'])
    const counts = executed.output!.rows.map((r) => r.new_subscribers as number)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
    expect(audit).toEqual([expect.objectContaining({ kind: 'tool_call', status: 'success', tool_name: NEW_PAGES })])
    expect(audit[0].sql).toContain('OR ? = 1')

    const all = await runTool(NEW_PAGES, { include_unsubscribed: true })
    expect(new Map(all.executed.output!.rows.map((r) => [r.first_page as string | null, r.new_subscribers as number]))).toEqual(await expected(true))
    const off = await runTool(NEW_PAGES, { include_unsubscribed: false })
    expect(off.executed.output!.rows).toEqual(executed.output!.rows)
  })
})
