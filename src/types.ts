// Response shapes the UI reads, as 04 §Endpoints defines them (the worker routes are the producers).

import type { DefinitionKey } from '../shared/derive'
import type { SubscriberStatus } from '../worker/ingest/quarantine'

/** GET /api/overview */
export interface Overview {
  subscribers: number
  active: number
  app_users: number
  events_received: number
  import_runs: { file: string; rows_in: number; rows_out: number; merged: number; quarantined: number; ran_at: string }[]
  quarantine_reasons: Record<string, number>
}

/** GET /api/lookup/search?q= (09 D-52) */
export interface LookupSearch {
  /** The fragment as the server normalized it. */
  q: string
  matches: {
    pkey: string
    email: string | null
    kind: Lookup['profile']['kind']
    user_id: string | null
    status: SubscriberStatus | null
  }[]
  truncated: boolean
  /** Near spellings (09 D-59), only when `matches` is empty; `[]` otherwise. */
  did_you_mean: {
    pkey: string
    email: string
    kind: Lookup['profile']['kind']
    /** Damerau–Levenshtein distance, 1 or 2. */
    distance: number
  }[]
}

/** GET /api/lookup?q= */
export interface Lookup {
  profile: {
    pkey: string
    kind: 'subscriber' | 'app_only' | 'unknown_user_stub'
    email: string | null
    engagement_score: number
    cold_since: string | null
    has_app: boolean
    app_after_signup: boolean
  }
  newsletter: {
    signup_date: string
    status: string
    source: string | null
    last_open_date: string | null
    merged_count: number
  } | null
  web: {
    visitor_id: string
    first_page: string
    first_utm_source: string | null
    events: { page: string; event_ts: string; utm_source: string | null; pre_signup: boolean }[]
  } | null
  app: {
    user_id: string
    created_at: string
    from_csv: boolean
    devices: string[]
    events: { event: string; event_ts: string; properties: unknown; attached_via: 'direct' | 'login_stitch' }[]
  } | null
}

/** One row of GET /api/events/recent, resolved at read time (01 §Identity resolution). */
export interface RecentEvent {
  event_id: string
  event: string
  device_id: string
  event_ts: string
  received_at: string
  user_id: string | null
  attached_via: 'direct' | 'login_stitch' | null
  pkey: string | null
  email: string | null
}

/** GET /api/events/recent */
export interface RecentEvents {
  events: RecentEvent[]
}

/** The filters object of POST /api/segments/preview and export.csv. */
export interface SegmentFilters {
  status: SubscriberStatus[]
  source?: string[]
  days_since_open_gte?: number
  include_never_opened: boolean
  has_app: boolean | null
}

export interface SegmentRow {
  email: string
  status: SubscriberStatus
  source: string | null
  signup_date: string
  last_open_date: string | null
  engagement_score: number
  has_app: boolean
}

/** POST /api/segments/preview */
export interface SegmentPreview {
  count: number
  hidden_unsubscribed: number
  rows: SegmentRow[]
  sql_shape: string
}

/** A cell of an assistant table (worker/assistant/tools/builtin-handlers.ts Cell). */
export type AssistantCell = string | number | boolean | null

/** POST /api/assistant (04 §POST /api/assistant), after server-side re-hydration. */
export interface AssistantResponse {
  type: 'answer' | 'table' | 'segment'
  text: string
  table: { columns: string[]; rows: Record<string, AssistantCell>[] } | null
  segment: { filters: SegmentFilters; count: number } | null
  window: { from: string; to: string } | null
  filters_applied: Record<string, unknown>
  definitions_used: DefinitionKey[]
  partial: boolean
  /** The trace_id of the request's ai_audit rows (GET /api/audit/:trace_id). */
  audit_id: string
}

export type AuditStatus = 'success' | 'error' | 'blocked'

/** How a request ended (worker/routes/audit.ts AuditOutcome and traceOutcome). */
export type AuditOutcome = 'answered' | 'answered_text_replaced' | 'blocked' | 'failed' | 'unfinished'

/** One line of GET /api/audit?limit= (worker/routes/audit.ts AuditTraceSummary). */
export interface AuditTraceSummary {
  trace_id: string
  started_at: string
  /** The redacted question the model received; null when no model call was made. */
  question: string | null
  /** The question was sent to the AI (a model call was stored, or its reply was blocked). */
  reached_ai: boolean
  /** How the request ended, from its last row. */
  outcome: AuditOutcome
  /** The most severe row status. */
  status: AuditStatus
  model_calls: number
  tool_calls: number
  tokens_in: number
  tokens_out: number
}

/** GET /api/audit?limit= */
export interface AuditList {
  traces: AuditTraceSummary[]
}

/** One ai_audit row as stored (01; worker/routes/audit.ts AuditRowOut). */
export interface AuditRow {
  id: string
  kind: 'model_request' | 'tool_call' | 'blocked'
  tool_name: string | null
  status: AuditStatus
  latency_ms: number | null
  model: string | null
  tokens_in: number | null
  tokens_out: number | null
  request_json: string | null
  response_json: string | null
  sql: string | null
  row_count: number | null
  error: string | null
  created_at: string
}

/** GET /api/audit/:trace_id */
export interface AuditTrace {
  trace_id: string
  rows: AuditRow[]
}

/** The counts every /growth number shares: the `explain` question opens /assistant prefilled (09 D-39). */
interface Explained {
  /** Share as a fraction, 4 decimals; null when the group is empty. */
  rate: number | null
  explain: string
}

/** Source → app counts (worker/insights/source-app.ts SourceAppCounts). */
export interface SourceAppCounts extends Explained {
  subscribers: number
  with_app: number
  with_app_after_signup: number
}

/** GET /api/insights/source-app-conversion (04, 06 §/growth panel 1). */
export interface SourceAppConversion {
  total: SourceAppCounts
  by_source: (SourceAppCounts & { source: string | null })[]
  definitions_used: DefinitionKey[]
}

/** Visitor → subscriber counts (worker/insights/funnel.ts FunnelCounts). */
export interface FunnelCounts extends Explained {
  visitors: number
  subscribed: number
}

/** GET /api/insights/funnel (04, 06 §/growth panel 2; v_funnel). */
export interface Funnel {
  total: FunnelCounts
  by_first_page: (FunnelCounts & { first_page: string })[]
  by_first_utm: (FunnelCounts & { first_utm_source: string | null })[]
}

/** Readers at risk of going cold (worker/insights/going-cold.ts GoingColdCounts); active subscribers only. */
export interface GoingColdCounts extends Explained {
  active: number
  at_risk: number
}

/** GET /api/insights/going-cold (04, 06 §/growth parked panel; going_cold_risk, 02 §Derived). */
export interface GoingCold {
  total: GoingColdCounts
  /** Unsubscribed readers at risk, left out of every count above (02 §Defaults). */
  hidden_unsubscribed: { count: number; explain: string }
  by_source: (GoingColdCounts & { source: string | null })[]
  definitions_used: DefinitionKey[]
}

/**
 * The data-quality check keys, as worker/insights/data-quality.ts DATA_QUALITY_CHECKS lists them.
 * Restated like every shape here: that module types D1Database, which the browser project does not
 * have. test/insights.test.ts pins this union to the worker's list.
 */
export type DataQualityCheckKey =
  | 'subscribers_without_source'
  | 'subscribers_unexpected_source'
  | 'page_views_without_utm'
  | 'page_views_unexpected_utm'
  | 'app_users_not_on_list'

/** GET /api/insights/data-quality (04, 06 §/growth parked panel; T-INS-3). */
export interface DataQuality {
  /** Sums over import_runs, and the quarantine table by file and reason. */
  import: {
    rows_in: number
    rows_out: number
    merged: number
    quarantined: number
    /** quarantined / rows_in; null when nothing was loaded. */
    rate: number | null
    by_file_reason: { file: string; reason: string; rows: number }[]
  }
  /** One per DATA_QUALITY_CHECKS key (worker/insights/data-quality.ts), in that order. */
  checks: ({ key: DataQualityCheckKey; count: number; of: number } & Explained)[]
}
