/**
 * Web ingest (02 §Quarantine, §Linking 2–3, §Time; 01 §Tables web_visitors, web_events).
 * Pure: a parsed web_events.csv in, visitor and event records out. `visitor_hash` is derived
 * later with the secret (link.ts); the seed script does the file I/O and SQL.
 */
import { canonicalSource, normalizeEmail } from '../../shared/normalize'
import type { ParsedCsv } from './csv'
import { isIsoDate, requireHeaders, type QuarantineReason } from './quarantine'
import { toCsvRecord, type QuarantinedRow } from './subscribers'

/** The columns web_events.csv must have; `utm_source` and `email` may be blank. */
export const WEB_COLUMNS = ['visitor_id', 'page', 'timestamp', 'utm_source', 'email'] as const

export type WebColumn = (typeof WEB_COLUMNS)[number]

/** The page whose `email` links a visitor to a subscriber (the brief's rule, 02 §Linking 2). */
export const SUBSCRIBE_PAGE = '/subscribe'

/**
 * Whether a row's page is the subscribe page (09 D-70 item 9): its path with any query string and
 * one trailing slash removed equals SUBSCRIBE_PAGE, so `/subscribe?utm_source=instagram` and
 * `/subscribe/` link like `/subscribe`. The page itself is stored as written.
 */
export function isSubscribePage(page: string): boolean {
  const query = page.indexOf('?')
  const path = query === -1 ? page : page.slice(0, query)
  return path === SUBSCRIBE_PAGE || path === `${SUBSCRIBE_PAGE}/`
}

/** The CSV's own timestamp format, `YYYY-MM-DD HH:MM:SS`, nothing looser (02 §Quarantine). */
const CSV_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/

/**
 * A zone-less CSV timestamp is UTC (02 §Time, 09 D-16) and is stored as
 * `YYYY-MM-DDTHH:MM:SSZ`. Returns `null` when the value is not in the CSV's format.
 */
export function csvTimestampToIso(value: string): string | null {
  const match = CSV_TIMESTAMP.exec(value)
  if (!match || !isIsoDate(match[1])) return null
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`
}

export interface WebEvent {
  visitor_id: string
  page: string
  /** ISO-8601 UTC, `YYYY-MM-DDTHH:MM:SSZ`. */
  event_ts: string
  /** Canonical (02 §Normalization); `null` when blank. */
  utm_source: string | null
  /** 1-based file line, kept for the error messages of later steps. */
  line_no: number
}

export interface WebVisitor {
  visitor_id: string
  /** From the visitor's `/subscribe` row carrying an email; `null` = anonymous (02 §Linking 3). */
  email_norm: string | null
  first_seen_ts: string
  first_page: string
  /** The canonical UTM of the visitor's first event (the landing touch); `null` when it had none. */
  first_utm_source: string | null
  /** `event_ts` of the `/subscribe` row carrying the email (the signup moment); `null` exactly when `email_norm` is. */
  signup_ts: string | null
}

export interface WebIngest {
  /** In file order. */
  events: WebEvent[]
  /** Keyed by `visitor_id`, in order of first appearance. */
  visitors: Map<string, WebVisitor>
  quarantined: QuarantinedRow[]
}

/**
 * Classifies one web_events.csv row: `null` when it can become an event, otherwise its
 * quarantine reason. Tested in order: blank_row, a blank `visitor_id`/`page`/`timestamp`
 * (missing_field), a non-blank email that does not normalize (invalid_email), then the
 * timestamp format (bad_date).
 */
export function classifyWebRow(header: readonly string[], row: readonly string[]): QuarantineReason | null {
  const col = requireHeaders('web_events.csv', header, WEB_COLUMNS)
  const value = (c: WebColumn) => row[col[c]].trim()

  if (row.every((field) => field.trim() === '')) return 'blank_row'
  if (value('visitor_id') === '' || value('page') === '' || value('timestamp') === '') return 'missing_field'
  const email = value('email')
  if (email !== '' && normalizeEmail(email) === null) return 'invalid_email'
  if (csvTimestampToIso(value('timestamp')) === null) return 'bad_date'
  return null
}

/**
 * Builds events and visitors. A visitor's first event is its earliest `event_ts` (the earlier
 * line on a tie). An email on a row other than `/subscribe`, or two different emails for one
 * visitor, has no rule in 02 and throws with the line number rather than being guessed.
 */
export function ingestWeb(csv: ParsedCsv): WebIngest {
  const col = requireHeaders('web_events.csv', csv.header, WEB_COLUMNS)
  const events: WebEvent[] = []
  const visitors = new Map<string, WebVisitor>()
  const quarantined: QuarantinedRow[] = []

  csv.rows.forEach((row, i) => {
    const lineNo = csv.lineNos[i]
    const reason = classifyWebRow(csv.header, row)
    if (reason !== null) {
      quarantined.push({ line_no: lineNo, reason, raw_row: toCsvRecord(row) })
      return
    }

    const visitorId = row[col.visitor_id].trim()
    const page = row[col.page].trim()
    const eventTs = csvTimestampToIso(row[col.timestamp].trim())
    if (eventTs === null)
      throw new Error(`web_events.csv line ${lineNo}: timestamp passed quarantine but did not parse`)
    const utm = canonicalSource(row[col.utm_source])
    const rawEmail = row[col.email].trim()
    const emailNorm = rawEmail === '' ? null : normalizeEmail(rawEmail)

    if (emailNorm !== null && !isSubscribePage(page)) {
      throw new Error(
        `web_events.csv line ${lineNo}: email on page "${page}"; only ${SUBSCRIBE_PAGE} rows link (02 §Linking 2)`,
      )
    }

    events.push({ visitor_id: visitorId, page, event_ts: eventTs, utm_source: utm, line_no: lineNo })

    const known = visitors.get(visitorId)
    if (!known) {
      visitors.set(visitorId, {
        visitor_id: visitorId,
        email_norm: emailNorm,
        first_seen_ts: eventTs,
        first_page: page,
        first_utm_source: utm,
        signup_ts: emailNorm === null ? null : eventTs,
      })
      return
    }
    if (emailNorm !== null) {
      if (known.email_norm !== null && known.email_norm !== emailNorm) {
        throw new Error(`web_events.csv line ${lineNo}: visitor has a second, different /subscribe email`)
      }
      known.email_norm = emailNorm
      // The same email on two /subscribe rows: the earlier one is the signup.
      if (known.signup_ts === null || eventTs < known.signup_ts) known.signup_ts = eventTs
    }
    if (eventTs < known.first_seen_ts) {
      known.first_seen_ts = eventTs
      known.first_page = page
      known.first_utm_source = utm
    }
  })

  return { events, visitors, quarantined }
}
