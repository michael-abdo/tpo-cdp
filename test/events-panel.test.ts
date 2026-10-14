/// <reference types="vite/client" />
import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { TODAY } from '../shared/config'
import { demoTimestamp } from '../shared/demo-timestamp'
import { webhookRoutes } from '../worker/routes/webhook'
import wranglerConfig from '../wrangler.jsonc?raw'
import { documentationIp, loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'
import { sendWebhook, signature as independentSignature, webhookSecret } from './helpers/webhook'

// POST /api/events/test (04 §POST /api/events/test, 06 §/events panel, 09 D-73): the "Send a
// test event" panel's server route. T-WH-PANEL-1..12 (08). The test D1 holds the real seed of
// data/*.csv (test/helpers/seed.ts); no network.
// Inputs (09 D-11, D-47: real ids, minimal edits for the refusal paths):
// - u_2b6447a3 is julia.evans230@gmail.com (app_users.csv:2, 02 §Counts demo subject): a real
//   app account with no app_events rows yet in this file.
// - u_09acb8a4 is an app-only user (02 §Counts); u_does_not_exist occurs nowhere in data/*.csv
//   (09 D-47: a real-shaped id that is simply not one of the real ones).
const KNOWN_USER = 'u_2b6447a3'
const KNOWN_USER_EMAIL = 'julia.evans230@gmail.com'
const UNKNOWN_USER_ID = 'u_does_not_exist'

let cookie: string

beforeAll(async () => {
  await seedDatabase()
  cookie = await loginCookie()
})

interface TestEventResponse {
  status: 202 | 200
  outcome: 'received' | 'duplicate'
  event: {
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
}

async function sendTest(body: Record<string, unknown>, sessionCookie = cookie, ip = documentationIp()): Promise<Response> {
  return SELF.fetch('http://cdp.test/api/events/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sessionCookie, 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  })
}

async function recent(): Promise<TestEventResponse['event'][]> {
  const res = await SELF.fetch('http://cdp.test/api/events/recent', { headers: { cookie } })
  expect(res.status).toBe(200)
  return (await res.json<{ events: TestEventResponse['event'][] }>()).events
}

function bindingLimit(name: string): number {
  const match = new RegExp(`"name": "${name}"[^}]*"limit": (\\d+), "period": 60`).exec(wranglerConfig)
  if (match === null) throw new Error(`wrangler.jsonc has no 60 s ratelimits binding named ${name}`)
  return Number(match[1])
}

describe('POST /api/events/test (09 D-73)', () => {
  it('T-WH-PANEL-1: 401 without a session cookie', async () => {
    const res = await sendTest({ user_id: KNOWN_USER, event: 'app_open' }, '')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Sign in to continue.' })
  })

  it('T-WH-PANEL-2: 400 for an unknown user_id', async () => {
    const res = await sendTest({ user_id: UNKNOWN_USER_ID, event: 'app_open' })
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string; details: { field: string }[] }>()
    expect(body.error).toBe('invalid_body')
    expect(body.details).toEqual([{ field: 'user_id', issue: expect.stringContaining('known app account') }])
    // No app_events row was written for a rejected send.
    expect(await env.DB.prepare('SELECT count(*) AS n FROM app_events WHERE user_id = ?').bind(UNKNOWN_USER_ID).first<number>('n')).toBe(0)
  })

  it('T-WH-PANEL-3: 400 for an event outside APP_EVENTS', async () => {
    const res = await sendTest({ user_id: KNOWN_USER, event: 'purchase' })
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string; details: { field: string; issue: string }[] }>()
    expect(body.error).toBe('invalid_body')
    expect(body.details).toEqual([{ field: 'event', issue: expect.stringContaining('app_open, read_story, link_click, login') }])
  })

  it('T-WH-PANEL-4: 202 received; the row is then first in /api/events/recent with the chosen account and event', async () => {
    const res = await sendTest({ user_id: KNOWN_USER, event: 'read_story' })
    expect(res.status).toBe(202)
    const body = await res.json<TestEventResponse>()
    expect(body.status).toBe(202)
    expect(body.outcome).toBe('received')
    expect(body.event).toMatchObject({
      event: 'read_story',
      user_id: KNOWN_USER,
      attached_via: 'direct',
      email: KNOWN_USER_EMAIL,
    })
    expect(body.event.event_id).toMatch(/^evt_[0-9a-f]+$/)
    // 8 random bytes (16 hex chars), not fewer (09 D-73 amended, round-4 fixer): a short id can
    // collide with an existing device (real or anonymous) and silently re-point its identity.
    expect(body.event.device_id).toMatch(/^d_[0-9a-f]{16}$/)
    // 09 D-01 / 02 §Time: a demo event's timestamp is TODAY (shared/config.ts) plus the current
    // UTC time of day, never wall-clock "now" — a mutant that used `new Date().toISOString()`
    // directly would date the event after TODAY and fails this. The time-of-day half is also
    // pinned exactly, with a fake clock, in the "demoTimestamp" describe block below.
    expect(body.event.event_ts).toMatch(new RegExp(`^${TODAY}T\\d{2}:\\d{2}:\\d{2}Z$`))
    const sentAt = Math.floor(Date.now() / 1000)
    const [, hh, mm, ss] = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})Z$/.exec(body.event.event_ts) as RegExpExecArray
    const eventSeconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss)
    const nowSeconds = sentAt % 86400
    // Within a few seconds of the real UTC clock (not a frozen or stale time of day); wraps at
    // midnight UTC are not exercised by this suite's run time, so a plain difference is enough.
    expect(Math.abs(eventSeconds - nowSeconds)).toBeLessThanOrEqual(5)
    const [first] = await recent()
    expect(first).toEqual(body.event)
  })

  it('T-WH-PANEL-4b: a second send for the same account gets a fresh device, not the first send\'s (D-73 amended 2026-10-14: device reuse dropped)', async () => {
    const first = await (await sendTest({ user_id: KNOWN_USER, event: 'app_open' })).json<TestEventResponse>()
    const second = await (await sendTest({ user_id: KNOWN_USER, event: 'login' })).json<TestEventResponse>()
    expect(second.event.device_id).not.toBe(first.event.device_id)
    expect(second.event.device_id).toMatch(/^d_[0-9a-f]{16}$/)
  })

  it('T-WH-PANEL-5: Send again (resend) answers 200 duplicate and leaves app_events unchanged', async () => {
    const sent = await (await sendTest({ user_id: KNOWN_USER, event: 'link_click' })).json<TestEventResponse>()
    const before = await env.DB.prepare('SELECT count(*) AS n FROM app_events').first<number>('n')

    const res = await sendTest({ resend: sent.event.event_id })
    expect(res.status).toBe(200)
    const body = await res.json<TestEventResponse>()
    expect(body.status).toBe(200)
    expect(body.outcome).toBe('duplicate')
    expect(body.event).toEqual(sent.event) // the identical stored row, unchanged by the resend

    const after = await env.DB.prepare('SELECT count(*) AS n FROM app_events').first<number>('n')
    expect(after).toBe(before)
  })

  it('T-WH-PANEL-5b: a resend sends the inner webhook exactly the stored row, no more and no less (kills M14: a dropped properties spread; M15: user_id sent as null)', async () => {
    // Spies on the inner POST /webhooks/app call the same way T-WH-PANEL-10's own runtime-proof
    // test does, so this is a live assertion on what the route actually sent, not just on its
    // response body.
    const sent = await (await sendTest({ user_id: KNOWN_USER, event: 'read_story' })).json<TestEventResponse>()
    const row = await env.DB.prepare('SELECT user_id, device_id, event_ts, properties FROM app_events WHERE event_id = ?')
      .bind(sent.event.event_id)
      .first<{ user_id: string | null; device_id: string; event_ts: string; properties: string | null }>()
    expect(row).not.toBeNull()

    const spy = vi.spyOn(webhookRoutes, 'request')
    try {
      const res = await sendTest({ resend: sent.event.event_id })
      expect(res.status).toBe(200)
      expect(spy).toHaveBeenCalledTimes(1)
      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(init.body as string) as Record<string, unknown>
      expect(sentBody).toEqual({
        event_id: sent.event.event_id,
        event: sent.event.event,
        user_id: row?.user_id,
        device_id: row?.device_id,
        timestamp: row?.event_ts,
        // No properties key at all for this event: storedEventBody() omits it when null,
        // never sends a literal `null` (M15-adjacent: that would still be a changed shape).
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('T-WH-PANEL-5c: a resend of an event with non-null properties sends them back unchanged (kills M14: a dropped properties spread)', async () => {
    // A real app account (KNOWN_USER) sending a real-shaped read_story event with a properties
    // story slug (09 D-11/D-47, 09 D-70 #2's own slug pattern), through the real webhook so the
    // row is genuinely stored, not constructed by hand.
    const eventId = 'evt_panel5c_props'
    const sentOnce = await sendWebhook(
      JSON.stringify({
        event_id: eventId,
        event: 'read_story',
        user_id: KNOWN_USER,
        device_id: 'd_panel5c',
        timestamp: '2026-09-27T00:00:00Z',
        properties: { story: 'supreme-court-ruling-explained' },
      }),
    )
    expect(sentOnce.status).toBe(202)

    const spy = vi.spyOn(webhookRoutes, 'request')
    try {
      const res = await sendTest({ resend: eventId })
      expect(res.status).toBe(200)
      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(init.body as string) as { properties?: unknown }
      expect(sentBody.properties).toEqual({ story: 'supreme-court-ruling-explained' })
    } finally {
      spy.mockRestore()
    }
  })

  it('T-WH-PANEL-5b: resend of an unknown event_id is 400, not a crash', async () => {
    const res = await sendTest({ resend: 'evt_not_a_real_one' })
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string; details: { field: string }[] }>()
    expect(body.error).toBe('invalid_body')
    expect(body.details).toEqual([{ field: 'resend', issue: expect.stringContaining('already sent') }])
  })

  it('T-WH-PANEL-6: an unknown field, a non-string resend, and an array/non-object body are each 400', async () => {
    expect((await sendTest({ user_id: KNOWN_USER, event: 'app_open', properties: {} })).status).toBe(400)
    expect((await sendTest({ resend: 123 as unknown as string })).status).toBe(400)
    expect((await sendTest({ resend: 'evt_x', user_id: KNOWN_USER })).status).toBe(400)
    const res = await SELF.fetch('http://cdp.test/api/events/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '[]',
    })
    expect(res.status).toBe(400)
  })

  it('T-WH-PANEL-7: the response body, and every log line this route writes, never carry WEBHOOK_SECRET or a "v1=" signature', async () => {
    const logged: string[] = []
    const origWarn = console.warn
    const origInfo = console.info
    console.warn = (...args: unknown[]) => logged.push(args.map(String).join(' '))
    console.info = (...args: unknown[]) => logged.push(args.map(String).join(' '))
    try {
      const res = await sendTest({ user_id: KNOWN_USER, event: 'app_open' })
      const text = await res.text()
      expect(text).not.toContain(env.WEBHOOK_SECRET)
      expect(text).not.toMatch(/v1=[0-9a-f]{64}/)
      expect(text.toLowerCase()).not.toContain('signature')
      for (const line of logged) {
        expect(line).not.toContain(env.WEBHOOK_SECRET)
        expect(line).not.toMatch(/v1=[0-9a-f]{64}/)
      }
    } finally {
      console.warn = origWarn
      console.info = origInfo
    }
  })

  it('T-WH-PANEL-8a: TEST_EVENT_LIMITER is 20/min, exactly as 04 §POST /api/events/test documents it (kills M7d: a quietly widened binding)', () => {
    expect(bindingLimit('TEST_EVENT_LIMITER')).toBe(20)
  })

  it('T-WH-PANEL-8: 429 past its own limit, and a new session from the same address is still 429 (09 D-70 #6 style)', async () => {
    const limit = bindingLimit('TEST_EVENT_LIMITER')
    const ip = documentationIp()
    const first = await loginCookie(ip)
    for (let i = 0; i < limit; i++) {
      expect((await sendTest({ user_id: KNOWN_USER, event: 'app_open' }, first, ip)).status).toBe(202)
    }
    const relogin = await loginCookie(ip)
    const limited = await sendTest({ user_id: KNOWN_USER, event: 'app_open' }, relogin, ip)
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' })
    // Another address is not limited by this one.
    expect((await sendTest({ user_id: KNOWN_USER, event: 'app_open' }, first, documentationIp())).status).toBe(202)
  })

  it('T-WH-PANEL-9: two sends for the same account each get their own fresh device, never one already in app_events', async () => {
    const user = 'u_3ab82c73' // faith.wilson277@gmail.com (app_users.csv): untouched by the tests above
    await env.DB.prepare(
      `INSERT INTO app_events (event_id, event, user_id, device_id, event_ts, received_at)
       VALUES ('evt_panel9a', 'app_open', ?, 'd_existing9', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    )
      .bind(user)
      .run()
    const first = await (await sendTest({ user_id: user, event: 'login' })).json<TestEventResponse>()
    const second = await (await sendTest({ user_id: user, event: 'app_open' })).json<TestEventResponse>()
    for (const id of [first.event.device_id, second.event.device_id]) expect(id).toMatch(/^d_[0-9a-f]{16}$/)
    expect(first.event.device_id).not.toBe('d_existing9')
    expect(second.event.device_id).not.toBe('d_existing9')
    expect(second.event.device_id).not.toBe(first.event.device_id)
  })

  it('T-WH-PANEL-9b: never moves device ownership to a different account (D-73 out of scope)', async () => {
    // A then B logs in on the same shared device, then an anonymous event on it resolves to B
    // via login_stitch (the device's most recent identified user, by event_ts). A panel send for
    // A must not touch that shared device at all (fresh device on every send, D-73 amended
    // 2026-10-14): re-pointing it would silently re-attribute B's own anonymous event to A,
    // exactly the live bug this route must never reintroduce. Two accounts untouched elsewhere in
    // this file (09 D-11, app_users.csv): u_baba14aa (daniel.hill389), u_c0d06d19 (leah.stewart812).
    const userA = 'u_baba14aa'
    const userB = 'u_c0d06d19'
    const send = async (eventId: string, event: string, userId: string | null, ts: string) => {
      const res = await sendWebhook(
        JSON.stringify({ event_id: eventId, event, user_id: userId, device_id: 'd_shared9b', timestamp: ts }),
      )
      expect(res.status).toBe(202)
    }
    await send('evt_panel9b_a_open', 'app_open', userA, '2026-09-01T00:00:00Z')
    await send('evt_panel9b_b_login', 'login', userB, '2026-09-10T00:00:00Z')
    await send('evt_panel9b_anon_read', 'read_story', null, '2026-09-11T00:00:00Z')

    const res = await sendTest({ user_id: userA, event: 'login' })
    expect(res.status).toBe(202)
    const body = await res.json<TestEventResponse>()
    // A gets a fresh device, never the shared one B now owns.
    expect(body.event.device_id).not.toBe('d_shared9b')

    const owner = await env.DB.prepare('SELECT user_id FROM device_identity WHERE device_id = ?').bind('d_shared9b').first<string>('user_id')
    expect(owner).toBe(userB)
    const anonResolved = (await recent()).find((e) => e.event_id === 'evt_panel9b_anon_read')
    expect(anonResolved).toMatchObject({ user_id: userB, attached_via: 'login_stitch' })
  })
})

// demoTimestamp() (shared/demo-timestamp.ts, imported by both the panel route and
// scripts/send-webhook.ts, D-72 one home): TODAY plus the CURRENT UTC time of day, never a
// frozen or dropped time of day. T-WH-PANEL-4 above only checks `startsWith(TODAY)`, which a
// mutant returning `${TODAY}T00:00:00Z` would still pass; this fakes the clock so the time-of-day
// half is pinned exactly, independent of 02 §Time's wall-clock allow-list / 09 D-01.
describe('demoTimestamp (shared/demo-timestamp.ts; 02 §Time, 09 D-01/D-73 amended 2026-10-14)', () => {
  it('returns TODAY at the exact faked UTC time of day, not midnight and not real "now"', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-14T16:23:36.789Z'))
      expect(demoTimestamp()).toBe(`${TODAY}T16:23:36Z`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('scripts/send-webhook.ts imports demoTimestamp from shared/demo-timestamp and defines no copy of its own (D-72 one home)', () => {
    const code = import.meta.glob<string>('../scripts/send-webhook.ts', { query: '?raw', import: 'default', eager: true })
    const text = code['../scripts/send-webhook.ts']
    expect(text).toMatch(/import \{ demoTimestamp \} from '\.\.\/shared\/demo-timestamp'/)
    expect(text).not.toMatch(/function demoTimestamp/)
  })
})

// T-WH-PANEL-10: no second copy of verify or ingest (09 D-73's own rule). A mutant that skips
// signing or verify, or swaps the real POST /webhooks/app call for a direct ingestEvent call,
// is caught two ways: (1) here, statically — the route must call the real webhookRoutes.request
// and the shared webhookMac, and must never call ingestEvent or verifyWebhook itself; (2)
// dynamically — T-WH-PANEL-4/4b/5 above fail loud (500, not 202/200) the moment the inner
// POST /webhooks/app call stops answering 202 or 200, which is exactly what a broken signature
// or a skipped verify produces, since this route throws on any other status from that call.
describe('T-WH-PANEL-10: the panel reuses verify and ingest, it never re-implements either', () => {
  const code = import.meta.glob<string>('../worker/routes/events.ts', { query: '?raw', import: 'default', eager: true })

  it('scans the real file, not an empty glob', () => {
    expect(Object.keys(code)).toEqual(['../worker/routes/events.ts'])
  })

  it('imports webhookMac and webhookRoutes, calls webhookRoutes.request, and defines neither ingestEvent nor verifyWebhook itself', () => {
    const text = code['../worker/routes/events.ts']
    expect(text).toMatch(/import \{ webhookMac \} from '\.\.\/webhooks\/verify'/)
    expect(text).toMatch(/import \{ webhookRoutes \} from '\.\/webhook'/)
    expect(text).toContain('webhookRoutes.request(')
    expect(text).not.toMatch(/\bingestEvent\(/)
    expect(text).not.toMatch(/\bverifyWebhook\(/)
    expect(text).not.toMatch(/crypto\.subtle\.sign\(/) // the HMAC math stays in webhookMac
    // Tighter than the above: no import of the ingest module or its parser at all, and no raw
    // INSERT into app_events — a mutant could otherwise satisfy the regexes above with a second,
    // differently-named copy of the same logic.
    expect(text).not.toMatch(/from '\.\.\/webhooks\/ingest'/)
    expect(text).not.toMatch(/\bparseWebhookEvent\b/)
    expect(text).not.toMatch(/INSERT\s+(OR\s+\w+\s+)?INTO\s+app_events/i)
  })

  it('fails loud on any status but 202/200 from the inner webhook call, so a broken signature cannot pass silently', () => {
    const text = code['../worker/routes/events.ts']
    expect(text).toMatch(/webhookRes\.status !== 202 && webhookRes\.status !== 200/)
    expect(text).toMatch(/throw new Error\(`events\/test: POST \/webhooks\/app answered/)
  })

  it('runtime proof: a Send logs the real webhook route\'s own "stored" line, a Send again its own "duplicate" line', async () => {
    const logged: string[] = []
    const origInfo = console.info
    console.info = (...args: unknown[]) => logged.push(args.map(String).join(' '))
    try {
      const sent = await (await sendTest({ user_id: KNOWN_USER, event: 'app_open' })).json<TestEventResponse>()
      expect(logged.some((l) => l.includes('"at":"webhook"') && l.includes('"outcome":"stored"') && l.includes('"status":202'))).toBe(true)
      logged.length = 0
      await sendTest({ resend: sent.event.event_id })
      expect(logged.some((l) => l.includes('"at":"webhook"') && l.includes('"outcome":"duplicate"') && l.includes('"status":200'))).toBe(true)
    } finally {
      console.info = origInfo
    }
  })

  it('runtime proof, not just text: the signature the route actually sends equals the independent signer\'s over the same timestamp and body (catches a mutant that keeps the real webhookMac import but stops using its output, e.g. a hard-coded zero signature paired with a verify-skipping header)', async () => {
    const spy = vi.spyOn(webhookRoutes, 'request')
    try {
      const res = await sendTest({ user_id: KNOWN_USER, event: 'app_open' })
      expect(res.status).toBe(202)
      expect(spy).toHaveBeenCalledTimes(1)
      const [path, init] = spy.mock.calls[0] as [string, RequestInit]
      expect(path).toBe('/app')
      const headers = init.headers as Record<string, string>
      const ts = headers['x-webhook-timestamp']
      const sentSignature = headers['x-webhook-signature']
      expect(ts).toMatch(/^\d+$/)
      expect(sentSignature).toMatch(/^v1=[0-9a-f]{64}$/)
      const bodyBytes =
        typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array(init.body as ArrayBuffer)
      const expected = await independentSignature(webhookSecret(), ts, bodyBytes)
      expect(sentSignature).toBe(expected) // not merely well-formed: it matches the real secret and body
    } finally {
      spy.mockRestore()
    }
  })
})

describe('T-WH-PANEL-11: fails loud when the inner webhook refuses a self-built resend', () => {
  it('a resend whose stored event_ts now lies beyond the 24h future bound (09 D-70 #3) is a 500 internal_error, logged with the inner status', async () => {
    // A real app_users id (09 D-47), a fresh row with only the timestamp edited to break the
    // webhook's own future bound: storedEventBody() rebuilds the body from this row unchanged,
    // so the inner POST /webhooks/app now refuses it with 400, and this route must not swallow
    // that refusal as a success.
    const futureTs = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    await env.DB.prepare(
      `INSERT INTO app_events (event_id, event, user_id, device_id, event_ts, received_at)
       VALUES ('evt_panel11_future', 'app_open', ?, 'd_panel11_future', ?, ?)`,
    )
      .bind(KNOWN_USER, futureTs, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
      .run()

    const logged: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '))
    try {
      const res = await sendTest({ resend: 'evt_panel11_future' })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'internal_error', message: 'Something went wrong on the server. The error has been logged.' })
      expect(
        logged.some(
          (l) => l.includes('"at":"unhandled"') && l.includes('events/test: POST /webhooks/app answered'),
        ),
      ).toBe(true)
    } finally {
      console.error = origError
    }
  })
})

describe('T-WH-PANEL-12: the same CSRF/body rules as every other session POST (09 D-73)', () => {
  it('a non-JSON content type is 415 unsupported_media_type, and nothing is written', async () => {
    const before = await env.DB.prepare('SELECT count(*) AS n FROM app_events').first<number>('n')
    const res = await SELF.fetch('http://cdp.test/api/events/test', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie, 'cf-connecting-ip': documentationIp() },
      body: JSON.stringify({ user_id: KNOWN_USER, event: 'app_open' }),
    })
    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({ error: 'unsupported_media_type' })
    const after = await env.DB.prepare('SELECT count(*) AS n FROM app_events').first<number>('n')
    expect(after).toBe(before)
  })
})
