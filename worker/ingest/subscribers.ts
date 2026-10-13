/**
 * Subscriber ingest: quarantine, normalize, dedupe (02 §Quarantine, §Dedupe, R1.3,
 * 09 D-27, D-28). Pure: a parsed CSV in, records and quarantined rows out; the seed script
 * (scripts/csv2sql) does the file I/O and the SQL.
 */
import { canonicalSource, normalizeEmail } from '../../shared/normalize'
import type { ParsedCsv } from './csv'
import {
  classifySubscriberRow,
  requireHeaders,
  SUBSCRIBER_COLUMNS,
  type QuarantineReason,
  type SubscriberStatus,
} from './quarantine'

export interface Subscriber {
  email_norm: string
  /** The first spelling seen, exactly as in the file. */
  email_raw: string
  signup_date: string
  status: SubscriberStatus
  /** Canonical source (02 §Normalization); `null` when blank. */
  source: string | null
  /** `null` = never opened. */
  last_open_date: string | null
  /** Source rows collapsed into this record. */
  merged_count: number
}

export interface QuarantinedRow {
  line_no: number
  reason: QuarantineReason
  /** The row re-serialized as one CSV record. PII possible; never in a view (01). */
  raw_row: string
}

export interface SubscriberIngest {
  subscribers: Map<string, Subscriber>
  quarantined: QuarantinedRow[]
}

function toCsvRecord(row: readonly string[]): string {
  return row.map((f) => (/[",\r\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(',')
}

/**
 * Merge precedence (02 §Dedupe, D-27): earliest `signup_date`, latest non-null
 * `last_open_date`, `unsubscribed` if any row says so, `source` from the earliest-signup
 * row (the earlier-seen row on a tie), first `email_raw`, `merged_count` summed.
 */
function merge(kept: Subscriber, next: Subscriber): Subscriber {
  const nextIsEarlier = next.signup_date < kept.signup_date
  const opens = [kept.last_open_date, next.last_open_date].filter((d): d is string => d !== null)
  return {
    email_norm: kept.email_norm,
    email_raw: kept.email_raw,
    signup_date: nextIsEarlier ? next.signup_date : kept.signup_date,
    status: kept.status === 'unsubscribed' || next.status === 'unsubscribed' ? 'unsubscribed' : 'active',
    source: nextIsEarlier ? next.source : kept.source,
    last_open_date: opens.length === 0 ? null : opens.reduce((a, b) => (b > a ? b : a)),
    merged_count: kept.merged_count + next.merged_count,
  }
}

export function ingestSubscribers(csv: ParsedCsv): SubscriberIngest {
  const col = requireHeaders('subscribers.csv', csv.header, SUBSCRIBER_COLUMNS)
  const subscribers = new Map<string, Subscriber>()
  const quarantined: QuarantinedRow[] = []

  csv.rows.forEach((row, i) => {
    const lineNo = csv.lineNos[i]
    const reason = classifySubscriberRow(csv.header, row, lineNo)
    if (reason !== null) {
      quarantined.push({ line_no: lineNo, reason, raw_row: toCsvRecord(row) })
      return
    }

    const emailRaw = row[col.email]
    const emailNorm = normalizeEmail(emailRaw)
    if (emailNorm === null) {
      throw new Error(`subscribers.csv line ${lineNo}: email passed quarantine but did not normalize`)
    }
    const lastOpen = row[col.last_open_date].trim()
    const record: Subscriber = {
      email_norm: emailNorm,
      email_raw: emailRaw,
      signup_date: row[col.signup_date].trim(),
      status: row[col.status].trim() as SubscriberStatus,
      source: canonicalSource(row[col.acquisition_source]),
      last_open_date: lastOpen === '' ? null : lastOpen,
      merged_count: 1,
    }
    const kept = subscribers.get(record.email_norm)
    subscribers.set(record.email_norm, kept ? merge(kept, record) : record)
  })

  return { subscribers, quarantined }
}
