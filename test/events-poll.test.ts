import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { TODAY } from '../shared/config'
import { RECENT_EVENTS_LIMIT } from '../worker/routes/events'
import { eventsAnnouncement, POLL_MS } from '../src/events-poll'
import type { RecentEvent, RecentEvents } from '../src/types'
import { loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'
import { eventIdPool, sendWebhook } from './helpers/webhook'

// /events polling: what the live
// region says after each fetch. The feeds are real answers of GET /api/events/recent on the
// seeded worker (SELF), before and after events sent through the real POST /webhooks/app, and
// the page's own eventsAnnouncement reads them. Inputs as in test/events.test.ts: the
// user is u_c3a64c0a (app_users.csv line 5), the device `d_` + its hex, event ids from
// eventIdPool(), times on TODAY.

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

describe('/events polls every 5 seconds and announces only new events', () => {
  it('polls every 5 seconds', () => {
    expect(POLL_MS).toBe(5_000)
  })

  it('first load says how many are shown; a poll on the full 20-event list says only how many are new; nothing new says nothing', async () => {
    // The list is normally full (RECENT_EVENTS_LIMIT), so new events push
    // old ones off the end and the count on screen stays the same: fill it before the first load.
    expect(await feed()).toHaveLength(0)
    for (let i = 0; i < RECENT_EVENTS_LIMIT; i++) await send('read_story', `09:${String(i).padStart(2, '0')}:00`)
    const first = await feed()
    expect(first).toHaveLength(RECENT_EVENTS_LIMIT)
    expect(eventsAnnouncement(null, first, 'initial')).toBe('20 events shown')

    await send('app_open', '10:00:00')
    const second = await feed()
    expect(second).toHaveLength(RECENT_EVENTS_LIMIT)
    expect(eventsAnnouncement(ids(first), second, 'poll')).toBe('1 new event at the top of the list')

    await send('read_story', '10:01:00')
    await send('link_click', '10:02:00')
    const third = await feed()
    expect(third).toHaveLength(RECENT_EVENTS_LIMIT)
    expect(eventsAnnouncement(ids(second), third, 'poll')).toBe('2 new events at the top of the list')
    // A manual Refresh that finds new events says so, never "No new events".
    expect(eventsAnnouncement(ids(second), third, 'manual')).toBe('2 new events at the top of the list')

    const fourth = await feed()
    expect(eventsAnnouncement(ids(third), fourth, 'poll')).toBeNull()
    expect(eventsAnnouncement(ids(third), fourth, 'manual')).toBe('No new events')
  })

  it('an empty list on first load says 0 events shown', () => {
    expect(eventsAnnouncement(null, [], 'initial')).toBe('0 events shown')
  })

  it("a 'sent' fetch says nothing even with a new row, since the panel's own result line already named the outcome; 'poll' with the same input still speaks", async () => {
    const shown = await feed()
    await send('app_open', '11:00:00')
    const withNew = await feed()
    expect(eventsAnnouncement(ids(shown), withNew, 'sent')).toBeNull()
    expect(eventsAnnouncement(ids(shown), withNew, 'poll')).toBe('1 new event at the top of the list')
  })
})
