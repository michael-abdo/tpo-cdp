import { env } from 'cloudflare:test'
import type Anthropic from '@anthropic-ai/sdk'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { TOOL_SEEDS, type ToolSeed, toolSeedInsert } from '../scripts/tool-seeds'
import { startTrace } from '../worker/assistant/audit/ai-audit'
import { MODEL } from '../worker/assistant/build-request'
import {
  GateDenied,
  raceTimeout,
  runReadOnlySelect,
  SQL_ROWS_READ_CAP,
  SqlTooHeavyError,
  SQL_TOO_HEAVY_MESSAGE,
} from '../worker/assistant/gates/gate3-readonly-sql'
import type { MessagesTransport } from '../worker/assistant/loop'
import { runChecked } from '../worker/assistant/tools/builtin-handlers'
import { executeToolCall } from '../worker/assistant/tools/tool-executor'
import { loadTools } from '../worker/assistant/tools/tool-loader'
import { requireJson, requireSession } from '../worker/auth/middleware'
import type { AppEnv } from '../worker/env'
import { onError } from '../worker/index'
import { INSIGHT_PARAMS_VERSION, listBoard, pinFromTrace } from '../worker/insights/board'
import { assistantRoutes } from '../worker/routes/assistant'
import { documentationIp, loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'

// T-AI-9 (09 D-81): query limits on model-run SQL. Designs: 09 D-81; 03 §Gateway layers rows 8-9.
//
// Inputs: the seeded D1 (data/*.csv) and the assistant_tools rows from scripts/tool-seeds.ts.
// Every SQL string here is either the real seeded query row's own SQL, a real view's columns
// (01), or a comma/`ON 1 = 1`/nested cartesian of two real views — the exact shapes the self-audit
// found, never an invented table or column. No test calls the network (09 D-54): the Ask-trace
// tests below use a recorded transport, the same pattern test/assistant.test.ts and
// test/insights-board.test.ts use.

const LEGIT_SQL = "SELECT pkey, page, utm_source FROM v_web_events WHERE pkey IS NOT NULL ORDER BY event_ts DESC LIMIT 100"
const CARTESIAN_COMMA = 'SELECT p.pkey, w.pkey FROM v_profiles p, v_web_events w'
const CARTESIAN_JOIN_1_1 = 'SELECT p.pkey, w.pkey FROM v_profiles p JOIN v_web_events w ON 1 = 1'
const REAL_INDEXED_JOIN = 'SELECT p.pkey, w.pkey FROM v_profiles p JOIN v_web_events w ON w.pkey = p.pkey LIMIT 100'

// Nested shapes the self-audit found: the same cartesian, moved one level down, where the earlier
// parent-0-only rule let it through (see gate3-readonly-sql.ts `cartesianScans`' doc comment).
const CARTESIAN_IN_UNION_BRANCH = 'SELECT 1 AS n UNION ALL SELECT count(*) FROM v_profiles p, v_web_events w'
const CARTESIAN_IN_SUBQUERY = "SELECT pkey FROM v_profiles WHERE pkey IN (SELECT p.pkey FROM v_profiles p, v_web_events w WHERE p.pkey <> w.pkey)"
const CARTESIAN_IN_FROM_SUBQUERY = 'SELECT n FROM (SELECT count(*) AS n FROM v_profiles p, v_web_events w)'
const CARTESIAN_IN_SCALAR_SUBQUERY = 'SELECT (SELECT count(*) FROM v_profiles p, v_web_events w) AS n'
// Not a cartesian group (one SCAN in its own scope), but an unindexed scan run once per outer row:
// read 1,096,962 rows when actually run against the seed (self-audit case A).
const CORRELATED_UNINDEXED_SCAN = "SELECT p.pkey, (SELECT count(*) FROM v_web_events w WHERE w.utm_source = p.source) AS n FROM v_profiles p"
// A genuine syntax error: EXPLAIN QUERY PLAN fails on it the same way the real run would.
const SYNTAX_ERROR_SQL = 'SELECT source, count(*) AS n FROM v_profiles GROUP BY'

let cookie: string

beforeAll(async () => {
  await seedDatabase()
  for (const seed of TOOL_SEEDS) {
    const { sql, params } = toolSeedInsert(seed)
    await env.DB.prepare(sql).bind(...params).run()
  }
  cookie = await loginCookie()
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

async function lastAuditRowFor(toolName: string) {
  return env.DB.prepare('SELECT kind, status, tool_name, error FROM ai_audit WHERE tool_name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .bind(toolName)
    .first<{ kind: string; status: string; tool_name: string | null; error: string | null }>()
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

// ── a real Ask trace (09 D-54: a recorded transport, never the network) ─────────────────────
//
// board.ts's pin path only ever keeps an answer that came from a real model trace (a
// `model_request` ai_audit row): pinnableCall(db, traceId) returns null, and pinFromTrace throws
// nothing_to_pin, for any trace with none. The tool-executor-only traces `runTool` above builds
// have no model_request row at all, so a `nothing_to_pin` result from one of those proves nothing
// about the pin path specifically (it would say the same thing regardless of what Gate 3 did).
// `askOnce` drives the real production route (assistantRoutes, requireJson, requireSession) with
// a transport that returns one scripted tool_use then a plain-text end_turn, so the resulting
// trace is the same shape a real Ask answer leaves.

let turn = 0
function message(content: Anthropic.ContentBlock[], stop_reason: Anthropic.StopReason): Anthropic.Message {
  turn += 1
  return {
    id: `msg_sql_limits_${turn}`,
    type: 'message',
    role: 'assistant',
    model: MODEL,
    container: null,
    diagnostics: null,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
    },
  }
}

/** A transport that returns one query_sql tool_use, then a plain-text end_turn. */
function queryOnceTransport(sql: string): MessagesTransport {
  const responses = [
    () => message([{ type: 'tool_use', id: `toolu_sql_limits_${turn}`, name: 'query_sql', input: { sql, explanation: 'sql-limits probe' }, caller: { type: 'direct' } }], 'tool_use'),
    () => message([{ type: 'text', text: 'Here is the answer.', citations: null }], 'end_turn'),
  ]
  let n = 0
  return async () => {
    const next = responses[n++]
    if (next === undefined) throw new Error('queryOnceTransport: no turn left')
    return next()
  }
}

/** Asks "probe" through the real production route with one scripted query_sql call; returns the audit_id. */
async function askOnce(sql: string): Promise<string> {
  const app = new Hono<AppEnv>()
  app.use('/api/*', requireJson, requireSession)
  app.route('/api', assistantRoutes(() => queryOnceTransport(sql)))
  app.onError(onError)
  const res = await app.request(
    '/api/assistant',
    {
      method: 'POST',
      // A fresh documentation address per call keeps these asks off one ASSISTANT_LIMITER key (09 D-70 #6).
      headers: { cookie, 'content-type': 'application/json', 'cf-connecting-ip': documentationIp() },
      body: JSON.stringify({ question: 'sql-limits probe' }),
    },
    env,
  )
  expect(res.status, await res.clone().text()).toBe(200)
  return (await res.json<{ audit_id: string }>()).audit_id
}

const insightCount = async () => (await env.DB.prepare('SELECT count(*) AS n FROM insights').first<number>('n')) ?? 0
const toolCount = async () => (await env.DB.prepare('SELECT count(*) AS n FROM assistant_tools').first<number>('n')) ?? 0

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

  // The self-audit's finding: isTopLevelFullScan only ever grouped by `parent = 0`, so a
  // cartesian moved one level down (a UNION branch, a FROM/IN/scalar subquery) passed the plan
  // check, then ran to completion (21-84 s locally) before the row-scan cap refused it
  // after the fact. Each shape here is refused by `cartesianScans`' per-scope grouping before
  // anything but EXPLAIN runs; reverting to the old parent-0-only rule makes every one of these
  // four fail (verified in a scratch worktree, 09 D-81's own mutation-check instruction).
  it.each([
    ['a UNION ALL branch', CARTESIAN_IN_UNION_BRANCH],
    ['an IN (SELECT …) subquery', CARTESIAN_IN_SUBQUERY],
    ['a FROM (SELECT …) subquery', CARTESIAN_IN_FROM_SUBQUERY],
    ['a scalar (SELECT …) subquery', CARTESIAN_IN_SCALAR_SUBQUERY],
  ])('a cartesian nested inside %s is refused before it runs, not only one at the outer level', async (_label, sql) => {
    const { db, prepared } = recordingDb()
    try {
      await runReadOnlySelect(db, sql)
      throw new Error('expected a GateDenied')
    } catch (err) {
      expect(err, sql).toBeInstanceOf(GateDenied)
      const denied = err as GateDenied
      expect(denied.gate, sql).toBe('gate3')
      expect(denied.problems[0], sql).toContain('unindexed table scans')
    }
    // Nothing beyond EXPLAIN reached D1 with this SQL's own text.
    expect(prepared.some((q) => q.includes(sql) && !q.startsWith('EXPLAIN')), sql).toBe(false)
    expect(prepared.some((q) => q.startsWith('EXPLAIN QUERY PLAN')), sql).toBe(true)
  })

  // Case A of the self-audit: not a cartesian group (one SCAN in its own scope), but a correlated
  // scalar subquery that scans its relation once per outer row — the same cost, caught by a
  // second rule (an ancestor-chain walk for a `CORRELATED …` node), not the per-scope SCAN count.
  it('an unindexed scan inside a correlated subquery is refused, even though it is only one SCAN in its own scope', async () => {
    const { db, prepared } = recordingDb()
    try {
      await runReadOnlySelect(db, CORRELATED_UNINDEXED_SCAN)
      throw new Error('expected a GateDenied')
    } catch (err) {
      expect(err).toBeInstanceOf(GateDenied)
      expect((err as GateDenied).gate).toBe('gate3')
      expect((err as GateDenied).problems[0]).toMatch(/correlated subquery/)
    }
    expect(prepared.some((q) => q.includes(CORRELATED_UNINDEXED_SCAN) && !q.startsWith('EXPLAIN'))).toBe(false)
  })

  // v_source_app_conversion's own view SQL carries a real CORRELATED SCALAR SUBQUERY (it reaches
  // app_users by an indexed SEARCH, never a SCAN); it must not be refused by the rule above.
  it('a view whose own definition has a correlated subquery, reached by an index, still runs', async () => {
    const result = await runReadOnlySelect(env.DB, 'SELECT source, rate FROM v_source_app_conversion ORDER BY rate DESC')
    expect(result.columns).toEqual(['source', 'rate'])
    expect(result.rows.length).toBeGreaterThan(0)
  })

  it('a query the EXPLAIN itself cannot plan is logged (plan_check_unavailable) but still reaches the real run, which reports its own failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const err = await runReadOnlySelect(env.DB, SYNTAX_ERROR_SQL).catch((e: unknown) => e)
      // Not a GateDenied: the plan check logged and stepped aside; the real run reports the
      // database's own failure (sanitizeSqlError), same as before D-81.
      expect(err).not.toBeInstanceOf(GateDenied)
      expect(err).toMatchObject({ name: 'SqlRunError' })
      const logged = errorSpy.mock.calls.map((args) => String(args[0]))
      expect(logged.some((line) => line.includes('plan_check_unavailable') && line.includes(SYNTAX_ERROR_SQL))).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
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

  // The self-audit's finding: both existing timeout tests inject `timeoutMs: 0`, which
  // raceTimeout short-circuits before creating any timer (`if (ms <= 0) throw`), so neither one
  // exercises the real `ms > 0` race at all — a mutant that deletes the `setTimeout(...)` line
  // and keeps the `ms <= 0` guard passed the whole suite. These two race the real timer directly
  // against a genuinely pending promise (never a mock of D1).
  it('raceTimeout, given ms > 0, really rejects once the timer fires, against a promise that has not settled', async () => {
    const neverWithinTest = new Promise((resolve) => setTimeout(resolve, 500))
    await expect(raceTimeout(neverWithinTest, 20)).rejects.toThrow()
  })

  it('raceTimeout, given ms > 0, resolves normally (and clears its timer) when the promise wins the race', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    try {
      await expect(raceTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok')
      expect(clearSpy).toHaveBeenCalled()
    } finally {
      clearSpy.mockRestore()
    }
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

  // LEGIT_SQL returns 100 rows but reads 45,323 (gate3-readonly-sql.ts's own measured comment): a
  // cap read from rows *returned* instead of D1's meta.rows_read would still pass at any cap
  // between those two numbers, so a mutant that swaps the field survives unless a test's cap sits
  // strictly between them.
  it('a cap between rows returned (100) and rows actually read (45,323) still refuses: the cap reads meta.rows_read, not rows returned', async () => {
    await expect(runReadOnlySelect(env.DB, LEGIT_SQL, [], { rowsReadCap: 1000 })).rejects.toBeInstanceOf(SqlTooHeavyError)
  })

  it('the exact measured boundary: a cap of 45,323 resolves, 45,322 refuses', async () => {
    await expect(runReadOnlySelect(env.DB, LEGIT_SQL, [], { rowsReadCap: 45_323 })).resolves.toMatchObject({ columns: ['pkey', 'page', 'utm_source'] })
    await expect(runReadOnlySelect(env.DB, LEGIT_SQL, [], { rowsReadCap: 45_322 })).rejects.toBeInstanceOf(SqlTooHeavyError)
  })

  it('the production default (SQL_ROWS_READ_CAP, 10x the largest legitimate query measured) does not refuse a real query', async () => {
    await expect(runReadOnlySelect(env.DB, LEGIT_SQL)).resolves.toMatchObject({ columns: ['pkey', 'page', 'utm_source'] })
    expect(SQL_ROWS_READ_CAP).toBeGreaterThan(45_323) // the largest measured legitimate query (gate3-readonly-sql.ts's own comment)
  })
})

describe('09 D-81 #4: one shared function protects every path that runs model/saved SQL, including the board and pin paths', () => {
  it('a pinned query-type tile whose stored SQL is a cartesian is refused on every board run, not just at pin time; nothing is stored or left behind', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const toolName = 'board_cartesian_probe'
    // Not CARTESIAN_COMMA: a tile's own key-projection guard (keyProjectionProblems) would refuse
    // its bare `pkey` columns before the call ever reaches the executor/Gate 3. This shape
    // selects only an aggregate, so it passes that guard and reaches the plan check below.
    await withRow(queryRow(toolName, CARTESIAN_IN_FROM_SUBQUERY), async () => {
      const insightId = crypto.randomUUID()
      const insightsBefore = await insightCount()
      const toolsBefore = await toolCount()
      await env.DB.prepare(
        `INSERT INTO insights (id, title, prompt, tool, tool_version, params, chart, sort_order, built_in, created_at)
         VALUES (?, 'D-81 cartesian probe tile', NULL, ?, ?, '{}', NULL, 9999, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
        .bind(insightId, toolName, INSIGHT_PARAMS_VERSION)
        .run()
      try {
        const { tiles } = await listBoard(env.DB)
        const tile = tiles.find((t) => t.id === insightId)
        expect(tile).toBeDefined()
        expect(tile!.status).toBe('error')
        expect(tile!.error_details).toContain('unindexed table scans')

        const audit = await lastAuditRowFor(toolName)
        expect(audit).toMatchObject({ kind: 'blocked', status: 'blocked', tool_name: toolName })
        expect(audit!.error).toMatch(/^gate3_denied: /)

        // listBoard only ever re-runs a tile; it never writes a new insights row or a new
        // assistant_tools row (the wrap-on-pin step, wrapQuerySql, runs only from pin()).
        expect(await insightCount()).toBe(insightsBefore + 1) // only the one this test inserted
        expect(await toolCount()).toBe(toolsBefore)
      } finally {
        await env.DB.prepare('DELETE FROM insights WHERE id = ?').bind(insightId).run()
      }
    })
  })

  it('a real Ask trace whose query_sql call is a cartesian leaves nothing pinnable: a genuine model_request row, still refused up front', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const insightsBefore = await insightCount()
    const toolsBefore = await toolCount()
    const traceId = await askOnce(CARTESIAN_COMMA)

    // A real model_request row exists (unlike runTool's bare tool-executor trace above), so
    // nothing_to_pin here is for the right reason: no successful tool_call to pin, not "no
    // model call happened at all".
    const rows = await auditRows(traceId)
    expect(rows.some((r) => r.kind === 'model_request')).toBe(true)
    expect(rows.some((r) => r.kind === 'blocked' && r.tool_name === 'query_sql' && r.error?.startsWith('gate3_denied: '))).toBe(true)
    expect(rows.some((r) => r.kind === 'tool_call' && r.status === 'success')).toBe(false)

    await expect(pinFromTrace(env.DB, { audit_id: traceId })).rejects.toMatchObject({ code: 'nothing_to_pin' })
    expect(await insightCount()).toBe(insightsBefore)
    expect(await toolCount()).toBe(toolsBefore) // no wrapQuerySql row was left behind
  })

  it('positive control: a real Ask trace with a legitimate query_sql call pins normally (so the negative result above is meaningful)', async () => {
    const legitGroupBy = "SELECT status, count(*) AS n FROM v_profiles GROUP BY status"
    const traceId = await askOnce(legitGroupBy)
    const tile = await pinFromTrace(env.DB, { audit_id: traceId })
    try {
      expect(tile.status).toBe('ok')
      expect(tile.result?.rows.length).toBeGreaterThan(0)
    } finally {
      await env.DB.prepare('DELETE FROM insights WHERE id = ?').bind(tile.id).run()
      await env.DB.prepare('DELETE FROM assistant_tools WHERE name = ?').bind(tile.tool).run()
    }
  })
})
