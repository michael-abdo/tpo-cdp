import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { TODAY } from '../shared/config'
import { pkeyForEmail } from '../shared/pseudonym'
import { loginCookie } from './helpers/auth'
import { piiKeySecret, seedDatabase } from './helpers/seed'
import { eventIdPool, resolvedOf, sendWebhook } from './helpers/webhook'

// Read-time login stitching: T-WH-9a (anonymous events first, login later) and T-WH-9b (login
// first, anonymous events late). T-WH-9c (the shared-device miss) is not built, so not here. Every
// event goes through the real POST /webhooks/app; every check reads the real GET /api/lookup and
// GET /api/events/recent. The test D1 holds the real seed of data/*.csv (test/helpers/seed.ts).
// Inputs and where they come from (brief-shaped payloads built from real ids):
// - users are real app_users.csv rows: u_baba14aa (line 3, daniel.hill389@gmail.com) for 9a and
//   u_3ab82c73 (line 4, faith.wilson277@gmail.com) for 9b; devices are `d_` + the hex of each.
// - event ids come from eventIdPool() (`evt_` + the hex of a real visitor_id).
// - event times are 09:00, 09:05 and 09:10 on TODAY (shared/config.ts; demo events default to
//   TODAY).
// - the read_story property is the brief's story slug.

const AT_0900 = `${TODAY}T09:00:00Z`
const AT_0905 = `${TODAY}T09:05:00Z`
const AT_0910 = `${TODAY}T09:10:00Z`
const STORY = { story: 'supreme-court-ruling-explained' }

const nextEventId = eventIdPool()
let cookie: string

beforeAll(async () => {
  await seedDatabase()
  cookie = await loginCookie()
})

type Body = Record<string, unknown>

/** The three events (app_open, read_story, login) for one user and device, with fixed event ids. */
function sequence(userId: string, deviceId: string) {
  const ids = [nextEventId(), nextEventId(), nextEventId()]
  return {
    appOpen: { event_id: ids[0], event: 'app_open', user_id: null, device_id: deviceId, timestamp: AT_0900 },
    readStory: {
      event_id: ids[1],
      event: 'read_story',
      user_id: null,
      device_id: deviceId,
      timestamp: AT_0905,
      properties: STORY,
    },
    login: { event_id: ids[2], event: 'login', user_id: userId, device_id: deviceId, timestamp: AT_0910 },
  }
}

/** Sends one event (202 expected) and returns who it resolves to right after it is stored. */
async function post(body: Body): Promise<{ user_id: string | null; pkey: string | null }> {
  const res = await sendWebhook(JSON.stringify(body))
  expect(res.status, await res.clone().text()).toBe(202)
  return resolvedOf(body.event_id as string)
}

async function lookup(q: string): Promise<Body> {
  const res = await SELF.fetch(`http://cdp.test/api/lookup?${new URLSearchParams({ q })}`, {
    headers: { cookie },
  })
  expect(res.status).toBe(200)
  return res.json()
}

interface FeedRow {
  event_id: string
  user_id: string | null
  attached_via: string | null
  pkey: string | null
  email: string | null
}

async function feedRow(eventId: string): Promise<FeedRow> {
  const res = await SELF.fetch('http://cdp.test/api/events/recent', { headers: { cookie } })
  expect(res.status).toBe(200)
  const { events } = await res.json<{ events: FeedRow[] }>()
  const row = events.find((e) => e.event_id === eventId)
  if (row === undefined) throw new Error('the event is not in the recent-events feed')
  return row
}

/** The app timeline after the anonymous-first order: both anonymous events stitched, the login direct. */
const STITCHED_TIMELINE = [
  { event: 'app_open', event_ts: AT_0900, properties: null, attached_via: 'login_stitch' },
  { event: 'read_story', event_ts: AT_0905, properties: STORY, attached_via: 'login_stitch' },
  { event: 'login', event_ts: AT_0910, properties: null, attached_via: 'direct' },
]

describe('T-WH-9a 07 §D: anonymous events first, login later', () => {
  it('stores the anonymous events unresolved, then attaches both to the user once the login arrives, tagged stitched', async () => {
    const user = 'u_baba14aa'
    const email = 'daniel.hill389@gmail.com'
    const s = sequence(user, 'd_baba14aa')
    const pkey = await pkeyForEmail(piiKeySecret(), email)

    // 1–2: stored; nothing names the device yet, so each resolves to "anonymous device".
    for (const e of [s.appOpen, s.readStory]) {
      expect(await post(e)).toEqual({ user_id: null, pkey: null })
      expect(await feedRow(e.event_id as string)).toMatchObject({
        user_id: null,
        attached_via: null,
        pkey: null,
        email: null,
      })
    }
    expect((await lookup(user)).app).toMatchObject({ devices: [], events: [] })

    // 3: the login names the device; no stored event is rewritten (resolution is at read time).
    expect(await post(s.login)).toEqual({ user_id: user, pkey })
    const stored = await env.DB.prepare(
      'SELECT event_id, user_id FROM app_events WHERE device_id = ? ORDER BY event_ts',
    )
      .bind('d_baba14aa')
      .all<{ event_id: string; user_id: string | null }>()
    expect(stored.results).toEqual([
      { event_id: s.appOpen.event_id, user_id: null },
      { event_id: s.readStory.event_id, user_id: null },
      { event_id: s.login.event_id, user_id: user },
    ])

    const after = await lookup(user)
    expect(after.app).toMatchObject({ user_id: user, devices: ['d_baba14aa'], events: STITCHED_TIMELINE })
    expect(after.profile).toMatchObject({ pkey, email })
    for (const e of [s.appOpen, s.readStory]) {
      expect(await feedRow(e.event_id as string)).toEqual(
        expect.objectContaining({ user_id: user, attached_via: 'login_stitch', pkey, email }),
      )
    }
    expect(await feedRow(s.login.event_id as string)).toMatchObject({
      user_id: user,
      attached_via: 'direct',
      pkey,
    })
  })
})

describe('T-WH-9b 07 §E: login first, anonymous events late', () => {
  it('gives lookup output identical to 07 §D for the same user, device and events', async () => {
    const user = 'u_3ab82c73'
    const device = 'd_3ab82c73'
    const s = sequence(user, device)
    const pkey = await pkeyForEmail(piiKeySecret(), 'faith.wilson277@gmail.com')

    // The anonymous-first order, and its lookup output.
    for (const e of [s.appOpen, s.readStory, s.login]) await post(e)
    const fromD = await lookup(user)
    expect((fromD.app as Body).events).toEqual(STITCHED_TIMELINE)

    // Back to the state before that order: these three rows and the device mapping are the only rows
    // the sequence wrote (the user is a CSV user, so no stub). The stored score stays as that order
    // left it; the login-first order must recompute it to the same value for the outputs to match.
    const cleared = await env.DB.batch([
      env.DB.prepare('DELETE FROM app_events WHERE device_id = ?').bind(device),
      env.DB.prepare('DELETE FROM device_identity WHERE device_id = ?').bind(device),
    ])
    expect(cleared.map((r) => r.meta.changes)).toEqual([3, 1])
    expect((await lookup(user)).app).toMatchObject({ devices: [], events: [] })

    // The login arrives first; each late anonymous event resolves the moment it is stored.
    expect(await post(s.login)).toEqual({ user_id: user, pkey })
    expect(await post(s.appOpen)).toEqual({ user_id: user, pkey })
    expect(await post(s.readStory)).toEqual({ user_id: user, pkey })

    expect(await lookup(user)).toEqual(fromD)
  })
})
