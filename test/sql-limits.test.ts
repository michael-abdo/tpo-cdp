import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { TOOL_SEEDS, type ToolSeed, toolSeedInsert } from '../scripts/tool-seeds'
import { startTrace } from '../worker/assistant/audit/ai-audit'
import { GateDenied, runReadOnlySelect, SQL_ROWS_READ_CAP, SqlTooHeavyError, SQL_TOO_HEAVY_MESSAGE } from '../worker/assistant/gates/gate3-readonly-sql'
import { runChecked } from '../worker/assistant/tools/builtin-handlers'
import { executeToolCall } from '../worker/assistant/tools/tool-executor'
import { loadTools } from '../worker/assistant/tools/tool-loader'
import { pinFromTrace } from '../worker/insights/board'
import { seedDatabase } from './helpers/seed'

// T-AI-9 (09 D-81): query limits on model-run SQL. Designs: 09 D-81; 03 §Gateway layers rows 8-9.
//
// Inputs: the seeded D1 (data/*.csv) and the assistant_tools rows from scripts/tool-seeds.ts.
// Every SQL string here is either the real seeded query row's own SQL, a real view's columns
// (01), or a comma/`ON 1 = 1` cross join of two real views — the exact cartesian the self-audit
// found, never an invented table or column. No test calls the network.

const LEGIT_SQL = "SELECT pkey, page, utm_source FROM v_web_events WHERE pkey IS NOT NULL ORDER BY event_ts DESC LIMIT 100"
const CARTESIAN_COMMA = 'SELECT p.pkey, w.pkey FROM v_profiles p, v_web_events w'
const CARTESIAN_JOIN_1_1 = 'SELECT p.pkey, w.pkey FROM v_profiles p JOIN v_web_events w ON 1 = 1'
const REAL_INDEXED_JOIN = 'SELECT p.pkey, w.pkey FROM v_profiles p JOIN v_web_events w ON w.pkey = p.pkey LIMIT 100'

beforeAll(async () => {
  await seedDatabase()
  for (const seed of TOOL_SEEDS) {
    const { sql, params } = toolSeedInsert(seed)
    await env.DB.prepare(sql).bind(...params).run()
  }
})

function queryRow(name: string, sql: string): ToolSeed {
  return {
    name,
    description: `Test query row ${name}.`,
    inputSchema: { type: 'object', properties: {} },
    handlerType: 'query',
    executionConfig: { sql, param_mapping: {} },
    sortOrder: 95,
  }
}

async function withRow<T>(seed: ToolSeed, body: () => Promise<T>): Promise<T> {
  const { sql, params } = toolSeedInsert(seed)
  await env.DB.prepare(sql).bind(...params).run()
  try {
    return await body()
  } finally {
    await env.DB.prepare('DELETE FROM assistant_tools WHERE name = ?').bind(seed.name).run()
  }
}

async function auditRows(traceId: string) {
  return (
    await env.DB.prepare('SELECT kind, status, tool_name, sql, row_count, error FROM ai_audit WHERE trace_id = ? ORDER BY created_at, rowid')
      .bind(traceId)
      .all<{ kind: string; status: string; tool_name: string | null; sql: string | null; row_count: number | null; error: string | null }>()
  ).results
}

async function runTool(name: string, input: unknown) {
  const trace = await startTrace(env.DB)
  const executed = await executeToolCall({ db: env.DB, trace, tools: await loadTools(env.DB) }, { id: `toolu_${name}`, name, input })
  return { executed, audit: await auditRows(trace.traceId), traceId: trace.traceId }
}

/** env.DB, recording every SQL text prepared (so a refused call can be shown to have run nothing). */
function recordingDb(): { db: D1Database; prepared: string[] } {
  const prepared: string[] = []
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (query: string) => {
          prepared.push(query)
          return target.prepare(query)
        }
      }
      const value: unknown = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { db, prepared }
}

describe('09 D-81 #1: the plan check refuses a cartesian/unindexed nested scan before it runs', () => {
  it('a comma cross join of two views is refused; nothing runs', async () => {
    const { db, prepared } = recordingDb()
    await expect(runReadOnlySelect(db, CARTESIAN_COMMA)).rejects.toThrow(GateDenied)
    // Only the EXPLAIN was prepared (a different text); the real cartesian SQL (with its forced
    // LIMIT) was never prepared at all.
    expect(prepared.some((q) => q.startsWith('SELECT p.pkey, w.pkey FROM v_profiles p, v_web_events w LIMIT'))).toBe(false)
    expect(prepared.some((q) => q.startsWith('EXPLAIN QUERY PLAN'))).toBe(true)
  })

  it('a JOIN … ON 1 = 1 cross join is refused the same way, naming the scan in the problem', async () => {
    try {
      await runReadOnlySelect(env.DB, CARTESIAN_JOIN_1_1)
      throw new Error('expected a GateDenied')
    } catch (err) {
      expect(err).toBeInstanceOf(GateDenied)
      const denied = err as GateDenied
      expect(denied.gate).toBe('gate3')
      expect(denied.problems[0]).toContain('unindexed table scans')
      expect(denied.problems[0]).toContain('SCAN')
    }
  })

  it('a real indexed join of the same two views is not a cartesian and still runs', async () => {
    const result = await runReadOnlySelect(env.DB, REAL_INDEXED_JOIN)
    expect(result.columns).toEqual(['pkey', 'pkey'])
    expect(result.rows.length).toBeGreaterThan(0)
  })

  it('a single-view query (no join at all) still runs, unchanged', async () => {
    const result = await runReadOnlySelect(env.DB, LEGIT_SQL)
    expect(result.columns).toEqual(['pkey', 'page', 'utm_source'])
    expect(result.rows.length).toBe(100)
  })

  it('through the full tool-call path (query_sql): refused as gate3_denied before running; nothing is stored via pin', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { executed, audit, traceId } = await runTool('query_sql', { sql: CARTESIAN_COMMA, explanation: 'cross join probe' })
    expect(executed.output).toBeNull()
    expect(executed.result.is_error).toBe(true)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ kind: 'blocked', status: 'blocked', tool_name: 'query_sql', row_count: null })
    expect(audit[0].error).toMatch(/^gate3_denied: /)
    expect(audit[0].error).toContain('unindexed table scans')

    // query_sql never writes a successful tool_call row, so there is nothing for a pin to keep.
    await expect(pinFromTrace(env.DB, { audit_id: traceId })).rejects.toMatchObject({ code: 'nothing_to_pin' })
  })

  it('the same plan check protects a `query`-type tool row too, not only query_sql (one shared function, no second copy)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await withRow(queryRow('bad_cartesian_probe', CARTESIAN_JOIN_1_1), async () => {
      const { executed, audit } = await runTool('bad_cartesian_probe', {})
      expect(executed.output).toBeNull()
      expect(audit[0]).toMatchObject({ kind: 'blocked', status: 'blocked', tool_name: 'bad_cartesian_probe' })
      expect(audit[0].error).toMatch(/^gate3_denied: /)
      expect(audit[0].error).toContain('unindexed table scans')
    })
  })

  it('the brief\'s seeded query row (pages_new_subscribers_hit_first) still runs with its real result, unaffected by D-81', async () => {
    const { executed } = await runTool('pages_new_subscribers_hit_first', {})
    expect(executed.output).not.toBeNull()
    expect(executed.output!.rows.length).toBeGreaterThan(0)
    expect(executed.output!.columns).toEqual(['first_page', 'new_subscribers'])
  })
})

describe('09 D-81 #2: the time limit', () => {
  it('an injected tiny timeout on a real query refuses as SqlTooHeavyError(sql_timeout), not SqlRunError', async () => {
    try {
      await runReadOnlySelect(env.DB, LEGIT_SQL, [], { timeoutMs: 0 })
      throw new Error('expected a timeout')
    } catch (err) {
      expect(err).toBeInstanceOf(SqlTooHeavyError)
      const heavy = err as SqlTooHeavyError
      expect(heavy.reasonCode).toBe('sql_timeout')
      expect(heavy.message).toBe(SQL_TOO_HEAVY_MESSAGE)
    }
  })

  it('reaches ai_audit as its own reason code through runChecked (the function query_sql and a query row both call)', async () => {
    await expect(runChecked(env.DB, LEGIT_SQL, [], { timeoutMs: 0 })).rejects.toMatchObject({ code: 'sql_timeout', problems: [SQL_TOO_HEAVY_MESSAGE] })
  })

  it('the production default (SQL_TIME_LIMIT_MS, about 3000 ms) does not time out a real query', async () => {
    await expect(runReadOnlySelect(env.DB, LEGIT_SQL)).resolves.toMatchObject({ columns: ['pkey', 'page', 'utm_source'] })
  })
})

describe('09 D-81 #3: the row-scan cap', () => {
  it('an injected small cap on a real query refuses as SqlTooHeavyError(sql_rows_cap)', async () => {
    try {
      await runReadOnlySelect(env.DB, LEGIT_SQL, [], { rowsReadCap: 10 })
      throw new Error('expected a rows-cap refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(SqlTooHeavyError)
      const heavy = err as SqlTooHeavyError
      expect(heavy.reasonCode).toBe('sql_rows_cap')
      expect(heavy.message).toBe(SQL_TOO_HEAVY_MESSAGE)
    }
  })

  it('reaches ai_audit as its own reason code through runChecked', async () => {
    await expect(runChecked(env.DB, LEGIT_SQL, [], { rowsReadCap: 10 })).rejects.toMatchObject({ code: 'sql_rows_cap', problems: [SQL_TOO_HEAVY_MESSAGE] })
  })

  it('the production default (SQL_ROWS_READ_CAP, 10x the largest legitimate query measured) does not refuse a real query', async () => {
    await expect(runReadOnlySelect(env.DB, LEGIT_SQL)).resolves.toMatchObject({ columns: ['pkey', 'page', 'utm_source'] })
    expect(SQL_ROWS_READ_CAP).toBeGreaterThan(45_323) // the largest measured legitimate query (gate3-readonly-sql.ts's own comment)
  })
})
