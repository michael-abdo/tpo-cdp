/**
 * What counts as PII for the model boundary (design 01 §PII denylist, 05 §What counts as
 * PII, 05 §Scanner, 09 D-17). Imported by the view introspection test (T-PII-2) and the
 * scanner; defined nowhere else.
 */

/** Columns no `v_*` view may select (01 §PII denylist). */
export const PII_COLUMNS = [
  'email_norm',
  'email_raw',
  'user_id',
  'device_id',
  'visitor_id',
  'raw_row',
  'properties',
] as const

/**
 * An email anywhere in serialized text, case-insensitive. The local part excludes quotes
 * and brackets so a match inside JSON stops at the string delimiter. No `g` flag: the
 * regex is shared, and a global regex carries `lastIndex` between `.test()` calls.
 */
export const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i

/**
 * One run of EMAIL_REGEX's local-part characters: the token Gate 1 compares with the known
 * local parts (09 D-70 #1). No `g` flag, as above.
 */
export const LOCAL_PART_TOKEN = /[a-z0-9._%+-]+/i

/**
 * The shortest known local part Gate 1 redacts on its own (09 D-70 #1). Every local part in
 * data/*.csv is longer (name, dot, surname, digits); a shorter one could be an ordinary word.
 */
export const LOCAL_PART_MIN_CHARS = 6

/**
 * A raw app user, device or web visitor id (`u_`, `d_`, `v_` followed by hex; data/*.csv has
 * `u_2b6447a3` and `v_c9e136fd6d`, the brief's sample webhook has device `d_4b21e8`, the
 * shortest seen). At least 6 hex chars and word-bounded, so
 * ordinary words and `pk_` keys do not match. No `g` flag, as above.
 */
export const RAW_ID_REGEX = /\b[udv]_[0-9a-f]{6,}\b/i

/**
 * The one normalizer every PII check runs text through first (09 D-79): Unicode NFKC (folds the
 * full-width `＠` U+FF20 and the small `﹫` U+FE6B to plain "@" on its own), zero-width and
 * soft-hyphen characters removed (U+200B/U+200C/U+200D/U+FEFF/U+00AD — a disguise could sit
 * between two halves of an address to split it from these checks), and every escaped or spelled
 * form of "@" and "." folded to the real character: `%40` (any case), `&#64;`, `&#x40;` (any
 * case), the bracketed words `[at]`/`(at)`/`{at}`/`<at>` and `[dot]`/`(dot)`/`{dot}` (optional
 * spaces inside the brackets), and the bare words "at" and "dot" used as spoken-style separators
 * (word-bounded, case-insensitive, their surrounding whitespace folded away too, so
 * "joy at example dot com" becomes "joy@example.com"). EMAIL_REGEX, the known-email set,
 * RAW_ID_REGEX and the known-local-part rule all run on the result, never on raw text — one home,
 * so no caller can read a disguised address by skipping this step (worker/assistant/gates/pii-guard.ts
 * findPII, KnownEmails.occursIn, redactEmails, redactKnownLocalParts).
 *
 * Returns the normalized text plus `mapToOriginal`, so a caller that must edit the ORIGINAL text
 * (Gate 1's redaction: everything the teammate did not write stays untouched) can turn a span
 * found in the normalized text back into the original span it came from, however many characters
 * a disguise took in the original (`%40` is 3 original characters folded to 1).
 */
export interface NormalizedScan {
  /** The normalized text; every detector pattern runs against this, never the original. */
  readonly text: string
  /** The original-text [start, end) span that produced normalized [start, end). */
  mapToOriginal(start: number, end: number): readonly [number, number]
}

/** One scanned unit: `out` is what normalizeForScan emits for the original span [origStart, origEnd). */
interface ScanToken {
  readonly origStart: number
  readonly origEnd: number
  readonly out: string
}

// One pass over the original text, left to right, with no gaps: the bracket and escape forms are
// tried first (longest, most specific), then the bare spelled-out words (which eat their own
// surrounding whitespace, so "at"/"dot" used as a spoken separator collapses the spaces around it
// the way a written "@"/"." has none), then a lone zero-width/soft-hyphen character (dropped), and
// finally one default character, NFKC-folded on its own (correct for every disguise character
// above: each is a standalone compatibility decomposition to a single ASCII character, not a
// decomposition that depends on its neighbors).
const SCAN_TOKEN_RE =
  /(?<pct>%40)|(?<hex>&#x40;)|(?<dec>&#64;)|(?<atBr>\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}|<\s*at\s*>)\s*)|(?<dotBr>\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\})\s*)|(?<atWord>\s*\bat\b\s*)|(?<dotWord>\s*\bdot\b\s*)|(?<zw>\u200B|\u200C|\u200D|\uFEFF|\u00AD)|(?<ch>[\s\S])/giu

/** Pure. The one normalizer (see NormalizedScan above). */
export function normalizeForScan(raw: string): NormalizedScan {
  const tokens: ScanToken[] = []
  for (const m of raw.matchAll(SCAN_TOKEN_RE)) {
    const origStart = m.index
    const origEnd = origStart + m[0].length
    const groups = m.groups as Record<string, string | undefined>
    const out =
      groups.pct !== undefined || groups.hex !== undefined || groups.dec !== undefined || groups.atBr !== undefined || groups.atWord !== undefined
        ? '@'
        : groups.dotBr !== undefined || groups.dotWord !== undefined
          ? '.'
          : groups.zw !== undefined
            ? ''
            : groups.ch!.normalize('NFKC')
    tokens.push({ origStart, origEnd, out })
  }
  const text = tokens.map((t) => t.out).join('')
  function mapToOriginal(start: number, end: number): readonly [number, number] {
    let pos = 0
    let origStart = -1
    let origEnd = -1
    for (const token of tokens) {
      const tokenEnd = pos + token.out.length
      if (origStart === -1 && tokenEnd > start) origStart = token.origStart
      if (pos < end) origEnd = token.origEnd
      pos = tokenEnd
      if (pos >= end && origStart !== -1) break
    }
    if (origStart === -1) origStart = raw.length
    if (origEnd === -1) origEnd = origStart
    return [origStart, origEnd]
  }
  return { text, mapToOriginal }
}
