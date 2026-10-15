import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HOSTED_URL, TODAY } from '../shared/config'
import { pkeyForEmail, pkeyForUnknownUser } from '../shared/pseudonym'
import { BUILTIN_HANDLERS } from '../worker/assistant/tools/builtin-handlers'
import { dataQuality } from '../worker/insights/data-quality'
import { loginCookie } from './helpers/auth'
import { piiKeySecret, seedDatabase } from './helpers/seed'
import {
  eventIdPool,
  nowSeconds,
  resolvedOf,
  sendWebhook,
  signature,
  signedRequest,
  webhookSecret,
} from './helpers/webhook'

// POST /webhooks/app (04 §Webhook; 07 §A–C, §G): T-WH-1..8, 11, 12 (08), plus the stored
// engagement_score recompute on every stored event (09 D-46). The test D1 holds the real seed of
// data/*.csv (test/helpers/seed.ts). Expected identities: 02 §Counts. Expected scores: the 02
// §Derived formula, written out in expectedScore() independently of shared/derive.ts, over the
// stored last_open_date and site visits.
// Inputs and where they come from (09 D-11: brief-shaped payloads built from real ids):
// - BRIEF_SAMPLE is the brief's payload, byte for byte as 04 §Webhook body quotes it.
// - user ids are real app_users.csv rows: u_2b6447a3 (line 2, julia.evans230@gmail.com),
//   u_ceed5f12 (line 303, joy.hall830@protonmail.com), u_baba14aa (line 3), u_3380b6e6 (line 8),
//   u_c0d06d19 (line 7), u_f2411d1c (line 9), u_e9edbf48 (line 10), u_38e852b0 (line 11,
//   sarah.edwards657@gmail.com), u_f1cad5ce (line 15, eli.clark874@icloud.com). The unknown user ids
//   u_2b6447a and u_3380b6e are real ids with the last character removed (09 D-47); neither
//   occurs in data/*.csv.
// - device ids: d_4b21e8 is the brief's; the others are `d_` + the hex of a real user id.
// - event ids: evt_9f3a1c is the brief's; the others come from eventIdPool() (`evt_` + the hex of
//   a real visitor_id).
// - event times: the brief's 2026-09-28T14:22:05Z, the same instant written with a -05:00
//   offset, and real web_events.csv times (lines 2 and 3, 2026-06-30 20:11:42 and 20:45:52).
//   T-WH-7's "6 hours old" time is taken from the wall clock, as 08 asks.
// - property values are real page slugs from web_events.csv (/news/supreme-court-ruling-explained,
//   /news/church-attendance-study); the over-long value repeats the brief's slug and cuts it. The
//   keys are `story` (the brief's) and `link`, the two keys v_app_events reads (0002_views.sql),
//   and `page`, a web_events.csv column, for a key the view does not read. A `link` is a URL (09
//   D-70 #2): LINK is the hosted app's own URL (shared/config.ts HOSTED_URL) with a real page path.
//   The size and nesting caps are exercised on `page`, since `story` and `link` have rules of
//   their own (T-HARD-2). Non-string property values are the brief's slug re-shaped (in an object,
//   in an array) or removed (null); the nesting-depth cases wrap the brief's slug in empty arrays.
// - the wrong secret is WEBHOOK_SECRET with its last character removed; "not-an-email" is a
//   real subscribers.csv value used as a non-JSON body. Secrets are never printed.

const BRIEF_SAMPLE =
  '{"event_id":"evt_9f3a1c","event":"read_story","user_id":"u_2b6447a3","device_id":"d_4b21e8","timestamp":"2026-09-28T14:22:05Z","properties":{"story":"supreme-court-ruling-explained"}}'
const BRIEF_TS = '2026-09-28T14:22:05Z'
const LINK = `${HOSTED_URL}/news/supreme-court-ruling-explained`
const JULIA = 'julia.evans230@gmail.com'
const ALLOWED_EVENTS = ['app_open', 'read_story', 'link_click', 'login']
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

const nextEventId = eventIdPool()
let cookie: string

afterEach(() => {
  vi.restoreAllMocks()
})

beforeAll(async () => {
  await seedDatabase()
  cookie = await loginCookie()
})

type Body = Record<string, unknown>

/** A brief-shaped event with a fresh real-id-derived event_id; `fields` override or add keys. */
function event(fields: Body): Body {
  return { event_id: nextEventId(), event: 'read_story', timestamp: BRIEF_TS, ...fields }
}

async function post(body: Body | string): Promise<{ status: number; json: Body }> {
  const res = await sendWebhook(typeof body === 'string' ? body : JSON.stringify(body))
  return { status: res.status, json: await res.json() }
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const n = await env.DB.prepare(`SELECT count(*) AS n FROM ${sql}`)
    .bind(...binds)
    .first<number>('n')
  if (n === null) throw new Error('count returned no row')
  return n
}

interface StoredEvent {
  event_id: string
  event: string
  user_id: string | null
  device_id: string
  event_ts: string
  received_at: string
  properties: string | null
}

function stored(eventId: string): Promise<StoredEvent | null> {
  return env.DB.prepare('SELECT * FROM app_events WHERE event_id = ?').bind(eventId).first<StoredEvent>()
}

function device(deviceId: string) {
  return env.DB.prepare('SELECT user_id, last_seen_ts FROM device_identity WHERE device_id = ?')
    .bind(deviceId)
    .first<{ user_id: string; last_seen_ts: string }>()
}

interface LookupApp {
  user_id: string
  from_csv: boolean
  devices: string[]
  events: { event: string; event_ts: string; properties: unknown; attached_via: string }[]
}

async function lookup(
  q: string,
): Promise<{ status: number; body: { profile: Body; newsletter: unknown; web: unknown; app: LookupApp } }> {
  const res = await SELF.fetch(`http://cdp.test/api/lookup?${new URLSearchParams({ q })}`, {
    headers: { cookie },
  })
  return { status: res.status, body: await res.json() }
}

const DAY_MS = 86_400_000
/** Whole days from `from` to `to`, by their date parts. */
const days = (from: string, to: string) =>
  (Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / DAY_MS

/**
 * 02 §Derived engagement_score, written out here rather than imported, over the stored inputs of
 * the profile with `email` (null for a stub: no opens, no site visits): recency from
 * subscribers.last_open_date, site visits = the profile's web events dated TODAY − 30 .. TODAY.
 * `appEvents` is what the caller expects to count.
 */
async function expectedScore(email: string | null, appEvents: number): Promise<number> {
  let recency = 0
  let site = 0
  if (email !== null) {
    const lastOpen = await env.DB.prepare('SELECT last_open_date FROM subscribers WHERE email_norm = ?')
      .bind(email)
      .first<string | null>('last_open_date')
    if (lastOpen !== null) recency = 50 * Math.max(0, 30 - Math.max(0, days(lastOpen, TODAY)))
    const { results } = await env.DB.prepare(
      `SELECT we.event_ts FROM web_events we JOIN web_visitors wv ON wv.visitor_id = we.visitor_id
        WHERE wv.email_norm = ?`,
    )
      .bind(email)
      .all<{ event_ts: string }>()
    site = results.filter((r) => days(r.event_ts, TODAY) >= 0 && days(r.event_ts, TODAY) <= 30).length
  }
  // In thirtieths of a point (recency 50·(30 − d), app 75·a, site 150·s), half up, so no float error.
  const thirtieths = recency + 75 * Math.min(appEvents, 10) + 150 * Math.min(site, 5)
  return Math.floor((2 * thirtieths + 30) / 60)
}

function storedScore(pkey: string): Promise<number | null> {
  return env.DB.prepare('SELECT engagement_score FROM profiles WHERE pkey = ?')
    .bind(pkey)
    .first<number>('engagement_score')
}

describe('T-WH-2 the brief sample payload', () => {
  it('is accepted verbatim, stored as sent and resolved to julia.evans230', async () => {
    const before = nowSeconds()
    const { status, json } = await post(BRIEF_SAMPLE)
    expect(status).toBe(202)
    expect(json).toEqual({ accepted: true, event_id: 'evt_9f3a1c' })
    expect(await resolvedOf('evt_9f3a1c')).toEqual({ user_id: 'u_2b6447a3', pkey: await pkeyForEmail(piiKeySecret(), JULIA) })
    const row = await stored('evt_9f3a1c')
    expect(row).toMatchObject({
      event: 'read_story',
      user_id: 'u_2b6447a3',
      device_id: 'd_4b21e8',
      event_ts: BRIEF_TS,
      properties: '{"story":"supreme-court-ruling-explained"}',
    })
    expect(row!.received_at).toMatch(ISO_SECONDS)
    const receivedSeconds = Date.parse(row!.received_at) / 1000
    expect(receivedSeconds).toBeGreaterThanOrEqual(before)
    expect(receivedSeconds).toBeLessThanOrEqual(nowSeconds())
    expect(await device('d_4b21e8')).toEqual({ user_id: 'u_2b6447a3', last_seen_ts: BRIEF_TS })
  })
})

describe('T-WH-1 a valid signed event', () => {
  it('returns 202 with no session cookie and shows in lookup immediately', async () => {
    const body = event({
      user_id: 'u_ceed5f12',
      device_id: 'd_ceed5f12',
      properties: { story: 'church-attendance-study' },
    })
    const before = await lookup('u_ceed5f12')
    expect(before.body.app.events).toEqual([])

    const { status, json } = await post(body)
    expect(status).toBe(202)
    expect(json).toEqual({ accepted: true, event_id: body.event_id })

    const after = await lookup('u_ceed5f12')
    expect(after.status).toBe(200)
    expect(after.body.app.devices).toEqual(['d_ceed5f12'])
    expect(after.body.app.events).toEqual([
      {
        event: 'read_story',
        event_ts: BRIEF_TS,
        properties: { story: 'church-attendance-study' },
        attached_via: 'direct',
      },
    ])
  })
})

describe('T-WH-3 event enum and one event per request', () => {
  it('rejects purchase with 400 invalid_event listing the four allowed events, storing nothing', async () => {
    const rows = await count('app_events')
    const body = event({ event: 'purchase', user_id: 'u_2b6447a3', device_id: 'd_4b21e8' })
    const { status, json } = await post(body)
    expect(status).toBe(400)
    expect(json.error).toBe('invalid_event')
    expect(json.details).toEqual([{ field: 'event', issue: expect.any(String), allowed: ALLOWED_EVENTS }])
    for (const name of ALLOWED_EVENTS) expect(json.message).toContain(name)
    expect(JSON.stringify(json)).not.toContain('purchase')
    expect(await count('app_events')).toBe(rows)
    expect(await stored(body.event_id as string)).toBeNull()
  })

  it('rejects an array body with 400 "one event per request"', async () => {
    const rows = await count('app_events')
    const one = event({ user_id: 'u_2b6447a3', device_id: 'd_4b21e8' })
    const { status, json } = await post(JSON.stringify([one]))
    expect(status).toBe(400)
    expect(json).toMatchObject({
      error: 'invalid_event',
      details: [{ field: 'body', issue: 'one event per request' }],
    })
    expect(await count('app_events')).toBe(rows)
  })

  it('rejects each broken required field with its own detail and ignores unknown fields', async () => {
    const base = { user_id: 'u_2b6447a3', device_id: 'd_4b21e8' }
    const cases: [Body, string][] = [
      [{ ...event(base), event_id: undefined }, 'event_id'],
      [{ ...event(base), event_id: 'evt_' + 'c9e136fd6d'.repeat(7) }, 'event_id'], // 74 chars of a real visitor hex
      [event({ ...base, device_id: '' }), 'device_id'],
      [event({ ...base, user_id: '' }), 'user_id'],
      [event({ ...base, timestamp: '2026-09-28' }), 'timestamp'], // the brief's time removed
      [event({ ...base, timestamp: '2026-09-28T14:22' }), 'timestamp'], // the brief's seconds removed
      [event({ ...base, properties: ['supreme-court-ruling-explained'] }), 'properties'],
      [event({ ...base, properties: 'supreme-court-ruling-explained' }), 'properties'],
      [event({ ...base, properties: null }), 'properties'],
    ]
    for (const [body, field] of cases) {
      const { status, json } = await post(body)
      expect(status, field).toBe(400)
      expect(json.error).toBe('invalid_event')
      expect((json.details as { field: string }[]).map((d) => d.field)).toEqual([field])
    }

    const extra = event({ ...base, email: JULIA })
    const accepted = await post(extra)
    expect(accepted.status).toBe(202)
    const row = await stored(extra.event_id as string)
    expect(JSON.stringify(row)).not.toContain(JULIA)
  })
})

describe('T-WH-4 user_id null or absent', () => {
  it('accepts both as anonymous events that resolve to nobody on a device never identified', async () => {
    const withNull = event({ event: 'app_open', user_id: null, device_id: 'd_3ab82c73' })
    const absent = event({ event: 'app_open', device_id: 'd_c3a64c0a' })
    for (const body of [withNull, absent]) {
      const { status, json } = await post(body)
      expect(status).toBe(202)
      expect(json).toEqual({ accepted: true, event_id: body.event_id })
      expect(await resolvedOf(body.event_id as string)).toEqual({ user_id: null, pkey: null })
      expect(await stored(body.event_id as string)).toMatchObject({ user_id: null, properties: null })
      expect(await device(body.device_id as string)).toBeNull()
    }
  })

  it('resolves an anonymous event through its device once the device has an identified event', async () => {
    await post(event({ event: 'login', user_id: 'u_c0d06d19', device_id: 'd_c0d06d19' }))
    const anonymous = event({ event: 'app_open', user_id: null, device_id: 'd_c0d06d19' })
    const { status } = await post(anonymous)
    expect(status).toBe(202)
    expect(await resolvedOf(anonymous.event_id as string)).toEqual({
      user_id: 'u_c0d06d19',
      pkey: await pkeyForEmail(piiKeySecret(), 'leah.stewart812@gmail.com'),
    })
  })
})

describe('T-WH-5 a known user_id', () => {
  it('resolves u_2b6447a3 to julia.evans230 and shows under her email in lookup', async () => {
    const body = event({
      event: 'link_click',
      user_id: 'u_2b6447a3',
      device_id: 'd_2b6447a3',
      properties: { link: LINK },
    })
    const { status } = await post(body)
    expect(status).toBe(202)
    expect(await resolvedOf(body.event_id as string)).toEqual({ user_id: 'u_2b6447a3', pkey: await pkeyForEmail(piiKeySecret(), JULIA) })

    const { body: profile } = await lookup(JULIA)
    expect(profile.profile.pkey).toBe(await pkeyForEmail(piiKeySecret(), JULIA))
    expect(profile.app.user_id).toBe('u_2b6447a3')
    expect(profile.app.events).toContainEqual({
      event: 'link_click',
      event_ts: BRIEF_TS,
      properties: { link: LINK },
      attached_via: 'direct',
    })

    // 09 D-46: her stored score counts every app event of hers in the last 30 days, this one too.
    const recent = profile.app.events.filter((e) => days(e.event_ts, TODAY) <= 30)
    expect(recent.length).toBeGreaterThan(0)
    const score = await storedScore(await pkeyForEmail(piiKeySecret(), JULIA))
    expect(score).toBe(await expectedScore(JULIA, recent.length))
    expect(score).toBeGreaterThan(await expectedScore(JULIA, 0))
  })
})

describe('T-WH-6 an unknown user_id', () => {
  it('is stored with a stub app user and unknown_user_stub profile, and lookup finds it', async () => {
    const unknown = 'u_2b6447a'
    expect(await count('app_users WHERE user_id = ?', unknown)).toBe(0)
    const stubKey = await pkeyForUnknownUser(piiKeySecret(), unknown)

    const first = event({ user_id: unknown, device_id: 'd_4b21e8' })
    const { status } = await post(first)
    expect(status).toBe(202)
    expect(await resolvedOf(first.event_id as string)).toEqual({ user_id: unknown, pkey: stubKey })

    const receivedAt = (await stored(first.event_id as string))!.received_at
    const user = await env.DB.prepare('SELECT * FROM app_users WHERE user_id = ?').bind(unknown).first()
    expect(user).toEqual({ user_id: unknown, email_norm: null, created_at: receivedAt, from_csv: 0 })
    const profile = await env.DB.prepare('SELECT * FROM profiles WHERE pkey = ?').bind(stubKey).first()
    // 09 D-46: the stub's one app event counts: 25 × min(1, 1/10) = 2.5, rounded to 3.
    // 09 D-78(b): user_id links this stub profile back to its app_users row for v_app_events,
    // below; it is never set on a subscriber or app_only profile (those resolve by email_norm).
    expect(profile).toEqual({
      pkey: stubKey,
      email_norm: null,
      user_id: unknown,
      kind: 'unknown_user_stub',
      engagement_score: 3,
      created_at: receivedAt,
    })
    expect(await expectedScore(null, 1)).toBe(3)

    // A second event for the same user reuses the stub.
    const second = await post(
      event({
        event: 'app_open',
        user_id: unknown,
        device_id: 'd_4b21e8',
        timestamp: '2026-09-28T09:22:05-05:00',
      }),
    )
    expect(second.status).toBe(202)
    expect(await count('app_users WHERE user_id = ?', unknown)).toBe(1)
    expect(await count('profiles WHERE pkey = ?', stubKey)).toBe(1)
    // Two app events: 25 × 2/10 = 5.
    expect(await storedScore(stubKey)).toBe(5)

    // 09 D-78(b): the stub's events resolve to its own pkey in the PII-free view the assistant's
    // app-activity counts read, exactly as Look up and /events already show them below, instead
    // of vanishing under pkey NULL (the old email-only join never matches a stub, whose
    // app_users.email_norm is NULL: SQL NULL = NULL is unknown, not true).
    const { results: viewRows } = await env.DB.prepare(
      'SELECT event FROM v_app_events WHERE pkey = ? ORDER BY event_ts',
    )
      .bind(stubKey)
      .all<{ event: string }>()
    expect(viewRows.map((r) => r.event)).toEqual(['read_story', 'app_open'])

    // 09 D-78(b): v_profiles has the identical email-only join gap as v_app_events did; migrations/
    // 0011 recreates it too, so has_app/app_created_at agree with Look up's has_app: true for this
    // stub (worker/routes/lookup.ts:233), never has_app: 0 / app_created_at: NULL.
    const profileRow = await env.DB.prepare('SELECT has_app, app_created_at FROM v_profiles WHERE pkey = ?')
      .bind(stubKey)
      .first<{ has_app: number; app_created_at: string }>()
    expect(profileRow).toEqual({ has_app: 1, app_created_at: receivedAt })

    // 09 D-78(b): the model's own read-only SQL tool (worker/assistant/tools/builtin-handlers.ts,
    // the handler query_sql actually calls) must count the stub's events too, agreeing with
    // v_app_events, /events and Look up — not just a raw SELECT against the view run by the test
    // itself. A mutant that reverts v_app_events' pkey back to `pe.pkey AS pkey` (dropping the
    // unknown_user_stub fallback) fails this assertion: the stub's row disappears from the
    // GROUP BY entirely instead of showing count 2.
    const toolResult = await BUILTIN_HANDLERS.query_sql.run(env.DB, {
      sql: 'SELECT pkey, count(*) AS n FROM v_app_events WHERE pkey IS NOT NULL GROUP BY pkey',
      explanation: 'app events per person',
    })
    const stubRow = (toolResult.rows as { pkey: string; n: number }[]).find((r) => r.pkey === stubKey)
    expect(stubRow).toEqual({ pkey: stubKey, n: 2 })

    const { status: found, body } = await lookup(unknown)
    expect(found).toBe(200)
    expect(body.profile).toMatchObject({ pkey: stubKey, kind: 'unknown_user_stub', email: null })
    expect(body.newsletter).toBeNull()
    expect(body.web).toBeNull()
    expect(body.app).toMatchObject({ user_id: unknown, from_csv: false })
    expect(body.app.events.map((e) => [e.event, e.event_ts, e.attached_via])).toEqual([
      ['read_story', BRIEF_TS, 'direct'],
      ['app_open', BRIEF_TS, 'direct'],
    ])
  })

  it('heals a stub created before migration 0011 (user_id still NULL) on its next event, never IGNOREd', async () => {
    // u_c0d06d1: data/app_users.csv's real u_c0d06d19 (line 7) with its last character removed
    // (09 D-47), unused as either a known or an unknown id anywhere else in this file.
    const unknown = 'u_c0d06d1'
    const stubKey = await pkeyForUnknownUser(piiKeySecret(), unknown)
    const first = await post(event({ user_id: unknown, device_id: 'd_c0d06d1' }))
    expect(first.status).toBe(202)

    // Simulate a database migrated to 0011 after this stub already existed: profiles.user_id
    // came back NULL for it (ALTER TABLE ADD COLUMN sets every existing row to NULL).
    await env.DB.prepare("UPDATE profiles SET user_id = NULL WHERE pkey = ? AND kind = 'unknown_user_stub'")
      .bind(stubKey)
      .run()
    expect(await count('profiles WHERE pkey = ? AND user_id IS NULL', stubKey)).toBe(1)
    const beforeViewRows = await env.DB.prepare('SELECT count(*) AS n FROM v_app_events WHERE pkey = ?')
      .bind(stubKey)
      .first<{ n: number }>()
    expect(beforeViewRows?.n).toBe(0) // vanished, the exact D-78(b) bug, until the next event

    const second = await post(
      event({ event: 'app_open', user_id: unknown, device_id: 'd_c0d06d1', timestamp: '2026-09-28T09:22:05-05:00' }),
    )
    expect(second.status).toBe(202)

    // INSERT ... ON CONFLICT DO UPDATE (worker/webhooks/ingest.ts), not INSERT OR IGNORE: the
    // next event heals user_id on the EXISTING row rather than leaving it NULL forever.
    expect(await count('profiles WHERE pkey = ? AND user_id = ?', stubKey, unknown)).toBe(1)
    expect(await count('profiles WHERE pkey = ?', stubKey)).toBe(1) // never duplicated
    const { results: healed } = await env.DB.prepare('SELECT event FROM v_app_events WHERE pkey = ? ORDER BY event_ts')
      .bind(stubKey)
      .all<{ event: string }>()
    expect(healed.map((r) => r.event)).toEqual(['read_story', 'app_open'])
  })

  it('never inflates data-quality app_users_not_on_list.of: a stub has no email to count it against (09 D-78(b) regression)', async () => {
    // u_f2411d1: data/app_users.csv's real u_f2411d1c (line 9) with its last character removed
    // (09 D-47), unused as either a known or an unknown id anywhere else in this file.
    const unknown = 'u_f2411d1'
    expect(await count('app_users WHERE user_id = ?', unknown)).toBe(0)
    // 02 §Counts: 930 app_users rows load from the CSV, every one with an email (test/insights.
    // test.ts's APP_ACCOUNTS); the two earlier T-WH-6 cases already added stub rows, so this
    // also proves the "of" does not drift per pre-existing stub, not just on a fresh seed.
    const APP_ACCOUNTS_WITH_EMAIL = 930
    const before = await dataQuality(env.DB)
    const ofBefore = before.checks.find((c) => c.key === 'app_users_not_on_list')!.of
    expect(ofBefore).toBe(APP_ACCOUNTS_WITH_EMAIL)
    expect(await count('app_users WHERE email_norm IS NOT NULL')).toBe(APP_ACCOUNTS_WITH_EMAIL)

    const res = await post(event({ user_id: unknown, device_id: 'd_f2411d1' }))
    expect(res.status).toBe(202)
    expect(await count('app_users WHERE user_id = ?', unknown)).toBe(1)

    // The new stub's v_profiles row carries has_app = 1 (migrations/0011, by its user_id link,
    // not an email), so worker/insights/data-quality.ts's email-scoped "of" must still read 930,
    // never 931, and the raw email count it mirrors must not have moved either.
    const after = await dataQuality(env.DB)
    expect(after.checks.find((c) => c.key === 'app_users_not_on_list')!.of).toBe(APP_ACCOUNTS_WITH_EMAIL)
    expect(await count('app_users WHERE email_norm IS NOT NULL')).toBe(APP_ACCOUNTS_WITH_EMAIL)
  })
})

describe('T-WH-7 out of order and old events', () => {
  it('stores an older event sent after a newer one and orders the timeline by event_ts', async () => {
    const user = 'u_baba14aa'
    const dev = 'd_baba14aa'
    const newer = await post(
      event({ event: 'app_open', user_id: user, device_id: dev, timestamp: '2026-06-30T20:45:52Z' }),
    )
    // The older one in the CSV's own zone-less form: UTC, stored normalized (02 §Time, 09 D-38).
    const older = await post(
      event({ event: 'read_story', user_id: user, device_id: dev, timestamp: '2026-06-30 20:11:42' }),
    )
    expect([newer.status, older.status]).toEqual([202, 202])
    expect(await device(dev)).toEqual({ user_id: user, last_seen_ts: '2026-06-30T20:45:52Z' })

    const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString()
    const old = await post(
      event({ event: 'link_click', user_id: user, device_id: dev, timestamp: sixHoursAgo }),
    )
    expect(old.status).toBe(202)

    const { body } = await lookup(user)
    expect(body.app.events.map((e) => e.event_ts)).toEqual([
      '2026-06-30T20:11:42Z',
      '2026-06-30T20:45:52Z',
      sixHoursAgo.slice(0, 19) + 'Z',
    ])

    // 09 D-46 with 02 §Time: the June events are more than 30 days before TODAY and do not count;
    // the wall-clock event is after TODAY and counts as 0 days old.
    expect(days(TODAY, sixHoursAgo)).toBeGreaterThan(0)
    const email = 'daniel.hill389@gmail.com' // app_users.csv line 3
    expect(await storedScore(await pkeyForEmail(piiKeySecret(), email))).toBe(await expectedScore(email, 1))
  })
})

describe('T-WH-7b lenient offsets (09 D-38)', () => {
  it('accepts an hour-only offset and stores the same UTC instant', async () => {
    // The brief's instant with the -05:00 offset used in T-WH-6, its minutes removed.
    for (const timestamp of [
      '2026-09-28T09:22:05-05:00',
      '2026-09-28T09:22:05-0500',
      '2026-09-28T09:22:05-05',
    ]) {
      const body = event({ user_id: 'u_2b6447a3', device_id: 'd_4b21e8', timestamp })
      expect((await post(body)).status, timestamp).toBe(202)
      expect((await stored(body.event_id as string))!.event_ts).toBe(BRIEF_TS)
    }
  })
})

describe('09 D-46 score recompute and 01 identity resolution across one device', () => {
  it('rescores both users when a device changes hands, and an older event keeps its own user_id', async () => {
    const [x, xEmail] = ['u_38e852b0', 'sarah.edwards657@gmail.com']
    const [y, yEmail] = ['u_f1cad5ce', 'eli.clark874@icloud.com']
    const dev = 'd_38e852b0'
    const xKey = await pkeyForEmail(piiKeySecret(), xEmail)
    const yKey = await pkeyForEmail(piiKeySecret(), yEmail)
    // The seed's stored scores have no app events (09 D-46).
    expect(await storedScore(xKey)).toBe(await expectedScore(xEmail, 0))
    expect(await storedScore(yKey)).toBe(await expectedScore(yEmail, 0))

    expect((await post(event({ event: 'login', user_id: x, device_id: dev }))).status).toBe(202)
    expect(await storedScore(xKey)).toBe(await expectedScore(xEmail, 1))

    // An anonymous event on x's device resolves to x and counts for x.
    const anon = event({ event: 'app_open', user_id: null, device_id: dev })
    expect((await post(anon)).status).toBe(202)
    expect(await resolvedOf(anon.event_id as string)).toEqual({ user_id: x, pkey: xKey })
    expect(await storedScore(xKey)).toBe(await expectedScore(xEmail, 2))

    // y logs in on the device at the same event_ts: the later arrival owns it (09 D-43), the
    // anonymous event moves to y, and x, the previous owner, is rescored without it.
    const yLogin = event({ event: 'login', user_id: y, device_id: dev })
    expect((await post(yLogin)).status).toBe(202)
    expect(await resolvedOf(yLogin.event_id as string)).toEqual({ user_id: y, pkey: yKey })
    expect(await resolvedOf(anon.event_id as string)).toEqual({ user_id: y, pkey: yKey })
    expect(await device(dev)).toEqual({ user_id: y, last_seen_ts: BRIEF_TS })
    expect(await storedScore(yKey)).toBe(await expectedScore(yEmail, 2))
    expect(await storedScore(xKey)).toBe(await expectedScore(xEmail, 1))

    // An older event from x on y's device resolves to x, its own user_id, and leaves the device to
    // y. It is more than 30 days before TODAY, so x's score does not change.
    const older = event({ event: 'read_story', user_id: x, device_id: dev, timestamp: '2026-06-30T20:45:52Z' })
    expect((await post(older)).status).toBe(202)
    expect(await resolvedOf(older.event_id as string)).toEqual({ user_id: x, pkey: xKey })
    expect(await device(dev)).toEqual({ user_id: y, last_seen_ts: BRIEF_TS })
    expect(await storedScore(xKey)).toBe(await expectedScore(xEmail, 1))
  })
})

describe('T-WH-8 duplicate delivery', () => {
  it('answers 200 duplicate, adds no row, and ignores a differing second body (first write wins)', async () => {
    const eventId = nextEventId()
    const first = {
      event_id: eventId,
      event: 'read_story',
      user_id: 'u_3380b6e6',
      device_id: 'd_3380b6e6',
      timestamp: BRIEF_TS,
    }
    expect((await post(first)).status).toBe(202)
    const row = await stored(eventId)
    const rows = await count('app_events')
    const mapping = await device('d_3380b6e6')

    const differing = {
      event_id: eventId,
      event: 'app_open',
      user_id: 'u_3380b6e',
      device_id: 'd_3380b6e',
      timestamp: '2026-06-30T20:45:52Z',
    }
    for (const body of [first, differing]) {
      const { status, json } = await post(body)
      expect(status).toBe(200)
      expect(json).toEqual({ accepted: true, duplicate: true })
    }
    expect(await count('app_events')).toBe(rows)
    expect(await stored(eventId)).toEqual(row)
    expect(await device('d_3380b6e6')).toEqual(mapping)
    expect(await device('d_3380b6e')).toBeNull()
    expect(await count('app_users WHERE user_id = ?', 'u_3380b6e')).toBe(0)
  })

  it('skips the device_identity update on a duplicate (07 §B), so a replay cannot take a device back', async () => {
    // Two users on one device at the same event_ts: the later arrival owns it (>=, 09 D-43).
    const dev = 'd_f2411d1c'
    const a = event({ event: 'login', user_id: 'u_f2411d1c', device_id: dev })
    const b = event({ event: 'login', user_id: 'u_e9edbf48', device_id: dev })
    expect((await post(a)).status).toBe(202)
    expect((await post(b)).status).toBe(202)
    expect(await device(dev)).toEqual({ user_id: 'u_e9edbf48', last_seen_ts: BRIEF_TS })
    expect((await post(a)).status).toBe(200)
    expect(await device(dev)).toEqual({ user_id: 'u_e9edbf48', last_seen_ts: BRIEF_TS })
  })
})

describe('T-WH-11 signature headers', () => {
  const unchanged = async (send: () => Promise<Response>, error: string) => {
    const rows = await count('app_events')
    const res = await send()
    const text = await res.text()
    expect(res.status, error).toBe(401)
    expect(JSON.parse(text).error).toBe(error)
    expect(text).not.toContain(webhookSecret())
    expect(await count('app_events')).toBe(rows)
  }

  it('rejects a wrong secret, a stale or future header time, a tampered body and missing headers', async () => {
    const secret = webhookSecret()
    const wrongSecret = secret.slice(0, -1)
    expect(wrongSecret.length).toBeGreaterThan(0)
    const body = JSON.stringify(event({ user_id: 'u_2b6447a3', device_id: 'd_4b21e8' }))

    await unchanged(() => sendWebhook(body, { secret: wrongSecret }), 'bad_signature')
    await unchanged(() => sendWebhook(body, { timestamp: String(nowSeconds() - 301) }), 'stale_timestamp')
    // A future time gets a margin: the server's clock may tick between signing and checking.
    await unchanged(() => sendWebhook(body, { timestamp: String(nowSeconds() + 330) }), 'stale_timestamp')
    await unchanged(
      () => sendWebhook(body, { sendBody: body.replace('read_story', 'app_open') }),
      'bad_signature',
    )
    await unchanged(
      () => sendWebhook(body, { headers: { 'x-webhook-signature': undefined } }),
      'missing_headers',
    )
    await unchanged(
      () => sendWebhook(body, { headers: { 'x-webhook-timestamp': undefined } }),
      'missing_headers',
    )
    await unchanged(
      () =>
        sendWebhook(body, {
          headers: { 'x-webhook-timestamp': undefined, 'x-webhook-signature': undefined },
        }),
      'missing_headers',
    )
  })

  it('logs each 401 with its reason and no header or body value (04 §Webhook responses)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = JSON.stringify(event({ user_id: 'u_2b6447a3', device_id: 'd_4b21e8' }))
    await unchanged(() => sendWebhook(body, { secret: webhookSecret().slice(0, -1) }), 'bad_signature')
    await unchanged(() => sendWebhook(body, { timestamp: String(nowSeconds() - 301) }), 'stale_timestamp')
    const lines = warn.mock.calls.map((args) => JSON.parse(String(args[0])))
    expect(lines.map((l) => [l.at, l.status, l.error])).toEqual([
      ['webhook', 401, 'bad_signature'],
      ['webhook', 401, 'stale_timestamp'],
    ])
    for (const line of lines) expect(line.reason).toEqual(expect.any(String))
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain('u_2b6447a3')
    expect(logged).not.toContain(webhookSecret())
  })

  it('rejects a signature without the v1= prefix', async () => {
    const body = JSON.stringify(event({ user_id: 'u_2b6447a3', device_id: 'd_4b21e8' }))
    const timestamp = String(nowSeconds())
    const bare = (await signature(webhookSecret(), timestamp, new TextEncoder().encode(body))).slice(
      'v1='.length,
    )
    await unchanged(
      () => sendWebhook(body, { timestamp, headers: { 'x-webhook-signature': bare } }),
      'bad_signature',
    )
  })

  it('checks the signature on the raw bytes before parsing: a bad signature on a non-JSON body is 401', async () => {
    await unchanged(
      () => sendWebhook('not-an-email', { secret: webhookSecret().slice(0, -1) }),
      'bad_signature',
    )
    const res = await sendWebhook('not-an-email')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_event', details: [{ field: 'body' }] })
  })

  it("rejects a wrong signature even under the exact header set the events/test panel sends (content-type, timestamp, signature, cf-connecting-ip; 09 D-73): a verify bypass keyed to this route's own header shape would otherwise go undetected", async () => {
    const body = JSON.stringify(event({ user_id: 'u_2b6447a3', device_id: 'd_4b21e8' }))
    const timestamp = String(nowSeconds())
    const wrongSignature = await signature('not-the-real-secret', timestamp, new TextEncoder().encode(body))
    expect(wrongSignature).not.toBe(await signature(webhookSecret(), timestamp, new TextEncoder().encode(body)))
    const rows = await count('app_events')
    const res = await SELF.fetch('http://cdp.test/webhooks/app', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': wrongSignature,
        'cf-connecting-ip': '198.51.100.9',
      },
      body,
    })
    expect(res.status).toBe(401)
    expect((await res.json<{ error: string }>()).error).toBe('bad_signature')
    expect(await count('app_events')).toBe(rows)
  })

  it('accepts a header time inside the window and answers an identical replay with 200 duplicate', async () => {
    const body = JSON.stringify(event({ user_id: 'u_2b6447a3', device_id: 'd_4b21e8' }))
    const request = await signedRequest(body, { timestamp: String(nowSeconds() - 290) })
    expect((await request.send()).status).toBe(202)
    const rows = await count('app_events')
    const replay = await request.send()
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ accepted: true, duplicate: true })
    expect(await count('app_events')).toBe(rows)
  })
})

describe('T-WH-12 size and content-type caps', () => {
  /** A brief-shaped body padded with JSON whitespace to exactly `bytes` bytes (no value is added). */
  const padded = (bytes: number) => {
    const json = JSON.stringify(event({ user_id: 'u_2b6447a3', device_id: 'd_4b21e8' }))
    return { json, body: json + ' '.repeat(bytes - new TextEncoder().encode(json).byteLength) }
  }

  it('answers 413 for a body over 64 KB and accepts one of exactly 64 KB', async () => {
    const rows = await count('app_events')
    const over = await sendWebhook(padded(64 * 1024 + 1).body)
    expect(over.status).toBe(413)
    expect(await over.json()).toMatchObject({ error: 'payload_too_large' })
    expect(await count('app_events')).toBe(rows)

    const atCap = padded(64 * 1024)
    expect((await sendWebhook(atCap.body)).status).toBe(202)
    expect(await stored(JSON.parse(atCap.json).event_id)).not.toBeNull()
  })

  it('answers 400 for a property string over 200 characters and accepts exactly 200', async () => {
    const long = Array(8).fill('supreme-court-ruling-explained').join('-')
    const over = await post(
      event({ user_id: 'u_2b6447a3', device_id: 'd_4b21e8', properties: { page: long.slice(0, 201) } }),
    )
    expect(over.status).toBe(400)
    expect(over.json).toMatchObject({ error: 'invalid_event', details: [{ field: 'properties' }] })
    // The sender's property key is never echoed.
    expect(JSON.stringify(over.json.details)).not.toContain('page')

    const atCap = event({
      user_id: 'u_2b6447a3',
      device_id: 'd_4b21e8',
      properties: { page: long.slice(0, 200) },
    })
    expect((await post(atCap)).status).toBe(202)
    expect(JSON.parse((await stored(atCap.event_id as string))!.properties!).page).toHaveLength(200)
  })

  it('accepts any JSON object as properties and caps strings at any depth (04, 09 D-22)', async () => {
    const slug = 'supreme-court-ruling-explained'
    const base = { user_id: 'u_2b6447a3', device_id: 'd_4b21e8' }
    const accepted = event({
      ...base,
      properties: { story: slug, link: LINK, page: [slug, { story: slug }], utm: null },
    })
    expect((await post(accepted)).status).toBe(202)
    expect(JSON.parse((await stored(accepted.event_id as string))!.properties!)).toEqual(accepted.properties)

    const long = Array(8).fill(slug).join('-').slice(0, 201)
    for (const properties of [{ page: { story: long } }, { page: [slug, long] }]) {
      const rows = await count('app_events')
      const { status, json } = await post(event({ ...base, properties }))
      expect(status).toBe(400)
      expect(json).toMatchObject({ error: 'invalid_event', details: [{ field: 'properties' }] })
      expect(JSON.stringify(json.details)).not.toContain('story')
      expect(await count('app_events')).toBe(rows)
    }
  })

  it('accepts properties nested as deep as the store allows and refuses one level more with 400', async () => {
    // The object is level 1; D1's json_valid CHECK on app_events.properties allows 1000 levels.
    const nested = (levels: number) => {
      let value: unknown = 'supreme-court-ruling-explained'
      for (let i = 1; i < levels; i++) value = [value]
      return { page: value }
    }
    const deepest = event({ user_id: 'u_2b6447a3', device_id: 'd_4b21e8', properties: nested(1000) })
    expect((await post(deepest)).status).toBe(202)
    expect(await stored(deepest.event_id as string)).not.toBeNull()
    const tooDeep = await post(
      event({ user_id: 'u_2b6447a3', device_id: 'd_4b21e8', properties: nested(1001) }),
    )
    expect(tooDeep.status).toBe(400)
    expect(tooDeep.json).toMatchObject({ error: 'invalid_event', details: [{ field: 'properties' }] })
  })

  it('answers 415 for a body that is not sent as application/json', async () => {
    const rows = await count('app_events')
    const res = await sendWebhook(JSON.stringify(event({ user_id: 'u_2b6447a3', device_id: 'd_4b21e8' })), {
      headers: { 'content-type': 'text/plain' },
    })
    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({ error: 'unsupported_media_type' })
    expect(await count('app_events')).toBe(rows)
  })
})

describe('user and device ids: trimmed like the CSV import, then letters, digits, "_" and "-" only', () => {
  // Inputs are the real u_2b6447a3 / d_4b21e8 (the brief's sample) with spaces or one character
  // added, never an invented id. Kept last in the file: the event-id pool is shared, so
  // a block placed earlier would shift the ids (and the tie order) of every test after it.
  it('a padded id is stored trimmed and resolves to the real user, with no phantom stub', async () => {
    const users = await count('app_users')
    const profiles = await count('profiles')
    const body = event({ user_id: ' u_2b6447a3 ', device_id: '\td_4b21e8 ' })
    const { status, json } = await post(body)
    expect(status).toBe(202)
    expect(json).toEqual({ accepted: true, event_id: body.event_id })
    expect(await stored(body.event_id as string)).toMatchObject({ user_id: 'u_2b6447a3', device_id: 'd_4b21e8' })
    expect(await resolvedOf(body.event_id as string)).toEqual({ user_id: 'u_2b6447a3', pkey: await pkeyForEmail(piiKeySecret(), JULIA) })
    expect(await count('app_users')).toBe(users)
    expect(await count('profiles')).toBe(profiles)
    expect(await count("app_users WHERE user_id <> trim(user_id)")).toBe(0)
  })

  it('a blank or odd id is 400 invalid_event naming the field, and stores nothing', async () => {
    const base = { user_id: 'u_2b6447a3', device_id: 'd_4b21e8' }
    const cases: [Body, string, string][] = [
      [event({ ...base, user_id: '   ' }), 'user_id', 'user_id must not be empty or only spaces'],
      [event({ ...base, device_id: ' \t ' }), 'device_id', 'device_id must not be empty or only spaces'],
      [event({ ...base, user_id: 'u_2b6447a3;' }), 'user_id', 'user_id must be 1 to 64 letters, digits, "_" or "-"'],
      [event({ ...base, user_id: 'u_2b64 47a3' }), 'user_id', 'user_id must be 1 to 64 letters, digits, "_" or "-"'],
      [event({ ...base, device_id: 'd_4b21e8/' }), 'device_id', 'device_id must be 1 to 64 letters, digits, "_" or "-"'],
      [event({ ...base, device_id: 'd_4b21e8\u0000' }), 'device_id', 'device_id must be 1 to 64 letters, digits, "_" or "-"'],
      [event({ ...base, device_id: 'ｄ_4b21e8' }), 'device_id', 'device_id must be 1 to 64 letters, digits, "_" or "-"'],
    ]
    const rows = await count('app_events')
    const users = await count('app_users')
    for (const [body, field, issue] of cases) {
      const { status, json } = await post(body)
      expect(status, issue).toBe(400)
      expect(json.error).toBe('invalid_event')
      expect(json.details).toEqual([{ field, issue }])
      expect(JSON.stringify(json)).not.toContain('2b6447a3')
      expect(JSON.stringify(json)).not.toContain('4b21e8')
    }
    expect(await count('app_events')).toBe(rows)
    expect(await count('app_users')).toBe(users)
  })

  it('the public 202 never says which person a device belongs to', async () => {
    // Her login on the brief's device first, so an anonymous event on it resolves to her.
    expect((await post(event({ event: 'login', user_id: 'u_2b6447a3', device_id: 'd_4b21e8' }))).status).toBe(202)
    const anonymous = event({ event: 'app_open', user_id: null, device_id: 'd_4b21e8' })
    const { status, json } = await post(anonymous)
    expect(status).toBe(202)
    expect(json).toEqual({ accepted: true, event_id: anonymous.event_id })
    expect(JSON.stringify(json)).not.toMatch(/pk_|u_2b6447a3/)
    // The session-only feed still knows who it is.
    expect((await resolvedOf(anonymous.event_id as string)).user_id).toBe('u_2b6447a3')
  })
})

describe('a retry of a stored event is 200 duplicate before any rule runs; event_id is trimmed and charset-checked too', () => {
  // Rows "stored before a rule existed" are written straight to app_events, the way the live
  // database still holds them; every value is a real id or the hosted URL with a real local part.
  async function storeLegacy(fields: { event_id: string; user_id: string | null; device_id: string; properties?: Body }): Promise<void> {
    await env.DB.prepare(
      'INSERT INTO app_events (event_id, event, user_id, device_id, event_ts, received_at, properties) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(fields.event_id, 'link_click', fields.user_id, fields.device_id, BRIEF_TS, BRIEF_TS, fields.properties === undefined ? null : JSON.stringify(fields.properties))
      .run()
  }

  it('a sender retry of an event stored before today\'s rules (a link with a local part, a padded user_id) is 200 duplicate, not 400', async () => {
    const withLocalPart = { event_id: nextEventId(), user_id: 'u_2b6447a3', device_id: 'd_2b6447a3', properties: { link: `${HOSTED_URL}/u/julia.evans230` } }
    const withPaddedUser = { event_id: nextEventId(), user_id: ' u_2b6447a3 ', device_id: 'd_2b6447a3' }
    await storeLegacy(withLocalPart)
    await storeLegacy(withPaddedUser)
    // The padded id was an unknown user then, so it got its own stub account and profile.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO app_users (user_id, email_norm, created_at, from_csv) VALUES (?, NULL, ?, 0)").bind(withPaddedUser.user_id, BRIEF_TS),
      env.DB.prepare("INSERT INTO profiles (pkey, email_norm, user_id, kind, engagement_score, created_at) VALUES (?, NULL, ?, 'unknown_user_stub', 3, ?)").bind(
        await pkeyForUnknownUser(piiKeySecret(), withPaddedUser.user_id),
        withPaddedUser.user_id,
        BRIEF_TS,
      ),
    ])
    const rows = await count('app_events')
    for (const stored of [withLocalPart, withPaddedUser]) {
      // As fresh events these bodies are refused (the first by the personal-data check, the second
      // would be stored trimmed), but their event_ids are already stored: the first write wins.
      const { status, json } = await post({ ...stored, event: 'link_click', timestamp: BRIEF_TS })
      expect(status, stored.event_id).toBe(200)
      expect(json).toEqual({ accepted: true, duplicate: true })
    }
    expect(await count('app_events')).toBe(rows)
    // The same link under a new event_id is still refused.
    const fresh = await post(event({ event: 'link_click', user_id: 'u_2b6447a3', device_id: 'd_2b6447a3', properties: withLocalPart.properties }))
    expect(fresh.status).toBe(400)
  })

  it('event_id is trimmed: " <id> " stores as <id>, and a later " <id> " or "<id>" is the duplicate', async () => {
    const id = nextEventId()
    const first = await post({ ...event({ user_id: 'u_2b6447a3', device_id: 'd_2b6447a3' }), event_id: ` ${id}\t` })
    expect(first.status).toBe(202)
    expect(first.json).toEqual({ accepted: true, event_id: id })
    expect(await stored(id)).not.toBeNull()
    const rows = await count('app_events')
    for (const retry of [id, `  ${id} `]) {
      const again = await post({ ...event({ user_id: 'u_2b6447a3', device_id: 'd_2b6447a3' }), event_id: retry })
      expect(again.status, JSON.stringify(retry)).toBe(200)
      expect(again.json).toEqual({ accepted: true, duplicate: true })
    }
    expect(await count('app_events')).toBe(rows)
  })

  it('a stored event_id that still holds its padding (written before the trim) is matched as sent', async () => {
    const padded = ` ${nextEventId()} `
    await storeLegacy({ event_id: padded, user_id: 'u_2b6447a3', device_id: 'd_2b6447a3' })
    const { status } = await post({ ...event({ user_id: 'u_2b6447a3', device_id: 'd_2b6447a3' }), event_id: padded })
    expect(status).toBe(200)
  })

  it('a blank or odd event_id is 400 naming event_id, and stores nothing', async () => {
    const rows = await count('app_events')
    const id = nextEventId()
    for (const [eventId, issue] of [
      ['   ', 'event_id must not be empty or only spaces'],
      [`${id};`, 'event_id must be 1 to 64 letters, digits, "_" or "-"'],
      [`${id.slice(0, 6)} ${id.slice(6)}`, 'event_id must be 1 to 64 letters, digits, "_" or "-"'],
    ]) {
      const { status, json } = await post({ ...event({ user_id: 'u_2b6447a3', device_id: 'd_2b6447a3' }), event_id: eventId })
      expect(status, eventId).toBe(400)
      expect(json.details).toEqual([{ field: 'event_id', issue }])
    }
    expect(await count('app_events')).toBe(rows)
  })
})
