/**
 * Pseudonymous keys (design 05 §Pseudonymous key, 09 D-17).
 *
 * `pk_` + the first 16 hex chars of HMAC-SHA256(PII_KEY_SECRET, input). Keyed, so a key
 * cannot be reversed or recomputed without the secret. WebCrypto only, so the same file
 * runs in workerd (the Worker) and in Node 20+ (scripts/csv2sql.ts).
 *
 * Errors never echo the input: it is an email or a raw id (04 §Error envelope).
 */
import { normalizeEmail } from './normalize'

const KEY_PREFIX = 'pk_'
const KEY_HEX_CHARS = 16

async function keyFor(secret: string, message: string): Promise<string> {
  if (secret === '') throw new Error('PII_KEY_SECRET is empty; pseudonymous keys cannot be derived')
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
  let hex = ''
  for (const byte of mac.subarray(0, KEY_HEX_CHARS / 2)) hex += byte.toString(16).padStart(2, '0')
  return KEY_PREFIX + hex
}

function requireValue(value: string, what: string): void {
  if (value === '') throw new Error(`${what} is empty; no pseudonymous key for an empty value`)
}

/**
 * The profile key for an already-normalized email. Throws if `emailNorm` is not exactly
 * what `normalizeEmail` produces (02 §Normalization lists this file as a location), so a
 * raw spelling can never yield a second key for the same person.
 */
export async function pkeyForEmail(secret: string, emailNorm: string): Promise<string> {
  requireValue(emailNorm, 'emailNorm')
  if (normalizeEmail(emailNorm) !== emailNorm) {
    throw new Error('pkeyForEmail expects an email already normalized by shared/normalize.ts')
  }
  return keyFor(secret, emailNorm)
}

/** The key of a stub profile for an app user with no known email: hashes `user:` + id. */
export async function pkeyForUnknownUser(secret: string, userId: string): Promise<string> {
  requireValue(userId, 'userId')
  return keyFor(secret, `user:${userId}`)
}

/** `visitor_hash` in `v_web_events`: hashes `visitor:` + id. */
export async function visitorHash(secret: string, visitorId: string): Promise<string> {
  requireValue(visitorId, 'visitorId')
  return keyFor(secret, `visitor:${visitorId}`)
}
