import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { TODAY } from '../shared/config'
import { pkeyForEmail, pkeyForUnknownUser } from '../shared/pseudonym'
import { loginCookie } from './helpers/auth'
import { piiKeySecret, seedDatabase } from './helpers/seed'
import { eventIdPool, sendWebhook, signedRequest } from './helpers/webhook'

// GET /api/events/recent (04 §GET /api/events/recent, 06 §/events) and T-WH-10 (08, R4.10).
// Every event goes through the real POST /webhooks/app; the feed and the segment preview are read
// through the real routes on the same worker (SELF), with no re-import between write and read.
// The test D1 holds the real seed of data/*.csv (test/helpers/seed.ts).
// Inputs and where they come from (09 D-11: brief-shaped payloads built from real ids):
// - users are real app_users.csv rows: u_c3a64c0a (line 5, julia.wilson12@yahoo.com),
//   u_2b6447a3 (line 2, julia.evans230@gmail.com, Instagram, active, 02 §Counts demo subject),
//   u_09acb8a4 (line 6, appuser17@gmail.com, app-only), which carries the 22 events of the feed
//   limit test so julia.evans230's app score is not saturated before T-WH-10. The unknown user
//   id u_09acb8a is u_09acb8a4 with its last character removed (09 D-47); it occurs nowhere in
//   data/*.csv.
// - devices are `d_` + the hex of a real user id; event ids come from eventIdPool().
// - event times are the brief's 2026-09-28T14:22:05Z (04 §Webhook body) and 07 §D's 09:00 and
//   09:10 on TODAY (02 §Time: demo events default to TODAY).

const BRIEF_TS = '2026-09-28T14:22:05Z'
const nextEventId = eventIdPool()
let cookie: string

beforeAll(async () => {
  await seedDatabase()
  cookie = await loginCookie()
})

interface FeedEvent {
  event_id: string
  event: string
  device_id: string
  event_ts: string
  received_at: string
  user_id: string | null
  attached_via: 'direct' | 'login_stitch' | null
  pkey: string | null
  email: string | null
}

async function feed(): Promise<FeedEvent[]> {
  const res = await SELF.fetch('http://cdp.test/api/events/recent', { headers: { cookie } })
  expect(res.status).toBe(200)
  const body = await res.json<{ events: FeedEvent[] }>()
  expect(Object.keys(body)).toEqual(['events'])
  return body.events
}

async function post(body: Record<string, unknown>): Promise<number> {
  return (await sendWebhook(JSON.stringify(body))).status
}

describe('GET /api/events/recent (04, 06 §/events)', () => {
  it('401 without a session cookie', async () => {
    const res = await SELF.fetch('http://cdp.test/api/events/recent')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Sign in to continue.' })
  })

  it('is empty before any event arrives (the seed writes no app events)', async () => {
    expect(await env.DB.prepare('SELECT count(*) AS n FROM app_events').first<number>('n')).toBe(0)
    expect(await feed()).toEqual([])
  })

  it('lists an anonymous event as unresolved, then as stitched once its device logs in', async () => {
    const anon = {
      event_id: nextEventId(),
      event: 'app_open',
      user_id: null,
      device_id: 'd_c3a64c0a',
      timestamp: `${TODAY}T09:00:00Z`,
    }
    expect(await post(anon)).toBe(202)
    const [first] = await feed()
    expect(first).toEqual({
      event_id: anon.event_id,
      event: 'app_open',
      device_id: 'd_c3a64c0a',
      event_ts: anon.timestamp,
      received_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      user_id: null,
      attached_via: null,
      pkey: null,
      email: null,
    })

    const login = {
      ...anon,
      event_id: nextEventId(),
      event: 'login',
      user_id: 'u_c3a64c0a',
      timestamp: `${TODAY}T09:10:00Z`,
    }
    expect(await post(login)).toBe(202)
    const pkey = await pkeyForEmail(piiKeySecret(), 'julia.wilson12@yahoo.com')
    const [newest, earlier] = await feed()
    expect(newest).toMatchObject({
      event_id: login.event_id,
      user_id: 'u_c3a64c0a',
      attached_via: 'direct',
      pkey,
      email: 'julia.wilson12@yahoo.com',
    })
    expect(earlier).toMatchObject({
      event_id: anon.event_id,
      user_id: 'u_c3a64c0a',
      attached_via: 'login_stitch',
      pkey,
      email: 'julia.wilson12@yahoo.com',
    })
  })

  it("shows an unknown user's stub key with no email", async () => {
    const unknown = 'u_09acb8a'
    const body = {
      event_id: nextEventId(),
      event: 'app_open',
      user_id: unknown,
      device_id: 'd_09acb8a4',
      timestamp: BRIEF_TS,
    }
    expect(await post(body)).toBe(202)
    const [newest] = await feed()
    expect(newest).toMatchObject({
      event_id: body.event_id,
      user_id: unknown,
      attached_via: 'direct',
      pkey: await pkeyForUnknownUser(piiKeySecret(), unknown),
      email: null,
    })
  })

  it('returns the last 20 newest first by received_at, and a duplicate adds no row', async () => {
    const sent: string[] = []
    for (let i = 0; i < 22; i++) {
      const id = nextEventId()
      sent.push(id)
      expect(
        await post({
          event_id: id,
          event: 'read_story',
          user_id: 'u_09acb8a4',
          device_id: 'd_09acb8a4',
          timestamp: BRIEF_TS,
        }),
      ).toBe(202)
    }
    const expected = sent.slice(-20).reverse()
    const events = await feed()
    expect(events.map((e) => e.event_id)).toEqual(expected)
    for (let i = 1; i < events.length; i++)
      expect(events[i - 1].received_at >= events[i].received_at).toBe(true)

    // Re-delivering the oldest listed event answers 200 duplicate and leaves the feed unchanged.
    const oldest = {
      event_id: expected[19],
      event: 'read_story',
      user_id: 'u_09acb8a4',
      device_id: 'd_09acb8a4',
      timestamp: BRIEF_TS,
    }
    expect((await (await signedRequest(JSON.stringify(oldest))).send()).status).toBe(200)
    expect((await feed()).map((e) => e.event_id)).toEqual(expected)
  })
})

interface PreviewBody {
  rows: { email: string; engagement_score: number; has_app: boolean }[]
}

async function preview(filters: unknown): Promise<PreviewBody> {
  const res = await SELF.fetch('http://cdp.test/api/segments/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ filters, limit: 1000 }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
  return res.json<PreviewBody>()
}

// 08 T-WH-10 reads "a segment count changes after an event". No 04 segment filter reads anything
// a webhook writes (status, source and last_open_date come from subscribers.csv; has_app from
// app_users rows with an email, which a webhook never creates), so no count can move. What a
// webhook does change in a segment is the stored engagement_score of its rows (09 D-46). This
// test pins that, on the same worker with no re-import; the count gap is reported, not hidden.
describe('T-WH-10 a segment reflects a webhook event with no re-import, same worker instance', () => {
  it("changes julia.evans230's engagement_score in the segment rows after a direct and a stitched event", async () => {
    const julia = 'julia.evans230@gmail.com'
    const filters = { source: ['instagram'], has_app: true }
    const runs = await env.DB.prepare('SELECT count(*) AS n FROM import_runs').first<number>('n')
    const row = async () => {
      const body = await preview(filters)
      const found = body.rows.find((r) => r.email === julia)
      if (found === undefined) throw new Error('julia.evans230 is not in the Instagram + has_app segment')
      return { score: found.engagement_score }
    }

    const before = await row()
    const device = 'd_4b21e8'
    // No event in this file has named her or used this device yet, so both events below count.
    const n = (sql: string, v: string) =>
      env.DB.prepare(`SELECT count(*) AS n FROM app_events WHERE ${sql} = ?`).bind(v).first<number>('n')
    expect(await n('device_id', device)).toBe(0)
    expect(await n('user_id', 'u_2b6447a3')).toBe(0)

    expect(
      await post({
        event_id: nextEventId(),
        event: 'login',
        user_id: 'u_2b6447a3',
        device_id: device,
        timestamp: BRIEF_TS,
      }),
    ).toBe(202)
    const afterDirect = await row()
    expect(afterDirect.score).toBeGreaterThan(before.score)

    // An anonymous event on her device counts for her through the read-time stitch.
    expect(
      await post({
        event_id: nextEventId(),
        event: 'app_open',
        user_id: null,
        device_id: device,
        timestamp: BRIEF_TS,
      }),
    ).toBe(202)
    const afterStitched = await row()
    expect(afterStitched.score).toBeGreaterThan(afterDirect.score)

    // The stored score is what the preview shows, read straight from the profile row.
    const stored = await env.DB.prepare('SELECT engagement_score FROM profiles WHERE email_norm = ?')
      .bind(julia)
      .first<number>('engagement_score')
    expect(stored).toBe(afterStitched.score)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM import_runs').first<number>('n')).toBe(runs)
  })
})
