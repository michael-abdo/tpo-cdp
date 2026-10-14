// GET /api/events/recent (04 §GET /api/events/recent, 06 §/events; R4.10). Mounted at /api by
// worker/index.ts, behind requireSession. The last 20 app events, newest first by received_at,
// each resolved at read time by worker/identity/resolve.ts (01 §Identity resolution): its
// pkey, email and attached_via. /events fetches it on page load, every 5 seconds while its tab is
// visible (src/events-poll.ts POLL_MS) and on Refresh. Nothing is cached (03 §No-restart), so an
// event stored a moment ago is in the next response.

import { Hono } from 'hono'
import { type AppEnv, requireSecret } from '../env'
import { recentEvents } from '../identity/resolve'

/** 04 §GET /api/events/recent: "the last 20 app events". */
export const RECENT_EVENTS_LIMIT = 20

export const eventRoutes = new Hono<AppEnv>()

eventRoutes.get('/events/recent', async (c) => {
  const events = await recentEvents(c.env.DB, requireSecret(c.env, 'PII_KEY_SECRET'), RECENT_EVENTS_LIMIT)
  return c.json({ events })
})
