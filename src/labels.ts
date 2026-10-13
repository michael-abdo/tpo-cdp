// Plain words for stored values, column names and filter keys (06 §UI principles 4). Display maps
// only: the values sent to the API and the raw names shown in Technical details stay as they are.
// /segments and /assistant read the same maps, so a reader's fields carry the same words on both.

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
  pkey: 'Reader key',
  status: 'Status',
  source: 'Signed up from',
  signup_date: 'Signed up',
  last_open_date: 'Last opened',
  engagement_score: 'Engagement',
  has_app: 'Uses the app',
  signup_month: 'Signup month',
  cold_month: 'Month they went cold',
  first_page: 'First page visited',
  utm_source: 'Campaign source',
  event: 'App event',
  subscribers: 'Subscribers',
  cold: 'Cold readers',
  went_cold: 'Went cold',
  with_app_after_signup: 'Got the app after signing up',
  rate: 'Rate',
  visitors: 'Visitors',
  subscribed: 'Subscribed',
  events: 'Events',
} as const satisfies Record<string, string>

/** Segment filter keys (FILTER_KEYS) and the aggregate inputs a model may echo in filters_applied. */
export const FILTER_LABEL: Readonly<Record<string, string>> = {
  status: 'Status',
  source: 'Signed up from',
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
