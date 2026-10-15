// Segment filters → bound SQL. Pure: a parsed filter object in, SQL text and its parameters out. Every value
// is a bound `?`, TODAY and every date included, so the SQL text is its own placeholders-only
// `sql_shape`. Each date comparison is a `DEFINITIONS.*.sql` fragment from shared/derive.ts with
// its dates computed there (lastNDays, wentColdWindow), never a re-typed formula. Source values are
// canonicalized by shared/normalize.ts, never by SQL. The filter keys, their
// limits and patterns live in shared/segment-filters.ts; this file is their one
// validator. The builder's SQL reads tables for the subscriber row: its rows carry the email,
// which staff may see on /segments. The assistant's segment tool compiles the same
// filters, through the same WHERE builder, over v_profiles (`compileModelSegment`), so the
// model's tool never reads a table. Site visits and app activity are, in both, an uncorrelated
// `pkey IN (SELECT pkey FROM v_web_events | v_app_events …)`: the identity rule of
// app events lives once, in v_app_events, and only positive filters exist, because those views'
// pkey is NULL for anonymous rows and `NOT IN` over a NULL is never true.

import { APP_EVENTS, type AppEventName } from '../../shared/app-events'
import { TODAY } from '../../shared/config'
import { DEFINITIONS, type DateWindow, lastNDays, wentColdWindow } from '../../shared/derive'
import { CANONICAL_SOURCES, canonicalSource } from '../../shared/normalize'
import {
  ENGAGEMENT_MAX,
  ENGAGEMENT_MIN,
  FILTER_KEYS,
  SEGMENT_COLUMNS,
  SEGMENT_SORT,
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

/** The validated filter object and its keys, and the export's column list and row order: one
 * home, shared/segment-filters.ts. */
export { FILTER_KEYS, SEGMENT_COLUMNS, SEGMENT_SORT, type SegmentFilters }

export interface CompiledSegment {
  /** One SELECT over the segment's rows in the export's column order, in SEGMENT_SORT order. */
  sql: string
  params: SqlValue[]
  /** The SQL with placeholders only: the same text, since no value is ever inlined. */
  sql_shape: string
}

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
 * with an invented score; the message names no email.
 */
export function toSegmentRow(raw: RawSegmentRow): SegmentRow {
  if (raw.engagement_score === null) {
    throw new Error('segments: a subscriber row has no profile, so no engagement_score')
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
 * Validates a request's `filters` and returns the canonical object, keys
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
    // No key text: an unknown filter key is a client's text (it could hold PII), never echoed
    // back or logged; the log names only how many. The response's
    // `details` array still carries one entry per unknown key, so its length is the count.
    if (!(FILTER_KEYS as readonly string[]).includes(key)) problems.push('unknown filter')
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
      else {
        const unique = [...new Set(canonical as string[])].sort()
        // Capped before the membership check: many distinct values (canonical or not) would
        // otherwise all reach the membership check and, if ever this list grows, bind that many
        // SQL variables (today 7 canonical names, so 100 distinct values would try to
        // bind as many as 100 of them before this cap, hitting SQLite's "too many SQL variables").
        if (unique.length > CANONICAL_SOURCES.length) problems.push(`source must name at most ${CANONICAL_SOURCES.length} sources`)
        else if (unique.some((s) => !(CANONICAL_SOURCES as readonly string[]).includes(s))) {
          problems.push(`source values must be one of ${CANONICAL_SOURCES.join(', ')}`)
        } else source = unique
      }
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
  /** The stored engagement_score (computed at write time, never in SQL). */
  engagement: string
  /** The profile's pseudonymous key, which v_web_events and v_app_events carry. */
  pkey: string
  /** True exactly when the subscriber has an app account. */
  hasApp: string
}

/** The builder's relation: tables, so its rows can carry the email the UI shows. */
const TABLES: SegmentRelation = {
  column: (name) => `s.${name}`,
  engagement: 'p.engagement_score',
  pkey: 'p.pkey',
  hasApp: 'EXISTS (SELECT 1 FROM app_users a WHERE a.email_norm = s.email_norm)',
}

/**
 * How the builder's SELECT reads each export column, raw (no `AS`): compileSegment aliases it to
 * the column's SEGMENT_COLUMNS name, and uses the SEGMENT_SORT columns bare in ORDER BY. One home
 * for the export's column list and its order, so the SELECT and the ORDER BY can never
 * read a different expression for the same column, and the /segments "What's in the file"
 * disclosure, reading only the column NAMES from shared/segment-filters.ts, never needs to repeat
 * this SQL to describe the same file.
 */
const SEGMENT_COLUMN_SQL: { readonly [K in (typeof SEGMENT_COLUMNS)[number]]: string } = {
  email: 's.email_norm',
  status: 's.status',
  source: 's.source',
  signup_date: 's.signup_date',
  last_open_date: 's.last_open_date',
  engagement_score: 'p.engagement_score',
  has_app: TABLES.hasApp,
}

/** The assistant's relation: v_profiles, a PII-free view the model may read. */
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
 * `<pkey> IN (SELECT pkey FROM <view> WHERE …)` for one event filter: the window and the page or
 * event narrow the same rows (same visit, same event). Uncorrelated, so SQLite runs the
 * subquery once. Event times are full timestamps; `event_ts >= 'YYYY-MM-DD'` holds from
 * that day's first second, with no upper bound, so a live event after TODAY counts.
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
    // days_since_open >= N; never-openers only with the toggle, regardless of signup age.
    const lastOpen = rel.column('last_open_date')
    const opened = `(${lastOpen} IS NOT NULL AND ${DAYS_SINCE_OPEN_SQL} >= ?)`
    params.push(TODAY, filters.days_since_open_gte)
    where.push(filters.include_never_opened ? `(${opened} OR ${lastOpen} IS NULL)` : opened)
  }

  if (filters.went_cold !== undefined) {
    // `any` = cold now (`cold`); a month = `went_cold_in(month)` (shared/derive.ts).
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
 * Compiles validated filters to one bound SELECT. Every subscriber has a profile (the seed
 * creates one per subscriber); the LEFT JOIN keeps a subscriber without one in the count, and the row
 * readers fail loud on its missing score instead of the row vanishing.
 */
export function compileSegment(filters: SegmentFilters): CompiledSegment {
  const { where, params } = segmentWhere(filters, TABLES)
  const sql = [
    `SELECT ${SEGMENT_COLUMNS.map((c) => `${SEGMENT_COLUMN_SQL[c]} AS ${c}`).join(', ')}`,
    'FROM subscribers s LEFT JOIN profiles p ON p.email_norm = s.email_norm',
    `WHERE ${where}`,
    `ORDER BY ${SEGMENT_SORT.map((key) => `${SEGMENT_COLUMN_SQL[key.column]} ${key.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`,
  ].join(' ')
  return { sql, params, sql_shape: sql }
}

/** Columns of a segment row as the assistant's segment tool returns it: the pkey in place of the email. */
export const MODEL_SEGMENT_COLUMNS = ['pkey', 'status', 'source', 'signup_date', 'last_open_date', 'engagement_score', 'has_app'] as const

/** The assistant's segment: the same filters over the v_* views, keyed by pkey (never an email). */
export interface CompiledModelSegment {
  /** The segment's rows, MODEL_SEGMENT_COLUMNS in order, most engaged first; the caller appends `LIMIT ?`. */
  rowsSql: string
  /** `SELECT count(*) AS n` over the same rows. */
  countSql: string
  params: SqlValue[]
}

/**
 * The same filters compiled over v_profiles, with site visits and app activity as IN-subqueries
 * on v_web_events and v_app_events: only v_* views, never a table, so the model's tool can read
 * no PII column. Rows come out most engaged first: the stored
 * engagement_score descending (an ORDER BY on the stored column, no formula), as
 * the builder's do. Ties break by pkey here, since the view has no email; the builder breaks them
 * by email, so two rows with the same score may swap places between the two lists.
 * status IN (…) drops the profiles that have no subscriber row.
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
 * The filters whose unsubscribed rows the default hides (counted, so the default is never silent): every other filter kept,
 * status set to unsubscribed. `null` when the status filter already includes them.
 */
export function hiddenUnsubscribedFilters(filters: SegmentFilters): SegmentFilters | null {
  if (filters.status.includes('unsubscribed')) return null
  return { ...filters, status: ['unsubscribed'] }
}
