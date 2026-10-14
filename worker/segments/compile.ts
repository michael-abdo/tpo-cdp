// Segment filters → bound SQL (04 §/api/segments/preview, 03 §Module layout; R3, 09 D-07,
// D-30, D-46, D-69). Pure: a parsed filter object in, SQL text and its parameters out. Every value
// is a bound `?`, TODAY and every date included, so the SQL text is its own placeholders-only
// `sql_shape`. Each date comparison is a `DEFINITIONS.*.sql` fragment from shared/derive.ts with
// its dates computed there (lastNDays, wentColdWindow), never a re-typed formula. Source values are
// canonicalized by shared/normalize.ts, never by SQL (02 §Normalization). The filter keys, their
// limits and patterns live in shared/segment-filters.ts (19 §5.5); this file is their one
// validator. The builder's SQL reads tables for the subscriber row: its rows carry the email,
// which the UI may see (03 §Other request flows). The assistant's segment tool compiles the same
// filters, through the same WHERE builder, over v_profiles (`compileModelSegment`), so the
// model's tool never reads a table. Site visits and app activity are, in both, an uncorrelated
// `pkey IN (SELECT pkey FROM v_web_events | v_app_events …)` (19 §0 F3, §4): the identity rule of
// app events lives once, in v_app_events, and only positive filters exist, because those views'
// pkey is NULL for anonymous rows and `NOT IN` over a NULL is never true.

import { APP_EVENTS, type AppEventName } from '../../shared/app-events'
import { TODAY } from '../../shared/config'
import { DEFINITIONS, type DateWindow, lastNDays, wentColdWindow } from '../../shared/derive'
import { canonicalSource } from '../../shared/normalize'
import {
  ENGAGEMENT_MAX,
  ENGAGEMENT_MIN,
  FILTER_KEYS,
  type SegmentFilters,
  SITE_PAGE_PATTERN,
  WENT_COLD_ANY,
  WENT_COLD_PATTERN,
  WITHIN_DAYS_MAX,
  WITHIN_DAYS_MIN,
} from '../../shared/segment-filters'
import { ApiError } from '../auth/middleware'
import { SUBSCRIBER_STATUSES, type SubscriberStatus } from '../ingest/quarantine'
import type { SqlValue } from '../ingest/sql'

/** The validated filter object and its keys: one home, shared/segment-filters.ts (19 §5.5). */
export { FILTER_KEYS, type SegmentFilters }

export interface CompiledSegment {
  /** One SELECT over the segment's rows in the 04 export column order, ordered by email. */
  sql: string
  params: SqlValue[]
  /** The SQL with placeholders only (04): the same text, since no value is ever inlined. */
  sql_shape: string
}

/** Columns of a segment row, in the 04 §/api/segments/export.csv order. */
export const SEGMENT_COLUMNS = [
  'email',
  'status',
  'source',
  'signup_date',
  'last_open_date',
  'engagement_score',
  'has_app',
] as const

/** One segment row as the routes return it; has_app is a boolean, not SQLite's 0/1. */
export interface SegmentRow {
  email: string
  status: SubscriberStatus
  source: string | null
  signup_date: string
  last_open_date: string | null
  engagement_score: number
  has_app: boolean
}

/** One row of the compiled SELECT as D1 returns it. */
export interface RawSegmentRow extends Omit<SegmentRow, 'engagement_score' | 'has_app'> {
  /** `null` only if the LEFT JOIN found no profile, which the seed never produces. */
  engagement_score: number | null
  has_app: number
}

/**
 * D1 row → SegmentRow. A subscriber without a profile fails loud rather than being exported
 * with an invented score; the message names no email (04 §Error envelope).
 */
export function toSegmentRow(raw: RawSegmentRow): SegmentRow {
  if (raw.engagement_score === null) {
    throw new Error('segments: a subscriber row has no profile, so no engagement_score (02 §Linking)')
  }
  if (raw.has_app !== 0 && raw.has_app !== 1) {
    throw new Error(`segments: has_app must be 0 or 1, got ${JSON.stringify(raw.has_app)}`)
  }
  return { ...raw, engagement_score: raw.engagement_score, has_app: raw.has_app === 1 }
}

const DEFAULT_STATUS: SubscriberStatus[] = ['active']

/**
 * The days-since-open fragment with its `:today` placeholder turned into a positional `?`
 * (D1 binds positional parameters). Fails at module load if derive.ts ever drops the
 * placeholder, rather than compiling SQL that silently ignores TODAY.
 */
const DAYS_SINCE_OPEN_SQL = (() => {
  const fragment = DEFINITIONS.days_since_open.sql
  const parts = fragment.split(':today')
  if (parts.length !== 2) {
    throw new Error(`segments: DEFINITIONS.days_since_open.sql must hold exactly one :today, got ${JSON.stringify(fragment)}`)
  }
  return parts.join('?')
})()

/** A DEFINITIONS window fragment split at its column: `<column><rest>`, `:name`s turned into `?` in order. */
interface WindowFragment {
  column: 'cold_since' | 'signup_date'
  rest: string
  names: readonly string[]
}

/**
 * Checks at module load that `fragment` starts with `column` and holds exactly the placeholders
 * `names`, in that order, and turns each into a positional `?` (D1 binds positional
 * parameters). Fails loud if derive.ts changes a fragment's shape, rather than compiling SQL that
 * binds the wrong date.
 */
function windowFragment(fragment: string, column: WindowFragment['column'], names: readonly string[]): WindowFragment {
  const found = [...fragment.matchAll(/:(\w+)/g)].map((m) => m[1])
  if (!fragment.startsWith(`${column} `) || JSON.stringify(found) !== JSON.stringify(names)) {
    throw new Error(`segments: DEFINITIONS fragment ${JSON.stringify(fragment)} must compare ${column} with ${names.map((n) => `:${n}`).join(', ')}`)
  }
  return { column, rest: fragment.slice(column.length).replace(/:\w+/g, '?'), names }
}

const COLD_NOW = windowFragment(DEFINITIONS.cold.sql, 'cold_since', ['today'])
const WENT_COLD_IN = windowFragment(DEFINITIONS.went_cold_in.sql, 'cold_since', ['from', 'to'])
const SIGNED_UP_IN = windowFragment(DEFINITIONS.new_subscriber.sql, 'signup_date', ['from', 'to'])

const WENT_COLD = new RegExp(WENT_COLD_PATTERN)
const SITE_PAGE = new RegExp(SITE_PAGE_PATTERN)

function invalid(problems: string[]): ApiError {
  return new ApiError(400, 'invalid_filters', 'The segment filters are not valid.', problems)
}

function stringList(value: unknown, key: string, problems: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string')) {
    problems.push(`${key} must be a non-empty array of strings`)
    return undefined
  }
  return value
}

function wholeNumberIn(raw: Record<string, unknown>, key: string, min: number, max: number, problems: string[]): number | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    problems.push(`${key} must be a whole number from ${min} to ${max}`)
    return undefined
  }
  return value
}

/** `value` matches `pattern`, or a problem naming the key (never the value: it is untrusted input). */
function patterned(raw: Record<string, unknown>, key: string, pattern: RegExp, rule: string, problems: string[]): string | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !pattern.test(value)) {
    problems.push(`${key} must be ${rule}`)
    return undefined
  }
  return value
}

/**
 * Validates a request's `filters` and returns the canonical object (19 §2 "Dedupe", §5.2), keys
 * in FILTER_KEYS order: status and source sorted and deduped, defaults applied (`status`
 * ['active'], `has_app` null), `include_never_opened` false whenever `days_since_open_gte` is
 * absent, an engagement bound at its end of the range (0, 100) dropped as no filter, every other
 * absent key omitted. Equal filters therefore give byte-equal JSON, the Previous searches key.
 *
 * Rejected with 400 invalid_filters, every problem listed: unknown keys; non-canonical status
 * values (only `active` and `unsubscribed`, exactly as stored); empty lists; blank sources; a
 * `days_since_open_gte` that is not a whole number of at least 1; a `*_within_days` outside
 * 1–3650; an engagement bound outside 0–100 or `engagement_gte` above `engagement_lte`; a
 * `went_cold` that is not `any` or `YYYY-MM`, or a month after TODAY's month; a `site_visit_page`
 * outside its pattern; an `app_event` that is not one of the four app events.
 *
 * `days_since_open_gte` starts at 1 because the derive.ts fragment is the unclamped day
 * difference: at N = 0 an open dated after TODAY would compare as negative, while
 * `days_since_open` clamps it to 0. Any N ≥ 1 gives the same answer either way.
 */
export function parseFilters(input: unknown): SegmentFilters {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid(['filters must be an object'])
  }
  const raw = input as Record<string, unknown>
  const problems: string[] = []
  for (const key of Object.keys(raw)) {
    if (!(FILTER_KEYS as readonly string[]).includes(key)) problems.push(`unknown filter: ${key}`)
  }

  let status = DEFAULT_STATUS
  if (raw.status !== undefined) {
    const list = stringList(raw.status, 'status', problems)
    if (list !== undefined) {
      const bad = list.filter((s) => !(SUBSCRIBER_STATUSES as readonly string[]).includes(s))
      if (bad.length > 0) problems.push(`status values must be one of ${SUBSCRIBER_STATUSES.join(', ')}`)
      else status = [...new Set(list as SubscriberStatus[])].sort()
    }
  }

  let source: string[] | undefined
  if (raw.source !== undefined) {
    const list = stringList(raw.source, 'source', problems)
    if (list !== undefined) {
      const canonical = list.map(canonicalSource)
      if (canonical.some((s) => s === null)) problems.push('source values must not be blank')
      else source = [...new Set(canonical as string[])].sort()
    }
  }

  const days = raw.days_since_open_gte
  if (days !== undefined && (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1)) {
    problems.push('days_since_open_gte must be a whole number of at least 1')
  }

  const includeNeverOpened = raw.include_never_opened
  if (includeNeverOpened !== undefined && typeof includeNeverOpened !== 'boolean') {
    problems.push('include_never_opened must be true or false')
  }

  const hasApp = raw.has_app
  if (hasApp !== undefined && hasApp !== null && typeof hasApp !== 'boolean') {
    problems.push('has_app must be true, false or null')
  }

  const wentCold = patterned(raw, 'went_cold', WENT_COLD, `"${WENT_COLD_ANY}" or a month written YYYY-MM`, problems)
  // TODAY's month is the last one a subscriber can have gone cold in (went_cold_in: <= TODAY).
  if (wentCold !== undefined && wentCold !== WENT_COLD_ANY && wentCold > TODAY.slice(0, 7)) {
    problems.push(`went_cold must not be a month after ${TODAY.slice(0, 7)}`)
  }
  const signedUp = wholeNumberIn(raw, 'signed_up_within_days', WITHIN_DAYS_MIN, WITHIN_DAYS_MAX, problems)
  const engagementGte = wholeNumberIn(raw, 'engagement_gte', ENGAGEMENT_MIN, ENGAGEMENT_MAX, problems)
  const engagementLte = wholeNumberIn(raw, 'engagement_lte', ENGAGEMENT_MIN, ENGAGEMENT_MAX, problems)
  if (engagementGte !== undefined && engagementLte !== undefined && engagementGte > engagementLte) {
    problems.push('engagement_gte must not be greater than engagement_lte')
  }
  const siteDays = wholeNumberIn(raw, 'site_visit_within_days', WITHIN_DAYS_MIN, WITHIN_DAYS_MAX, problems)
  const sitePage = patterned(raw, 'site_visit_page', SITE_PAGE, 'a site path such as /about: "/" then lowercase letters, digits, "/" or "-"', problems)
  const appDays = wholeNumberIn(raw, 'app_active_within_days', WITHIN_DAYS_MIN, WITHIN_DAYS_MAX, problems)
  const appEvent = raw.app_event
  if (appEvent !== undefined && !(APP_EVENTS as readonly unknown[]).includes(appEvent)) {
    problems.push(`app_event must be one of ${APP_EVENTS.join(', ')}`)
  }

  if (problems.length > 0) throw invalid(problems)
  const hasDays = days !== undefined
  return {
    status,
    ...(source === undefined ? {} : { source }),
    ...(hasDays ? { days_since_open_gte: days as number } : {}),
    include_never_opened: hasDays && includeNeverOpened === true,
    ...(wentCold === undefined ? {} : { went_cold: wentCold }),
    ...(signedUp === undefined ? {} : { signed_up_within_days: signedUp }),
    ...(engagementGte === undefined || engagementGte === ENGAGEMENT_MIN ? {} : { engagement_gte: engagementGte }),
    ...(engagementLte === undefined || engagementLte === ENGAGEMENT_MAX ? {} : { engagement_lte: engagementLte }),
    has_app: (hasApp as boolean | null | undefined) ?? null,
    ...(siteDays === undefined ? {} : { site_visit_within_days: siteDays }),
    ...(sitePage === undefined ? {} : { site_visit_page: sitePage }),
    ...(appDays === undefined ? {} : { app_active_within_days: appDays }),
    ...(appEvent === undefined ? {} : { app_event: appEvent as AppEventName }),
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

/** How one relation spells the columns a segment's WHERE reads. */
interface SegmentRelation {
  /** A column of the subscriber row as this relation names it. */
  column(name: 'status' | 'source' | 'last_open_date' | 'signup_date' | 'cold_since'): string
  /** The stored engagement_score (09 D-46). */
  engagement: string
  /** The profile's pseudonymous key, which v_web_events and v_app_events carry (05 §Pseudonymous key). */
  pkey: string
  /** True exactly when the subscriber has an app account. */
  hasApp: string
}

/** The builder's relation: tables, so its rows can carry the email the UI shows (03 §Other request flows). */
const TABLES: SegmentRelation = {
  column: (name) => `s.${name}`,
  engagement: 'p.engagement_score',
  pkey: 'p.pkey',
  hasApp: 'EXISTS (SELECT 1 FROM app_users a WHERE a.email_norm = s.email_norm)',
}

/** The assistant's relation: v_profiles, the view 01 §PII-free views lets the model read. */
const MODEL_VIEW: SegmentRelation = {
  column: (name) => name,
  engagement: 'engagement_score',
  pkey: 'pkey',
  hasApp: '(has_app = 1)',
}

/** `<column> <comparison>` with the fragment's placeholders bound from `values`, in fragment order. */
function windowClause(
  fragment: WindowFragment,
  rel: SegmentRelation,
  values: Record<string, string>,
  params: SqlValue[],
): string {
  for (const name of fragment.names) {
    const value = values[name]
    if (value === undefined) throw new Error(`segments: no value for :${name} of the ${fragment.column} fragment`)
    params.push(value)
  }
  return `${rel.column(fragment.column)}${fragment.rest}`
}

/**
 * `<pkey> IN (SELECT pkey FROM <view> WHERE …)` for one event filter (19 §4 "Same visit / same
 * event"): the window and the page or event narrow the same rows. Uncorrelated, so SQLite runs the
 * subquery once (19 §0 F3). Event times are full timestamps; `event_ts >= 'YYYY-MM-DD'` holds from
 * that day's first second, with no upper bound, so a live event after TODAY counts (09 D-01).
 */
function eventClause(
  rel: SegmentRelation,
  view: 'v_web_events' | 'v_app_events',
  window: DateWindow | null,
  match: { column: 'page' | 'event'; value: string } | null,
  params: SqlValue[],
): string {
  const conditions: string[] = []
  if (window !== null) {
    conditions.push('event_ts >= ?')
    params.push(window.from)
  }
  if (match !== null) {
    conditions.push(`${match.column} = ?`)
    params.push(match.value)
  }
  return `${rel.pkey} IN (SELECT pkey FROM ${view} WHERE ${conditions.join(' AND ')})`
}

/**
 * The one filter → WHERE translation, used by the builder and the assistant's segment tool, so
 * both apply the same rules to the same filter object (T-AI-3 pins equal counts). Clauses follow
 * FILTER_KEYS order.
 */
function segmentWhere(filters: SegmentFilters, rel: SegmentRelation): { where: string; params: SqlValue[] } {
  const where: string[] = []
  const params: SqlValue[] = []

  where.push(`${rel.column('status')} IN (${placeholders(filters.status.length)})`)
  params.push(...filters.status)

  if (filters.source !== undefined) {
    where.push(`${rel.column('source')} IN (${placeholders(filters.source.length)})`)
    params.push(...filters.source)
  }

  if (filters.days_since_open_gte !== undefined) {
    // 02 §Derived: days_since_open >= N; never-openers only with the toggle, regardless of signup age.
    const lastOpen = rel.column('last_open_date')
    const opened = `(${lastOpen} IS NOT NULL AND ${DAYS_SINCE_OPEN_SQL} >= ?)`
    params.push(TODAY, filters.days_since_open_gte)
    where.push(filters.include_never_opened ? `(${opened} OR ${lastOpen} IS NULL)` : opened)
  }

  if (filters.went_cold !== undefined) {
    // `any` = cold now (`cold`); a month = `went_cold_in(month)` (02 §Derived, 09 D-10).
    where.push(
      filters.went_cold === WENT_COLD_ANY
        ? windowClause(COLD_NOW, rel, { today: TODAY }, params)
        : windowClause(WENT_COLD_IN, rel, { ...wentColdWindow(filters.went_cold) }, params),
    )
  }

  if (filters.signed_up_within_days !== undefined) {
    where.push(windowClause(SIGNED_UP_IN, rel, { ...lastNDays(filters.signed_up_within_days) }, params))
  }

  if (filters.engagement_gte !== undefined) {
    where.push(`${rel.engagement} >= ?`)
    params.push(filters.engagement_gte)
  }
  if (filters.engagement_lte !== undefined) {
    where.push(`${rel.engagement} <= ?`)
    params.push(filters.engagement_lte)
  }

  if (filters.has_app !== null) {
    where.push(`${filters.has_app ? '' : 'NOT '}${rel.hasApp}`)
  }

  if (filters.site_visit_within_days !== undefined || filters.site_visit_page !== undefined) {
    const window = filters.site_visit_within_days === undefined ? null : lastNDays(filters.site_visit_within_days)
    const page = filters.site_visit_page === undefined ? null : { column: 'page' as const, value: filters.site_visit_page }
    where.push(eventClause(rel, 'v_web_events', window, page, params))
  }

  if (filters.app_active_within_days !== undefined || filters.app_event !== undefined) {
    const window = filters.app_active_within_days === undefined ? null : lastNDays(filters.app_active_within_days)
    const event = filters.app_event === undefined ? null : { column: 'event' as const, value: filters.app_event }
    where.push(eventClause(rel, 'v_app_events', window, event, params))
  }
  return { where: where.join(' AND '), params }
}

/**
 * Compiles validated filters to one bound SELECT. Every subscriber has a profile (seed,
 * 02 §Linking); the LEFT JOIN keeps a subscriber without one in the count, and the row
 * readers fail loud on its missing score instead of the row vanishing.
 */
export function compileSegment(filters: SegmentFilters): CompiledSegment {
  const { where, params } = segmentWhere(filters, TABLES)
  const sql = [
    'SELECT s.email_norm AS email, s.status, s.source, s.signup_date, s.last_open_date, p.engagement_score,',
    `${TABLES.hasApp} AS has_app`,
    'FROM subscribers s LEFT JOIN profiles p ON p.email_norm = s.email_norm',
    `WHERE ${where}`,
    'ORDER BY s.email_norm',
  ].join(' ')
  return { sql, params, sql_shape: sql }
}

/** Columns of a segment row as the assistant's segment tool returns it: the pkey in place of the email. */
export const MODEL_SEGMENT_COLUMNS = ['pkey', 'status', 'source', 'signup_date', 'last_open_date', 'engagement_score', 'has_app'] as const

/** The assistant's segment: the same filters over the v_* views, keyed by pkey (05 §Strategy). */
export interface CompiledModelSegment {
  /** The segment's rows, MODEL_SEGMENT_COLUMNS in order, most engaged first; the caller appends `LIMIT ?`. */
  rowsSql: string
  /** `SELECT count(*) AS n` over the same rows. */
  countSql: string
  params: SqlValue[]
}

/**
 * The same filters compiled over v_profiles, with site visits and app activity as IN-subqueries
 * on v_web_events and v_app_events: only v_* views, never a table (05 §Exactly what the model
 * receives, "Structural"). Rows come out most engaged first: the stored
 * engagement_score descending, pkey breaking ties (09 D-56, D-46: an ORDER BY on the stored
 * column, no formula). That is the path for "our most engaged readers" (R5.2); the builder keeps
 * its email order (04). status IN (…) drops the profiles that have no subscriber row.
 */
export function compileModelSegment(filters: SegmentFilters): CompiledModelSegment {
  const { where, params } = segmentWhere(filters, MODEL_VIEW)
  return {
    rowsSql: `SELECT ${MODEL_SEGMENT_COLUMNS.join(', ')} FROM v_profiles WHERE ${where} ORDER BY engagement_score DESC, pkey`,
    countSql: `SELECT count(*) AS n FROM v_profiles WHERE ${where}`,
    params,
  }
}

/**
 * The filters whose unsubscribed rows the default hides (02 §Defaults): every other filter kept,
 * status set to unsubscribed. `null` when the status filter already includes them.
 */
export function hiddenUnsubscribedFilters(filters: SegmentFilters): SegmentFilters | null {
  if (filters.status.includes('unsubscribed')) return null
  return { ...filters, status: ['unsubscribed'] }
}
