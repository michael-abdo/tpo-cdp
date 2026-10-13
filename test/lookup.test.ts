import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { pkeyForEmail, pkeyForUnknownUser } from '../shared/pseudonym'
import { csvTimestampToIso } from '../worker/ingest/web'
import { loginCookie } from './helpers/auth'
import { piiKeySecret, seedDatabase } from './helpers/seed'
import { eventIdPool, sendWebhook } from './helpers/webhook'

// GET /api/lookup (04 §/api/lookup, 06 §/lookup; R2, R1.2), T-API-1 and the lookup half of
// T-ING-5 (08). The test D1 holds the real seed of data/*.csv (test/helpers/seed.ts) and no
// webhook events, so every app section has events []. Demo subjects and numbers: 02 §Counts.
// Inputs and where they come from:
// - joy.hall830@protonmail.com: subscribers.csv:902, app_users.csv:303 (u_ceed5f12), her
//   /subscribe row web_events.csv:5421 at 2026-09-02 20:40:04.
// - julia.evans230@gmail.com: app_users.csv:2 (u_2b6447a3, the PDF's sample user).
// - server-side normalization uses real raw spellings only: "  zoe.allen235@gmail.com "
//   (subscribers.csv:56, its twin is line 1333) and PAUL.GARCIA558@GMAIL.COM (app_users.csv:8,
//   u_3380b6e6; subscribers.csv:238 has paul.garcia558@gmail.com).
// - appuser17@gmail.com: app_users.csv:6 (u_09acb8a4), an app-only account.
// Error-path inputs per 09 D-47, each a removal from a real value: "joy.hall83@protonmail.com"
// and "u_ceed5f1" (last character removed; neither occurs in data/*.csv), and "joy.hall830"
// (the domain removed, so it is not an email).
// Lookup by pk_, d_ and v_ (T-API-1, 16 §If time remains 3), in the last describe because it
// sends webhooks and storage persists across this file's tests:
// - joy's pk_ key (derived), her visitor v_c9e136fd6d (web_events.csv, 02 §Counts) and the
//   brief's sample device d_4b21e8 (09 D-11), named by a webhook from u_ceed5f12.
// - the stub u_2b6447a (julia's id with its last character removed, as T-WH-6 uses), sent on
//   the same device AFTER joy but with an earlier event_ts (2026-06-30 20:45:52,
//   web_events.csv:3, as T-WH-7 uses), so the device's current user is joy by event_ts
//   (01 §Identity resolution, 09 D-43), not the stub that arrived last.
// - v_569d3a387c (web_events.csv:13), an anonymous visitor: no /subscribe email, no profile.
// - 404 inputs per 09 D-47, each a real id with its last character removed: joy's pk_ key,
//   "d_4b21e" and "v_c9e136fd6" (none occurs in data/*.csv or in a sent event).

const JOY = 'joy.hall830@protonmail.com'
const JULIA = 'julia.evans230@gmail.com'
const JOY_SUBSCRIBE_TS = csvTimestampToIso('2026-09-02 20:40:04')

let cookie: string

beforeAll(async () => {
  await seedDatabase()
  cookie = await loginCookie()
})

function lookup(q: string, headers: Record<string, string> = { cookie }): Promise<Response> {
  return SELF.fetch(`http://cdp.test/api/lookup?${new URLSearchParams({ q })}`, { headers })
}

interface WebEvent {
  page: string
  event_ts: string
  utm_source: string | null
  pre_signup: boolean
}

interface LookupBody {
  profile: {
    pkey: string
    kind: string
    email: string | null
    engagement_score: number
    cold_since: string | null
    has_app: boolean
    app_after_signup: boolean
  }
  newsletter: Record<string, unknown> | null
  web: { visitor_id: string; first_page: string; first_utm_source: string | null; events: WebEvent[] } | null
  app: { user_id: string; created_at: string; from_csv: boolean; devices: string[]; events: unknown[] } | null
}

async function found(q: string): Promise<LookupBody> {
  const res = await lookup(q)
  expect(res.status, q).toBe(200)
  return res.json<LookupBody>()
}

async function storedScore(pkey: string): Promise<number | null> {
  return env.DB.prepare('SELECT engagement_score FROM profiles WHERE pkey = ?')
    .bind(pkey)
    .first<number>('engagement_score')
}

describe('T-API-1 lookup by email and by u_ resolve one profile', () => {
  it('joy by email and by u_ceed5f12 return the same pkey and the same body', async () => {
    const byEmail = await found(JOY)
    const byUser = await found('u_ceed5f12')
    expect(byEmail.profile.pkey).toBe(await pkeyForEmail(piiKeySecret(), JOY))
    expect(byUser.profile.pkey).toBe(byEmail.profile.pkey)
    expect(byUser).toEqual(byEmail)
  })

  it('joy: exactly the 04 shape, stored derived values, 9 web events with 3 pre-signup', async () => {
    const body = await found(JOY)
    expect(Object.keys(body)).toEqual(['profile', 'newsletter', 'web', 'app'])
    expect(body.profile).toEqual({
      pkey: body.profile.pkey,
      kind: 'subscriber',
      email: JOY,
      engagement_score: await storedScore(body.profile.pkey),
      cold_since: '2026-10-22',
      has_app: true,
      app_after_signup: true,
    })
    expect(Object.keys(body.profile)).toEqual([
      'pkey',
      'kind',
      'email',
      'engagement_score',
      'cold_since',
      'has_app',
      'app_after_signup',
    ])
    expect(body.newsletter).toEqual({
      signup_date: '2026-09-02',
      status: 'active',
      source: 'instagram',
      last_open_date: '2026-09-22',
      merged_count: 1,
    })
    expect(Object.keys(body.newsletter!)).toEqual([
      'signup_date',
      'status',
      'source',
      'last_open_date',
      'merged_count',
    ])

    const web = body.web!
    expect(Object.keys(web)).toEqual(['visitor_id', 'first_page', 'first_utm_source', 'events'])
    expect(web.visitor_id).toBe('v_c9e136fd6d')
    expect(web.first_page).toBe('/')
    expect(web.first_utm_source).toBe('instagram')
    expect(web.events).toHaveLength(9)
    for (const e of web.events)
      expect(Object.keys(e)).toEqual(['page', 'event_ts', 'utm_source', 'pre_signup'])
    const ts = web.events.map((e) => e.event_ts)
    expect(ts).toEqual([...ts].sort())
    expect(web.events.filter((e) => e.pre_signup)).toHaveLength(3)
    // pre_signup is exactly "before her /subscribe row", which is itself not pre-signup.
    expect(JOY_SUBSCRIBE_TS).not.toBeNull()
    for (const e of web.events) expect(e.pre_signup, e.event_ts).toBe(e.event_ts < JOY_SUBSCRIBE_TS!)
    expect(web.events.find((e) => e.event_ts === JOY_SUBSCRIBE_TS)).toMatchObject({
      page: '/subscribe',
      pre_signup: false,
    })

    expect(body.app).toEqual({
      user_id: 'u_ceed5f12',
      created_at: '2026-09-03',
      from_csv: true,
      devices: [],
      events: [],
    })
    expect(Object.keys(body.app!)).toEqual(['user_id', 'created_at', 'from_csv', 'devices', 'events'])
  })

  it('julia.evans230: web null, app created 2026-08-22 before signup, so not app_after_signup', async () => {
    const body = await found(JULIA)
    expect(body.web).toBeNull()
    expect(body.app).toMatchObject({ user_id: 'u_2b6447a3', created_at: '2026-08-22', from_csv: true })
    expect(body.profile).toMatchObject({
      kind: 'subscriber',
      email: JULIA,
      cold_since: '2026-10-15',
      has_app: true,
      app_after_signup: false,
    })
    expect(body.profile.engagement_score).toBe(await storedScore(body.profile.pkey))
    expect(body.newsletter).toMatchObject({
      signup_date: '2026-09-13',
      source: 'instagram',
      last_open_date: '2026-09-15',
    })
    expect((await found('u_2b6447a3')).profile.pkey).toBe(body.profile.pkey)
  })

  it('normalizes q on the server: real raw spellings with whitespace or upper case find the same profile', async () => {
    const zoe = await found('  zoe.allen235@gmail.com ')
    expect(zoe.profile.pkey).toBe((await found('zoe.allen235@gmail.com')).profile.pkey)
    expect(zoe.profile.email).toBe('zoe.allen235@gmail.com')
    expect(zoe.newsletter).toMatchObject({ merged_count: 2 })

    const paul = await found('PAUL.GARCIA558@GMAIL.COM')
    expect(paul.profile.pkey).toBe((await found('paul.garcia558@gmail.com')).profile.pkey)
    expect(paul.profile.pkey).toBe((await found('u_3380b6e6')).profile.pkey)
    expect(paul.profile.email).toBe('paul.garcia558@gmail.com')
  })

  it('an appuserN email is kind app_only with newsletter null', async () => {
    const body = await found('appuser17@gmail.com')
    expect(body.profile).toMatchObject({
      kind: 'app_only',
      email: 'appuser17@gmail.com',
      cold_since: null,
      has_app: true,
      app_after_signup: false,
    })
    expect(body.newsletter).toBeNull()
    expect(body.web).toBeNull()
    expect(body.app).toEqual({
      user_id: 'u_09acb8a4',
      created_at: '2026-09-10',
      from_csv: true,
      devices: [],
      events: [],
    })
    expect((await found('u_09acb8a4')).profile.pkey).toBe(body.profile.pkey)
  })

  it('404 not_found for an unknown email or user id, without echoing q', async () => {
    for (const q of ['joy.hall83@protonmail.com', 'u_ceed5f1']) {
      const res = await lookup(q)
      expect(res.status, q).toBe(404)
      const text = await res.text()
      expect(JSON.parse(text)).toEqual({
        error: 'not_found',
        message: 'No profile matches that email or id.',
      })
      expect(text).not.toContain('joy')
      expect(text).not.toContain('ceed')
    }
  })

  it('404 not_found for a blank or missing q and for one that is neither an email nor u_… (04 lists only 404)', async () => {
    const notFound = { error: 'not_found', message: 'No profile matches that email or id.' }
    for (const q of ['', '   ', 'joy.hall830']) {
      const res = await lookup(q)
      expect(res.status, JSON.stringify(q)).toBe(404)
      expect(await res.json()).toEqual(notFound)
    }
    const res = await SELF.fetch('http://cdp.test/api/lookup', { headers: { cookie } })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(notFound)
  })

  it('401 without a session cookie', async () => {
    const res = await lookup(JOY, {})
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Sign in to continue.' })
  })
})

describe('T-API-1 lookup by pk_, d_ and v_ resolve the same profile as the email', () => {
  const SAMPLE_DEVICE = 'd_4b21e8'
  const STUB = 'u_2b6447a'

  // Joy first at the brief's sample time (09 D-11), then the stub on the same device at an
  // earlier real time (web_events.csv:3): arrival order and event_ts order disagree.
  const SENT: [user_id: string, timestamp: string][] = [
    ['u_ceed5f12', '2026-09-28T14:22:05Z'],
    [STUB, '2026-06-30T20:45:52Z'],
  ]

  beforeAll(async () => {
    const nextEventId = eventIdPool()
    for (const [user_id, timestamp] of SENT) {
      const res = await sendWebhook(
        JSON.stringify({ event_id: nextEventId(), event: 'read_story', user_id, device_id: SAMPLE_DEVICE, timestamp }),
      )
      expect(res.status, user_id).toBe(202)
    }
  })

  it('a device names the user of its latest event_ts, not of the event that arrived last', async () => {
    const lastArrived = await env.DB.prepare(
      'SELECT user_id FROM app_events WHERE device_id = ? AND user_id IS NOT NULL ORDER BY received_at DESC, rowid DESC LIMIT 1',
    )
      .bind(SAMPLE_DEVICE)
      .first<string>('user_id')
    expect(lastArrived).toBe(STUB)
    const byDevice = await found(SAMPLE_DEVICE)
    expect(byDevice.profile.email).toBe(JOY)
    expect(byDevice.app).toMatchObject({ user_id: 'u_ceed5f12' })
  })

  it('joy by pk_, by her device and by her visitor id: the same body as by email', async () => {
    const byEmail = await found(JOY)
    expect(byEmail.app).toMatchObject({ user_id: 'u_ceed5f12', devices: [SAMPLE_DEVICE] })
    expect(byEmail.app!.events).toHaveLength(1)
    const pkey = await pkeyForEmail(piiKeySecret(), JOY)
    expect(byEmail.profile.pkey).toBe(pkey)
    for (const q of [pkey, SAMPLE_DEVICE, 'v_c9e136fd6d', ` ${pkey} `]) expect(await found(q), q).toEqual(byEmail)
  })

  it('a stub by its pk_ key: the same body as by its u_ id', async () => {
    const pkey = await pkeyForUnknownUser(piiKeySecret(), STUB)
    const byUser = await found(STUB)
    expect(byUser.profile).toMatchObject({ pkey, kind: 'unknown_user_stub', email: null })
    expect(byUser.app).toMatchObject({ user_id: STUB, from_csv: false })
    expect(await found(pkey)).toEqual(byUser)
  })

  it('404 not_found for an unknown pk_, d_ or v_ and for an anonymous visitor', async () => {
    const pkey = await pkeyForEmail(piiKeySecret(), JOY)
    const anonymous = await env.DB.prepare('SELECT email_norm FROM web_visitors WHERE visitor_id = ?')
      .bind('v_569d3a387c')
      .first<{ email_norm: string | null }>()
    expect(anonymous).toEqual({ email_norm: null })
    for (const q of [pkey.slice(0, -1), 'd_4b21e', 'v_c9e136fd6', 'v_569d3a387c']) {
      const res = await lookup(q)
      expect(res.status, q).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found', message: 'No profile matches that email or id.' })
    }
  })
})

describe('T-ING-5 pre-signup views come from the stored signup moment (02 §Linking 2, §Counts)', () => {
  it('signup_ts is set exactly for the 1,400 linked visitors, on their signup_date', async () => {
    const n = (sql: string) => env.DB.prepare(sql).first<number>('n')
    expect(await n('SELECT count(*) AS n FROM web_visitors WHERE signup_ts IS NOT NULL')).toBe(1400)
    expect(
      await n('SELECT count(*) AS n FROM web_visitors WHERE (signup_ts IS NULL) <> (email_norm IS NULL)'),
    ).toBe(0)
    expect(
      await n(
        'SELECT count(*) AS n FROM web_visitors v JOIN subscribers s ON s.email_norm = v.email_norm WHERE substr(v.signup_ts, 1, 10) = s.signup_date',
      ),
    ).toBe(1400)
    // Each signup_ts is one of the visitor's own /subscribe events.
    expect(
      await n(
        "SELECT count(*) AS n FROM web_visitors v WHERE v.signup_ts IS NOT NULL AND NOT EXISTS (SELECT 1 FROM web_events e WHERE e.visitor_id = v.visitor_id AND e.page = '/subscribe' AND e.event_ts = v.signup_ts)",
      ),
    ).toBe(0)
  })

  it('1,144 linked visitors have pre-signup views, 1,930 events in all', async () => {
    const row = await env.DB.prepare(
      'SELECT count(DISTINCT e.visitor_id) AS visitors, count(*) AS events FROM web_events e JOIN web_visitors v ON v.visitor_id = e.visitor_id WHERE e.event_ts < v.signup_ts',
    ).first<{ visitors: number; events: number }>()
    expect(row).toEqual({ visitors: 1144, events: 1930 })
  })
})
