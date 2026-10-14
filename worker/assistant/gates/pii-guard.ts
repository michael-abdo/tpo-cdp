// The outbound PII scanner (design 05 §Scanner; 03 §Gateway layers row 5). New in the port:
// the origin had no model-side PII control at all (14 §3.6, §5.3).
//
// `assertNoPII` serializes a payload and checks three things, in this order:
//   1. known_email   — membership against every email_norm in the database (loaded per request)
//   2. email_pattern — the case-insensitive email regex (shared/pii.ts EMAIL_REGEX)
//   3. raw_id        — raw app user, device or web visitor ids (shared/pii.ts RAW_ID_REGEX)
// A hit throws `PiiBlockedError` (500 `blocked_pii`, 04 §POST /api/assistant). It never redacts
// and retries, never degrades, and never echoes the matched value in a message or a log line.

import { normalizeEmail, normalizeQueryFragment } from '../../../shared/normalize'
import { EMAIL_REGEX, LOCAL_PART_MIN_CHARS, LOCAL_PART_TOKEN, RAW_ID_REGEX } from '../../../shared/pii'
import { ApiError } from '../../auth/middleware'
import type { AuditTrace } from '../audit/ai-audit'

export type PiiCheck = 'known_email' | 'email_pattern' | 'raw_id'

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
  private readonly emails: ReadonlySet<string>
  private readonly shapes: ReadonlyMap<number, readonly number[]>
  /** The local part of every known email with at least LOCAL_PART_MIN_CHARS characters (09 D-70 #1). */
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
      set.add(email)
      if (at >= LOCAL_PART_MIN_CHARS) localParts.add(email.slice(0, at))
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

  /** True when `token`, folded as a lookup fragment is, is the local part of a known email (09 D-70 #1). */
  isLocalPart(token: string): boolean {
    return this.localParts.has(normalizeQueryFragment(token))
  }

  /** True when any known email occurs anywhere in `text`, ignoring case. */
  occursIn(text: string): boolean {
    for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
      for (const [local, lengths] of this.shapes) {
        const start = at - local
        if (start < 0) continue
        for (const length of lengths) {
          const candidate = normalizeEmail(text.slice(start, start + length))
          if (candidate !== null && this.emails.has(candidate)) return true
        }
      }
    }
    return false
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

/** The first check `payload` fails, or null when it is clean. Pure. */
export function findPII(payload: unknown, known: KnownEmails): PiiCheck | null {
  const raw = serialize(payload)
  // A percent-encoded "@" (%40, as URLs and unsubscribe links carry it) counts as "@" (09 D-70 #1).
  const text = decodeAt(raw)
  if (known.occursIn(text)) return 'known_email'
  if (EMAIL_REGEX.test(text)) return 'email_pattern'
  if (RAW_ID_REGEX.test(text)) return 'raw_id'
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
 * Gate 1's email redaction of user text (03 row 2): every email-shaped span becomes `[email]`.
 * The shared regex has no `g` flag (shared/pii.ts), so a global copy is made here per call.
 */
export function redactEmails(text: string): { text: string; count: number } {
  let count = 0
  const redacted = text.replace(new RegExp(EMAIL_REGEX.source, 'gi'), () => {
    count += 1
    return '[email]'
  })
  return { text: redacted, count }
}

/**
 * Gate 1's local-part redaction (09 D-70 #1): a known email's local part typed without its
 * domain ("is joy.hall830 engaged?") becomes `[email]` too. Only whole tokens count: a maximal
 * run of local-part characters (shared/pii.ts LOCAL_PART_TOKEN), as typed or less any leading
 * or trailing `. _ % + -` (sentence punctuation, "joy.hall830-"), must equal a known local part
 * of at least LOCAL_PART_MIN_CHARS characters, so "joy.hall8301" or "joy.hall83" stay as typed. Run after `redactEmails`, whose
 * `[email]` holds no token that long.
 */
export function redactKnownLocalParts(text: string, known: KnownEmails): { text: string; count: number } {
  let count = 0
  const redacted = text.replace(new RegExp(LOCAL_PART_TOKEN.source, 'gi'), (token) => {
    // A known local part counts wherever it starts and ends on a non-alphanumeric boundary inside the
    // token, so "joy.hall830+x", "joy.hall830.protonmail" and "-joy.hall830" are caught, while
    // "xjoy.hall830" and "joy.hall8301" (a different word) are not. Longest match first.
    let out = ''
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
        out += '[email]'
        count += 1
        i = end
      } else {
        out += token[i]
        i += 1
      }
    }
    return out
  })
  return { text: redacted, count }
}

/** Decodes a percent-encoded "@" (%40, any case), the only escape that can hide an email from the checks. */
export function decodeAt(text: string): string {
  return text.replace(/%40/gi, '@')
}

/**
 * A redaction for a 400 `details` line or a `console.warn`/`console.error` log (09 D-70 item 1):
 * decodes a percent-encoded "@" first (so "name%40host.tld" redacts exactly as "name@host.tld"
 * would), then runs `redactEmails`, then masks any `RAW_ID_REGEX` match (`u_`/`d_`/`v_` + hex) as
 * `[id]`. It is regex-based and therefore incomplete on its own: it decodes only one level of
 * percent-encoding (misses `%2540`, a double-encoded "@"), `RAW_ID_REGEX`'s `\b` never fires
 * between two word characters (misses a raw id glued to a letter, e.g. "xu_ceed5f12"), and it
 * never runs `redactKnownLocalParts` (no bound `KnownEmails` at this call site), so a bare known
 * local part with no "@" passes through untouched.
 *
 * `worker/routes/segments.ts` (readBody's unknown field, filtersFrom's rethrown problems) runs
 * every detail through this function, but as a backstop only (fixer round 4): the real defense
 * there is that an unknown filter key or body field is never interpolated into the message text
 * at all ("unknown filter" / "unknown field", with no key), so none of this function's blind
 * spots can leak through that route. A future caller that does interpolate client text should not
 * rely on this function alone for a value it cannot afford to leak.
 */
export function redactDetail(text: string): string {
  const { text: withoutEmails } = redactEmails(decodeAt(text))
  return withoutEmails.replace(new RegExp(RAW_ID_REGEX.source, 'gi'), '[id]')
}

const ALNUM = /[a-z0-9]/i
