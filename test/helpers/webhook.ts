/// <reference types="vite/client" />
import { env, SELF } from 'cloudflare:test'
import webCsv from '../../data/web_events.csv?raw'
import { parseCsv } from '../../worker/ingest/csv'
import { documentationIp } from './auth'

// Signs and sends app webhooks the way 04 §Webhook headers specifies, with WEBHOOK_SECRET from
// .dev.vars (never printed). The HMAC is computed here with WebCrypto, independently of
// worker/webhooks/verify.ts, so a bug there cannot be mirrored by the signer.

const encoder = new TextEncoder()

/** WEBHOOK_SECRET from .dev.vars; the value is never printed. */
export function webhookSecret(): string {
  const value = env.WEBHOOK_SECRET
  if (!value) throw new Error('WEBHOOK_SECRET missing from .dev.vars; the test cannot sign webhooks')
  return value
}

/** Unix seconds from the wall clock, the header timestamp a live sender uses. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** `v1=` + hex HMAC-SHA256(secret, `<timestamp>.<raw body bytes>`) (04 §Webhook headers). */
export async function signature(secret: string, timestamp: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const prefix = encoder.encode(`${timestamp}.`)
  const message = new Uint8Array(prefix.byteLength + body.byteLength)
  message.set(prefix)
  message.set(body, prefix.byteLength)
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  return 'v1=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface SendOptions {
  /** Header timestamp; default now. */
  timestamp?: string
  /** Signing secret; default WEBHOOK_SECRET. */
  secret?: string
  /** Bytes to send instead of the signed ones (a tampered body). */
  sendBody?: string | Uint8Array
  /** Overrides or removals (`undefined`) applied after the defaults. */
  headers?: Record<string, string | undefined>
}

/** Prepares one signed request; `send()` may be called repeatedly to replay identical bytes and headers. */
export async function signedRequest(body: string | Uint8Array, options: SendOptions = {}) {
  const bytes = typeof body === 'string' ? encoder.encode(body) : body
  const timestamp = options.timestamp ?? String(nowSeconds())
  const headers: Record<string, string | undefined> = {
    'content-type': 'application/json',
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature': await signature(options.secret ?? webhookSecret(), timestamp, bytes),
    ...options.headers,
  }
  const sent = options.sendBody ?? bytes
  const finalHeaders = Object.fromEntries(
    Object.entries(headers).filter((e): e is [string, string] => e[1] !== undefined),
  )
  return {
    send: () =>
      SELF.fetch('http://cdp.test/webhooks/app', {
        method: 'POST',
        // A fresh documentation address per request keeps the tests off one WEBHOOK_LIMITER key.
        headers: { ...finalHeaders, 'cf-connecting-ip': documentationIp() },
        body: sent,
      }),
  }
}

/** Signs and sends once. */
export async function sendWebhook(body: string | Uint8Array, options: SendOptions = {}): Promise<Response> {
  return (await signedRequest(body, options)).send()
}

/**
 * Distinct event ids built from real ids (09 D-11): `evt_` + the hex of each distinct visitor_id
 * in data/web_events.csv, in file order. No events CSV exists, so ids cannot come from one.
 */
export function eventIdPool(): () => string {
  const csv = parseCsv(webCsv)
  const col = csv.header.indexOf('visitor_id')
  if (col < 0) throw new Error('webhook helper: web_events.csv has no visitor_id column')
  const hexes = [...new Set(csv.rows.map((r) => r[col].trim()))].map((id) => id.replace(/^v_/, ''))
  let next = 0
  return () => {
    if (next >= hexes.length) throw new Error('webhook helper: the event id pool is exhausted')
    return `evt_${hexes[next++]}`
  }
}
