/**
 * What counts as PII for the model boundary (design 01 §PII denylist, 05 §What counts as
 * PII, 05 §Scanner, 09 D-17). Imported by the view introspection test (T-PII-2) and the
 * scanner; defined nowhere else.
 */

import { FORMAT_CHARS } from './sql-sign'

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

/** Non-global copy of `FORMAT_CHARS` for a stateless single-character `.test()` (a global regex keeps `lastIndex` between calls). */
const FORMAT_CHAR_TEST = new RegExp(FORMAT_CHARS.source, 'u')

/**
 * The one normalizer every PII check runs text through first (09 D-79), in two stages so a
 * disguise cannot hide inside what stage 1 folds (a full-width "ａｔ" inside "[ａｔ]" must become
 * plain "at" before the bracket mapping below can see it; a zero-width character spliced into
 * the middle of the word "at" must be dropped before the same mapping sees it):
 *
 *  1. Per character: every Unicode format character (`shared/sql-sign.ts` `FORMAT_CHARS`, one
 *     home shared with the D-58 SQL-sign check — U+00AD, U+180E, U+200B-U+200D, U+2060, the
 *     bidi controls U+202A-202E/U+2066-2069, U+FEFF and the rest of category `Cf`) is dropped,
 *     then Unicode NFKC folds what is left (the full-width `＠` U+FF20 and the small `﹫`
 *     U+FE6B to plain "@" on their own, full-width letters to ASCII, and so on).
 *  2. Over the stage-1 text: every escaped or spelled form of "@" and "." folded to the real
 *     character — `%40` (any case), `&#64;`, `&#x40;` (any case), the bracketed words
 *     `[at]`/`(at)`/`{at}`/`<at>` and `[dot]`/`(dot)`/`{dot}` (optional spaces inside the
 *     brackets, their surrounding whitespace folded away too), and the full spoken shape
 *     "<local> at <domain> dot <tld>" (word-bounded, case-insensitive, whitespace-separated
 *     only — a hyphen or slash next to "at"/"dot" does not count, so "look-at-this.html" and
 *     "clicked at thepourover.com/news" are left untouched, and so is a bare "at <domain>" with
 *     no spelled "dot": the local part may itself hold a literal "." or a spelled " dot "
 *     ("joy.hall830" and "joy dot hall830" both work), but the domain must hold at least one
 *     spelled " dot " — 09 D-79 fixer round, closing the false positive the old bare `\bat\b`
 *     mapping caused on ordinary prose like "signed up at instagram.com").
 *
 * EMAIL_REGEX, the known-email set, RAW_ID_REGEX and the known-local-part rule all run on the
 * result, never on raw text — one home, so no caller can read a disguised address by skipping
 * this step (worker/assistant/gates/pii-guard.ts findPII, KnownEmails.occursIn, redactEmails,
 * redactKnownLocalParts).
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

/** A run of plain word characters (letters, digits, "_", "-"), case-insensitive. */
const LABEL = '[\\p{L}\\p{N}_-]+'
/** The local part of the spoken form: may already hold a literal "." (a typed local part like "joy.hall830") or a spelled " dot " ("joy dot hall830"); zero or more extra chunks, so a bare word also matches. */
const LOCAL_SPELLED = `${LABEL}(?:\\.${LABEL}|\\s+dot\\s+${LABEL})*`
/**
 * The domain of the spoken form: at least one spelled " dot " is required (the tld), so a plain
 * "instagram.com" with no spoken "dot" never matches on its own. The trailing negative lookahead
 * rejects a match immediately followed by another "\s+at\s+<word>": without it, a sentence like
 * "write to her at joy dot hall830 at protonmail dot com" matches leftmost at "her" (local "her",
 * domain "joy dot hall830"), stealing the "at" the REAL address needs and leaving "at protonmail
 * dot com" an orphan; the lookahead forces that earlier, wrong match to fail, so the regex engine
 * advances to the correct one starting at "joy" instead (09 D-79 fixer round).
 */
const DOMAIN_SPELLED = `${LABEL}(?:\\s+dot\\s+${LABEL})+(?!\\s+at\\s+${LABEL})`

/** Folds a matched spelled-out address span to its "@"/"." shape, keeping every other character as typed. */
function foldSpelled(match: string): string {
  return match.replace(/\s+dot\s+/gi, '.').replace(/\s+at\s+/gi, '@')
}

// Stage 2: one pass over the stage-1 (format-characters-dropped, NFKC-folded) text, left to
// right, with no gaps. The bracket and escape forms are tried first (longest, most specific),
// then the full spoken shape above (which requires its own trailing "dot", so a lone "at" is
// never folded on its own), then one default character, already folded in stage 1 so stage 2
// copies it through unchanged.
const SCAN_TOKEN_RE = new RegExp(
  '(?<pct>%40)' +
    '|(?<hex>&#x40;)' +
    '|(?<dec>&#64;)' +
    '|(?<atBr>\\s*(?:\\[\\s*at\\s*\\]|\\(\\s*at\\s*\\)|\\{\\s*at\\s*\\}|<\\s*at\\s*>)\\s*)' +
    '|(?<dotBr>\\s*(?:\\[\\s*dot\\s*\\]|\\(\\s*dot\\s*\\)|\\{\\s*dot\\s*\\})\\s*)' +
    `|(?<spelled>\\b(?:${LOCAL_SPELLED})\\s+at\\s+(?:${DOMAIN_SPELLED})\\b)` +
    '|(?<ch>[\\s\\S])',
  'giu',
)

/** Pure. Stage 1: format characters dropped, then NFKC, one original character at a time; keeps each output character's origin span. */
function foldChars(raw: string): ScanToken[] {
  const tokens: ScanToken[] = []
  let i = 0
  for (const ch of raw) {
    const origStart = i
    i += ch.length
    const origEnd = i
    tokens.push({ origStart, origEnd, out: FORMAT_CHAR_TEST.test(ch) ? '' : ch.normalize('NFKC') })
  }
  return tokens
}

/** Pure. The one normalizer (see NormalizedScan above). */
export function normalizeForScan(raw: string): NormalizedScan {
  const stage1 = foldChars(raw)
  let stage1Text = ''
  const spanAt: Array<readonly [number, number]> = []
  for (const t of stage1) {
    for (let k = 0; k < t.out.length; k += 1) spanAt.push([t.origStart, t.origEnd])
    stage1Text += t.out
  }

  const tokens: ScanToken[] = []
  for (const m of stage1Text.matchAll(SCAN_TOKEN_RE)) {
    const start = m.index
    const end = start + m[0].length
    const [origStart] = end > start ? spanAt[start]! : [raw.length, raw.length]
    const [, origEnd] = end > start ? spanAt[end - 1]! : [raw.length, raw.length]
    const groups = m.groups as Record<string, string | undefined>
    const out =
      groups.pct !== undefined || groups.hex !== undefined || groups.dec !== undefined || groups.atBr !== undefined
        ? '@'
        : groups.dotBr !== undefined
          ? '.'
          : groups.spelled !== undefined
            ? foldSpelled(groups.spelled)
            : groups.ch!
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
