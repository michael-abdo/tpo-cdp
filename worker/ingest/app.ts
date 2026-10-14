/**
 * App user ingest (02 §Quarantine, §Linking 1; 01 §Tables app_users). Pure: a parsed
 * app_users.csv in, records and quarantined rows out.
 */
import { normalizeEmail } from '../../shared/normalize'
import type { ParsedCsv } from './csv'
import { isIsoDate, requireHeaders, type QuarantineReason } from './quarantine'
import { toCsvRecord, type QuarantinedRow } from './subscribers'

/** The columns app_users.csv must have; all three are required per row. */
export const APP_COLUMNS = ['user_id', 'email', 'created_at'] as const

export type AppColumn = (typeof APP_COLUMNS)[number]

export interface AppUser {
  user_id: string
  email_norm: string
  /** `YYYY-MM-DD`, as in the file. */
  created_at: string
  /** 1 = from app_users.csv (0 is reserved for webhook-created unknown users, 02 §Linking 4). */
  from_csv: 1
}

export interface AppIngest {
  /** Keyed by `user_id`, in file order. */
  users: Map<string, AppUser>
  quarantined: QuarantinedRow[]
}

/**
 * Classifies one app_users.csv row: `null` when it can become an app user, otherwise its
 * quarantine reason. Tested in order: blank_row, a blank email (missing_field), an email that
 * does not normalize (invalid_email), a blank `user_id`/`created_at` (missing_field), then
 * `created_at` as `YYYY-MM-DD` (bad_date) — the same order as subscribers.
 */
export function classifyAppRow(header: readonly string[], row: readonly string[]): QuarantineReason | null {
  const col = requireHeaders('app_users.csv', header, APP_COLUMNS)
  const value = (c: AppColumn) => row[col[c]].trim()

  if (row.every((field) => field.trim() === '')) return 'blank_row'
  const email = value('email')
  if (email === '') return 'missing_field'
  if (normalizeEmail(email) === null) return 'invalid_email'
  if (value('user_id') === '' || value('created_at') === '') return 'missing_field'
  if (!isIsoDate(value('created_at'))) return 'bad_date'
  return null
}

/**
 * A `user_id` seen twice has no rule in 02, so a repeat is quarantined (`duplicate_user_id`,
 * 09 D-78) rather than guessed or aborting the seed: the first row with that id is kept, the
 * later one is set aside.
 */
export function ingestApp(csv: ParsedCsv): AppIngest {
  const col = requireHeaders('app_users.csv', csv.header, APP_COLUMNS)
  const users = new Map<string, AppUser>()
  const quarantined: QuarantinedRow[] = []

  csv.rows.forEach((row, i) => {
    const lineNo = csv.lineNos[i]
    const reason = classifyAppRow(csv.header, row)
    if (reason !== null) {
      quarantined.push({ line_no: lineNo, reason, raw_row: toCsvRecord(row) })
      return
    }
    const userId = row[col.user_id].trim()
    const emailNorm = normalizeEmail(row[col.email])
    if (emailNorm === null)
      throw new Error(`app_users.csv line ${lineNo}: email passed quarantine but did not normalize`)
    if (users.has(userId)) {
      quarantined.push({ line_no: lineNo, reason: 'duplicate_user_id', raw_row: toCsvRecord(row) })
      return
    }
    users.set(userId, {
      user_id: userId,
      email_norm: emailNorm,
      created_at: row[col.created_at].trim(),
      from_csv: 1,
    })
  })

  return { users, quarantined }
}
