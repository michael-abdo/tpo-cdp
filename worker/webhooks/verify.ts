// Webhook signature check (04 §Webhook headers, 09 D-37; 10 §Controls by surface, webhook).
// Origin: palisade lib/webhooks/adapters/zoom.ts L19-39 + types.ts L36-53 (14 §3.10, §7): HMAC over
// timestamp + raw body, prefixed hex, constant-time compare. Two changes from the origin: the
// signature is checked on the raw bytes before any JSON parsing, and the header timestamp must be
// fresh (the origin had no freshness check).

import { timingSafeEqual } from '../auth/constant-time'

export const TIMESTAMP_HEADER = 'x-webhook-timestamp'
export const SIGNATURE_HEADER = 'x-webhook-signature'
export const SIGNATURE_PREFIX = 'v1='
/** ±300 s between the header timestamp and the server's wall clock (04 §Webhook headers). */
export const SIGNATURE_WINDOW_SECONDS = 300

/** The three 401 codes of 04 §Webhook responses. */
export type VerifyError = 'missing_headers' | 'bad_signature' | 'stale_timestamp'

export type VerifyResult =
  | { ok: true }
  /** `reason` is for the server log only; the client sees `error`. Neither carries header or body values. */
  | { ok: false; error: VerifyError; reason: string }

const encoder = new TextEncoder()
const UNIX_SECONDS = /^\d{1,12}$/
const HEX_SHA256 = /^[0-9a-f]{64}$/i

/** HMAC-SHA256(secret, `<timestamp>.<raw body bytes>`) as raw bytes. */
export async function webhookMac(
  secret: string,
  timestamp: string,
  rawBody: Uint8Array,
): Promise<Uint8Array> {
  if (secret.length === 0) throw new Error('WEBHOOK_SECRET is empty; refusing to sign or verify a webhook')
  const prefix = encoder.encode(`${timestamp}.`)
  const message = new Uint8Array(prefix.byteLength + rawBody.byteLength)
  message.set(prefix, 0)
  message.set(rawBody, prefix.byteLength)
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/**
 * Checks the two auth headers against the raw body. Order: both headers present, signature
 * (`v1=` + 64 hex, constant-time compare), then freshness of the header timestamp against
 * `nowSeconds` (the caller's wall clock, which 02 §Time allows for the replay window). The
 * signature goes first so only a holder of the secret can learn anything about the window.
 * The body's own `timestamp` is never read here: it is the event time and may be any age (R4.7).
 */
export async function verifyWebhook(
  secret: string,
  headers: { timestamp: string | undefined; signature: string | undefined },
  rawBody: Uint8Array,
  nowSeconds: number,
): Promise<VerifyResult> {
  const { timestamp, signature } = headers
  if (timestamp === undefined || signature === undefined || timestamp === '' || signature === '') {
    const absent = [timestamp ? null : TIMESTAMP_HEADER, signature ? null : SIGNATURE_HEADER].filter(
      (h) => h !== null,
    )
    return { ok: false, error: 'missing_headers', reason: `absent or empty: ${absent.join(', ')}` }
  }
  if (!signature.startsWith(SIGNATURE_PREFIX)) {
    return {
      ok: false,
      error: 'bad_signature',
      reason: `signature header lacks the ${SIGNATURE_PREFIX} prefix`,
    }
  }
  const hex = signature.slice(SIGNATURE_PREFIX.length)
  if (!HEX_SHA256.test(hex)) {
    return {
      ok: false,
      error: 'bad_signature',
      reason: 'signature is not 64 hex characters after the prefix',
    }
  }
  const expected = await webhookMac(secret, timestamp, rawBody)
  if (!timingSafeEqual(fromHex(hex.toLowerCase()), expected)) {
    return {
      ok: false,
      error: 'bad_signature',
      reason: 'signature does not match the timestamp and raw body',
    }
  }
  if (!UNIX_SECONDS.test(timestamp)) {
    return { ok: false, error: 'stale_timestamp', reason: 'header timestamp is not unix seconds' }
  }
  const skew = Number(timestamp) - nowSeconds
  if (Math.abs(skew) > SIGNATURE_WINDOW_SECONDS) {
    return {
      ok: false,
      error: 'stale_timestamp',
      reason: `header timestamp is ${skew} s from the server clock (window ±${SIGNATURE_WINDOW_SECONDS} s)`,
    }
  }
  return { ok: true }
}
