// GET /api/events/recent. Mounted at /api by worker/index.ts, behind requireSession. The last 20
// app events, newest first by received_at, each resolved at read time by
// worker/identity/resolve.ts: its pkey, email and attached_via. /events fetches it on page load,
// every 5 seconds while its tab is visible (src/events-poll.ts POLL_MS) and on Refresh. Nothing
// is cached, so an event stored a moment ago is in the next response, with no restart.
//
// POST /api/events/test (T-WH-PANEL-*): the "Send a test event" panel behind /events, so a
// reviewer can prove live events work without a terminal. Session, CSRF and body rules come from
// the requireJson + requireSession mount on /api/* in worker/index.ts, the same as every other
// session POST; this route adds its own TEST_EVENT_LIMITER (keyed by client, not session, so a
// new sign-in does not reset it). Two bodies: `{user_id, event}` builds a fresh event for a real
// app account (user_id must exist in app_users, event one of APP_EVENTS, timestamp =
// demoTimestamp(), a fresh `d_` device id on every send, so a test event can never
// touch a real device's identity); `{resend: event_id}` re-sends an already-stored event's
// exact body unchanged, device_id included, so a resend keeps the stored device. Either way
// the event is signed with WEBHOOK_SECRET exactly as a client would and run through
// POST /webhooks/app itself, in process (webhookRoutes.request, worker/routes/webhook.ts) —
// never a second copy of verify or ingest. The secret and signature never leave this function:
// the response and every log line here name only field names, outcomes and ids.

import { Hono } from 'hono'
import { APP_EVENTS, type AppEventName } from '../../shared/app-events'
import { demoTimestamp } from '../../shared/demo-timestamp'
import { ApiError } from '../auth/middleware'
import { type AppEnv, requireSecret } from '../env'
import { feedEventById, recentEvents } from '../identity/resolve'
import { webhookMac } from '../webhooks/verify'
import { webhookRoutes } from './webhook'

/** GET /api/events/recent returns the last 20 app events. */
export const RECENT_EVENTS_LIMIT = 20

export const eventRoutes = new Hono<AppEnv>()

eventRoutes.get('/events/recent', async (c) => {
  const events = await recentEvents(c.env.DB, requireSecret(c.env, 'PII_KEY_SECRET'), RECENT_EVENTS_LIMIT)
  return c.json({ events })
})

type TestEventBody =
  | { kind: 'new'; user_id: string; event: AppEventName }
  | { kind: 'resend'; event_id: string }

const TEST_EVENT_MESSAGE =
  'Send { user_id, event } to build a new test event, or { resend: "<event_id>" } to send that one again.'

function invalidTestEvent(details: { field: string; issue: string }[]): ApiError {
  // An unknown field's name is client text (it could be an email), so the log counts those and names only known fields.
  const unknownCount = details.filter((d) => d.issue.startsWith('unknown field')).length
  const fields = details.filter((d) => !d.issue.startsWith('unknown field')).map((d) => d.field)
  console.warn(JSON.stringify({ at: 'events/test', outcome: 'invalid_body', fields, unknown_fields: unknownCount }))
  return new ApiError(400, 'invalid_body', TEST_EVENT_MESSAGE, details)
}

/** Parses and shape-checks the body; never touches the database (that is the caller's 400s). */
async function readTestEventBody(req: Request): Promise<TestEventBody> {
  let parseError: string | undefined
  const raw: unknown = await req.json().catch((err: unknown) => {
    parseError = err instanceof Error ? err.name : 'unknown' // the class name only; never the body text
    return undefined
  })
  if (parseError !== undefined) throw invalidTestEvent([{ field: 'body', issue: `body is not JSON: ${parseError}` }])
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalidTestEvent([{ field: 'body', issue: 'body must be a JSON object' }])
  }
  const body = raw as Record<string, unknown>

  if ('resend' in body) {
    const extra = Object.keys(body).filter((k) => k !== 'resend')
    if (extra.length > 0) throw invalidTestEvent(extra.map((k) => ({ field: k, issue: 'unknown field alongside resend' })))
    if (typeof body.resend !== 'string' || body.resend.length === 0) {
      throw invalidTestEvent([{ field: 'resend', issue: 'must be the event_id string of an event already sent' }])
    }
    return { kind: 'resend', event_id: body.resend }
  }

  const extra = Object.keys(body).filter((k) => k !== 'user_id' && k !== 'event')
  if (extra.length > 0) throw invalidTestEvent(extra.map((k) => ({ field: k, issue: 'unknown field' })))
  if (typeof body.user_id !== 'string' || body.user_id.length === 0) {
    throw invalidTestEvent([{ field: 'user_id', issue: 'must be a non-empty app account id' }])
  }
  if (typeof body.event !== 'string' || !(APP_EVENTS as readonly string[]).includes(body.event)) {
    throw invalidTestEvent([{ field: 'event', issue: `must be one of ${APP_EVENTS.join(', ')}` }])
  }
  return { kind: 'new', user_id: body.user_id, event: body.event as AppEventName }
}

interface StoredEventRow {
  event_id: string
  event: string
  user_id: string | null
  device_id: string
  event_ts: string
  properties: string | null
}

/** The exact stored body of one app event, for "Send again"; null when no event has this id. */
async function storedEventBody(db: D1Database, eventId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT event_id, event, user_id, device_id, event_ts, properties FROM app_events WHERE event_id = ?')
    .bind(eventId)
    .first<StoredEventRow>()
  if (row === null) return null
  return JSON.stringify({
    event_id: row.event_id,
    event: row.event,
    user_id: row.user_id,
    device_id: row.device_id,
    timestamp: row.event_ts,
    ...(row.properties === null ? {} : { properties: JSON.parse(row.properties) }),
  })
}

/** `prefix` + `bytes` fresh random bytes as hex (Web Crypto; no node:crypto in a Worker). */
function freshId(prefix: string, bytes: number): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes))
  return prefix + [...random].map((b) => b.toString(16).padStart(2, '0')).join('')
}

eventRoutes.post('/events/test', async (c) => {
  // Its own per-client limit, independent of WEBHOOK_LIMITER inside POST /webhooks/app.
  const clientKey = c.req.header('cf-connecting-ip') ?? 'local'
  const { success } = await c.env.TEST_EVENT_LIMITER.limit({ key: clientKey })
  if (!success) {
    console.warn(JSON.stringify({ at: 'events/test', outcome: 'rate_limited' }))
    throw new ApiError(429, 'rate_limited', 'Too many test events from this network in the last minute. Wait a minute and try again.')
  }

  const body = await readTestEventBody(c.req.raw)

  let bodyText: string
  if (body.kind === 'resend') {
    const stored = await storedEventBody(c.env.DB, body.event_id)
    if (stored === null) {
      throw invalidTestEvent([{ field: 'resend', issue: 'must be the event_id string of an event already sent' }])
    }
    bodyText = stored
  } else {
    const known = await c.env.DB.prepare('SELECT 1 FROM app_users WHERE user_id = ?').bind(body.user_id).first()
    if (known === null) {
      throw invalidTestEvent([{ field: 'user_id', issue: 'must be the id of a known app account' }])
    }
    bodyText = JSON.stringify({
      event_id: freshId('evt_', 8),
      event: body.event,
      user_id: body.user_id,
      // Always fresh: a test send must never re-point an
      // existing device's identity, real or anonymous, at this account or any other.
      // 8 bytes (64 bits), not 4: a fresh id must not collide with an existing device and
      // silently stitch that device's events to this account.
      device_id: freshId('d_', 8),
      timestamp: demoTimestamp(),
    })
  }

  // Signed exactly as a client would, then run through the real
  // POST /webhooks/app in process: no second copy of verify or ingest, so the panel proves the real path.
  const timestamp = String(Math.floor(Date.now() / 1000))
  const mac = await webhookMac(requireSecret(c.env, 'WEBHOOK_SECRET'), timestamp, new TextEncoder().encode(bodyText))
  const signature = 'v1=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  const webhookRes = await webhookRoutes.request(
    '/app',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': signature,
        'cf-connecting-ip': clientKey,
      },
      body: bodyText,
    },
    c.env,
  )

  if (webhookRes.status !== 202 && webhookRes.status !== 200) {
    // This route builds and signs the event itself, so any other answer is a server bug, not a
    // client mistake (fail loud); never surface the webhook's own body, which may
    // carry none of our secrets but is not this route's documented shape.
    throw new Error(`events/test: POST /webhooks/app answered ${webhookRes.status} for a self-built event`)
  }
  // The public webhook answer names no person, so who the event resolves to is read here, behind
  // the session, from the feed (worker/identity/resolve.ts), by the event_id this route built.
  const eventId = (JSON.parse(bodyText) as { event_id: string }).event_id
  const event = await feedEventById(c.env.DB, requireSecret(c.env, 'PII_KEY_SECRET'), eventId)
  if (event === null) throw new Error('events/test: the event was just stored but is missing from the feed')

  const outcome = webhookRes.status === 200 ? 'duplicate' : 'received'
  console.info(JSON.stringify({ at: 'events/test', outcome, status: webhookRes.status }))
  return c.json({ status: webhookRes.status, outcome, event }, webhookRes.status as 202 | 200)
})
