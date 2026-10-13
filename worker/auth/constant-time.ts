// Constant-time comparisons for the session signature and the site password (04 §Auth).
// Origin: palisade site-auth.ts L99-107 (14 §7), ported from node:crypto to WebCrypto.

const encoder = new TextEncoder()

/**
 * True when both byte arrays are equal. Unequal lengths return false without comparing
 * contents. Uses workerd's crypto.subtle.timingSafeEqual when present, else a loop whose
 * running time depends only on the length.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(a, b)
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Compares two strings as UTF-8 bytes in constant time. `supplied` is the attacker-controlled
 * value: when the lengths differ it is compared against itself, so the time taken depends only
 * on its own length and not on the length of `expected`.
 */
export function constantTimeStringEq(supplied: string, expected: string): boolean {
  const a = encoder.encode(supplied)
  const b = encoder.encode(expected)
  if (a.byteLength !== b.byteLength) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}
