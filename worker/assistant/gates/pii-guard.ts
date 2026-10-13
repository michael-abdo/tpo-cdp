// The outbound PII scanner (design 05 §Scanner; 03 §Gateway layers row 5). New in the port:
// the origin had no model-side PII control at all (14 §3.6, §5.3).
//
// `assertNoPII` serializes a payload and checks three things, in this order:
//   1. known_email   — membership against every email_norm in the database (loaded per request)
//   2. email_pattern — the case-insensitive email regex (shared/pii.ts EMAIL_REGEX)
//   3. raw_id        — raw app user, device or web visitor ids (shared/pii.ts RAW_ID_REGEX)
// A hit throws `PiiBlockedError` (500 `blocked_pii`, 04 §POST /api/assistant). It never redacts
// and retries, never degrades, and never echoes the matched value in a message or a log line.

import { normalizeEmail } from '../../../shared/normalize'
import { EMAIL_REGEX, RAW_ID_REGEX } from '../../../shared/pii'
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

  constructor(emails: Iterable<string>) {
    const set = new Set<string>()
    const shapes = new Map<number, Set<number>>()
    for (const email of emails) {
      const at = email.indexOf('@')
      if (at <= 0 || at !== email.lastIndexOf('@') || normalizeEmail(email) !== email) {
        // Never echo the value: it is an email or something that should have been one.
        throw new Error('pii-guard: a known email is not a normalized address with exactly one "@"')
      }
      set.add(email)
      let lengths = shapes.get(at)
      if (lengths === undefined) shapes.set(at, (lengths = new Set()))
      lengths.add(email.length)
    }
    this.emails = set
    this.size = set.size
    this.shapes = new Map([...shapes].map(([local, lengths]) => [local, [...lengths]]))
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
  const text = serialize(payload)
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
