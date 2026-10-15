/**
 * The segment filter contract (design 19 §5.5, 04 §/api/segments/preview; 09 D-69): the one home
 * of the filter keys, their order, their TypeScript type, their limits and patterns, and the
 * JSON-schema fragment the assistant's `segment` tool row declares; also the export's column list
 * and the order of a segment's rows (09 D-76). Imported by worker/segments/compile.ts (validation and SQL),
 * scripts/tool-seeds.ts (the tool's input_schema) and src/ (the form, the Previous searches label
 * and the export's "What's in the file" disclosure).
 *
 * Every string key, `source` included, is limited by an enum or a pattern, so no value can hold
 * an email address or a raw app, device or visitor id (shared/pii.ts EMAIL_REGEX, RAW_ID_REGEX;
 * 19 §3 "Model PII risk"). The page pattern bans `@` and `_`; the went-cold pattern is a word or a
 * month. `source` is folded through the same `canonicalSource` used at ingest (02 §Normalization)
 * and then checked in `worker/segments/compile.ts` parseFilters against `shared/normalize.ts`
 * CANONICAL_SOURCES — capped at CANONICAL_SOURCES.length unique values before that membership
 * check ever runs, so a long list can't try to bind more SQL variables than SQLite allows — so
 * bound params are defense in depth for `source`, not what makes it SQL-safe on their own; the
 * model-facing `segment` tool and the Insights board reach it only through Gate 2's
 * enum/guardPayload, and the page's own checkboxes list only CANONICAL_SOURCES, so no caller the
 * page exposes can pass a free string through to Previous searches (which also checks the same
 * enum itself, `src/previous-searches.ts` meetsSchema's generic FILTER_SCHEMA check, as a
 * hand-edited-storage backstop).
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

/**
 * Columns of an exported segment row, in the 04 §/api/segments/export.csv order: email first so
 * the file imports into beehiiv unchanged, status always present (02 §Defaults export rule). One
 * home for both sides (09 D-76): worker/segments/compile.ts reads this to build the export SELECT
 * and export.ts's CSV header, and /segments' "What's in the file" disclosure reads it for the
 * plain-word column list and the raw headers in Technical details, so the two can never list a
 * different file.
 */
export const SEGMENT_COLUMNS = ['email', 'status', 'source', 'signup_date', 'last_open_date', 'engagement_score', 'has_app'] as const

/** One key of a segment's row order, with the plain words /segments says for its direction. */
export interface SegmentSortKey {
  readonly column: (typeof SEGMENT_COLUMNS)[number]
  readonly direction: 'asc' | 'desc'
  /** How /segments says the direction: "highest first" for the score, "A to Z" for the email. */
  readonly words: string
}

/**
 * The order of a segment's rows wherever they are listed: the preview on /segments, the list
 * "Open segment" opens there, and the Export CSV file. Most engaged first (the stored
 * engagement_score, highest first), so "our most engaged readers" comes out as a ranked list;
 * email breaks ties, so the order is the same on every run. The order changes no count.
 * worker/segments/compile.ts compileSegment builds its ORDER BY from this, and the /segments
 * "Sorted by" sentence reads it, so the two can never name a different order (09 D-76).
 */
export const SEGMENT_SORT: readonly SegmentSortKey[] = [
  { column: 'engagement_score', direction: 'desc', words: 'highest first' },
  { column: 'email', direction: 'asc', words: 'A to Z' },
]

/**
 * What "our most engaged readers" means as a filter: a stored engagement_score of at least this
 * (`engagement_gte`), half of the 0–100 range. On the seed it keeps 487 active subscribers of
 * 2,610, with 27 unsubscribed hidden. The assistant's segment tool description names it
 * (scripts/tool-seeds.ts), so the question gets a short, ranked list rather than every active
 * subscriber.
 */
export const MOST_ENGAGED_MIN = 50

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
