// Plain words for stored values, column names and filter keys: the screens never show a raw code
// name as a label. Display maps
// only: the values sent to the API and the raw names shown in Technical details stay as they are.
// /segments and /insights read the same maps, so a subscriber's fields carry the same words on each.
// Field words are the brief's own: Signup date, Acquisition source, Last open date, UTM source.

import type { DefinitionKey } from '../shared/derive'
import { FILTER_KEYS, type FilterKey, type SegmentFilters } from '../shared/segment-filters'
import type { DataQualityCheckKey } from './types'

/** Signup sources as stored (canonical lowercase, shared/normalize.ts) → display words. */
export const SOURCE_LABEL: Readonly<Record<string, string>> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  referral: 'Referral',
  google: 'Google',
  direct: 'Direct',
  podcast: 'Podcast',
  x: 'X',
}
export const STATUS_LABEL: Readonly<Record<string, string>> = { active: 'Active', unsubscribed: 'Unsubscribed' }

export const sourceLabel = (s: string | null) => (s === null ? 'Unknown' : (SOURCE_LABEL[s] ?? s))
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s

/**
 * Plain headings for the definitions (shared/derive.ts DEFINITIONS): the one home of these words.
 * /insights, /segments and every InfoTip on a definition (shared/glossary.ts explain()) read them;
 * the raw names show only in Technical details. COLUMN_LABEL's app_after_signup column reads
 * `app_after_signup` from here rather than retyping it, so the two can never drift apart.
 */
export const DEFINITION_LABEL: Record<DefinitionKey, string> = {
  days_since_open: 'Days since last open',
  cold_since: 'Cold date',
  cold: 'Cold',
  went_cold_in: 'Went cold in a month',
  no_open_in_days: "Haven't opened in N days",
  new_subscriber: 'New subscriber',
  going_cold_risk: 'At risk of going cold',
  engagement_score: 'Engagement',
  has_app: 'Uses the app',
  app_after_signup: 'Got the app after signing up',
  last_month: 'Last month',
  last_n_days: 'Last N days',
}

/**
 * Result columns the assistant's tools can return: the segment tool's rows (MODEL_SEGMENT_COLUMNS,
 * `pkey` renamed `email` after re-hydration; a stub profile keeps its key) and the aggregate
 * tool's group and count columns (builtin-handlers.ts METRICS). Wording matches /segments.
 */
export const COLUMN_LABEL = {
  email: 'Email',
  pkey: 'Profile key',
  status: 'Status',
  source: 'Acquisition source',
  signup_date: 'Signup date',
  last_open_date: 'Last open date',
  engagement_score: 'Engagement',
  has_app: 'Uses the app',
  signup_month: 'Signup month',
  cold_month: 'Month they went cold',
  first_page: 'First page visited',
  utm_source: 'UTM source',
  event: 'App event',
  subscribers: 'Subscribers',
  cold: 'Cold subscribers',
  went_cold: 'Went cold',
  with_app_after_signup: DEFINITION_LABEL.app_after_signup,
  rate: 'Rate',
  visitors: 'Visitors',
  subscribed: 'Subscribed',
  events: 'Events',
  // The built-in tiles' columns (worker/insights/board.ts panelOutput, the former Growth panels).
  with_app: 'Have the app',
  at_risk: 'At risk',
  active: 'Active subscribers',
  check: 'What we checked',
  count: 'Count',
  of: 'Out of',
} as const satisfies Record<string, string>

/** The data-quality checks (worker/insights/data-quality.ts DATA_QUALITY_CHECKS) in words; the "Gaps in the data" tile's rows. */
export const CHECK_LABEL: Record<DataQualityCheckKey, string> = {
  subscribers_without_source: 'Subscribers with no acquisition source',
  subscribers_unexpected_source: 'Subscribers with an acquisition source we don’t recognise',
  page_views_without_utm: 'Site visits with no UTM source',
  page_views_unexpected_utm: 'Site visits with a UTM source we don’t recognise',
  app_users_not_on_list: 'App accounts whose email is not a subscriber',
}

export const checkLabel = (key: string) => (CHECK_LABEL as Record<string, string | undefined>)[key] ?? words(key)

/** Segment filter keys (FILTER_KEYS) and the aggregate inputs a model may echo in filters_applied. */
export const FILTER_LABEL: Readonly<Record<string, string>> = {
  status: 'Status',
  source: 'Acquisition source',
  days_since_open_gte: "Haven't opened an email in at least",
  include_never_opened: 'Also includes people who never opened',
  has_app: 'Uses the app',
  signed_up_within_days: 'Signed up in the last N days',
  went_cold: 'Went cold',
  engagement_gte: 'Engagement at least',
  engagement_lte: 'Engagement at most',
  site_visit_within_days: 'Visited the site in the last N days',
  site_visit_page: 'Page visited',
  app_active_within_days: 'Used the app in the last N days',
  app_event: 'App event',
  metric: 'Measure',
  group_by: 'Grouped by',
  window_from: 'From',
  window_to: 'To',
}

/** A name with no entry above as words: `went_cold` → `Went cold`. Only a fallback for names no map knows. */
export function words(name: string): string {
  const spaced = name.replace(/_/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export const columnLabel = (name: string) => (COLUMN_LABEL as Record<string, string | undefined>)[name] ?? words(name)
export const filterLabel = (name: string) => (FILTER_LABEL as Record<string, string | undefined>)[name] ?? words(name)

/** `2026-08` → `August 2026` (`long`) or `Aug 2026` (`short`); the digits are read as written, in UTC. */
export function monthLabel(month: string, style: 'long' | 'short' = 'long'): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month)
  if (m === null) return month
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
  return date.toLocaleString('en-US', { month: style, year: 'numeric', timeZone: 'UTC' })
}

const n = (value: number) => value.toLocaleString('en-US')
const days = (value: number) => (value === 1 ? '1 day' : `${n(value)} days`)

/** "a", "a and b", "a, b and c" (how segment labels join their parts). */
function joined(items: string[], last: string): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`
}

/**
 * The clause each filter key adds after "who", or null when the key adds none. Keys read in pairs
 * (include_never_opened with days_since_open_gte, the engagement range, a page with its visit
 * window, an event with its app window) speak once, at the first key of the pair. Typed over every
 * FilterKey, so a new key cannot ship without words.
 */
const CLAUSE: { readonly [K in FilterKey]: (f: SegmentFilters) => string | null } = {
  status: () => null,
  source: () => null,
  days_since_open_gte: (f) =>
    f.days_since_open_gte === undefined
      ? null
      : f.include_never_opened
        ? `haven't opened in ${days(f.days_since_open_gte)}`
        : `last opened ${n(f.days_since_open_gte)} or more days ago`,
  include_never_opened: () => null,
  has_app: (f) => (f.has_app === true ? 'have an app account' : f.has_app === false ? 'have no app account' : null),
  signed_up_within_days: (f) =>
    f.signed_up_within_days === undefined ? null : `signed up in the last ${days(f.signed_up_within_days)}`,
  went_cold: (f) =>
    f.went_cold === undefined ? null : f.went_cold === 'any' ? 'have gone cold' : `went cold in ${monthLabel(f.went_cold)}`,
  engagement_gte: (f) => {
    const { engagement_gte: gte, engagement_lte: lte } = f
    if (gte !== undefined && lte !== undefined) return `have engagement from ${n(gte)} to ${n(lte)}`
    if (gte !== undefined) return `have engagement of ${n(gte)} or more`
    if (lte !== undefined) return `have engagement of ${n(lte)} or less`
    return null
  },
  engagement_lte: () => null,
  site_visit_within_days: (f) => {
    const { site_visit_within_days: within, site_visit_page: page } = f
    if (page !== undefined) return within === undefined ? `visited ${page}` : `visited ${page} in the last ${days(within)}`
    return within === undefined ? null : `visited the site in the last ${days(within)}`
  },
  site_visit_page: () => null,
  app_active_within_days: (f) => {
    const { app_active_within_days: within, app_event: event } = f
    if (within === undefined && event === undefined) return null
    return `used the app${event === undefined ? '' : ` (${event})`}${within === undefined ? '' : ` in the last ${days(within)}`}`
  },
  app_event: () => null,
}

/**
 * A segment's filters as one sentence in the brief's words: the
 * one home of segment names, read by Previous searches and the result line on /segments. Subject
 * (by source and status), then "who" and each key's clause in FILTER_KEYS order. The brief's
 * preset reads "Instagram subscribers who haven't opened in 30 days".
 */
export function segmentLabel(f: SegmentFilters): string {
  const active = f.status.includes('active')
  const unsubscribed = f.status.includes('unsubscribed')
  const onlyUnsubscribed = unsubscribed && !active
  const sources = (f.source ?? []).map((s) => sourceLabel(s))
  const clauses = FILTER_KEYS.map((key) => CLAUSE[key](f)).filter((c): c is string => c !== null)

  let subject: string
  if (sources.length === 1) subject = `${onlyUnsubscribed ? 'Unsubscribed ' : ''}${sources[0]} subscribers`
  else if (sources.length > 1) subject = `${onlyUnsubscribed ? 'Unsubscribed subscribers' : 'Subscribers'} from ${joined(sources, 'or')}`
  else if (clauses.length > 0) subject = onlyUnsubscribed ? 'Unsubscribed subscribers' : 'Subscribers'
  else subject = onlyUnsubscribed ? 'All unsubscribed subscribers' : unsubscribed ? 'All subscribers' : 'All active subscribers'

  const who = clauses.length === 0 ? '' : ` who ${joined(clauses, 'and')}`
  return `${subject}${who}${active && unsubscribed ? ', including unsubscribed' : ''}`
}
