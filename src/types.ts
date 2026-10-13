// Response shapes the UI reads, as 04 §Endpoints defines them (the worker routes are the producers).

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
