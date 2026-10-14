// GET /api/events/recent (04 §GET /api/events/recent, 06 §/events; R4.10). Mounted at /api by
// worker/index.ts, behind requireSession. The last 20 app events, newest first by received_at,
// each resolved at read time by worker/identity/resolve.ts (01 §Identity resolution): its
// pkey, email and attached_via. /events fetches it on page load, every 5 seconds while its tab is
// visible (src/events-poll.ts POLL_MS) and on Refresh. Nothing is cached (03 §No-restart), so an
// event stored a moment ago is in the next response.
//
// POST /api/events/test (04 §POST /api/events/test, 06 §/events panel, 09 D-73; T-WH-PANEL-*):
// the "Send a test event" panel behind /events. Session, CSRF and body rules come from the
// requireJson + requireSession mount on /api/* in worker/index.ts, the same as every other
// session POST; this route adds its own TEST_EVENT_LIMITER (09 D-70 #6 style: keyed by client,
// not session). Two bodies: `{user_id, event}` builds a fresh event for a real app account
// (user_id must exist in app_users, event one of APP_EVENTS); `{resend: event_id}` re-sends an
// already-stored event's exact body unchanged. Either way the event is signed with
// WEBHOOK_SECRET exactly as a client would and run through POST /webhooks/app itself, in
// process (webhookRoutes.request, worker/routes/webhook.ts) — never a second copy of verify or
// ingest. The secret and signature never leave this function: the response and every log line
// here name only field names, outcomes and ids.

import { Hono } from 'hono'
import { APP_EVENTS, type AppEventName } from '../../shared/app-events'
import { ApiError } from '../auth/middleware'
import { type AppEnv, requireSecret } from '../env'
import { feedEventById, recentEvents } from '../identity/resolve'
import { webhookMac } from '../webhooks/verify'
import { webhookRoutes } from './webhook'

/** 04 §GET /api/events/recent: "the last 20 app events". */
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
  console.warn(JSON.stringify({ at: 'events/test', outcome: 'invalid_body', fields: details.map((d) => d.field) }))
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

/**
 * The account's most recent device from its own app_events rows, else a fresh one (09 D-73).
 * D-73 puts anonymous-device → login stitching out of scope for the panel: a test send must
 * never re-point device_identity at a different account. Reused only when device_identity has
 * no row for that device yet, or already names this same user_id; otherwise (another account
 * now owns it, by a later-or-equal login per the ingest upsert) a fresh device is used instead,
 * so the test event can never rewrite someone else's attribution.
 */
async function deviceForAccount(db: D1Database, userId: string): Promise<string> {
  const device = await db
    .prepare('SELECT device_id FROM app_events WHERE user_id = ? ORDER BY event_ts DESC, rowid DESC LIMIT 1')
    .bind(userId)
    .first<string>('device_id')
  if (device === null) return freshId('d_', 4)
  const owner = await db.prepare('SELECT user_id FROM device_identity WHERE device_id = ?').bind(device).first<string>('user_id')
  if (owner !== null && owner !== userId) return freshId('d_', 4)
  return device
}

eventRoutes.post('/events/test', async (c) => {
  // Its own limit (09 D-70 #6 style), independent of WEBHOOK_LIMITER inside POST /webhooks/app.
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
      device_id: await deviceForAccount(c.env.DB, body.user_id),
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    })
  }

  // Signed exactly as a client would (04 §Webhook headers), then run through the real
  // POST /webhooks/app in process: no second copy of verify or ingest (09 D-73).
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
    // client mistake (CLAUDE.md fail loud); never surface the webhook's own body, which may
    // carry none of our secrets but is not this route's documented shape.
    throw new Error(`events/test: POST /webhooks/app answered ${webhookRes.status} for a self-built event`)
  }
  const webhookBody = await webhookRes.json<{ event_id?: string; duplicate: boolean }>()
  const eventId = webhookBody.event_id ?? (JSON.parse(bodyText) as { event_id: string }).event_id
  const event = await feedEventById(c.env.DB, requireSecret(c.env, 'PII_KEY_SECRET'), eventId)
  if (event === null) throw new Error('events/test: the event was just stored but is missing from the feed')

  const outcome = webhookBody.duplicate ? 'duplicate' : 'received'
  console.info(JSON.stringify({ at: 'events/test', outcome, status: webhookRes.status }))
  return c.json({ status: webhookRes.status, outcome, event }, webhookRes.status as 202 | 200)
})
