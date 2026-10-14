import { env, SELF } from 'cloudflare:test'
import type Anthropic from '@anthropic-ai/sdk'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { TOOL_SEEDS, toolSeedInsert } from '../scripts/tool-seeds'
import { TODAY } from '../shared/config'
import { lastMonth, lastNDays } from '../shared/derive'
import { SORT_ORDER_MAX } from '../worker/insights/board'
import { detectWindow, resolveWindow } from '../shared/insight-window'
import { findPII, loadKnownEmails } from '../worker/assistant/gates/pii-guard'
import { MODEL } from '../worker/assistant/build-request'
import type { MessagesTransport } from '../worker/assistant/loop'
import { BUILTIN_HANDLERS } from '../worker/assistant/tools/builtin-handlers'
import { requireJson, requireSession } from '../worker/auth/middleware'
import type { AppEnv } from '../worker/env'
import { onError } from '../worker/index'
import { INSIGHT_PANEL, INSIGHT_PANELS, type Tile } from '../worker/insights/board'
import { assistantRoutes } from '../worker/routes/assistant'
import { documentationIp, loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'

// The insights board (09 D-64; 04 §/api/insights board; 01 §insights; 06 §/insights):
// T-INS-4, T-INS-5, T-INS-6, T-INS-8 and T-INS-9 of 08.
//
// No test calls the network (09 D-54). Each pin starts from a real trace: a question sent through
// the production assistant route with a transport defined in this file that returns
// Messages-API-shaped turns written here (recorded test input, like assistant.test.ts), so the
// ai_audit rows are the ones the real gateway writes. The board itself is the production Worker
// (SELF) over the seeded D1 (data/*.csv) and the assistant_tools rows of scripts/tool-seeds.ts.
// Expected numbers come from 02 §Counts only: Instagram active went_cold_in(2026-08) = 46; the
// brief's preset = 177; 2,900 subscribers. Other numbers are compared between two paths (the
// tile and the same tool run directly), never written down. The demo subject
// joy.hall830@protonmail.com (subscribers.csv) is the real email a title must not carry (D-47).

const JOY = 'joy.hall830@protonmail.com'
const WENT_COLD_AUGUST = { metric: 'went_cold', status: ['active'], source: ['instagram'], window_from: '2026-08-01', window_to: '2026-08-31' }
const PRESET = { status: ['active'], source: ['instagram'], days_since_open_gte: 30, include_never_opened: true }
const WENT_COLD_AUGUST_SQL =
  "SELECT count(*) AS went_cold FROM v_profiles WHERE status = 'active' AND source = 'instagram' " +
  "AND cold_since BETWEEN '2026-08-01' AND '2026-08-31' AND cold_since <= '2026-09-28'"

let turn = 0

function message(content: Anthropic.ContentBlock[], stop_reason: Anthropic.StopReason): Anthropic.Message {
  turn += 1
  return {
    id: `msg_board_${turn}`,
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

/** Recorded turns: one tool round per call, in order, then a plain-text answer. Counts every transport call. */
const transportCalls: Anthropic.MessageCreateParamsNonStreaming[] = []
function recorded(calls: Array<{ name: string; input: unknown }>): MessagesTransport {
  const responses = [
    ...calls.map((c, i) => () => message([{ type: 'tool_use', id: `toolu_${turn}_${i}`, name: c.name, input: c.input, caller: { type: 'direct' } }], 'tool_use')),
    () => message([{ type: 'text', text: 'Here is the answer.', citations: null }], 'end_turn'),
  ]
  let n = 0
  return async (request) => {
    transportCalls.push(request)
    const next = responses[n++]
    if (next === undefined) throw new Error('recorded transport: no turn left')
    return next()
  }
}

/** Asks through the production assistant route with recorded turns; returns the trace id (audit_id). */
async function askRecorded(question: string, calls: Array<{ name: string; input: unknown }>): Promise<string> {
  return (await askAnswer(question, calls)).audit_id
}

/** The whole 200 body of POST /api/assistant for recorded turns. */
async function askAnswer(
  question: string,
  calls: Array<{ name: string; input: unknown }>,
): Promise<{ audit_id: string; pin_window: { from: string; to: string } | null }> {
  const app = new Hono<AppEnv>()
  app.use('/api/*', requireJson, requireSession)
  app.route('/api', assistantRoutes(() => recorded(calls)))
  app.onError(onError)
  const res = await app.request(
    '/api/assistant',
    { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ question }) },
    env,
  )
  expect(res.status).toBe(200)
  return res.json()
}

let cookie: string

const api = (path: string, init: { method?: string; body?: unknown; cookie?: string | null } = {}) =>
  SELF.fetch(`http://cdp.test/api/insights${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.cookie === null ? {} : { cookie: init.cookie ?? cookie }),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })

async function board(): Promise<{ today: string; tiles: Tile[] }> {
  const res = await api('')
  expect(res.status).toBe(200)
  return res.json()
}

async function pin(body: unknown): Promise<Tile> {
  const res = await api('', { method: 'POST', body })
  expect(res.status, await res.clone().text()).toBe(201)
  return res.json()
}

interface StoredRow {
  id: string
  title: string
  prompt: string | null
  tool: string
  params: string
  chart: string | null
  sort_order: number
  built_in: number
}

async function stored(id: string): Promise<StoredRow | null> {
  return env.DB.prepare('SELECT id, title, prompt, tool, params, chart, sort_order, built_in FROM insights WHERE id = ?').bind(id).first<StoredRow>()
}

const tileCount = () => env.DB.prepare('SELECT count(*) AS n FROM insights').first<number>('n')

/** Replaces the checked input stored on a trace's successful tool_call row (an edited copy of a real trace, 09 D-47). */
async function editTracedInput(auditId: string, input: unknown): Promise<void> {
  const res = await env.DB.prepare("UPDATE ai_audit SET request_json = ? WHERE trace_id = ? AND kind = 'tool_call' AND status = 'success'")
    .bind(JSON.stringify(input), auditId)
    .run()
  expect(res.meta.changes).toBe(1)
}

/** Stores a copy of a real pinned row under a new id with other params (stored-state drift, 09 D-47). */
async function insertCopy(of: string, params: Record<string, unknown>, title: string): Promise<string> {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO insights (id, title, prompt, tool, tool_version, params, chart, sort_order, built_in, created_at)
     SELECT ?, ?, prompt, tool, tool_version, ?, chart, sort_order + 1, built_in, created_at FROM insights WHERE id = ?`,
  )
    .bind(id, title, JSON.stringify(params), of)
    .run()
  return id
}

beforeAll(async () => {
  await seedDatabase()
  for (const seed of TOOL_SEEDS) {
    const { sql, params } = toolSeedInsert(seed)
    await env.DB.prepare(sql).bind(...params).run()
  }
  cookie = await loginCookie(documentationIp())
})

describe('T-INS-4: a pin is the trace’s last successful tool call, re-validated server-side', () => {
  it('stores the last successful tool call of a real trace, not an earlier one or a later failed one', async () => {
    const auditId = await askRecorded(`how many Instagram signups like ${JOY} went cold last month?`, [
      { name: 'segment', input: PRESET },
      { name: 'aggregate', input: WENT_COLD_AUGUST },
      { name: 'aggregate', input: { metric: 'went_cold' } }, // fails: went_cold needs a window
    ])
    const calls = await env.DB.prepare("SELECT tool_name, status FROM ai_audit WHERE trace_id = ? AND kind = 'tool_call' ORDER BY created_at, rowid")
      .bind(auditId)
      .all<{ tool_name: string; status: string }>()
    expect(calls.results.map((r) => `${r.tool_name}/${r.status}`)).toEqual(['segment/success', 'aggregate/success', 'aggregate/error'])

    const tile = await pin({ audit_id: auditId })
    expect(tile).toMatchObject({ tool: 'aggregate', built_in: false, status: 'ok', error: null, chart: 'number' })
    expect(tile.result?.rows).toEqual([{ went_cold: 46 }]) // 02 §Counts
    // The prompt is the question as the model received it: Gate 1 redacted the email (05).
    expect(tile.prompt).toBe('how many Instagram signups like [email] went cold last month?')
    expect(tile.title).toBe(tile.prompt)
    const row = await stored(tile.id)
    expect(row).not.toBeNull()
    expect(row!.tool).toBe('aggregate')
    expect(JSON.parse(row!.params)).toEqual({ metric: 'went_cold', status: ['active'], source: ['instagram'], window: { rolling: 'last_month' } })
  })

  it('refuses a body carrying tool, params or sql; an unknown trace is 404; no successful tool call is 409', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const auditId = await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }])
    for (const extra of [{ tool: 'query_sql' }, { params: { metric: 'subscribers' } }, { sql: 'SELECT 1' }]) {
      const res = await api('', { method: 'POST', body: { audit_id: auditId, ...extra } })
      expect(res.status).toBe(400)
      expect((await res.json<{ error: string }>()).error).toBe('invalid_body')
    }
    const before = await env.DB.prepare('SELECT count(*) AS n FROM insights').first<number>('n')

    const unknown = await api('', { method: 'POST', body: { audit_id: crypto.randomUUID() } })
    expect(unknown.status).toBe(404)
    expect((await unknown.json<{ error: string }>()).error).toBe('not_found')

    const noTool = await askRecorded('how many went cold?', [{ name: 'aggregate', input: { metric: 'went_cold' } }])
    const nothing = await api('', { method: 'POST', body: { audit_id: noTool } })
    expect(nothing.status).toBe(409)
    expect((await nothing.json<{ error: string }>()).error).toBe('nothing_to_pin')

    // A board run's trace holds successful tool calls but no answer: nothing to pin either.
    await board()
    const boardTrace = await env.DB.prepare(
      "SELECT trace_id FROM ai_audit WHERE tool_name = 'insight_panel' AND status = 'success' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).first<string>('trace_id')
    const fromBoard = await api('', { method: 'POST', body: { audit_id: boardTrace } })
    expect(fromBoard.status).toBe(409)
    expect((await fromBoard.json<{ error: string }>()).error).toBe('nothing_to_pin')

    expect(await env.DB.prepare('SELECT count(*) AS n FROM insights').first<number>('n')).toBe(before)
  })

  it('a stored call that fails Gate 2 against today’s tool rows is 400 and stores nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const auditId = await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }])
    // The aggregate row's schema changes after the answer: its window inputs are no longer declared.
    const original = await env.DB.prepare("SELECT input_schema FROM assistant_tools WHERE name = 'aggregate'").first<string>('input_schema')
    const schema = JSON.parse(original!) as { properties: Record<string, unknown> }
    delete schema.properties.window_from
    delete schema.properties.window_to
    await env.DB.prepare("UPDATE assistant_tools SET input_schema = ? WHERE name = 'aggregate'").bind(JSON.stringify(schema)).run()
    try {
      const before = await env.DB.prepare('SELECT count(*) AS n FROM insights').first<number>('n')
      const res = await api('', { method: 'POST', body: { audit_id: auditId } })
      expect(res.status).toBe(400)
      const body = await res.json<{ error: string; details: string[] }>()
      expect(body.error).toBe('invalid_pin')
      expect(body.details).toContain('input_schema: input has unknown property "window_from"')
      expect(await env.DB.prepare('SELECT count(*) AS n FROM insights').first<number>('n')).toBe(before)
    } finally {
      await env.DB.prepare("UPDATE assistant_tools SET input_schema = ? WHERE name = 'aggregate'").bind(original).run()
    }
  })

  it('a stored query_sql that reads a raw table or is not one SELECT fails Gate 2 / Gate 3 on re-validation: 400, nothing stored', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const explanation = 'Instagram active readers whose cold_since is in August'
    for (const [sql, gate] of [
      ['SELECT email_norm FROM subscribers LIMIT 1', 'gate2'],
      // Over the views, so Gate 2's view check passes; a comment is not one plain SELECT (Gate 3).
      ["SELECT count(*) AS went_cold FROM v_profiles WHERE source = 'instagram' /* every reader */", 'gate3'],
    ] as const) {
      const auditId = await askRecorded('how many Instagram signups went cold last month?', [{ name: 'query_sql', input: { sql: WENT_COLD_AUGUST_SQL, explanation } }])
      await editTracedInput(auditId, { sql, explanation })
      const before = await tileCount()
      const res = await api('', { method: 'POST', body: { audit_id: auditId } })
      expect(res.status, sql).toBe(400)
      const body = await res.json<{ error: string; details: string[] }>()
      expect(body.error).toBe('invalid_pin')
      expect(body.details.length).toBeGreaterThan(0)
      expect(body.details.every((d) => d.startsWith(`${gate}: `)), JSON.stringify(body.details)).toBe(true)
      expect(await tileCount()).toBe(before)
    }
  })

  it('the answer reports the time period a pin keeps (pin_window): the aggregate’s window, none for a segment', async () => {
    const aggregate = await askAnswer('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }])
    expect(aggregate.pin_window).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    const segment = await askAnswer('which Instagram readers have not opened in 30 days?', [{ name: 'segment', input: PRESET }])
    expect(segment.pin_window).toBeNull()
    // The pin stores exactly that: a window for the aggregate, none for the segment.
    expect((await pin({ audit_id: aggregate.audit_id })).window).toMatchObject({ from: '2026-08-01', to: '2026-08-31' })
    expect((await pin({ audit_id: segment.audit_id })).window).toBeNull()
  })
})

describe('T-INS-5: windows resolve against TODAY', () => {
  it('rolling presets resolve on TODAY; fixed stays as stored; detection prefers a preset', () => {
    expect(TODAY).toBe('2026-09-28')
    expect(resolveWindow({ rolling: 'last_month' }, TODAY)).toEqual({ kind: 'rolling', preset: 'last_month', from: '2026-08-01', to: '2026-08-31' })
    expect(resolveWindow({ rolling: 'last_month' }, TODAY)).toMatchObject(lastMonth()) // 02 §Derived "last month"
    // 02 §Derived "last N days" = TODAY − N .. TODAY = 2026-08-29..2026-09-28 (08 T-INS-5); the
    // same window as lastNDays(30) and new_subscriber. Literal dates, so a one-day drift fails here.
    expect(resolveWindow({ rolling: 'last_30_days' }, TODAY)).toEqual({ kind: 'rolling', preset: 'last_30_days', from: '2026-08-29', to: '2026-09-28' })
    expect(lastNDays(30)).toEqual({ from: '2026-08-29', to: '2026-09-28' })
    expect(resolveWindow({ rolling: 'this_month' }, TODAY)).toEqual({ kind: 'rolling', preset: 'this_month', from: '2026-09-01', to: '2026-09-28' })
    expect(resolveWindow({ fixed: ['2026-08-01', '2026-08-15'] }, TODAY)).toEqual({ kind: 'fixed', from: '2026-08-01', to: '2026-08-15' })
    expect(detectWindow('2026-08-01', '2026-08-31', TODAY)).toEqual({ rolling: 'last_month' })
    expect(detectWindow('2026-08-01', '2026-08-15', TODAY)).toEqual({ fixed: ['2026-08-01', '2026-08-15'] })
  })

  it('a pinned went-cold aggregate returns 46 for last month; a fixed window stays fixed; PATCH re-resolves', async () => {
    const tile = await pin({ audit_id: await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }]) })
    expect(tile.window).toEqual({ kind: 'rolling', preset: 'last_month', from: '2026-08-01', to: '2026-08-31' })
    expect(tile.result?.rows).toEqual([{ went_cold: 46 }])

    const halfAugust = { ...WENT_COLD_AUGUST, window_to: '2026-08-15' }
    const fixed = await pin({ audit_id: await askRecorded('how many Instagram signups went cold in early August?', [{ name: 'aggregate', input: halfAugust }]) })
    expect(fixed.window).toEqual({ kind: 'fixed', from: '2026-08-01', to: '2026-08-15' })
    expect(JSON.parse((await stored(fixed.id))!.params).window).toEqual({ fixed: ['2026-08-01', '2026-08-15'] })
    const direct = await BUILTIN_HANDLERS.aggregate.run(env.DB, halfAugust)
    expect(fixed.result?.rows).toEqual(direct.rows)

    const res = await api(`/${tile.id}`, { method: 'PATCH', body: { window: { rolling: 'last_30_days' } } })
    expect(res.status).toBe(200)
    const moved = await res.json<Tile>()
    expect(moved.window).toEqual({ kind: 'rolling', preset: 'last_30_days', from: '2026-08-29', to: '2026-09-28' })
    const direct30 = await BUILTIN_HANDLERS.aggregate.run(env.DB, { ...WENT_COLD_AUGUST, window_from: '2026-08-29', window_to: '2026-09-28' })
    expect(moved.result?.rows).toEqual(direct30.rows)
  })

  it('a query_sql window is stored as :window_from/:window_to and runs through Gate 2 and Gate 3', async () => {
    const tile = await pin({
      audit_id: await askRecorded('how many Instagram signups went cold last month?', [
        { name: 'query_sql', input: { sql: WENT_COLD_AUGUST_SQL, explanation: 'Instagram active readers whose cold_since is in August' } },
      ]),
    })
    expect(tile.result?.rows).toEqual([{ went_cold: 46 }])
    expect(tile.window).toMatchObject({ kind: 'rolling', preset: 'last_month' })
    const params = JSON.parse((await stored(tile.id))!.params) as { sql: string; window: unknown }
    expect(params.window).toEqual({ rolling: 'last_month' })
    expect(params.sql).toContain('cold_since BETWEEN :window_from AND :window_to')
    expect(params.sql).not.toContain("'2026-08-01'")
    expect(tile.sql).toContain("BETWEEN '2026-08-01' AND '2026-08-31'") // the SQL that ran

    const res = await api(`/${tile.id}`, { method: 'PATCH', body: { window: { fixed: ['2026-08-01', '2026-08-15'] } } })
    expect(res.status).toBe(200)
    const moved = await res.json<Tile>()
    const direct = await BUILTIN_HANDLERS.aggregate.run(env.DB, { ...WENT_COLD_AUGUST, window_to: '2026-08-15' })
    expect(moved.result?.rows).toEqual(direct.rows)
    expect(moved.sql).toContain("BETWEEN '2026-08-01' AND '2026-08-15'")
  })

  it('"Explain this" on a pinned tile names the time period it shows now, not the one it was asked about', async () => {
    const question = 'how many Instagram signups went cold last month?'
    const tile = await pin({ audit_id: await askRecorded(question, [{ name: 'aggregate', input: WENT_COLD_AUGUST }]) })
    expect(tile.explain).toBe(`${question} (time period: Aug 1–31, 2026)`)
    expect((await api(`/${tile.id}`, { method: 'PATCH', body: { window: { rolling: 'this_month' } } })).status).toBe(200)
    const after = (await board()).tiles.find((t) => t.id === tile.id)!
    expect(after.window).toMatchObject({ from: '2026-09-01', to: '2026-09-28' })
    expect(after.explain).toBe(`${question} (time period: Sep 1–28, 2026)`)
    // A built-in tile keeps its panel's own question (09 D-39).
    const builtIn = (await board()).tiles.find((t) => t.id === 'builtin-going-cold')!
    expect(builtIn.explain).not.toContain('time period:')
  })
})

describe('T-INS-6: the board re-runs every tile with no model call', () => {
  it('every tile equals the same tool run directly; the transport is never called', async () => {
    await pin({ audit_id: await askRecorded('which readers went quiet?', [{ name: 'segment', input: PRESET }]) })
    const transportBefore = transportCalls.length
    const modelRowsBefore = await env.DB.prepare("SELECT count(*) AS n FROM ai_audit WHERE kind = 'model_request'").first<number>('n')

    const { today, tiles } = await board()
    expect(today).toBe(TODAY)
    expect(transportCalls.length).toBe(transportBefore)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM ai_audit WHERE kind = 'model_request'").first<number>('n')).toBe(modelRowsBefore)
    expect(tiles.map((t) => t.sort_order)).toEqual([...tiles.map((t) => t.sort_order)].sort((a, b) => a - b))

    for (const tile of tiles) {
      expect(tile.status, `${tile.title}: ${tile.error}`).toBe('ok')
      const row = await stored(tile.id)
      const params = JSON.parse(row!.params) as Record<string, unknown>
      if (tile.tool === 'insight_panel') {
        const direct = await INSIGHT_PANEL.handler.run(env.DB, params)
        expect(tile.result).toEqual({ columns: direct.columns, rows: direct.rows, summary: direct.summary })
      } else if (tile.tool === 'segment') {
        const direct = await BUILTIN_HANDLERS.segment.run(env.DB, params)
        expect(tile.segment).toEqual({ count: direct.segment!.count, filters: direct.segment!.filters })
      } else if (tile.tool === 'aggregate' || tile.tool === 'query_sql') {
        // The stored params with the window written back as the tile ran it.
        const { window: _window, ...rest } = params
        const input =
          tile.tool === 'query_sql' ? { ...rest, sql: tile.sql } : tile.window === null ? rest : { ...rest, window_from: tile.window.from, window_to: tile.window.to }
        const direct = await BUILTIN_HANDLERS[tile.tool].run(env.DB, input)
        expect(tile.result?.rows).toEqual(direct.rows)
      } else {
        throw new Error(`T-INS-6: no direct run for tool ${tile.tool}`)
      }
    }
    // The board's own trace holds tool calls only, and none counts toward a session's limit.
    const boardRows = await env.DB.prepare(
      "SELECT kind, session_sub FROM ai_audit WHERE trace_id = (SELECT trace_id FROM ai_audit WHERE tool_name = 'insight_panel' ORDER BY created_at DESC, rowid DESC LIMIT 1)",
    ).all<{ kind: string; session_sub: string | null }>()
    expect(boardRows.results.length).toBe(tiles.length)
    expect(boardRows.results.every((r) => r.kind === 'tool_call' && r.session_sub === null)).toBe(true)
  })

  it('one failing tile is that tile’s error; the board still answers 200', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tile = await pin({ audit_id: await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }]) })
    await env.DB.prepare("UPDATE assistant_tools SET enabled = 0 WHERE name = 'aggregate'").run()
    try {
      const { tiles } = await board()
      const failed = tiles.filter((t) => t.status === 'error')
      expect(failed.length).toBeGreaterThan(0)
      expect(failed.every((t) => t.tool === 'aggregate' && t.result === null && t.error !== null)).toBe(true)
      expect(failed.map((t) => t.id)).toContain(tile.id)
      expect(tiles.filter((t) => t.tool !== 'aggregate').every((t) => t.status === 'ok')).toBe(true)
    } finally {
      await env.DB.prepare("UPDATE assistant_tools SET enabled = 1 WHERE name = 'aggregate'").run()
    }
  })
})

describe('T-INS-8: built-in tiles, PATCH, DELETE, session', () => {
  it('the four former Growth panels are seeded built-ins and cannot be deleted', async () => {
    const builtIns = (await env.DB.prepare('SELECT id, tool, params, built_in FROM insights WHERE built_in = 1 ORDER BY sort_order').all<StoredRow>()).results
    expect(builtIns.map((r) => JSON.parse(r.params).panel)).toEqual([...INSIGHT_PANELS])
    expect(builtIns.every((r) => r.tool === 'insight_panel')).toBe(true)
    // insight_panel is the board's own tool, never an assistant_tools row (09 D-64).
    expect(await env.DB.prepare("SELECT count(*) AS n FROM assistant_tools WHERE name = 'insight_panel'").first<number>('n')).toBe(0)

    const { tiles } = await board()
    const panelTiles = tiles.filter((t) => t.built_in)
    expect(panelTiles).toHaveLength(4)
    const sourceApp = panelTiles.find((t) => t.id === builtIns[0].id)!
    expect(sourceApp.result?.summary.total).toMatchObject({ subscribers: 2900 }) // 02 §Counts
    expect(sourceApp.chart).toBe('bar')

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const { id } of builtIns) {
      const res = await api(`/${id}`, { method: 'DELETE' })
      expect(res.status).toBe(409)
      expect((await res.json<{ error: string }>()).error).toBe('built_in')
    }
    expect(await env.DB.prepare('SELECT count(*) AS n FROM insights WHERE built_in = 1').first<number>('n')).toBe(4)
  })

  it('PATCH title, window, chart and sort_order; DELETE 204', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tile = await pin({ audit_id: await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }]) })
    const res = await api(`/${tile.id}`, {
      method: 'PATCH',
      body: { title: 'Instagram readers who went cold', chart: 'table', sort_order: 5, window: { fixed: ['2026-08-01', '2026-08-31'] } },
    })
    expect(res.status).toBe(200)
    const patched = await res.json<Tile>()
    expect(patched).toMatchObject({ title: 'Instagram readers who went cold', chart: 'table', chart_override: 'table', sort_order: 5 })
    expect(patched.window).toEqual({ kind: 'fixed', from: '2026-08-01', to: '2026-08-31' })
    const row = await stored(tile.id)
    expect(row).toMatchObject({ title: 'Instagram readers who went cold', chart: 'table', sort_order: 5 })
    expect(JSON.parse(row!.params).window).toEqual({ fixed: ['2026-08-01', '2026-08-31'] })

    const auto = await api(`/${tile.id}`, { method: 'PATCH', body: { chart: null } })
    expect((await auto.json<Tile>()).chart).toBe('number')

    for (const [body, code] of [
      [{ chart: 'pie' }, 'invalid_body'],
      [{ window: { fixed: ['2026-08-31', '2026-08-01'] } }, 'invalid_body'],
      [{ title: ' ' }, 'invalid_body'],
      [{ tool: 'query_sql' }, 'invalid_body'],
    ] as const) {
      const bad = await api(`/${tile.id}`, { method: 'PATCH', body })
      expect(bad.status).toBe(400)
      expect((await bad.json<{ error: string }>()).error).toBe(code)
    }
    const builtInWindow = await api('/builtin-funnel', { method: 'PATCH', body: { window: { rolling: 'last_month' } } })
    expect(builtInWindow.status).toBe(400)
    expect((await builtInWindow.json<{ error: string }>()).error).toBe('no_window')
    const renamed = await api('/builtin-funnel', { method: 'PATCH', body: { title: 'Visitors who subscribed' } })
    expect(renamed.status).toBe(200)
    await api('/builtin-funnel', { method: 'PATCH', body: { title: 'Website visitors who subscribed' } })

    const del = await api(`/${tile.id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    expect(await stored(tile.id)).toBeNull()
    expect((await api(`/${tile.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('PATCH re-validates a new window against today’s tool rows: 400 invalid_window, params unchanged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tile = await pin({ audit_id: await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }]) })
    const paramsBefore = (await stored(tile.id))!.params
    const original = await env.DB.prepare("SELECT input_schema FROM assistant_tools WHERE name = 'aggregate'").first<string>('input_schema')
    const schema = JSON.parse(original!) as { properties: Record<string, unknown> }
    delete schema.properties.window_from
    delete schema.properties.window_to
    await env.DB.prepare("UPDATE assistant_tools SET input_schema = ? WHERE name = 'aggregate'").bind(JSON.stringify(schema)).run()
    try {
      const res = await api(`/${tile.id}`, { method: 'PATCH', body: { window: { rolling: 'last_30_days' } } })
      expect(res.status).toBe(400)
      const body = await res.json<{ error: string; details: string[] }>()
      expect(body.error).toBe('invalid_window')
      expect(body.details).toContain('input_schema: input has unknown property "window_from"')
      expect((await stored(tile.id))!.params).toBe(paramsBefore)
    } finally {
      await env.DB.prepare("UPDATE assistant_tools SET input_schema = ? WHERE name = 'aggregate'").bind(original).run()
    }
  })

  it('PATCH needs Content-Type: application/json (415), a bounded sort_order, and no chart on a list tile', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plain = await SELF.fetch('http://cdp.test/api/insights/builtin-funnel', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'text/plain' },
      body: JSON.stringify({ title: 'Renamed by a form post' }),
    })
    expect(plain.status).toBe(415)
    expect((await plain.json<{ error: string }>()).error).toBe('unsupported_media_type')
    expect((await stored('builtin-funnel'))!.title).toBe('Website visitors who subscribed')

    for (const sort_order of [SORT_ORDER_MAX + 1, -SORT_ORDER_MAX - 1, Number.MAX_SAFE_INTEGER]) {
      const res = await api('/builtin-funnel', { method: 'PATCH', body: { sort_order } })
      expect(res.status, String(sort_order)).toBe(400)
      expect((await res.json<{ error: string }>()).error).toBe('invalid_body')
    }
    expect((await api('/builtin-funnel', { method: 'PATCH', body: { sort_order: SORT_ORDER_MAX } })).status).toBe(200)
    // The next pin goes last and stays a safe integer (max + 10, capped).
    const last = await pin({ audit_id: await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }]) })
    expect(Number.isSafeInteger(last.sort_order) && last.sort_order <= SORT_ORDER_MAX).toBe(true)
    expect((await api('/builtin-funnel', { method: 'PATCH', body: { sort_order: 20 } })).status).toBe(200)
    expect((await api(`/${last.id}`, { method: 'DELETE' })).status).toBe(204)

    // A segment tile always shows its count and "Open list" (09 D-64): a chart override is refused.
    const list = await pin({ audit_id: await askRecorded('which Instagram readers have not opened in 30 days?', [{ name: 'segment', input: PRESET }]) })
    const chart = await api(`/${list.id}`, { method: 'PATCH', body: { chart: 'number' } })
    expect(chart.status).toBe(400)
    expect((await chart.json<{ error: string }>()).error).toBe('invalid_body')
    expect((await stored(list.id))!.chart).toBeNull()
    expect((await api(`/${list.id}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('every board route needs a session: 401 without one', async () => {
    const anyId = 'builtin-funnel'
    for (const [path, method, body] of [
      ['', 'GET', undefined],
      ['', 'POST', { audit_id: crypto.randomUUID() }],
      [`/${anyId}`, 'PATCH', { title: 'x' }],
      [`/${anyId}`, 'DELETE', undefined],
    ] as const) {
      const res = await api(path, { method, body, cookie: null })
      expect(res.status, `${method} ${path}`).toBe(401)
      expect((await res.json<{ error: string }>()).error).toBe('unauthorized')
    }
    expect(await env.DB.prepare('SELECT count(*) AS n FROM insights WHERE built_in = 1').first<number>('n')).toBe(4)
  })
})

describe('T-INS-9: no tile or stored row holds an email or a raw id', () => {
  it('a segment tile is a count and filters, never rows', async () => {
    const tile = await pin({ audit_id: await askRecorded('which Instagram readers have not opened in 30 days?', [{ name: 'segment', input: PRESET }]) })
    expect(tile.chart).toBe('segment')
    expect(tile.segment?.count).toBe(177) // 02 §Counts, the brief's preset
    expect(tile.segment?.filters).toMatchObject({ status: ['active'], source: ['instagram'], days_since_open_gte: 30, include_never_opened: true })
    expect(tile.result?.rows).toEqual([])
    expect(JSON.stringify(tile)).not.toContain('pk_')
  })

  it('the scanner passes every tile and every stored row; a title with an email is refused before insert', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const known = await loadKnownEmails(env.DB)
    const res = await api('')
    const text = await res.text()
    expect(findPII(text, known)).toBeNull()
    const rows = (await env.DB.prepare('SELECT * FROM insights').all()).results
    expect(rows.length).toBeGreaterThan(4)
    expect(findPII(rows, known)).toBeNull()

    const auditId = await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }])
    const before = rows.length
    const refused = await api('', { method: 'POST', body: { audit_id: auditId, title: `Readers like ${JOY}` } })
    expect(refused.status).toBe(400)
    const body = await refused.json<{ error: string; message: string }>()
    expect(body.error).toBe('blocked_pii')
    expect(body.message).not.toContain('@')
    expect(await env.DB.prepare('SELECT count(*) AS n FROM insights').first<number>('n')).toBe(before)
  })

  it('a pin whose rows name individual readers is refused: the board holds counts only', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = await tileCount()
    for (const sql of [
      "SELECT pkey, signup_date FROM v_profiles WHERE source = 'instagram' LIMIT 5",
      // A key inside a longer cell, and a key with its pk_ prefix cut off, name readers too.
      "SELECT ' ' || group_concat(pkey) AS ks, count(*) AS n FROM v_profiles WHERE source = 'instagram'",
      "SELECT substr(pkey, 4) AS k, engagement_score FROM v_profiles WHERE source = 'instagram' LIMIT 5",
    ]) {
      const auditId = await askRecorded('list some Instagram readers', [{ name: 'query_sql', input: { sql, explanation: 'Instagram readers' } }])
      const res = await api('', { method: 'POST', body: { audit_id: auditId } })
      expect(res.status, sql).toBe(400)
      expect((await res.json<{ error: string }>()).error).toBe('not_aggregate')
    }
    expect(await tileCount()).toBe(before)
  })

  it('a traced input holding an email is refused at pin (the saved input is scanned before insert)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const auditId = await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }])
    await editTracedInput(auditId, { ...WENT_COLD_AUGUST, source: [JOY] })
    const before = await tileCount()
    const res = await api('', { method: 'POST', body: { audit_id: auditId } })
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string; message: string; details: Array<{ field: string }> }>()
    expect(body.error).toBe('blocked_pii')
    expect(body.details[0].field).toBe('saved input')
    expect(body.message).not.toContain('@')
    expect(JSON.stringify(body)).not.toContain(JOY)
    expect(await tileCount()).toBe(before)
  })

  it('a stored tile whose params or SQL drifted to hold an email is that tile’s error; the board answers 200 without the email', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const aggregate = await pin({ audit_id: await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }]) })
    const sqlTile = await pin({
      audit_id: await askRecorded('how many Instagram signups went cold last month?', [
        { name: 'query_sql', input: { sql: WENT_COLD_AUGUST_SQL, explanation: 'Instagram active readers whose cold_since is in August' } },
      ]),
    })
    const aggregateParams = JSON.parse((await stored(aggregate.id))!.params) as Record<string, unknown>
    const sqlParams = JSON.parse((await stored(sqlTile.id))!.params) as { sql: string }
    const drifted = [
      await insertCopy(aggregate.id, { ...aggregateParams, source: [JOY] }, 'Drifted params'),
      await insertCopy(sqlTile.id, { ...sqlParams, sql: sqlParams.sql.replace("source = 'instagram'", `source = '${JOY}'`) }, 'Drifted SQL'),
    ]
    try {
      const res = await api('')
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).not.toContain(JOY)
      expect(findPII(text, await loadKnownEmails(env.DB))).toBeNull()
      const { tiles } = JSON.parse(text) as { tiles: Tile[] }
      for (const id of drifted) {
        const tile = tiles.find((t) => t.id === id)!
        expect(tile).toMatchObject({ status: 'error', result: null, params: {}, sql: null, prompt: null })
        expect(tile.error).toContain('personal-data check')
      }
      expect(tiles.filter((t) => !drifted.includes(t.id)).every((t) => t.status === 'ok')).toBe(true)
      // The block is in the audit trail, without the email (03 row 11).
      const blocked = await env.DB.prepare("SELECT error FROM ai_audit WHERE kind = 'blocked' AND error LIKE 'blocked_pii:% in audit_row' ORDER BY rowid DESC LIMIT 2").all<{ error: string }>()
      expect(blocked.results).toHaveLength(2)
    } finally {
      for (const id of drifted) await env.DB.prepare('DELETE FROM insights WHERE id = ?').bind(id).run()
    }
  })
})

describe('board runs in the audit log (05 §Proof surfaces, R5.5)', () => {
  it('a board run is listed as board_run only on request; the questions stay on the default page', async () => {
    const auditId = await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }])
    for (let i = 0; i < 4; i++) await board()
    const boardTrace = await env.DB.prepare("SELECT trace_id FROM ai_audit WHERE tool_name = 'insight_panel' ORDER BY rowid DESC LIMIT 1").first<string>('trace_id')
    const list = async (query: string) => {
      const res = await SELF.fetch(`http://cdp.test/api/audit${query}`, { headers: { cookie } })
      expect(res.status, query).toBe(200)
      return (await res.json<{ traces: Array<{ trace_id: string; outcome: string; reached_ai: boolean; model_calls: number }> }>()).traces
    }
    // Four board runs came after the question; a default page of 3 still starts with it.
    const page = await list('?limit=3')
    expect(page[0].trace_id).toBe(auditId)
    expect(page.every((t) => t.outcome !== 'board_run')).toBe(true)
    const all = await list('?limit=100&board_runs=include')
    const run = all.find((t) => t.trace_id === boardTrace)
    expect(run).toMatchObject({ outcome: 'board_run', reached_ai: false, model_calls: 0 })
    expect(all.filter((t) => t.outcome === 'board_run').length).toBeGreaterThanOrEqual(4)
    expect(all.some((t) => t.trace_id === auditId && t.outcome === 'answered')).toBe(true)

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = await SELF.fetch('http://cdp.test/api/audit?board_runs=yes', { headers: { cookie } })
    expect(bad.status).toBe(400)
    expect((await bad.json<{ error: string }>()).error).toBe('invalid_board_runs')
  })
})
