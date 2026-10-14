// Plain words for stored values, column names and filter keys (06 §UI principles 4). Display maps
// only: the values sent to the API and the raw names shown in Technical details stay as they are.
// /segments and /insights read the same maps, so a subscriber's fields carry the same words on each.
// Field words are the brief's own (06 §Vocabulary, 09 D-66): Signup date, Acquisition source, Last open date, UTM source.

import type { DefinitionKey } from '../shared/derive'
import type { DataQualityCheckKey } from './types'

/** Signup sources as stored (02 §Normalization: canonical lowercase) → display words. */
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
  with_app_after_signup: 'Got the app after signing up',
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

/** Plain headings for the definitions (02 §Derived), on /insights; the raw names show only in Technical details. */
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
