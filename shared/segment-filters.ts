/**
 * The segment filter contract (design 19 §5.5, 04 §/api/segments/preview; 09 D-69): the one home
 * of the filter keys, their order, their TypeScript type, their limits and patterns, and the
 * JSON-schema fragment the assistant's `segment` tool row declares. Imported by
 * worker/segments/compile.ts (validation and SQL), scripts/tool-seeds.ts (the tool's
 * input_schema) and src/ (the form and the Previous searches label).
 *
 * Every string key except `source` is limited by an enum or a pattern, so no value can hold an
 * email address or a raw app, device or visitor id (shared/pii.ts EMAIL_REGEX, RAW_ID_REGEX; 19 §3
 * "Model PII risk"). The page pattern bans `@` and `_`; the went-cold pattern is a word or a month.
 * `source` is folded through the same canonicalSource used at ingest (02 §Normalization) but not
 * enum-restricted at this layer, so bound params, not an enum, are what keep it SQL-safe
 * (worker/segments/compile.ts); the model-facing `segment` tool and the Insights board reach it
 * only through Gate 2's enum/guardPayload, and the page's own checkboxes list only
 * `shared/normalize.ts` CANONICAL_SOURCES, so no caller the page exposes can pass a free string
 * through to Previous searches.
 *
 * Pure data: no validation code lives here (worker/segments/compile.ts parseFilters is the one
 * validator), and the browser never normalizes a value (02 §Normalization).
 */
import { SUBSCRIBER_STATUSES, type SubscriberStatus } from '../worker/ingest/quarantine'
import { APP_EVENTS, type AppEventName } from './app-events'
import { CANONICAL_SOURCES } from './normalize'

/**
 * Every filter key, in the order the canonical echo lists them and the Previous searches label
 * reads its clauses (19 §2 "Label": no-open, went cold, signed up, engagement, app account, site
 * visits, app activity). The assistant's segment tool row may name only these.
 */
export const FILTER_KEYS = [
  'status',
  'source',
  'days_since_open_gte',
  'include_never_opened',
  'went_cold',
  'signed_up_within_days',
  'engagement_gte',
  'engagement_lte',
  'has_app',
  'site_visit_within_days',
  'site_visit_page',
  'app_active_within_days',
  'app_event',
] as const

export type FilterKey = (typeof FILTER_KEYS)[number]

/** The validated, canonical filter object: what POST /api/segments/preview echoes as `filters`. */
export interface SegmentFilters {
  /** Sorted and deduped; default `['active']` (02 §Defaults, 09 D-07). */
  status: SubscriberStatus[]
  /** Canonical source names, sorted and deduped; absent = any source. */
  source?: string[]
  /** "no open in N days" (02 §Derived, 09 D-30); absent = no recency filter. */
  days_since_open_gte?: number
  /** With `days_since_open_gte`, also match everyone who never opened; always false without it. */
  include_never_opened: boolean
  /** `any` = cold now (`cold`); `YYYY-MM` = went cold in that month (`went_cold_in`). */
  went_cold?: string
  /** Signed up in the last N days (`last N days` over signup_date). */
  signed_up_within_days?: number
  /** Stored engagement_score at least this; absent when it would be 0 (no filter). */
  engagement_gte?: number
  /** Stored engagement_score at most this; absent when it would be 100 (no filter). */
  engagement_lte?: number
  /** `null` = either. */
  has_app: boolean | null
  /** Visited the site in the last N days (no upper bound, 09 D-01). */
  site_visit_within_days?: number
  /** Visited this page; with `site_visit_within_days`, in the same visit window. */
  site_visit_page?: string
  /** Used the app in the last N days (no upper bound, 09 D-01). */
  app_active_within_days?: number
  /** Sent this app event; with `app_active_within_days`, inside that window. */
  app_event?: AppEventName
}

/** Smallest and largest N for every `*_within_days` key (19 §5.1). */
export const WITHIN_DAYS_MIN = 1
export const WITHIN_DAYS_MAX = 3650

/** The stored engagement_score range (02 §Derived, 0001_core.sql CHECK). */
export const ENGAGEMENT_MIN = 0
export const ENGAGEMENT_MAX = 100

/** `any` or a calendar month `YYYY-MM` (19 §5.1). JSON-schema form: no flags, anchored. */
export const WENT_COLD_PATTERN = '^(any|\\d{4}-(0[1-9]|1[0-2]))$'

/** A site path: `/`, lowercase letters, digits, `/` and `-` only, at most 121 characters (19 §3 row 6). */
export const SITE_PAGE_PATTERN = '^/[a-z0-9/-]{0,120}$'

/** The `went_cold` value meaning "cold now". */
export const WENT_COLD_ANY = 'any'

/** The JSON Schema of one filter key, in the subset tool rows may use (tool-loader.ts SCHEMA_KEYWORDS). */
export interface FilterSchema {
  type: string | string[]
  enum?: readonly string[]
  items?: { type: string; enum: readonly string[] }
  minItems?: number
  minimum?: number
  maximum?: number
  pattern?: string
}

const withinDays: FilterSchema = { type: 'integer', minimum: WITHIN_DAYS_MIN, maximum: WITHIN_DAYS_MAX }
const engagement: FilterSchema = { type: 'integer', minimum: ENGAGEMENT_MIN, maximum: ENGAGEMENT_MAX }

/**
 * The contract fragment (19 §5.1): one JSON-schema property per FILTER_KEYS entry, in that order.
 * The assistant's segment tool input_schema is exactly these properties plus a description each
 * (scripts/tool-seeds.ts). `source` lists the canonical names, so the model cannot send free text.
 */
export const FILTER_SCHEMA: { readonly [K in FilterKey]: FilterSchema } = {
  status: { type: 'array', items: { type: 'string', enum: SUBSCRIBER_STATUSES }, minItems: 1 },
  source: { type: 'array', items: { type: 'string', enum: CANONICAL_SOURCES }, minItems: 1 },
  days_since_open_gte: { type: 'integer', minimum: 1 },
  include_never_opened: { type: 'boolean' },
  went_cold: { type: 'string', pattern: WENT_COLD_PATTERN },
  signed_up_within_days: withinDays,
  engagement_gte: engagement,
  engagement_lte: engagement,
  has_app: { type: ['boolean', 'null'] },
  site_visit_within_days: withinDays,
  site_visit_page: { type: 'string', pattern: SITE_PAGE_PATTERN },
  app_active_within_days: withinDays,
  app_event: { type: 'string', enum: APP_EVENTS },
}
