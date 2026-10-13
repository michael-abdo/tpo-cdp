/**
 * Quarantine rules (02 §Quarantine, 09 D-28). A row that cannot become a record is kept
 * with exactly one reason, never dropped, and is not counted. Required headers are checked
 * before any row is read so a wrong file fails fast with the file and column named.
 * Pure: plain arrays in, a reason out.
 */
import { normalizeEmail } from '../../shared/normalize'

/** The reasons in 02 §Quarantine, in the order they are tested. */
export type QuarantineReason = 'blank_row' | 'invalid_email' | 'missing_field' | 'bad_date'

/** The columns subscribers.csv must have; `acquisition_source` and `last_open_date` may be blank. */
export const SUBSCRIBER_COLUMNS = [
  'email',
  'signup_date',
  'status',
  'acquisition_source',
  'last_open_date',
] as const

export type SubscriberColumn = (typeof SUBSCRIBER_COLUMNS)[number]

/** The status values the subscribers table accepts (migrations/0001_core.sql CHECK). */
export const SUBSCRIBER_STATUSES = ['active', 'unsubscribed'] as const

export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number]

/**
 * Maps each required column to its index in `header` (names compared after trim).
 * Throws naming `file` and the first missing column.
 */
export function requireHeaders<C extends string>(
  file: string,
  header: readonly string[],
  required: readonly C[],
): Record<C, number> {
  const names = header.map((h) => h.trim())
  const index = {} as Record<C, number>
  for (const column of required) {
    const at = names.indexOf(column)
    if (at === -1) {
      throw new Error(`${file}: missing required column "${column}" (header: ${names.join(',')})`)
    }
    index[column] = at
  }
  return index
}

/** `YYYY-MM-DD` that names a real calendar day. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/**
 * Classifies one subscribers.csv row: `null` when it can become a subscriber, otherwise
 * its quarantine reason. A status that is present but not `active`/`unsubscribed` has no
 * reason in 02 §Quarantine, so it throws with the line number instead of being guessed.
 */
export function classifySubscriberRow(
  header: readonly string[],
  row: readonly string[],
  lineNo: number,
): QuarantineReason | null {
  const col = requireHeaders('subscribers.csv', header, SUBSCRIBER_COLUMNS)
  const value = (c: SubscriberColumn) => row[col[c]].trim()

  if (row.every((field) => field.trim() === '')) return 'blank_row'

  const email = value('email')
  if (email === '') return 'missing_field'
  if (normalizeEmail(email) === null) return 'invalid_email'

  const signup = value('signup_date')
  const status = value('status')
  if (signup === '' || status === '') return 'missing_field'

  const lastOpen = value('last_open_date')
  if (!isIsoDate(signup) || (lastOpen !== '' && !isIsoDate(lastOpen))) return 'bad_date'

  if (!(SUBSCRIBER_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `subscribers.csv line ${lineNo}: status "${status}" is not one of ${SUBSCRIBER_STATUSES.join('|')}`,
    )
  }
  return null
}
