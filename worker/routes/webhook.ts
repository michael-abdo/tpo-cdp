// POST /webhooks/app (04 §Webhook; R4.1–R4.8, D3). Mounted outside /api/*, so no session
// cookie applies; auth is the HMAC headers only (04 §Auth). Never calls the model or the assistant
// loop (03 §Other request flows); it borrows only the shared PII detector, for story and link.
// Origin: palisade app/api/webhooks/[provider]/route.ts L24-98 (14 §7).
//
// Order, cheapest refusal first: rate limit (429) → JSON content type (415) → body ≤ 64 KB (413)
// → signature over the raw bytes, before any parsing (401) → JSON parse + schema (400) → personal
// data in properties.story or properties.link (400) → store (202 {accepted, event_id}; 200
// {accepted, duplicate} for an event_id already stored). Every refusal is logged with its reason
// and no header or body values (CLAUDE.md fail loud; 04 §Error envelope).

import { Hono } from 'hono'
import { ApiError, requireJson } from '../auth/middleware'
import { type AppEnv, requireSecret } from '../env'
import { exposedPropertyProblems } from '../webhooks/exposed-properties'
import { ingestEvent } from '../webhooks/ingest'
import { APP_EVENTS, parseWebhookEvent, type SchemaIssue } from '../webhooks/schema'
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyWebhook } from '../webhooks/verify'

/** 04 §Webhook body and validation: body ≤ 64 KB. */
export const MAX_BODY_BYTES = 64 * 1024

const INVALID_EVENT_MESSAGE = `Send one JSON object with event_id, event (one of ${APP_EVENTS.join(', ')}), device_id, timestamp, and optionally user_id and properties.`

function logRefusal(
  status: number,
  error: string,
  reason: string,
  extra: Record<string, unknown> = {},
): void {
  console.warn(JSON.stringify({ at: 'webhook', outcome: 'rejected', status, error, reason, ...extra }))
}

function invalidEvent(reason: string, details: SchemaIssue[]): ApiError {
  // Field names and fixed issue texts only (worker/webhooks/schema.ts); never values.
  logRefusal(400, 'invalid_event', reason, { fields: details.map((d) => d.field) })
  return new ApiError(400, 'invalid_event', INVALID_EVENT_MESSAGE, details)
}

/**
 * The raw body, or null once it passes `max` bytes. Reads the stream itself so an oversized body
 * without a Content-Length is refused after max + 1 bytes rather than buffered whole.
 */
async function readBodyCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > max) return null
  if (request.body === null) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** Wall clock in whole seconds; 02 §Time allows it for the replay window and received_at, 09 D-70 #3 for the future bound. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** Mounted at /webhooks by worker/index.ts. */
export const webhookRoutes = new Hono<AppEnv>()

webhookRoutes.post('/app', async (c) => {
  const webhookSecret = requireSecret(c.env, 'WEBHOOK_SECRET')
  const piiKeySecret = requireSecret(c.env, 'PII_KEY_SECRET')

  // Cloudflare sets CF-Connecting-IP at the edge; local dev has no edge, so every local sender shares one key.
  const { success } = await c.env.WEBHOOK_LIMITER.limit({ key: c.req.header('cf-connecting-ip') ?? 'local' })
  if (!success) {
    logRefusal(429, 'rate_limited', 'over 300 requests per minute from one client')
    throw new ApiError(429, 'rate_limited', 'Too many webhook requests. Wait a minute and retry.')
  }

  try {
    await requireJson(c, async () => {})
  } catch (err) {
    if (err instanceof ApiError) logRefusal(err.status, err.code, 'content type is not application/json')
    throw err
  }

  const raw = await readBodyCapped(c.req.raw, MAX_BODY_BYTES)
  if (raw === null) {
    logRefusal(413, 'payload_too_large', `body over ${MAX_BODY_BYTES} bytes`)
    throw new ApiError(413, 'payload_too_large', `The body must be at most ${MAX_BODY_BYTES} bytes (64 KB).`)
  }

  const verified = await verifyWebhook(
    webhookSecret,
    { timestamp: c.req.header(TIMESTAMP_HEADER), signature: c.req.header(SIGNATURE_HEADER) },
    raw,
    nowSeconds(),
  )
  if (!verified.ok) {
    logRefusal(401, verified.error, verified.reason)
    throw new ApiError(
      401,
      verified.error,
      'The webhook signature headers are missing, wrong or outside the 5-minute window.',
    )
  }

  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw))
  } catch (err) {
    // The error's class name only: a JSON SyntaxError message quotes the body.
    throw invalidEvent(`body is not UTF-8 JSON (${err instanceof Error ? err.name : 'unknown'})`, [
      { field: 'body', issue: 'body must be UTF-8 JSON' },
    ])
  }
  // Wall clock: the bound on how far an event time may run ahead of it (09 D-70 #3), beside the
  // replay window and received_at on the 02 §Time allow-list.
  const parsed = parseWebhookEvent(body, nowSeconds() * 1000)
  if (!parsed.ok) throw invalidEvent('schema validation failed', parsed.details)
  // story and link reach the assistant through v_app_events, so personal data in them is refused
  // here, in any spelling the outbound scanner reads (worker/webhooks/exposed-properties.ts).
  const personal = await exposedPropertyProblems(c.env.DB, parsed.event)
  if (personal.issues.length > 0) {
    throw invalidEvent(`personal data in properties (${personal.checks.join(', ')})`, personal.issues)
  }

  const receivedAt = new Date(nowSeconds() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const result = await ingestEvent(c.env.DB, piiKeySecret, parsed.event, receivedAt)
  if (result.duplicate) {
    console.info(JSON.stringify({ at: 'webhook', outcome: 'duplicate', status: 200 }))
    return c.json({ accepted: true, duplicate: true }, 200)
  }
  console.info(JSON.stringify({ at: 'webhook', outcome: 'stored', status: 202, event: parsed.event.event }))
  // Only what the sender already knows. Which person a device resolves to is never told to a
  // caller of this open URL; /events and its "Send a test event" panel read it behind the session.
  return c.json({ accepted: true, event_id: parsed.event.event_id }, 202)
})

/** What a GET (a browser, a link checker) or any other non-POST to the webhook URL is told. */
export const METHOD_NOT_ALLOWED_MESSAGE =
  'This URL takes only POST: one signed JSON app event per request, as described in the Webhook section of docs/notes.md.'

// Any other method on the same path: 405 with `Allow: POST`, not the generic 404, so a person
// who opens the URL in a browser learns it exists and how to use it. HEAD is routed as GET.
webhookRoutes.all('/app', (c) => {
  logRefusal(405, 'method_not_allowed', `method ${c.req.method}`)
  return c.json({ error: 'method_not_allowed', message: METHOD_NOT_ALLOWED_MESSAGE }, 405, { Allow: 'POST' })
})
