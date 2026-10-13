// Signed session cookie (04 §Auth, 09 D-05). Origin: palisade site-auth.ts L50-96 (14 §3.1, §7),
// ported to WebCrypto: cdp_session = base64url(JSON{sub, exp}) "." base64url(HMAC-SHA256(SESSION_SECRET, payload)).

import { timingSafeEqual } from './constant-time'

export const SESSION_COOKIE = 'cdp_session'
/** 12 hours, the cookie Max-Age and the signed exp (04 §Auth). */
export const SESSION_TTL_SECONDS = 12 * 60 * 60

export type Session = { sub: string; exp: number }

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]+$/
const SHA256_BYTES = 32

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Unpadded base64url: the alphabet, and a length that is not 1 mod 4 (no byte string encodes to that). */
function isBase64Url(text: string): boolean {
  return BASE64URL_ALPHABET.test(text) && text.length % 4 !== 1
}

/** Decodes base64url; callers check isBase64Url first, so atob cannot throw. */
function fromBase64Url(text: string): Uint8Array {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0))
}

async function hmac(secret: string, payload: string): Promise<Uint8Array> {
  if (secret.length === 0) throw new Error('SESSION_SECRET is empty; refusing to sign or verify a session')
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)))
}

/** Current Unix time in seconds. Wall clock is allowed for session expiry (02 §Time). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** Signs a session as the cookie value. */
export async function signSession(secret: string, session: Session): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ sub: session.sub, exp: session.exp })))
  return `${payload}.${toBase64Url(await hmac(secret, payload))}`
}

/** A new session for a successful login: random subject, expiring SESSION_TTL_SECONDS from now. */
export function newSession(): Session {
  return { sub: crypto.randomUUID(), exp: nowSeconds() + SESSION_TTL_SECONDS }
}

/**
 * Returns the session when the cookie value is well formed, correctly signed and unexpired,
 * otherwise null. Order: split, base64url and length checks, constant-time compare, parse, exp check.
 */
export async function verifySession(secret: string, cookie: string | undefined): Promise<Session | null> {
  if (cookie === undefined) return null
  const parts = cookie.split('.')
  if (parts.length !== 2) return null
  const [payload, signature] = parts
  if (!isBase64Url(payload) || !isBase64Url(signature)) return null
  const supplied = fromBase64Url(signature)
  if (supplied.byteLength !== SHA256_BYTES) return null
  if (!timingSafeEqual(supplied, await hmac(secret, payload))) return null
  // The signature matched, so this payload was produced by signSession; the shape check guards future edits.
  const parsed: unknown = JSON.parse(decoder.decode(fromBase64Url(payload)))
  if (typeof parsed !== 'object' || parsed === null) return null
  const { sub, exp } = parsed as Record<string, unknown>
  if (typeof sub !== 'string' || typeof exp !== 'number' || !Number.isInteger(exp)) return null
  if (exp <= nowSeconds()) return null
  return { sub, exp }
}
