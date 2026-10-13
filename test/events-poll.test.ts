import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { TODAY } from '../shared/config'
import { eventsAnnouncement, POLL_MS } from '../src/events-poll'
import type { RecentEvent, RecentEvents } from '../src/types'
import { loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'
import { eventIdPool, sendWebhook } from './helpers/webhook'

// /events polling (06 §/events, §UI principles 7; 16 §If time remains item 2): what the live
// region says after each fetch. The feeds are real answers of GET /api/events/recent on the
// seeded worker (SELF), before and after events sent through the real POST /webhooks/app, and
// the page's own eventsAnnouncement reads them. Inputs as in test/events.test.ts (09 D-11): the
// user is u_c3a64c0a (app_users.csv line 5), the device `d_` + its hex, event ids from
// eventIdPool(), times on TODAY (02 §Time).

const nextEventId = eventIdPool()
let cookie: string

beforeAll(async () => {
  await seedDatabase()
  cookie = await loginCookie()
})

async function feed(): Promise<RecentEvent[]> {
  const res = await SELF.fetch('http://cdp.test/api/events/recent', { headers: { cookie } })
  expect(res.status).toBe(200)
  return (await res.json<RecentEvents>()).events
}

async function send(event: string, time: string): Promise<void> {
  const body = { event_id: nextEventId(), event, user_id: 'u_c3a64c0a', device_id: 'd_c3a64c0a', timestamp: `${TODAY}T${time}Z` }
  expect((await sendWebhook(JSON.stringify(body))).status).toBe(202)
}

const ids = (events: readonly RecentEvent[]) => new Set(events.map((e) => e.event_id))

describe('/events polls every 5 seconds and announces only new events (06 §/events)', () => {
  it('polls every 5 seconds', () => {
    expect(POLL_MS).toBe(5_000)
  })

  it('first load says how many are shown; a poll says only how many are new; nothing new says nothing', async () => {
    const first = await feed()
    expect(eventsAnnouncement(null, first, 'initial')).toBe(`${first.length} ${first.length === 1 ? 'event' : 'events'} shown`)

    await send('app_open', '10:00:00')
    const second = await feed()
    expect(eventsAnnouncement(ids(first), second, 'poll')).toBe('1 new event at the top of the list')

    await send('read_story', '10:01:00')
    await send('link_click', '10:02:00')
    const third = await feed()
    expect(eventsAnnouncement(ids(second), third, 'poll')).toBe('2 new events at the top of the list')

    const fourth = await feed()
    expect(eventsAnnouncement(ids(third), fourth, 'poll')).toBeNull()
    expect(eventsAnnouncement(ids(third), fourth, 'manual')).toBe('No new events')
  })
})
