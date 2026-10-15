/**
 * What counts as PII for the model boundary (design 01 §PII denylist, 05 §What counts as
 * PII, 05 §Scanner, 09 D-17). Imported by the view introspection test (T-PII-2) and the
 * scanner; defined nowhere else.
 */

import { INVISIBLE_CHARS } from './sql-sign'

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

/** Non-global copy of `INVISIBLE_CHARS` for a stateless single-character `.test()` (a global regex keeps `lastIndex` between calls). */
const INVISIBLE_CHAR_TEST = new RegExp(INVISIBLE_CHARS.source, 'u')

/**
 * The one normalizer every PII check runs text through first (09 D-79), in three stages so a
 * disguise cannot hide inside what an earlier stage folds (a full-width "ａｔ" inside "[ａｔ]" must
 * become plain "at" before the bracket mapping below can see it; a zero-width character spliced
 * into the middle of the word "at" must be dropped before the same mapping sees it; and a spelled
 * "dot" must already be a literal "." before the "at" shape below can tell a real domain like
 * "instagram.com" apart from a disguised one):
 *
 *  1. Per character: every Unicode format character or other default-ignorable code point
 *     (`shared/sql-sign.ts` `INVISIBLE_CHARS` — category `Cf` (U+00AD, U+180E, U+200B-U+200D,
 *     U+2060, the bidi controls U+202A-202E/U+2066-2069, U+FEFF and the rest) plus every other
 *     `Default_Ignorable_Code_Point` (U+034F, U+FE0F, U+180B, U+115F, U+3164 and the rest) —
 *     09 D-79 fixer round item 2: `Cf` alone missed these, which a model can still splice into
 *     the middle of a disguise) is dropped, then Unicode NFKC folds what is left (the full-width
 *     `＠` U+FF20 and the small `﹫` U+FE6B to plain "@" on their own, full-width letters to
 *     ASCII, and so on).
 *  2. Over the stage-1 text (`DISGUISE_TOKEN_RE`): every escaped or bracketed form of "@" and
 *     "." folded to the real character — `%40` (any case), `&#64;`, `&#x40;` (any case), the
 *     bracketed words `[at]`/`(at)`/`{at}`/`<at>` and `[dot]`/`(dot)`/`{dot}` (optional spaces
 *     inside the brackets, their surrounding whitespace folded away too) — and, on its own, a
 *     BARE spelled "dot" between two labels (`data dot com` → `data.com`): safe unconditionally,
 *     because a dot alone, with no "@" anywhere, is never an email shape. A bare spelled "at" is
 *     deliberately left alone here (09 D-79 fixer round: folding every lone "at" on its own is
 *     what made "signed up at instagram.com" read as local "up", domain "instagram.com"). Every
 *     "." this stage produces is marked as a disguised one, whether it came from a bracket/escape
 *     form or the bare spelled fold.
 *  3. Over stage 2's text (`AT_SHAPE_RE`): the full spoken shape "<local> at <domain>" — word-
 *     bounded, whitespace-separated only, so a hyphen or slash next to "at" never counts
 *     ("look-at-this.html" and "clicked at thepourover.com/news" are one label each, with no
 *     whitespace around "at") — folds its "at" to "@", but ONLY when the matched domain holds at
 *     least one "." stage 2 marked as disguised (bracketed or spelled): "press at example [dot]
 *     com" and "press at example dot com" both fold, because their domain's "." is a disguise;
 *     "signed up at instagram.com" does not, because its "." was typed plain. A trailing
 *     negative lookahead stops the match from stealing an earlier, unrelated "at" in a sentence
 *     like "write to her at joy dot hall830 at protonmail dot com" (stage 2 already turned both
 *     spelled dots into literal ones): without it the match starting at "her" would otherwise win
 *     leftmost, with domain "joy.hall830", and leave "at protonmail.com" an orphan; the lookahead
 *     forces that wrong match to fail so the search advances to the correct one starting at "joy".
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
/** One or more labels joined by a literal "." (a bare word also matches, zero dots). */
const DOTTED = `${LABEL}(?:\\.${LABEL})*`
/** The same shape, but requiring at least one "." (a domain always has a TLD). */
const DOTTED_WITH_DOT = `${LABEL}(?:\\.${LABEL})+`

/**
 * The top-level domains stage 2b's spelled "at" fold accepts as a disguised domain's TLD (09 D-79):
 * every two-letter country code (`de`, `ai`, `ca`, `uk`…) plus the common generic ones, so a
 * spelled address with any of them ("press at example dot de") folds; an 11-entry list let
 * those through (the closure review's regression). One home, so ordinary prose that merely contains the word
 * "dot" before some other noun ("Look at the dot plot below.", "Click at random dot points.")
 * never manufactures an "@" that was never there — its last label ("plot", "points") is not a
 * real TLD, so the match stays prose; a genuine disguised address ("protonmail dot com", "gmail
 * dot co dot uk") always ends in one of these. Matched case-insensitively by the `i` flag, never
 * by lowercasing the candidate (T-NORM-3: one home for case-folding, shared/normalize.ts).
 */
const DISGUISED_EMAIL_TLD_RE =
  /^(?:[a-z]{2}|com|org|net|edu|gov|mil|int|info|biz|name|pro|app|dev|xyz|online|site|tech|store|shop|blog|email|news|media|cloud|live|life|world|today|space|website|club|agency|digital|studio|design|global)$/i

// Stage 2a: one pass over the stage-1 (format-characters-dropped, NFKC-folded) text, left to
// right, with no gaps. The bracket and escape "@" forms are tried first (longest, most
// specific), then bracketed "dot", then a BARE spelled "dot" between two labels (unconditional:
// a dot alone is never an email shape), then one default character, already folded in stage 1 so
// stage 2 copies it through unchanged. A bare spelled "at" is deliberately absent here; only
// stage 2b folds it, and only inside the full shape (see normalizeForScan's doc comment).
const DISGUISE_TOKEN_RE = new RegExp(
  '(?<pct>%40)' +
    '|(?<hex>&#x40;)' +
    '|(?<dec>&#64;)' +
    '|(?<atBr>\\s*(?:\\[\\s*at\\s*\\]|\\(\\s*at\\s*\\)|\\{\\s*at\\s*\\}|<\\s*at\\s*>)\\s*)' +
    '|(?<dotBr>\\s*(?:\\[\\s*dot\\s*\\]|\\(\\s*dot\\s*\\)|\\{\\s*dot\\s*\\})\\s*)' +
    '|(?<dotSpelled>(?<=[\\p{L}\\p{N}_-])\\s+dot\\s+(?=[\\p{L}\\p{N}_-]))' +
    // A literal "@" or "." padded with spaces between word characters ("joy . hall830 @
    // protonmail . com"), the self-audit's unlisted spelling (09 D-79): folded like the others.
    // A "@" glued to the name with spaces after it ("press@ example.com") always folds; one with
    // a space before it folds only when the name looks like an address part (holds a ".", digit,
    // "_" or "+", or follows a spaced dot), so "visit us @ pourover.com" stays prose.
    '|(?<atSpaced>(?<=[\\p{L}\\p{N}_.+-])@\\s+(?=[\\p{L}\\p{N}])|(?<=(?:[._+\\p{N}][\\p{L}\\p{N}._+-]*|\\s\\.\\s+[\\p{L}\\p{N}_+-]+))\\s+@\\s*(?=[\\p{L}\\p{N}]))' +
    // A spaced "." needs a space on BOTH sides, so an ordinary sentence end ("at Instagram. Of
    // those…") is never read as a domain dot.
    '|(?<dotSpaced>(?<=[\\p{L}\\p{N}_-])\\s+\\.\\s+(?=[\\p{L}\\p{N}_-]))' +
    '|(?<ch>[\\s\\S])',
  'giu',
)

// Stage 2b: over stage 2a's text, the full spoken shape "<local> at <domain>" (local and domain
// already hold only literal "."s, whichever stage 2a folded them from); word-bounded,
// whitespace-separated only, so a hyphen or slash next to "at" never counts (LABEL already
// swallows it: "look-at-this" is one label, never three words around whitespace). The trailing
// negative lookahead rejects a match immediately followed by another "\s+at\s+<word>" (09 D-79
// fixer round: see normalizeForScan's doc comment for "write to her at joy dot hall830 at
// protonmail dot com"). Matched with 'd' (hasIndices) so the caller can read where the domain
// group actually falls, to check it for a disguised "." before folding anything.
const AT_SHAPE_RE = new RegExp(`\\b(${DOTTED})\\s+at\\s+(${DOTTED_WITH_DOT})\\b(?!\\s+at\\s+${LABEL})`, 'gidu')

/** Pure. Stage 1: format characters dropped, then NFKC, one original character at a time; keeps each output character's origin span. */
function foldChars(raw: string): ScanToken[] {
  const tokens: ScanToken[] = []
  let i = 0
  for (const ch of raw) {
    const origStart = i
    i += ch.length
    const origEnd = i
    tokens.push({ origStart, origEnd, out: INVISIBLE_CHAR_TEST.test(ch) ? '' : ch.normalize('NFKC') })
  }
  return tokens
}

/** A stage-2a token: like ScanToken, plus whether its "." (if any) came from a disguise (bracketed or a bare spelled "dot"), never a "." someone just typed. */
interface DisguiseToken extends ScanToken {
  readonly disguisedDot: boolean
}

/** Pure. Stage 2a (see DISGUISE_TOKEN_RE above): folds brackets, escapes and the bare spelled "dot" over stage 1's text; keeps each output character's origin span and whether it is a disguised ".". */
function foldDisguises(stage1: readonly ScanToken[]): DisguiseToken[] {
  let stage1Text = ''
  const spanAt: Array<readonly [number, number]> = []
  for (const t of stage1) {
    for (let k = 0; k < t.out.length; k += 1) spanAt.push([t.origStart, t.origEnd])
    stage1Text += t.out
  }
  const tokens: DisguiseToken[] = []
  for (const m of stage1Text.matchAll(DISGUISE_TOKEN_RE)) {
    const start = m.index
    const end = start + m[0].length
    const [origStart] = end > start ? spanAt[start]! : [stage1Text.length, stage1Text.length]
    const [, origEnd] = end > start ? spanAt[end - 1]! : [stage1Text.length, stage1Text.length]
    const groups = m.groups as Record<string, string | undefined>
    const isDot = groups.dotBr !== undefined || groups.dotSpelled !== undefined || groups.dotSpaced !== undefined
    // A spaced "." folds to "." but never marks a disguise: "signed up at instagram . com" must not
    // let stage 2b's spelled-"at" fold read it as an address.
    const disguisedDot = groups.dotBr !== undefined || groups.dotSpelled !== undefined
    const out =
      groups.pct !== undefined || groups.hex !== undefined || groups.dec !== undefined || groups.atBr !== undefined || groups.atSpaced !== undefined
        ? '@'
        : isDot
          ? '.'
          : groups.ch!
    tokens.push({ origStart, origEnd, out, disguisedDot })
  }
  return tokens
}

/**
 * Pure. Stage 2b (see AT_SHAPE_RE above): over stage 2a's tokens (each exactly one output
 * character), folds every "\s+at\s+" infix whose match's domain group both holds at least one
 * disguised "." and ends in a real TLD (DISGUISED_EMAIL_TLD_RE, 09 D-79 fixer round item 5) into
 * one "@" token; every other token passes through unchanged, so a plain domain's "at" (no
 * disguise found) and an ordinary "<word> dot <word>" whose last word is not a real TLD (chart
 * prose: "the dot plot", "random dot points") are never touched.
 */
function applyAtShape(disguiseTokens: readonly DisguiseToken[]): ScanToken[] {
  const midText = disguiseTokens.map((t) => t.out).join('')
  const foldRanges: Array<readonly [number, number]> = []
  for (const m of midText.matchAll(AT_SHAPE_RE)) {
    const indices = (m as RegExpMatchArray & { indices: Array<[number, number] | undefined> }).indices
    const localRange = indices[1]
    const domainRange = indices[2]
    if (localRange === undefined || domainRange === undefined) continue
    const [domainStart, domainEnd] = domainRange
    let disguised = false
    for (let i = domainStart; i < domainEnd; i += 1) if (disguiseTokens[i]!.disguisedDot) { disguised = true; break }
    // A spelled "dot" in the name part marks it as a disguised address too ("new dot person at
    // example.com"); a plain word before "at" ("signed up at instagram.com") never does.
    for (let i = localRange[0]; i < localRange[1] && !disguised; i += 1) if (disguiseTokens[i]!.disguisedDot) disguised = true
    const domain = midText.slice(domainStart, domainEnd)
    const tld = domain.slice(domain.lastIndexOf('.') + 1)
    if (disguised && DISGUISED_EMAIL_TLD_RE.test(tld)) foldRanges.push([localRange[1], domainRange[0]])
  }
  const tokens: ScanToken[] = []
  let i = 0
  let rangeIdx = 0
  while (i < disguiseTokens.length) {
    const range = foldRanges[rangeIdx]
    if (range !== undefined && i === range[0]) {
      tokens.push({ origStart: disguiseTokens[range[0]]!.origStart, origEnd: disguiseTokens[range[1] - 1]!.origEnd, out: '@' })
      i = range[1]
      rangeIdx += 1
    } else {
      const { disguisedDot: _disguisedDot, ...token } = disguiseTokens[i]!
      tokens.push(token)
      i += 1
    }
  }
  return tokens
}

/** Pure. The one normalizer (see NormalizedScan above). */
export function normalizeForScan(raw: string): NormalizedScan {
  return scanOf(raw, applyAtShape(foldDisguises(foldChars(raw))))
}

/**
 * Pure. The same normalized text with every whitespace run next to a "." or "@" dropped
 * ("joy .hall830@protonmail .com" → "joy.hall830@protonmail.com"). Used ONLY for membership
 * checks against stored values (a known email, a known local part), which can match nothing but
 * a real subscriber's address, so this aggressive fold adds no false positive; the email-shape
 * pattern keeps running on normalizeForScan's conservative text (09 D-79, self-audit at 1200107).
 */
export function normalizeForMembership(raw: string): NormalizedScan {
  const tokens = applyAtShape(foldDisguises(foldChars(raw)))
  const isSpace = (t: ScanToken | undefined) => t !== undefined && /^\s+$/u.test(t.out)
  const isSep = (t: ScanToken | undefined) => t !== undefined && (t.out === '.' || t.out === '@')
  const kept: ScanToken[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    if (isSpace(tokens[i])) {
      let before = i - 1
      while (before >= 0 && isSpace(tokens[before])) before -= 1
      let after = i + 1
      while (after < tokens.length && isSpace(tokens[after])) after += 1
      if (isSep(tokens[before]) || isSep(tokens[after])) continue
    }
    kept.push(tokens[i]!)
  }
  return scanOf(raw, kept)
}

function scanOf(raw: string, tokens: readonly ScanToken[]): NormalizedScan {
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
