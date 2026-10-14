import { env, SELF } from 'cloudflare:test'
import type Anthropic from '@anthropic-ai/sdk'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { TOOL_SEEDS, type ToolSeed, toolSeedInsert } from '../scripts/tool-seeds'
import { TODAY } from '../shared/config'
import { lastMonth, lastNDays } from '../shared/derive'
import {
  BLOCKED_TILE_TITLE,
  INSIGHT_PARAMS_VERSION,
  KEY_PIECE_CHARS,
  keyProjectionProblems,
  loadKnownKeys,
  namesASubject,
  NOT_PINNABLE_MESSAGE,
  NOT_PINNABLE_OTHER_MESSAGE,
  PIN_FAILED_MESSAGE,
  SORT_ORDER_MAX,
  TILE_RUN_FAILED_MESSAGE,
} from '../worker/insights/board'
import { detectWindow, resolveWindow } from '../shared/insight-window'
import { sanitizeQuestion } from '../worker/assistant/gates/gate1-input-sanitizer'
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
): Promise<{
  audit_id: string
  pin_window: { from: string; to: string } | null
  pin_own_dates: { from: string; to: string } | null
  pin_refusal: string | null
}> {
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

/**
 * Stores a copy of a real pinned row under a new id with other params, and optionally another
 * prompt (stored-state drift, 09 D-47).
 */
async function insertCopy(of: string, params: Record<string, unknown>, title: string, prompt?: string): Promise<string> {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO insights (id, title, prompt, tool, tool_version, params, chart, sort_order, built_in, created_at)
     SELECT ?, ?, coalesce(?, prompt), tool, tool_version, ?, chart, sort_order + 1, built_in, created_at FROM insights WHERE id = ?`,
  )
    .bind(id, title, prompt ?? null, JSON.stringify(params), of)
    .run()
  return id
}

/** The one seeded query row (scripts/tool-seeds.ts): a pinnable lookup with fixed SQL (09 D-64a). */
const QUERY_ROW = 'pages_new_subscribers_hit_first'

/**
 * Runs `body` with one more enabled `query` row whose template is `sql`, the way the Growth team adds
 * a question type (09 D-41), then removes it. The loader validates it like any row (03 row 3).
 */
async function withQueryRow(sql: string, body: (name: string) => Promise<void>): Promise<void> {
  const seed: ToolSeed = {
    name: 'board_test_lookup',
    description: 'A lookup added for this test.',
    inputSchema: { type: 'object', properties: {} },
    handlerType: 'query',
    executionConfig: { sql, param_mapping: {} },
    sortOrder: 900,
  }
  const { sql: insert, params } = toolSeedInsert(seed)
  await env.DB.prepare(insert).bind(...params).run()
  try {
    await body(seed.name)
  } finally {
    await env.DB.prepare('DELETE FROM assistant_tools WHERE name = ?').bind(seed.name).run()
  }
}

/** Replaces the seeded query row's SQL template for the length of `body` (stored-state drift, 09 D-47). */
async function withQueryRowSql(sql: string, body: () => Promise<void>): Promise<void> {
  const original = await env.DB.prepare('SELECT execution_config FROM assistant_tools WHERE name = ?').bind(QUERY_ROW).first<string>('execution_config')
  const config = JSON.parse(original!) as { sql: string }
  await env.DB.prepare('UPDATE assistant_tools SET execution_config = ? WHERE name = ?').bind(JSON.stringify({ ...config, sql }), QUERY_ROW).run()
  try {
    await body()
  } finally {
    await env.DB.prepare('UPDATE assistant_tools SET execution_config = ? WHERE name = ?').bind(original, QUERY_ROW).run()
  }
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
      const auditBefore = await env.DB.prepare('SELECT coalesce(max(rowid), 0) AS r FROM ai_audit').first<number>('r')
      const res = await api('', { method: 'POST', body: { audit_id: auditId } })
      expect(res.status).toBe(400)
      const body = await res.json<{ error: string; message: string; details: string[] }>()
      expect(body.error).toBe('invalid_pin')
      // The pin's own re-validation refused it, before any run: its sentence, not the first run's, and
      // no blocked audit row (a run would have reached the executor's Gate 2 and written one).
      expect(body.message).toBe('This answer can no longer be pinned: its saved tool call does not pass today’s checks.')
      expect(body.details).toContain('input_schema: input has unknown property "window_from"')
      expect(
        await env.DB.prepare("SELECT count(*) AS n FROM ai_audit WHERE rowid > ? AND kind = 'blocked'").bind(auditBefore).first<number>('n'),
      ).toBe(0)
      expect(await env.DB.prepare('SELECT count(*) AS n FROM insights').first<number>('n')).toBe(before)
    } finally {
      await env.DB.prepare("UPDATE assistant_tools SET input_schema = ? WHERE name = 'aggregate'").bind(original).run()
    }
  })

  it('a query_sql or insight_panel trace is 400 not_pinnable with the D-64a sentence; nothing is stored', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const explanation = 'Instagram active subscribers whose cold_since is in August'
    // Free-form SQL is refused before any re-validation, whether its SQL would pass the gates or not.
    for (const sql of [WENT_COLD_AUGUST_SQL, 'SELECT email_norm FROM subscribers LIMIT 1', "SELECT count(*) AS n FROM v_profiles /* every subscriber */"]) {
      const answer = await askAnswer('how many Instagram signups went cold last month?', [{ name: 'query_sql', input: { sql: WENT_COLD_AUGUST_SQL, explanation } }])
      // The answer card learns it up front: no time period to offer, the refusal sentence instead of Pin.
      expect(answer.pin_refusal).toBe(NOT_PINNABLE_MESSAGE)
      expect(answer.pin_window).toBeNull()
      expect(answer.pin_own_dates).toBeNull()
      await editTracedInput(answer.audit_id, { sql, explanation })
      const before = await tileCount()
      const res = await api('', { method: 'POST', body: { audit_id: answer.audit_id } })
      expect(res.status, sql).toBe(400)
      expect(await res.json()).toEqual({ error: 'not_pinnable', message: NOT_PINNABLE_MESSAGE })
      expect(await tileCount()).toBe(before)
    }
    expect(NOT_PINNABLE_MESSAGE).toBe("Answers written as free-form queries can't be pinned. Ask the Growth team to add this as a saved question type.")

    // insight_panel is the board's own tool, never pinned: a real trace's call edited to name it (09 D-47).
    const auditId = await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }])
    const edited = await env.DB.prepare(
      "UPDATE ai_audit SET tool_name = 'insight_panel', request_json = ? WHERE trace_id = ? AND kind = 'tool_call' AND status = 'success'",
    )
      .bind(JSON.stringify({ panel: 'funnel' }), auditId)
      .run()
    expect(edited.meta.changes).toBe(1)
    const before = await tileCount()
    const res = await api('', { method: 'POST', body: { audit_id: auditId } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'not_pinnable', message: NOT_PINNABLE_MESSAGE })
    expect(await tileCount()).toBe(before)

    // With the query_sql row turned off, its answer is still not_pinnable with the D-64a sentence,
    // never re-validated into invalid_pin: the refusal is by name, not by the loaded row.
    const offAnswer = await askAnswer('how many Instagram signups went cold last month?', [
      { name: 'query_sql', input: { sql: WENT_COLD_AUGUST_SQL, explanation } },
    ])
    await env.DB.prepare("UPDATE assistant_tools SET enabled = 0 WHERE name = 'query_sql'").run()
    try {
      const offRes = await api('', { method: 'POST', body: { audit_id: offAnswer.audit_id } })
      expect(offRes.status).toBe(400)
      expect(await offRes.json()).toEqual({ error: 'not_pinnable', message: NOT_PINNABLE_MESSAGE })
      expect(await tileCount()).toBe(before)
    } finally {
      await env.DB.prepare("UPDATE assistant_tools SET enabled = 1 WHERE name = 'query_sql'").run()
    }
    expect(offAnswer.pin_refusal).toBe(NOT_PINNABLE_MESSAGE)
  })

  it('only segment and aggregate among the builtins pin: describe_schema and every other builtin is 400 not_pinnable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A real input for each builtin that is not a count or a segment; a new builtin fails here until it is listed.
    const inputs: Record<string, unknown> = {
      query_sql: { sql: WENT_COLD_AUGUST_SQL, explanation: 'Instagram active subscribers whose cold_since is in August' },
      describe_schema: {},
    }
    const others = Object.keys(BUILTIN_HANDLERS).filter((name) => name !== 'segment' && name !== 'aggregate')
    expect(others.sort()).toEqual(Object.keys(inputs).sort())
    for (const name of others) {
      const answer = await askAnswer('what data can you see?', [{ name, input: inputs[name] }])
      // The answer itself ran (a real successful tool call), so only D-64a stops the pin.
      const call = await env.DB.prepare("SELECT tool_name FROM ai_audit WHERE trace_id = ? AND kind = 'tool_call' AND status = 'success'")
        .bind(answer.audit_id)
        .first<string>('tool_name')
      expect(call).toBe(name)
      // D-64a's sentence is about free-form queries; a schema answer gets a sentence that is true of it.
      const message = name === 'query_sql' ? NOT_PINNABLE_MESSAGE : NOT_PINNABLE_OTHER_MESSAGE
      expect(answer.pin_refusal, name).toBe(message)
      expect(answer.pin_window).toBeNull()
      const before = await tileCount()
      const res = await api('', { method: 'POST', body: { audit_id: answer.audit_id } })
      expect(res.status, name).toBe(400)
      expect(await res.json()).toEqual({ error: 'not_pinnable', message })
      expect(await tileCount()).toBe(before)
    }
    expect(NOT_PINNABLE_OTHER_MESSAGE).toBe('Only counts, segments and saved question types can be pinned, and this answer is none of them.')
  })

  it('an aggregate trace whose went-cold call lost its window is 400 invalid_pin on its first run; nothing is stored', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const auditId = await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }])
    const { window_from: _from, window_to: _to, ...noWindow } = WENT_COLD_AUGUST
    await editTracedInput(auditId, noWindow)
    const before = await tileCount()
    const res = await api('', { method: 'POST', body: { audit_id: auditId } })
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string; details: string[] }>()
    expect(body.error).toBe('invalid_pin')
    // Gate 2 passes (the schema has no required window); the handler refuses it, and the problem is kept in details.
    expect(body.details).toEqual(['went_cold needs window_from and window_to'])
    expect(await tileCount()).toBe(before)
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

  it('"Explain this" on a pinned tile leads with its title and the dates it shows now; the pinned question follows', async () => {
    const question = 'how many Instagram signups went cold last month?'
    const tile = await pin({ audit_id: await askRecorded(question, [{ name: 'aggregate', input: WENT_COLD_AUGUST }]) })
    expect(tile.explain).toBe(`Explain “${question}” for Aug 1–31, 2026 only (last month). It was pinned from: ${question}`)
    const title = 'Instagram signups who went cold'
    expect((await api(`/${tile.id}`, { method: 'PATCH', body: { title, window: { rolling: 'last_30_days' } } })).status).toBe(200)
    const after = (await board()).tiles.find((t) => t.id === tile.id)!
    expect(after.window).toMatchObject({ from: '2026-08-29', to: '2026-09-28' })
    // The tile's period wins: its dates come first and "only"; "last month" is left as the pinned question's words.
    expect(after.explain).toBe(`Explain “${title}” for Aug 29 – Sep 28, 2026 only (last 30 days). It was pinned from: ${question}`)
    expect(sanitizeQuestion(after.explain).ok).toBe(true) // Ask accepts it (Gate 1)
    expect((await api(`/${tile.id}`, { method: 'PATCH', body: { window: { fixed: ['2026-08-01', '2026-08-15'] } } })).status).toBe(200)
    const fixed = (await board()).tiles.find((t) => t.id === tile.id)!
    expect(fixed.explain).toBe(`Explain “${title}” for Aug 1–15, 2026 only. It was pinned from: ${question}`)
  })

  it('a built-in tile’s "Explain this" is its panel’s question (09 D-39), in plain words', async () => {
    const { tiles } = await board()
    for (const tile of tiles.filter((t) => t.built_in)) {
      const panel = (await stored(tile.id).then((r) => JSON.parse(r!.params))) as { panel: string }
      const res = await SELF.fetch(`http://cdp.test/api/insights/${panel.panel}`, { headers: { cookie } })
      expect(res.status).toBe(200)
      const body = await res.json<{ total?: { explain: string }; checks?: Array<{ explain: string }> }>()
      // data-quality has no total: its first check's question stands for the panel (board.ts panelOutput).
      const question = panel.panel === 'data-quality' ? body.checks![0].explain : body.total!.explain
      expect(tile.explain, tile.id).toBe(question)
      expect(tile.explain).not.toBe(tile.title)
    }
    // 06 §UI principles 4: "Explain this" fills the Ask bar at level 1, so no code name such as going_cold_risk.
    for (const tile of tiles) expect(tile.explain, tile.id).not.toMatch(/[a-z]+_[a-z_]+/)
    // 09 D-66, 06 §Vocabulary: the brief's words in every question the board hands to Ask — each
    // tile's, and every per-row question of the four panels (going-cold's names its definition key).
    // (A pinned tile's question is the teammate's own words, so only the built-in tiles are ours.)
    const retired = /\breaders?\b|\bapp users?\b|\bnewsletter list\b/i
    for (const tile of tiles.filter((t) => t.built_in)) expect(tile.explain, tile.id).not.toMatch(retired)
    const questions: string[] = []
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect)
      else if (typeof value === 'object' && value !== null)
        for (const [key, inner] of Object.entries(value)) {
          if (key === 'explain' && typeof inner === 'string') questions.push(inner)
          else collect(inner)
        }
    }
    for (const panel of INSIGHT_PANELS) {
      const res = await SELF.fetch(`http://cdp.test/api/insights/${panel}`, { headers: { cookie } })
      collect(await res.json())
    }
    expect(questions.length).toBeGreaterThan(15)
    for (const question of questions) expect(question).not.toMatch(retired)
  })

  it('a lookup that sets its own dates (a query row) has no window; the answer and the tile name the same dates', async () => {
    const answer = await askAnswer('which pages do new subscribers hit first?', [{ name: 'pages_new_subscribers_hit_first', input: {} }])
    expect(answer.pin_window).toBeNull()
    // 02 §Derived new_subscriber = TODAY − 30 .. TODAY.
    expect(answer.pin_own_dates).toEqual({ from: '2026-08-29', to: '2026-09-28' })
    const tile = await pin({ audit_id: answer.audit_id })
    const segment = await askAnswer('build me a list of our most engaged readers', [{ name: 'segment', input: { status: ['active'] } }])
    const segmentTile = await pin({ audit_id: segment.audit_id })
    try {
      expect(tile.window).toBeNull()
      expect(tile.own_dates).toEqual(answer.pin_own_dates)
      expect((await board()).tiles.find((t) => t.id === tile.id)!.own_dates).toEqual(answer.pin_own_dates)
      // A segment sets no dates, whatever the model's answer said about time.
      expect(segment.pin_own_dates).toBeNull()
      expect(segmentTile.own_dates).toBeNull()
      // A windowed lookup (the aggregate's window_from/window_to) reports the window, never own dates.
      const windowed = await askAnswer('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }])
      expect(windowed.pin_window).toEqual({ from: '2026-08-01', to: '2026-08-31' })
      expect(windowed.pin_own_dates).toBeNull()
      const windowedTile = await pin({ audit_id: windowed.audit_id })
      expect(windowedTile.own_dates).toBeNull()
      expect((await api(`/${windowedTile.id}`, { method: 'DELETE' })).status).toBe(204)
    } finally {
      // T-INS-6 runs every tile directly; a query row has no direct handler there.
      for (const id of [tile.id, segmentTile.id]) await env.DB.prepare('DELETE FROM insights WHERE id = ?').bind(id).run()
    }
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
      } else if (tile.tool === 'aggregate') {
        // The stored params with the window written back as the tile ran it.
        const { window: _window, ...rest } = params
        const input = tile.window === null ? rest : { ...rest, window_from: tile.window.from, window_to: tile.window.to }
        const direct = await BUILTIN_HANDLERS.aggregate.run(env.DB, input)
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

  it('tiles that name an assistant tool say so plainly when the tool rows cannot load; the loader’s words are only in Technical details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tile = await pin({ audit_id: await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }]) })
    const enabled = (await env.DB.prepare('SELECT name FROM assistant_tools WHERE enabled = 1').all<{ name: string }>()).results.map((r) => r.name)
    expect(enabled.length).toBeGreaterThan(0)
    // No enabled row: the loader refuses (no_tools), and only the tiles that need a row fail.
    await env.DB.prepare('UPDATE assistant_tools SET enabled = 0').run()
    try {
      const res = await api('')
      expect(res.status).toBe(200)
      const { tiles } = await res.json<{ tiles: Tile[] }>()
      const failed = tiles.find((t) => t.id === tile.id)!
      expect(failed).toMatchObject({
        status: 'error',
        result: null,
        error: 'The data tools are not set up right now, so this tile cannot run. Technical details say why.',
      })
      expect(failed.error).not.toMatch(/tools:seed|assistant_tools|execution_config/)
      expect(failed.error_details).toMatch(/\S/)
      expect(tiles.filter((t) => t.built_in).every((t) => t.status === 'ok')).toBe(true)
    } finally {
      for (const name of enabled) await env.DB.prepare('UPDATE assistant_tools SET enabled = 1 WHERE name = ?').bind(name).run()
      await env.DB.prepare('DELETE FROM insights WHERE id = ?').bind(tile.id).run()
    }
  })

  it('a stored query-type tile whose params drifted is re-checked by Gate 2 on every board run; a row drifted to query_sql never runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tile = await pin({ audit_id: await askRecorded('which pages do new subscribers hit first?', [{ name: QUERY_ROW, input: {} }]) })
    const rawTable = 'SELECT email_norm FROM subscribers LIMIT 5'
    const chained = 'SELECT count(*) AS n FROM v_profiles; SELECT count(*) AS n FROM v_web_events'
    // Copies of the real row whose stored params now carry SQL: the query row's input takes none (Gate 2).
    const asQueryRow = [await insertCopy(tile.id, { sql: rawTable }, 'Drifted to raw-table SQL'), await insertCopy(tile.id, { sql: chained }, 'Drifted to chained SQL')]
    // Copies whose tool also drifted to query_sql: refused before the executor (09 D-64a), whether or
    // not their SQL would pass the gates (the last one does, and would show a number if it ran).
    const asQuerySql = [
      await insertCopy(tile.id, { sql: rawTable, explanation: 'drift' }, 'Drifted to query_sql over a table'),
      await insertCopy(tile.id, { sql: chained, explanation: 'drift' }, 'Drifted to chained query_sql'),
      await insertCopy(tile.id, { sql: WENT_COLD_AUGUST_SQL, explanation: 'drift' }, 'Drifted to gate-passing query_sql'),
    ]
    for (const id of asQuerySql) await env.DB.prepare("UPDATE insights SET tool = 'query_sql' WHERE id = ?").bind(id).run()
    // A pinned row drifted to the board's own tool: insight_panel runs only on a built-in tile.
    const asPanel = await insertCopy(tile.id, { panel: 'funnel' }, 'Drifted to insight_panel')
    await env.DB.prepare("UPDATE insights SET tool = 'insight_panel' WHERE id = ?").bind(asPanel).run()
    const drifted = [...asQueryRow, ...asQuerySql, asPanel]
    try {
      for (const run of [1, 2]) {
        const before = await env.DB.prepare('SELECT coalesce(max(rowid), 0) AS r FROM ai_audit').first<number>('r')
        const res = await api('')
        expect(res.status).toBe(200)
        const { tiles } = await res.json<{ tiles: Tile[] }>()
        for (const id of drifted) {
          const t = tiles.find((x) => x.id === id)!
          expect(t, `run ${run}`).toMatchObject({ status: 'error', result: null, segment: null, sql: null })
          // Level 1 is a plain sentence; the gates' problems are only in Technical details (09 D-64a).
          expect(t.error).toBe('This tile’s saved lookup no longer passes today’s checks, so it cannot run. Technical details say why.')
          expect(t.error_details).toMatch(/\S/)
        }
        for (const id of asQuerySql) expect(tiles.find((x) => x.id === id)!.error_details).toContain('query_sql is not a tool a tile may run')
        expect(tiles.find((x) => x.id === asPanel)!.error_details).toBe('insight_panel runs only on a built-in tile')
        expect(tiles.filter((t) => !drifted.includes(t.id)).every((t) => t.status === 'ok')).toBe(true)
        expect(await env.DB.prepare('SELECT count(*) AS n FROM insights WHERE id = ?').bind(tile.id).first<number>('n')).toBe(1)
        // Every run re-checks every drifted query-row tile: one blocked audit row each, naming the gate.
        // The query_sql and insight_panel rows never reach the executor, so they run nothing and write no call.
        const rows = (
          await env.DB.prepare("SELECT kind, tool_name, error FROM ai_audit WHERE rowid > ? AND kind IN ('blocked', 'tool_call') ORDER BY rowid")
            .bind(before)
            .all<{ kind: string; tool_name: string | null; error: string | null }>()
        ).results
        const blocked = rows.filter((r) => r.kind === 'blocked').map((r) => r.error)
        expect(blocked, `run ${run}`).toHaveLength(asQueryRow.length)
        expect(blocked.every((e) => e?.startsWith('gate2_denied: input_schema: input has unknown property "sql"'))).toBe(true)
        expect(rows.some((r) => r.tool_name === 'query_sql')).toBe(false)
      }
    } finally {
      for (const id of [...drifted, tile.id]) await env.DB.prepare('DELETE FROM insights WHERE id = ?').bind(id).run()
    }
  })

  it('a tile whose query the database refuses says so plainly; the raw text is only in Technical details; a pin of it is 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tile = await pin({ audit_id: await askRecorded('which pages do new subscribers hit first?', [{ name: QUERY_ROW, input: {} }]) })
    const freshAnswer = await askRecorded('which pages do new subscribers hit first?', [{ name: QUERY_ROW, input: {} }])
    const config = JSON.parse((await env.DB.prepare('SELECT execution_config FROM assistant_tools WHERE name = ?').bind(QUERY_ROW).first<string>('execution_config'))!) as {
      sql: string
    }
    // The row's own SQL with one more condition that passes both gates and that SQLite refuses when it
    // runs (abs() of the smallest integer overflows): a database failure, not a refused call.
    const failing = config.sql.replace('GROUP BY', 'AND abs(-9223372036854775807 - 1) > 0 GROUP BY')
    expect(failing).not.toBe(config.sql)
    try {
      await withQueryRowSql(failing, async () => {
        const res = await api('')
        expect(res.status).toBe(200)
        const t = (await res.json<{ tiles: Tile[] }>()).tiles.find((x) => x.id === tile.id)!
        expect(t).toMatchObject({ status: 'error', result: null, error: TILE_RUN_FAILED_MESSAGE })
        expect(TILE_RUN_FAILED_MESSAGE).toBe('This tile could not run right now. Press Refresh to try again.')
        expect(t.error).not.toMatch(/overflow|SQL|query_failed/i)
        expect(t.error_details).toContain('integer overflow')
        // Pinning an answer whose lookup now fails in the database: a plain retry sentence, nothing stored.
        const before = await tileCount()
        const pinRes = await api('', { method: 'POST', body: { audit_id: freshAnswer } })
        expect(pinRes.status).toBe(500)
        expect(await pinRes.json()).toEqual({ error: 'internal_error', message: PIN_FAILED_MESSAGE })
        expect(PIN_FAILED_MESSAGE).toBe('The answer could not be pinned because of a server error. Try Pin to board again.')
        expect(await tileCount()).toBe(before)
      })
    } finally {
      await env.DB.prepare('DELETE FROM insights WHERE id = ?').bind(tile.id).run()
    }
  })

  it('a row stored under another params version reports outdated (01 §insights); the rest of the board runs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tile = await pin({ audit_id: await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }]) })
    const params = JSON.parse((await stored(tile.id))!.params) as Record<string, unknown>
    const old = await insertCopy(tile.id, params, 'Saved by an older board')
    await env.DB.prepare('UPDATE insights SET tool_version = ? WHERE id = ?').bind(INSIGHT_PARAMS_VERSION - 1, old).run()
    try {
      const { tiles } = await board()
      const outdated = tiles.find((t) => t.id === old)!
      expect(outdated).toMatchObject({ status: 'error', result: null, segment: null })
      expect(outdated.error).toContain('older version of the board')
      expect(tiles.filter((t) => t.id !== old).every((t) => t.status === 'ok')).toBe(true)
    } finally {
      await env.DB.prepare('DELETE FROM insights WHERE id = ?').bind(old).run()
    }
  })

  it('a stored row whose params are not a JSON object or whose window is invalid is that tile’s plain error; the board answers 200', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tile = await pin({ audit_id: await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }]) })
    const params = JSON.parse((await stored(tile.id))!.params) as Record<string, unknown>
    // Copies of the real row (09 D-47): one with a window the board does not know, one whose params is a JSON array.
    const badWindow = await insertCopy(tile.id, { ...params, window: { rolling: 'bogus' } }, 'Drifted window')
    const notObject = await insertCopy(tile.id, params, 'Drifted params shape')
    await env.DB.prepare('UPDATE insights SET params = ? WHERE id = ?').bind(JSON.stringify([params]), notObject).run()
    try {
      const res = await api('')
      expect(res.status).toBe(200)
      const { tiles } = await res.json<{ tiles: Tile[] }>()
      for (const id of [badWindow, notObject]) {
        const t = tiles.find((x) => x.id === id)!
        expect(t, id).toMatchObject({ status: 'error', result: null, segment: null, error: TILE_RUN_FAILED_MESSAGE })
        // The server's own words for the failure stay in its log: never "insights-board:" or an Error name at level 1.
        expect(t.error).not.toMatch(/insights-board|Error|window\.rolling/)
      }
      expect(tiles.filter((t) => t.id !== badWindow && t.id !== notObject).every((t) => t.status === 'ok')).toBe(true)
    } finally {
      for (const id of [badWindow, notObject, tile.id]) await env.DB.prepare('DELETE FROM insights WHERE id = ?').bind(id).run()
    }
  })

  it('a failed audit write fails the request (500), never a tile error; a pin then stores nothing (04, 03 row 11)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const auditId = await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }])
    const before = await tileCount()
    await env.DB.prepare("CREATE TRIGGER audit_down BEFORE INSERT ON ai_audit BEGIN SELECT RAISE(ABORT, 'audit down'); END").run()
    try {
      const get = await api('')
      expect(get.status).toBe(500)
      const getBody = await get.json<{ error: string; message: string }>()
      expect(getBody.error).toBe('internal_error')
      // The raw server text (the error's name, the trigger's message) stays in the log, never in the response.
      expect(getBody.message).not.toMatch(/AuditWriteError|audit down/)
      const post = await api('', { method: 'POST', body: { audit_id: auditId } })
      expect(post.status).toBe(500)
      expect(await post.json()).toEqual({ error: 'internal_error', message: PIN_FAILED_MESSAGE })
      expect(await tileCount()).toBe(before)
    } finally {
      await env.DB.prepare('DROP TRIGGER audit_down').run()
    }
    expect((await api('')).status).toBe(200)
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
      body: { title: 'Instagram subscribers who went cold', chart: 'table', sort_order: 5, window: { fixed: ['2026-08-01', '2026-08-31'] } },
    })
    expect(res.status).toBe(200)
    const patched = await res.json<Tile>()
    expect(patched).toMatchObject({ title: 'Instagram subscribers who went cold', chart: 'table', chart_override: 'table', sort_order: 5 })
    expect(patched.window).toEqual({ kind: 'fixed', from: '2026-08-01', to: '2026-08-31' })
    const row = await stored(tile.id)
    expect(row).toMatchObject({ title: 'Instagram subscribers who went cold', chart: 'table', sort_order: 5 })
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

  it('PATCH needs Content-Type: application/json (415), a bounded sort_order, and no chart on a segment tile', async () => {
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

    // A segment tile always shows its count and "Open segment" (09 D-64): a chart override is refused.
    const list = await pin({ audit_id: await askRecorded('which Instagram readers have not opened in 30 days?', [{ name: 'segment', input: PRESET }]) })
    const chart = await api(`/${list.id}`, { method: 'PATCH', body: { chart: 'number' } })
    expect(chart.status).toBe(400)
    expect((await chart.json<{ error: string }>()).error).toBe('invalid_body')
    expect((await stored(list.id))!.chart).toBeNull()
    // Read from the tool, not this run: with the segment tool turned off the run fails, and the override is still refused.
    await env.DB.prepare("UPDATE assistant_tools SET enabled = 0 WHERE name = 'segment'").run()
    try {
      const off = await api(`/${list.id}`, { method: 'PATCH', body: { chart: 'table' } })
      expect(off.status).toBe(400)
      expect((await off.json<{ error: string }>()).error).toBe('invalid_body')
      expect((await stored(list.id))!.chart).toBeNull()
    } finally {
      await env.DB.prepare("UPDATE assistant_tools SET enabled = 1 WHERE name = 'segment'").run()
    }
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

  it('PATCH with a title holding an email is 400 blocked_pii (field "title"); the stored title is unchanged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tile = await pin({ audit_id: await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }]) })
    for (const id of [tile.id, 'builtin-funnel']) {
      const titleBefore = (await stored(id))!.title
      const res = await api(`/${id}`, { method: 'PATCH', body: { title: `Readers like ${JOY}` } })
      expect(res.status, id).toBe(400)
      const text = await res.text()
      expect(text).not.toContain(JOY)
      const body = JSON.parse(text) as { error: string; details: Array<{ field: string }> }
      expect(body.error).toBe('blocked_pii')
      expect(body.details[0].field).toBe('title')
      expect((await stored(id))!.title).toBe(titleBefore)
    }
    expect((await api(`/${tile.id}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('a pin whose rows name individual subscribers is refused: the board holds counts only', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = await tileCount()
    // A query row is data the Growth team adds (09 D-41), so its fixed SQL may list subscribers by key:
    // the aggregates-only check still runs on every pinnable lookup after D-64a.
    for (const sql of [
      "SELECT pkey, signup_date FROM v_profiles WHERE source = 'instagram' LIMIT 5",
      // A key inside a longer cell, and a key with its pk_ prefix cut off, name subscribers too.
      "SELECT ' ' || group_concat(pkey) AS ks, count(*) AS n FROM v_profiles WHERE source = 'instagram'",
      "SELECT substr(pkey, 4) AS k, engagement_score FROM v_profiles WHERE source = 'instagram' LIMIT 5",
      // Any piece of a real key of KEY_PIECE_CHARS (8) hex or more names its subscriber, whatever the column is called.
      'SELECT substr(pkey, 4, 15) AS k, signup_date, source FROM v_profiles LIMIT 5',
      'SELECT substr(pkey, 1, 12) AS k, signup_date FROM v_profiles LIMIT 5',
      'SELECT substr(visitor_hash, 5, 10) AS v, page FROM v_web_events LIMIT 5',
      `SELECT substr(pkey, 9, ${KEY_PIECE_CHARS}) AS k, count(*) AS n FROM v_profiles GROUP BY k LIMIT 5`,
      // A key split across cells (7 + 7 + 2) or into dashed groups of 4: no cell holds 8 hex in a row.
      "SELECT substr(pkey, 4, 7) AS a, substr(pkey, 11, 7) AS b, substr(pkey, 18, 2) AS c FROM v_profiles WHERE source = 'instagram' LIMIT 5",
      "SELECT substr(pkey, 4, 4) || '-' || substr(pkey, 8, 4) || '-' || substr(pkey, 12, 4) || '-' || substr(pkey, 16, 4) AS k FROM v_profiles LIMIT 5",
      // A key spelled as numbers (each hex digit's place in '0123456789abcdef'): no string cell holds
      // it, so only the check on the SQL (a key selected other than as count(DISTINCT …)) refuses it.
      "SELECT instr('0123456789abcdef', substr(pkey, 4, 1)) AS d1, instr('0123456789abcdef', substr(pkey, 5, 1)) AS d2, " +
        "instr('0123456789abcdef', substr(pkey, 6, 1)) AS d3 FROM v_profiles LIMIT 5",
      // A key column with no rows at all still names subscribers: the column is refused, not its cells.
      "SELECT * FROM v_profiles WHERE source = 'instagram' AND signup_date > '2999-01-01'",
      "SELECT * FROM v_web_events WHERE event_ts > '2999-01-01'",
    ]) {
      await withQueryRow(sql, async (name) => {
        const auditId = await askRecorded('list some Instagram subscribers', [{ name, input: {} }])
        const res = await api('', { method: 'POST', body: { audit_id: auditId } })
        expect(res.status, sql).toBe(400)
        expect((await res.json<{ error: string }>()).error).toBe('not_aggregate')
      })
    }
    expect(await tileCount()).toBe(before)
  })

  it('a query row may select a key only as count(DISTINCT key): checked on its SQL before it runs (04, 09 D-64a)', () => {
    // Allowed: the seeded query row, distinct counts (any case, qualified), keys outside every SELECT list.
    const seeded = TOOL_SEEDS.find((t) => t.name === QUERY_ROW)!.executionConfig as { sql: string }
    for (const sql of [
      // As the loader holds it: every :name rewritten to ? (09 D-45, tool-loader.ts).
      seeded.sql.replace(/:\w+/g, '?'),
      'SELECT source, count(DISTINCT pkey) AS subscribers FROM v_profiles GROUP BY source',
      'SELECT page, COUNT( distinct w.visitor_hash ) AS visitors FROM v_web_events w GROUP BY page',
      'SELECT count(*) AS n FROM v_web_events WHERE pkey IS NOT NULL',
      "SELECT 'pkey' AS word, count(*) AS n FROM v_profiles -- pkey in a comment",
    ])
      expect(keyProjectionProblems(sql), sql).toEqual([])
    // Refused: every other way a key reaches a SELECT list, at any depth.
    for (const sql of [
      "SELECT substr(pkey, 4, 7) AS a, substr(pkey, 11, 7) AS b, substr(pkey, 18, 2) AS c FROM v_profiles WHERE source = 'instagram'",
      "SELECT substr(pkey, 4, 4) || '-' || substr(pkey, 8, 4) AS k FROM v_profiles",
      'SELECT min(pkey) AS first, count(*) AS n FROM v_profiles',
      'SELECT p.pkey FROM v_profiles p',
      'SELECT "PKEY" FROM v_profiles',
      'SELECT count(DISTINCT pkey || page) AS n FROM v_web_events',
      'SELECT count(*) AS n FROM (SELECT substr(visitor_hash, 5, 10) AS v FROM v_web_events)',
      'SELECT (SELECT max(visitor_hash) FROM v_web_events) AS v',
    ])
      expect(keyProjectionProblems(sql).length, sql).toBeGreaterThan(0)
    expect(keyProjectionProblems('SELECT substr(pkey, 4) FROM v_profiles')).toEqual(['pkey is selected other than as count(DISTINCT pkey)'])
  })

  it('a result naming a key across cells, through separators, or as a bare key column is not an aggregate (namesASubject)', async () => {
    const keys = await loadKnownKeys(env.DB)
    // A real subscriber's key and a real visitor's (09 D-47).
    const pkey = (await env.DB.prepare('SELECT pkey FROM profiles WHERE email_norm = ?').bind(JOY).first<string>('pkey'))!
    const visitor = (await env.DB.prepare('SELECT visitor_hash FROM web_visitors WHERE email_norm = ?').bind(JOY).first<string>('visitor_hash'))!
    const hex = pkey.slice(3)
    const row = (cells: Record<string, string | number | null>) => ({ columns: Object.keys(cells), rows: [cells] })
    // The old check read one cell at a time and only unbroken runs: each of these got past it.
    expect(namesASubject(row({ a: hex.slice(0, 7), b: hex.slice(7, 14), c: hex.slice(14) }), keys)).toBe(true)
    expect(namesASubject(row({ k: hex.match(/.{4}/g)!.join('-') }), keys)).toBe(true)
    expect(namesASubject(row({ a: `${hex.slice(0, 4)}-`, n: 3, b: hex.slice(4, 9) }), keys)).toBe(true)
    expect(namesASubject(row({ v: visitor.slice(3).split('').join(' ') }), keys)).toBe(true)
    expect(namesASubject({ columns: ['pkey', 'signup_date'], rows: [] }, keys)).toBe(true)
    expect(namesASubject({ columns: ['n', 'visitor_hash'], rows: [] }, keys)).toBe(true)
    // An aggregate passes: a category and its numbers, and a page path with a date in it.
    expect(namesASubject(row({ source: 'instagram', subscribers: 412, rate: 0.1234 }), keys)).toBe(false)
    expect(namesASubject(row({ first_page: '/stories/2026-08-29', new_subscribers: 4 }), keys)).toBe(false)
  })

  it('a query row whose result holds a dashed key it did not select is refused at pin (the output check, 04)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Joy's stored first page drifts to carry her own key in dashed groups of four, as a client-sent
    // path can (09 D-47: a real row, edited). The query row selects no key, so only the output check sees it.
    const auditId = await askRecorded('which pages do new subscribers hit first?', [{ name: QUERY_ROW, input: {} }])
    const original = (
      await env.DB.prepare('SELECT visitor_hash, first_page FROM web_visitors WHERE email_norm = ?').bind(JOY).all<{ visitor_hash: string; first_page: string | null }>()
    ).results
    const drift = await env.DB.prepare(
      `UPDATE web_visitors SET first_page = '/s/' || (SELECT substr(pkey, 4, 4) || '-' || substr(pkey, 8, 4) || '-' || substr(pkey, 12, 4) || '-' || substr(pkey, 16, 4)
         FROM profiles WHERE profiles.email_norm = web_visitors.email_norm) WHERE email_norm = ?`,
    )
      .bind(JOY)
      .run()
    expect(drift.meta.changes).toBeGreaterThan(0)
    try {
      const before = await tileCount()
      const res = await api('', { method: 'POST', body: { audit_id: auditId } })
      expect(res.status).toBe(400)
      expect((await res.json<{ error: string }>()).error).toBe('not_aggregate')
      expect(await tileCount()).toBe(before)
    } finally {
      for (const row of original) {
        await env.DB.prepare('UPDATE web_visitors SET first_page = ? WHERE visitor_hash = ?').bind(row.first_page, row.visitor_hash).run()
      }
    }
  })

  it('a pin whose first run’s result fails the scanner is 400 blocked_pii, never echoing the email; nothing is stored', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The query row groups new subscribers by their first page, a path a client sent (05: untrusted).
    // Joy (a new subscriber, 02 §Demo subjects) has a tracked visit; after the answer, her stored first
    // page drifts to a link carrying her own email, as a newsletter link can (09 D-47: a real row, edited).
    const auditId = await askRecorded('which pages do new subscribers hit first?', [{ name: QUERY_ROW, input: {} }])
    const original = (
      await env.DB.prepare('SELECT visitor_hash, first_page FROM web_visitors WHERE email_norm = ?').bind(JOY).all<{ visitor_hash: string; first_page: string | null }>()
    ).results
    const drift = await env.DB.prepare("UPDATE web_visitors SET first_page = '/?ref=' || email_norm WHERE email_norm = ?").bind(JOY).run()
    expect(drift.meta.changes).toBeGreaterThan(0)
    try {
      const before = await tileCount()
      const res = await api('', { method: 'POST', body: { audit_id: auditId } })
      expect(res.status).toBe(400)
      const text = await res.text()
      expect(JSON.parse(text)).toMatchObject({ error: 'blocked_pii' })
      expect(text).not.toContain(JOY)
      expect(text).not.toContain('@')
      expect(await tileCount()).toBe(before)
      // The executor's result scan caught it, and the block is audited without the email (03 row 11).
      const blocked = await env.DB.prepare("SELECT error FROM ai_audit WHERE kind = 'blocked' ORDER BY rowid DESC LIMIT 1").first<string>('error')
      expect(blocked).toMatch(/^blocked_pii: \w+ in tool_result$/)
    } finally {
      for (const row of original) {
        await env.DB.prepare('UPDATE web_visitors SET first_page = ? WHERE visitor_hash = ?').bind(row.first_page, row.visitor_hash).run()
      }
    }
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

  it('a stored tile whose params drifted to hold an email is that tile’s error; the board answers 200 without the email', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const aggregate = await pin({ audit_id: await askRecorded('how many Instagram signups went cold last month?', [{ name: 'aggregate', input: WENT_COLD_AUGUST }]) })
    const queryTile = await pin({ audit_id: await askRecorded('which pages do new subscribers hit first?', [{ name: QUERY_ROW, input: {} }]) })
    const aggregateParams = JSON.parse((await stored(aggregate.id))!.params) as Record<string, unknown>
    const drifted = [
      await insertCopy(aggregate.id, { ...aggregateParams, source: [JOY] }, 'Drifted params'),
      await insertCopy(queryTile.id, { include_unsubscribed: JOY }, 'Drifted query input'),
      // The stored texts that leave on the tile as they are (title, prompt, and explain built from both).
      await insertCopy(aggregate.id, aggregateParams, `Readers like ${JOY}`),
      await insertCopy(aggregate.id, aggregateParams, 'Drifted prompt', `who is ${JOY}`),
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
        // A blocked tile carries none of its stored text.
        expect(tile).toMatchObject({ status: 'error', result: null, params: {}, sql: null, prompt: null, title: BLOCKED_TILE_TITLE, explain: BLOCKED_TILE_TITLE })
        expect(tile.error).toContain('personal-data check')
      }
      expect(tiles.filter((t) => !drifted.includes(t.id)).every((t) => t.status === 'ok')).toBe(true)
      // The block is in the audit trail, without the email (03 row 11): one row per blocked tile of this run.
      const runTrace = await env.DB.prepare("SELECT trace_id FROM ai_audit WHERE tool_name = 'insight_panel' ORDER BY rowid DESC LIMIT 1").first<string>('trace_id')
      const blocked = await env.DB.prepare("SELECT error FROM ai_audit WHERE trace_id = ? AND kind = 'blocked'").bind(runTrace).all<{ error: string }>()
      expect(blocked.results).toHaveLength(drifted.length)
      expect(blocked.results.every((r) => /^blocked_pii: \w+ in audit_row$/.test(r.error))).toBe(true)
      // A change to a blocked tile is never stored (fail safe, as a pin).
      const rename = await api(`/${drifted[0]}`, { method: 'PATCH', body: { title: 'Renamed drifted tile' } })
      expect(rename.status).toBe(400)
      expect((await rename.json<{ error: string }>()).error).toBe('blocked_pii')
      expect((await stored(drifted[0]))!.title).toBe('Drifted params')
    } finally {
      for (const id of [...drifted, queryTile.id]) await env.DB.prepare('DELETE FROM insights WHERE id = ?').bind(id).run()
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
