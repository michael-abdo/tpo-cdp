/**
 * The one runtime source of every derived definition (design 02 §Derived, 09 D-46).
 *
 * Each `DEFINITIONS` entry carries the function, a plain-English doc string, the formula as
 * written in 02 and, where a segment filter compares a stored column in SQL, the comparison
 * fragment over that column with a `:today` placeholder. Values are computed here at write
 * time and stored; SQL never re-implements a formula. Three consumers render from this object
 * and nothing else: the assistant system prompt (05), the UI footers (06) and the README
 * "Definitions" table (copied from the doc strings by hand for the MVP, 11 §Scripts).
 *
 * Pure functions over plain inputs: ISO dates (`YYYY-MM-DD`, or a stored UTC timestamp whose
 * date part is used) and numbers. The only clock is `TODAY` (02 §Time); `Date.now()` is never
 * called here.
 */
import { TODAY } from './config'

const DAY_MS = 86_400_000

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/

/**
 * UTC midnight (ms) of the date part of an ISO date or stored UTC timestamp.
 * Throws on anything else: a bad date reaching derive is an ingest bug, not a value to guess at.
 */
function dayMs(value: string): number {
  const match = ISO_DAY.exec(value)
  if (!match) throw new Error(`derive: not an ISO date: ${JSON.stringify(value)}`)
  const [, y, m, d] = match
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d))
  if (toIsoDate(ms) !== `${y}-${m}-${d}`) {
    throw new Error(`derive: not a calendar date: ${JSON.stringify(value)}`)
  }
  return ms
}

/** `YYYY-MM-DD` for a UTC midnight timestamp. */
export function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayMs(to) - dayMs(from)) / DAY_MS)
}

/** `date + n` calendar days as `YYYY-MM-DD`. */
export function addDays(date: string, n: number): string {
  return toIsoDate(dayMs(date) + n * DAY_MS)
}

export interface DateWindow {
  from: string
  to: string
}

/** `TODAY − N .. TODAY` (02 §Derived "last N days"). */
export function lastNDays(n: number): DateWindow {
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`derive: lastNDays needs a non-negative integer, got ${n}`)
  return { from: addDays(TODAY, -n), to: TODAY }
}

/** The previous calendar month relative to TODAY: `{ from: '2026-08-01', to: '2026-08-31' }` (09 D-10). */
export function lastMonth(): DateWindow {
  const today = new Date(dayMs(TODAY))
  const from = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)
  const to = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)
  return { from: toIsoDate(from), to: toIsoDate(to) }
}

function inWindow(date: string, window: DateWindow): boolean {
  const ms = dayMs(date)
  return ms >= dayMs(window.from) && ms <= dayMs(window.to)
}

/** `max(0, TODAY − last_open_date)`; `null` if never opened. */
export function daysSinceOpen(lastOpenDate: string | null): number | null {
  if (lastOpenDate === null) return null
  return Math.max(0, daysBetween(lastOpenDate, TODAY))
}

/** `(last_open_date ?? signup_date) + 30 days`. */
export function coldSince(lastOpenDate: string | null, signupDate: string): string {
  return addDays(lastOpenDate ?? signupDate, 30)
}

/** `cold_since <= TODAY` (09 D-10). */
export function isCold(coldSinceDate: string): boolean {
  return dayMs(coldSinceDate) <= dayMs(TODAY)
}

const ISO_MONTH = /^\d{4}-\d{2}$/

/** `cold_since` falls inside the calendar month `YYYY-MM` and is `<= TODAY`. */
export function wentColdIn(coldSinceDate: string, month: string): boolean {
  if (!ISO_MONTH.test(month)) throw new Error(`derive: month must be YYYY-MM, got ${JSON.stringify(month)}`)
  return toIsoDate(dayMs(coldSinceDate)).startsWith(month) && isCold(coldSinceDate)
}

/**
 * The brief's literal R3 filter (09 D-30): `days_since_open >= N`. With `includeNeverOpened`
 * a never-opener matches regardless of signup age; without it, never-openers never match.
 */
export function noOpenInDays(lastOpenDate: string | null, n: number, includeNeverOpened: boolean): boolean {
  const days = daysSinceOpen(lastOpenDate)
  if (days === null) return includeNeverOpened
  return days >= n
}

/** `signup_date` within `TODAY − 30 .. TODAY` (09 D-36). */
export function isNewSubscriber(signupDate: string): boolean {
  return inWindow(signupDate, lastNDays(30))
}

/**
 * Opened in the last 30 days but not in the last 14, or `cold_since` within the next 7 days
 * (09 D-31, parked with its panel).
 */
export function goingColdRisk(lastOpenDate: string | null, coldSinceDate: string): boolean {
  const openedInLast30 = lastOpenDate !== null && inWindow(lastOpenDate, lastNDays(30))
  const openedInLast14 = lastOpenDate !== null && inWindow(lastOpenDate, lastNDays(14))
  const coldWithin7 = inWindow(coldSinceDate, { from: addDays(TODAY, 1), to: addDays(TODAY, 7) })
  return (openedInLast30 && !openedInLast14) || coldWithin7
}

export interface EngagementInput {
  last_open_date: string | null
  app_events_last_30d: number
  site_visits_last_30d: number
}

/**
 * 0–100 integer: recency 50 × max(0, 1 − days_since_open/30) · app 25 × min(1, app_events_last_30d/10)
 * · site 25 × min(1, site_visits_last_30d/5). Never opened contributes 0 recency (09 D-14, D-35).
 */
export function engagementScore(input: EngagementInput): number {
  const days = daysSinceOpen(input.last_open_date)
  const recency = days === null ? 0 : 50 * Math.max(0, 1 - days / 30)
  const app = 25 * Math.min(1, Math.max(0, input.app_events_last_30d) / 10)
  const site = 25 * Math.min(1, Math.max(0, input.site_visits_last_30d) / 5)
  return Math.round(recency + app + site)
}

/** An app account exists for the subscriber's email. */
export function hasApp(appCreatedAt: string | null): boolean {
  return appCreatedAt !== null
}

/** `app_created_at > signup_date` (same day is not a conversion; 02 §Counts lists 11 same-day rows). */
export function appAfterSignup(appCreatedAt: string | null, signupDate: string): boolean {
  return appCreatedAt !== null && daysBetween(signupDate, appCreatedAt) > 0
}

export interface Definition {
  /** The row's name in 02 §Derived. */
  name: string
  /** One plain-English sentence; rendered verbatim to the model, the UI and the README. */
  doc: string
  /** The formula exactly as 02 §Derived states it. */
  formula: string
  /** SQL comparison fragment over the stored column, with `:today` bound to TODAY (09 D-46). */
  sql?: string
  fn: (...args: never[]) => unknown
}

/** One entry per row of 02 §Derived, in that order. */
export const DEFINITIONS = {
  days_since_open: {
    name: 'days_since_open',
    doc: 'Whole days between the last email open and today; a date after today counts as 0 and a subscriber who never opened has no value.',
    formula: 'max(0, TODAY − last_open_date); null if never opened',
    sql: 'julianday(:today) - julianday(last_open_date)',
    fn: daysSinceOpen,
  },
  cold_since: {
    name: 'cold_since',
    doc: 'The day a subscriber becomes cold: 30 days after their last open, or 30 days after signup if they never opened.',
    formula: '(last_open_date ?? signup_date) + 30 days',
    fn: coldSince,
  },
  cold: {
    name: 'cold',
    doc: 'True when the cold date has arrived: no open in 30 or more days, or never opened and signed up 30 or more days ago.',
    formula: 'cold_since <= TODAY',
    sql: 'cold_since <= :today',
    fn: isCold,
  },
  went_cold_in: {
    name: 'went_cold_in(month)',
    doc: 'True when the cold date falls inside the given calendar month and is not in the future.',
    formula: 'cold_since within that calendar month and <= TODAY',
    fn: wentColdIn,
  },
  no_open_in_days: {
    name: 'no open in N days',
    doc: "The brief's segment filter: at least N days since the last open, with a toggle that also includes everyone who never opened, whatever their signup date.",
    formula: 'days_since_open >= N, plus never-openers when includeNeverOpened',
    fn: noOpenInDays,
  },
  new_subscriber: {
    name: 'new_subscriber',
    doc: 'Signed up within the last 30 days including today.',
    formula: 'signup_date within TODAY − 30 .. TODAY',
    fn: isNewSubscriber,
  },
  going_cold_risk: {
    name: 'going_cold_risk',
    doc: 'Opened an email in the last 30 days but not in the last 14, or will become cold within the next 7 days.',
    formula: 'opened in the last 30 days but not in the last 14, or cold_since within the next 7 days',
    fn: goingColdRisk,
  },
  engagement_score: {
    name: 'engagement_score',
    doc: 'A 0–100 score: up to 50 points for how recently the last email was opened (full at today, none at 30+ days or never), up to 25 for app events in the last 30 days (full at 10) and up to 25 for site visits in the last 30 days (full at 5).',
    formula:
      'recency 50 × max(0, 1 − days_since_open/30) + app 25 × min(1, app_events_last_30d/10) + site 25 × min(1, site_visits_last_30d/5)',
    fn: engagementScore,
  },
  has_app: {
    name: 'has_app',
    doc: 'An app account exists with the same email as the subscriber.',
    formula: 'app account exists',
    fn: hasApp,
  },
  app_after_signup: {
    name: 'app_after_signup',
    doc: 'The app account was created on a later day than the newsletter signup, so the newsletter came first.',
    formula: 'app_created_at > signup_date',
    fn: appAfterSignup,
  },
  last_month: {
    name: 'last month',
    doc: 'The previous calendar month relative to today, 2026-08-01 to 2026-08-31.',
    formula: 'previous calendar month relative to TODAY = 2026-08-01..31',
    fn: lastMonth,
  },
  last_n_days: {
    name: 'last N days',
    doc: 'The N days up to and including today.',
    formula: 'TODAY − N .. TODAY',
    fn: lastNDays,
  },
} as const satisfies Record<string, Definition>

export type DefinitionKey = keyof typeof DEFINITIONS
