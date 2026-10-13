// Segment filters → bound SQL (04 §/api/segments/preview, 03 §Module layout; R3, 09 D-07,
// D-30, D-46). Pure: a parsed filter object in, SQL text and its parameters out. Every value is
// a bound `?`, TODAY included, so the SQL text is its own placeholders-only `sql_shape`. The
// days-since-open comparison is the `DEFINITIONS.days_since_open.sql` fragment from
// shared/derive.ts, never a re-typed formula. Source values are canonicalized by
// shared/normalize.ts, never by SQL (02 §Normalization). The builder's SQL reads tables, not
// v_* views: its rows carry the email, which the UI may see (03 §Other request flows). The
// assistant's segment tool compiles the same filters, through the same WHERE builder, over
// v_profiles only (`compileModelSegment`), so the model's tool never reads a table.

import { TODAY } from '../../shared/config'
import { DEFINITIONS } from '../../shared/derive'
import { canonicalSource } from '../../shared/normalize'
import { ApiError } from '../auth/middleware'
import { SUBSCRIBER_STATUSES, type SubscriberStatus } from '../ingest/quarantine'
import type { SqlValue } from '../ingest/sql'

/** The validated filter object (04 §/api/segments/preview); the assistant's segment tool takes the same one. */
export interface SegmentFilters {
  /** Default `['active']` (02 §Defaults, 09 D-07). */
  status: SubscriberStatus[]
  /** Canonical source names; absent = any source. */
  source?: string[]
  /** "no open in N days" (02 §Derived, 09 D-30); absent = no recency filter. */
  days_since_open_gte?: number
  /** With `days_since_open_gte`, also match everyone who never opened, whatever their signup date. */
  include_never_opened: boolean
  /** `null` or absent = either. */
  has_app: boolean | null
}

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

/** Every filter key 04 defines; the assistant's segment tool row may name only these (tools/tool-loader.ts). */
export const FILTER_KEYS = ['status', 'source', 'days_since_open_gte', 'include_never_opened', 'has_app'] as const

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

/**
 * Validates a request's `filters` and applies the defaults. Unknown keys, non-canonical status
 * values (only `active` and `unsubscribed`, exactly as stored), empty lists, blank sources and a
 * `days_since_open_gte` that is not a whole number of at least 1 are rejected with 400
 * invalid_filters, every problem listed. N starts at 1 because the derive.ts fragment is the
 * unclamped day difference: at N = 0 an open dated after TODAY would compare as negative, while
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
      else status = [...new Set(list as SubscriberStatus[])]
    }
  }

  let source: string[] | undefined
  if (raw.source !== undefined) {
    const list = stringList(raw.source, 'source', problems)
    if (list !== undefined) {
      const canonical = list.map(canonicalSource)
      if (canonical.some((s) => s === null)) problems.push('source values must not be blank')
      else source = [...new Set(canonical as string[])]
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

  if (problems.length > 0) throw invalid(problems)
  return {
    status,
    ...(source === undefined ? {} : { source }),
    ...(days === undefined ? {} : { days_since_open_gte: days as number }),
    include_never_opened: includeNeverOpened === true,
    has_app: (hasApp as boolean | null | undefined) ?? null,
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

/** How one relation spells the columns a segment's WHERE reads. */
interface SegmentRelation {
  /** A column of the subscriber row (status, source, last_open_date) as this relation names it. */
  column(name: 'status' | 'source' | 'last_open_date'): string
  /** True exactly when the subscriber has an app account. */
  hasApp: string
}

/** The builder's relation: tables, so its rows can carry the email the UI shows (03 §Other request flows). */
const TABLES: SegmentRelation = {
  column: (name) => `s.${name}`,
  hasApp: 'EXISTS (SELECT 1 FROM app_users a WHERE a.email_norm = s.email_norm)',
}

/** The assistant's relation: v_profiles only, the view 01 §PII-free views lets the model read. */
const MODEL_VIEW: SegmentRelation = {
  column: (name) => name,
  hasApp: '(has_app = 1)',
}

/**
 * The one filter → WHERE translation, used by the builder and the assistant's segment tool, so
 * both apply the same rules to the same filter object (T-AI-3 pins equal counts).
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

  if (filters.has_app !== null) {
    where.push(`${filters.has_app ? '' : 'NOT '}${rel.hasApp}`)
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

/** The assistant's segment: the same filters over v_profiles, keyed by pkey (05 §Strategy). */
export interface CompiledModelSegment {
  /** The segment's rows, MODEL_SEGMENT_COLUMNS in order, most engaged first; the caller appends `LIMIT ?`. */
  rowsSql: string
  /** `SELECT count(*) AS n` over the same rows. */
  countSql: string
  params: SqlValue[]
}

/**
 * The same filters compiled over v_profiles, the only relation this SQL names (05 §Exactly what
 * the model receives, "Structural"). Rows come out most engaged first: the stored
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
