/**
 * The one normalization implementation (design 02 §Normalization, 09 D-26, A2).
 *
 * Every place that folds an email or a source value imports from here; the list of
 * callers is kept in 02 §Normalization, and T-NORM-3 fails if anything else lowercases
 * an email or if SQL does it with LOWER(. SQL and the browser never normalize.
 */

/** Pattern an email must match after folding; anything else is quarantined (02 §Quarantine). */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * The one email fold (09 D-70 item 8): `trim()` then `toLowerCase()`, nothing else: no
 * plus-stripping, no Gmail dot removal (D-26). Private, so an address and a fragment of one can
 * only be folded through the two exports below, and both fold exactly as `email_norm` was stored.
 */
function foldEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/** The folded address, or `null` when it does not look like an address. */
export function normalizeEmail(raw: string): string | null {
  const email = foldEmail(raw)
  return EMAIL_PATTERN.test(email) ? email : null
}

/** The canonical source names (02 §Normalization). `twitter` folds to `x`. */
export const CANONICAL_SOURCES = [
  'instagram',
  'facebook',
  'referral',
  'google',
  'direct',
  'podcast',
  'x',
] as const

export type CanonicalSource = (typeof CANONICAL_SOURCES)[number]

/**
 * Trim, lowercase, then `twitter → x`. Unknown values pass through lowercased so that an
 * unexpected source is visible in the data rather than silently dropped. Blank → `null`.
 */
export function canonicalSource(raw: string): string | null {
  const source = raw.trim().toLowerCase()
  if (source === '') return null
  return source === 'twitter' ? 'x' : source
}

/**
 * A partial-lookup query fragment (09 D-52, 04 §/api/lookup/search): the same fold as
 * `normalizeEmail` (D-70 item 8), so a fragment of a stored address still matches it. No
 * validation: a fragment is not an address.
 */
export function normalizeQueryFragment(raw: string): string {
  return foldEmail(raw)
}

/** Shortest normalized fragment the search answers; shorter is 400 `query_too_short` (04). */
export const QUERY_FRAGMENT_MIN_LENGTH = 3
