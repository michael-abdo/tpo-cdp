// The outbound PII scanner (design 05 §Scanner; 03 §Gateway layers row 5). New in the port:
// the origin had no model-side PII control at all (14 §3.6, §5.3).
//
// `assertNoPII` serializes a payload, normalizes it once (shared/pii.ts normalizeForScan: NFKC,
// zero-width/soft-hyphen stripped, every %XX escape decoded, every disguised "@"/"." folded to
// the real character — 09 D-79) and checks four things against the normalized text, in this
// order (the two membership checks also read "-" and "_" as ".", shared/pii.ts foldSeparators):
//   1. known_email      — membership against every email_norm in the database (loaded per request)
//   2. email_pattern    — the case-insensitive email regex (shared/pii.ts EMAIL_REGEX)
//   3. raw_id           — raw app user, device or web visitor ids (shared/pii.ts RAW_ID_REGEX)
//   4. known_local_part — a known email's local part with no "@" at all (09 D-79; this is what
//                         closes the gap a stored email's local part took through a tool result,
//                         e.g. a webhook `link` such as "…/u/joy.hall830")
// A hit throws `PiiBlockedError` (500 `blocked_pii`, 04 §POST /api/assistant). It never redacts
// and retries, never degrades, and never echoes the matched value in a message or a log line.

import { normalizeEmail, normalizeQueryFragment } from '../../../shared/normalize'
import { EMAIL_REGEX, foldSeparators, LOCAL_PART_MIN_CHARS, LOCAL_PART_TOKEN, type NormalizedScan, normalizeForMembership, normalizeForScan, RAW_ID_REGEX } from '../../../shared/pii'
import { ApiError } from '../../auth/middleware'
import type { AuditTrace } from '../audit/ai-audit'

export type PiiCheck = 'known_email' | 'email_pattern' | 'raw_id' | 'known_local_part'

/** Where the scanned payload was going (05 §Strategy diagram; 05 §Scanner "logging"). */
export type PiiSite = 'model_request' | 'tool_result' | 'model_output' | 'log' | 'audit_row'

/**
 * The full set of `email_norm` values, indexed for a scan that costs nothing when a payload has
 * no "@". Every email_norm holds exactly one "@" (02 §Normalization), so an email occurs in a
 * text only aligned to one of the text's "@" characters: for each "@" the scan slices the
 * candidate for every (local-part length, total length) shape in the set, folds it with the one
 * normalizer (shared/normalize.ts, so a raw spelling such as upper case still matches) and looks
 * it up. That is a case-insensitive `text.includes(email)` for each email, without one pass per
 * email.
 */
export class KnownEmails {
  readonly size: number
  /** Every known email with "-" and "_" read as "." (shared/pii.ts foldSeparators). */
  private readonly emails: ReadonlySet<string>
  private readonly shapes: ReadonlyMap<number, readonly number[]>
  /** The local part of every known email with at least LOCAL_PART_MIN_CHARS characters (09 D-70 #1), separators folded as above. */
  private readonly localParts: ReadonlySet<string>
  /** The longest known local part: bounds the search in redactKnownLocalParts. */
  readonly maxLocalPartLength: number

  constructor(emails: Iterable<string>) {
    const set = new Set<string>()
    const shapes = new Map<number, Set<number>>()
    const localParts = new Set<string>()
    for (const email of emails) {
      const at = email.indexOf('@')
      if (at <= 0 || at !== email.lastIndexOf('@') || normalizeEmail(email) !== email) {
        // Never echo the value: it is an email or something that should have been one.
        throw new Error('pii-guard: a known email is not a normalized address with exactly one "@"')
      }
      set.add(foldSeparators(email))
      if (at >= LOCAL_PART_MIN_CHARS) localParts.add(foldSeparators(email.slice(0, at)))
      let lengths = shapes.get(at)
      if (lengths === undefined) shapes.set(at, (lengths = new Set()))
      lengths.add(email.length)
    }
    this.emails = set
    this.size = set.size
    this.shapes = new Map([...shapes].map(([local, lengths]) => [local, [...lengths]]))
    this.localParts = localParts
    this.maxLocalPartLength = Math.max(0, ...[...localParts].map((l) => l.length))
  }

  /**
   * True when `token`, folded as a lookup fragment is and with "-"/"_" read as ".", is the local
   * part of a known email (09 D-70 #1): "joy-hall830" in a story slug is "joy.hall830".
   */
  isLocalPart(token: string): boolean {
    return this.localParts.has(foldSeparators(normalizeQueryFragment(token)))
  }

  /**
   * True when any known email occurs anywhere in `text`, ignoring case. `text` must already be
   * normalized (shared/pii.ts normalizeForScan) — every caller in this file normalizes once at
   * its own entry point and passes the result on, so this never re-normalizes.
   */
  occursIn(text: string): boolean {
    for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) if (this.matchAt(text, at) !== null) return true
    return false
  }

  /** The [start, end) span of a known email whose "@" is at `at` in `text`, or null. */
  matchAt(text: string, at: number): readonly [number, number] | null {
    for (const [local, lengths] of this.shapes) {
      const start = at - local
      if (start < 0) continue
      for (const length of lengths) {
        const slice = text.slice(start, start + length)
        // normalizeEmail trims, so a slice starting or ending on a space would also match; the span
        // must be the address itself, or a redaction would swallow the space next to it.
        if (/^\s|\s$/u.test(slice)) continue
        const candidate = normalizeEmail(slice)
        if (candidate !== null && this.emails.has(foldSeparators(candidate))) return [start, start + length]
      }
    }
    return null
  }
}

/**
 * Every email_norm the database holds, per request (03 §No-restart: never cached). Profiles
 * carry all of them; the other tables are included so the set is "the full set" (05 §Scanner)
 * even if a row exists before its profile does.
 */
export async function loadKnownEmails(db: D1Database): Promise<KnownEmails> {
  const { results } = await db
    .prepare(
      `SELECT email_norm FROM profiles WHERE email_norm IS NOT NULL
       UNION SELECT email_norm FROM subscribers
       UNION SELECT email_norm FROM app_users WHERE email_norm IS NOT NULL
       UNION SELECT email_norm FROM web_visitors WHERE email_norm IS NOT NULL`,
    )
    .all<{ email_norm: string }>()
  return new KnownEmails(results.map((row) => row.email_norm))
}

/** The scanner's view of a payload: strings as they are, anything else as its JSON. */
function serialize(payload: unknown): string {
  if (typeof payload === 'string') return payload
  const text = JSON.stringify(payload)
  if (text === undefined) throw new Error('pii-guard: the payload has no JSON form and cannot be scanned')
  return text
}

/**
 * Every normalized-text span (09 D-79) that is a known local part at a non-alphanumeric
 * boundary — the one scan both the outbound detector (findPII) and Gate 1's redaction
 * (redactKnownLocalParts) run; neither keeps its own copy. `text` must already be normalized.
 */
function findLocalPartSpans(text: string, known: KnownEmails): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = []
  for (const m of text.matchAll(new RegExp(LOCAL_PART_TOKEN.source, 'gi'))) {
    const token = m[0]
    const base = m.index
    let i = 0
    while (i < token.length) {
      let end = -1
      if (ALNUM.test(token[i]) && (i === 0 || !ALNUM.test(token[i - 1]))) {
        const last = Math.min(token.length, i + known.maxLocalPartLength)
        for (let e = last; e >= i + LOCAL_PART_MIN_CHARS; e--) {
          if (e < token.length && ALNUM.test(token[e])) continue
          if (known.isLocalPart(token.slice(i, e))) {
            end = e
            break
          }
        }
      }
      if (end > 0) {
        spans.push([base + i, base + end])
        i = end
      } else {
        i += 1
      }
    }
  }
  return spans
}

/**
 * Builds the redacted ORIGINAL text from `spans` (normalized-text coordinates, ascending, from
 * `normalized`): everything between spans is copied from the original exactly as typed, and each
 * span's original range — however many original characters its disguise took — becomes
 * `replacement`. Shared by redactEmails and redactKnownLocalParts so a disguise is mapped back to
 * the original exactly once, the same way for both.
 */
function applySpans(
  original: string,
  normalized: NormalizedScan,
  spans: Array<readonly [number, number]>,
  replacement: string,
): { text: string; count: number } {
  let result = ''
  let lastOrigEnd = 0
  let count = 0
  for (const [ns, ne] of spans) {
    const [os, oe] = normalized.mapToOriginal(ns, ne)
    result += original.slice(lastOrigEnd, os) + replacement
    lastOrigEnd = oe
    count += 1
  }
  result += original.slice(lastOrigEnd)
  return { text: result, count }
}

/**
 * The four checks, in order, over one raw text: the shape checks (email pattern, raw id) on the
 * conservative normalization, the membership checks (a stored email, a stored local part) on the
 * aggressive one, which only a real subscriber's address can match (09 D-79).
 */
function checkText(raw: string, known: KnownEmails): PiiCheck | null {
  const shape = normalizeForScan(raw).text
  const member = normalizeForMembership(raw).text
  if (known.occursIn(member)) return 'known_email'
  if (EMAIL_REGEX.test(shape)) return 'email_pattern'
  if (RAW_ID_REGEX.test(shape)) return 'raw_id'
  if (findLocalPartSpans(member, known).length > 0) return 'known_local_part'
  return null
}

/**
 * Collects every string a person or the model actually wrote inside `payload` (every string
 * value and every object key, at any depth), so each can be normalized and scanned on its own
 * characters rather than on `JSON.stringify`'s escaped form of them (09 D-79 fixer round: a real
 * newline or tab inside a string becomes the two characters `\n`/`\t` once serialized, which the
 * `\s*`-based disguise mappings in `shared/pii.ts` never see as whitespace — "press\n[at]\nexample"
 * reached the model because only the serialized, still-escaped text was ever scanned).
 */
function collectLeafStrings(payload: unknown, out: string[]): void {
  if (typeof payload === 'string') {
    out.push(payload)
  } else if (Array.isArray(payload)) {
    for (const v of payload) collectLeafStrings(v, out)
  } else if (payload !== null && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload)) {
      out.push(k)
      collectLeafStrings(v, out)
    }
  }
}

/**
 * The first check `payload` fails, or null when it is clean. Pure. Checked in this order: a
 * stored email anywhere in the text, the email shape on its own, a raw id, and (09 D-79, closing
 * the gap the self-audit found) a known local part with no "@" at all — the path a webhook
 * `link` like `…/u/joy.hall830` takes.
 *
 * Two passes (09 D-79 fixer round): first the whole payload serialized to one string (catches a
 * match that spans two fields, or a match inside a bare string payload), then, when `payload` is
 * not already a bare string, every individual string value and object key on its own
 * (collectLeafStrings) — the pass that sees a disguise written with a real newline or tab, which
 * JSON.stringify would otherwise turn into the two characters `\`+`n`/`\`+`t` before any check
 * ran. Every text normalizeForScan sees is normalized once, never raw.
 */
export function findPII(payload: unknown, known: KnownEmails): PiiCheck | null {
  const wholeHit = checkText(serialize(payload), known)
  if (wholeHit !== null) return wholeHit
  if (typeof payload !== 'string') {
    const leaves: string[] = []
    collectLeafStrings(payload, leaves)
    for (const leaf of leaves) {
      const hit = checkText(leaf, known)
      if (hit !== null) return hit
    }
  }
  return null
}

/** 500 `blocked_pii` (04). Carries which check fired and where; never the matched text. */
export class PiiBlockedError extends ApiError {
  readonly check: PiiCheck
  readonly site: PiiSite
  constructor(check: PiiCheck, site: PiiSite) {
    super(
      500,
      'blocked_pii',
      'The assistant stopped this request because a personal-data check failed. Nothing more was sent to the model.',
      [{ check, site }],
    )
    this.name = 'PiiBlockedError'
    this.check = check
    this.site = site
  }
}

/** Throws `PiiBlockedError` if `payload` fails any check (05 §Scanner). Pure. */
export function assertNoPII(payload: unknown, known: KnownEmails, site: PiiSite): void {
  const check = findPII(payload, known)
  if (check !== null) throw new PiiBlockedError(check, site)
}

/**
 * `assertNoPII` plus the loud half of a block: one log line naming the check and the site, and
 * an awaited `ai_audit` row `kind=blocked, status=blocked` under the request's trace (05
 * §Scanner, 03 row 11). The row stores no payload, because the payload is what failed.
 */
export async function guardPayload(
  trace: AuditTrace,
  payload: unknown,
  site: PiiSite,
  toolName: string | null = null,
): Promise<void> {
  try {
    assertNoPII(payload, trace.knownEmails, site)
  } catch (err) {
    if (!(err instanceof PiiBlockedError)) throw err
    console.error(
      JSON.stringify({ at: 'pii-guard', trace_id: trace.traceId, error: 'blocked_pii', check: err.check, site, tool_name: toolName }),
    )
    await trace.write({ kind: 'blocked', status: 'blocked', tool_name: toolName, error: `blocked_pii: ${err.check} in ${site}` })
    throw err
  }
}

/** The only way to log a model payload (05 §Scanner): scanned first, so an email is never logged. */
export function logModelPayload(at: string, payload: unknown, known: KnownEmails): void {
  assertNoPII(payload, known, 'log')
  console.log(JSON.stringify({ at, payload }))
}

/**
 * Gate 1's email redaction of user text (03 row 2): every email-shaped span, including a
 * disguised one (09 D-79, shared/pii.ts normalizeForScan), becomes `[email]`; everything else in
 * `text` is copied back exactly as typed (applySpans). The shared regex has no `g` flag
 * (shared/pii.ts), so a global copy is made here per call.
 */
export function redactEmails(text: string): { text: string; count: number } {
  const normalized = normalizeForScan(text)
  const spans: Array<readonly [number, number]> = [...normalized.text.matchAll(new RegExp(EMAIL_REGEX.source, 'gi'))].map((m) => [
    m.index,
    m.index + m[0].length,
  ])
  return applySpans(text, normalized, spans, '[email]')
}

/**
 * Gate 1's local-part redaction (09 D-70 #1): a known email's local part typed without its
 * domain ("is joy.hall830 engaged?"), disguised or not, becomes `[email]` too. Only whole tokens
 * count: a maximal run of local-part characters (shared/pii.ts LOCAL_PART_TOKEN), as typed or
 * less any leading or trailing `. _ % + -` (sentence punctuation, "joy.hall830-"), must equal a
 * known local part of at least LOCAL_PART_MIN_CHARS characters, so "joy.hall8301" or
 * "joy.hall83" stay as typed. Run after `redactEmails`, whose `[email]` holds no token that
 * long. Shares `findLocalPartSpans` with the outbound detector (findPII), so the two never drift.
 */
export function redactKnownLocalParts(text: string, known: KnownEmails): { text: string; count: number } {
  // On the membership normalization, so a stored address spaced any way ("joy .hall830@protonmail
  // .com") is redacted whole, not just its local part (09 D-79, self-audit at 1200107).
  const normalized = normalizeForMembership(text)
  const spans = [...knownEmailSpans(normalized.text, known), ...findLocalPartSpans(normalized.text, known)].sort((a, b) => a[0] - b[0])
  const merged: Array<readonly [number, number]> = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span[0] < last[1]) merged[merged.length - 1] = [last[0], Math.max(last[1], span[1])]
    else merged.push(span)
  }
  return applySpans(text, normalized, merged, '[email]')
}

/** Every normalized-text span that is a stored email (the same lookup as KnownEmails.occursIn). */
function knownEmailSpans(text: string, known: KnownEmails): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = []
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    const hit = known.matchAt(text, at)
    if (hit !== null) spans.push(hit)
  }
  return spans
}

/**
 * A redaction for a 400 `details` line or a `console.warn`/`console.error` log (09 D-70 item 1):
 * normalizes first (shared/pii.ts normalizeForScan, so a disguised "@" redacts exactly as a
 * plain one would), then runs `redactEmails`, then masks any `RAW_ID_REGEX` match (`u_`/`d_`/`v_`
 * + hex) as `[id]`. Still incomplete on its own: `RAW_ID_REGEX`'s `\b` never fires between two
 * word characters (misses a raw id glued to a letter, e.g. "xu_ceed5f12"), and it never runs
 * `redactKnownLocalParts` (no bound `KnownEmails` at this call site), so a bare known local part
 * with no "@" passes through untouched.
 *
 * `worker/routes/segments.ts` (readBody's unknown field, filtersFrom's rethrown problems) runs
 * every detail through this function, but as a backstop only (fixer round 4): the real defense
 * there is that an unknown filter key or body field is never interpolated into the message text
 * at all ("unknown filter" / "unknown field", with no key), so none of this function's blind
 * spots can leak through that route. A future caller that does interpolate client text should not
 * rely on this function alone for a value it cannot afford to leak.
 */
export function redactDetail(text: string): string {
  const { text: withoutEmails } = redactEmails(text)
  return withoutEmails.replace(new RegExp(RAW_ID_REGEX.source, 'gi'), '[id]')
}

const ALNUM = /[a-z0-9]/i
