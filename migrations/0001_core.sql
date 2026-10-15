-- Core tables. Derived values (cold_since, engagement_score) are computed once by
-- shared/derive.ts when a row is written and then stored, so SQL only compares columns and
-- never repeats a formula that could drift from the code.
-- Timestamps are ISO-8601 TEXT in UTC. Columns marked PII are listed in PII_COLUMNS
-- (shared/pii.ts) and are never selected by a v_* view (0002_views.sql, T-PII-2).
-- CHECK constraints cover the enums that belong to these tables. Sets owned by code (the
-- canonical sources in shared/normalize.ts, the quarantine reasons in worker/ingest/quarantine.ts)
-- are enforced by that one module, so each list has a single home.

CREATE TABLE profiles (
  pkey             TEXT PRIMARY KEY,                -- keyed hash, not reversible (shared/pseudonym.ts)
  email_norm       TEXT,                            -- PII; NULL for unknown_user_stub profiles
  kind             TEXT NOT NULL CHECK (kind IN ('subscriber','app_only','unknown_user_stub')),
  engagement_score INTEGER NOT NULL CHECK (engagement_score BETWEEN 0 AND 100), -- stored by shared/derive.ts
  created_at       TEXT NOT NULL                    -- signup_date, else app created_at; webhook stubs: received_at
);

CREATE TABLE subscribers (
  email_norm     TEXT PRIMARY KEY,                  -- PII
  email_raw      TEXT NOT NULL,                     -- PII, first spelling seen
  signup_date    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active','unsubscribed')),
  source         TEXT,                              -- canonical (shared/normalize.ts); NULL = blank
  last_open_date TEXT,                              -- NULL = never opened
  cold_since     TEXT NOT NULL,                     -- stored by shared/derive.ts
  merged_count   INTEGER NOT NULL DEFAULT 1 CHECK (merged_count >= 1)
);

CREATE TABLE web_visitors (
  visitor_id       TEXT PRIMARY KEY,                -- PII
  visitor_hash     TEXT NOT NULL UNIQUE,            -- shared/pseudonym.ts visitorHash, set at ingest
  email_norm       TEXT,                            -- PII; from the /subscribe row
  first_seen_ts    TEXT NOT NULL,
  first_page       TEXT NOT NULL,
  first_utm_source TEXT,                            -- canonical
  -- event_ts of the /subscribe row that carried the email: /api/lookup marks earlier events
  -- pre_signup. Not derivable from web_events, where a visitor can have
  -- several /subscribe rows and most carry no email. NULL exactly when email_norm is NULL:
  -- the seed (worker/ingest/web.ts) writes both from the same row and /api/lookup fails loud
  -- on a linked visitor without it.
  signup_ts        TEXT
);

CREATE TABLE web_events (
  id         INTEGER PRIMARY KEY,
  visitor_id TEXT NOT NULL REFERENCES web_visitors (visitor_id), -- PII
  page       TEXT NOT NULL,
  event_ts   TEXT NOT NULL,
  utm_source TEXT                                   -- canonical
);

CREATE TABLE app_users (
  user_id    TEXT PRIMARY KEY,                      -- PII
  email_norm TEXT,                                  -- PII; NULL for webhook-created unknown users
  created_at TEXT NOT NULL,
  from_csv   INTEGER NOT NULL CHECK (from_csv IN (0,1))
);

CREATE TABLE app_events (
  event_id    TEXT PRIMARY KEY,                     -- idempotency key: a resent event is stored once
  event       TEXT NOT NULL CHECK (event IN ('app_open','read_story','link_click','login')),
  user_id     TEXT,                                 -- PII; as sent, NULL when anonymous
  device_id   TEXT NOT NULL,                        -- PII
  event_ts    TEXT NOT NULL,                        -- payload timestamp, the ordering key
  received_at TEXT NOT NULL,                        -- wall clock, when the webhook arrived
  properties  TEXT CHECK (properties IS NULL OR json_valid(properties)) -- PII possible
);

CREATE TABLE device_identity (
  device_id    TEXT PRIMARY KEY,                    -- PII
  user_id      TEXT NOT NULL,                       -- PII; most recent user by event_ts, not arrival order
  last_seen_ts TEXT NOT NULL
);

CREATE TABLE import_runs (
  id          INTEGER PRIMARY KEY,
  file        TEXT NOT NULL CHECK (file IN ('subscribers','web_events','app_users')),
  rows_in     INTEGER NOT NULL,
  rows_out    INTEGER NOT NULL,
  merged      INTEGER NOT NULL,
  quarantined INTEGER NOT NULL,
  ran_at      TEXT NOT NULL
);

CREATE TABLE quarantine (
  id      INTEGER PRIMARY KEY,
  run_id  INTEGER NOT NULL REFERENCES import_runs (id),
  file    TEXT NOT NULL CHECK (file IN ('subscribers','web_events','app_users')),
  line_no INTEGER NOT NULL,
  reason  TEXT NOT NULL,                            -- enum in worker/ingest/quarantine.ts
  raw_row TEXT NOT NULL                             -- PII possible
);

CREATE TABLE assistant_tools (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  description      TEXT NOT NULL,
  input_schema     TEXT NOT NULL CHECK (json_valid(input_schema)),
  handler_type     TEXT NOT NULL CHECK (handler_type IN ('builtin','query','passthrough')),
  execution_config TEXT NOT NULL CHECK (json_valid(execution_config)),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  metadata         TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE ai_audit (
  id            TEXT PRIMARY KEY,
  trace_id      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('model_request','tool_call','blocked')),
  tool_name     TEXT,                               -- NULL for model_request rows
  status        TEXT NOT NULL CHECK (status IN ('success','error','blocked')),
  latency_ms    INTEGER,
  model         TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  request_json  TEXT,
  response_json TEXT,
  sql           TEXT,
  row_count     INTEGER,
  error         TEXT,
  created_at    TEXT NOT NULL                       -- wall clock, when the call happened
);

CREATE INDEX subscribers_status_source_open ON subscribers (status, source, last_open_date);
CREATE INDEX web_events_visitor_ts ON web_events (visitor_id, event_ts);
CREATE INDEX web_events_page ON web_events (page);
CREATE INDEX app_events_device_ts ON app_events (device_id, event_ts);
CREATE INDEX app_events_user_ts ON app_events (user_id, event_ts);
CREATE INDEX app_users_email ON app_users (email_norm);
CREATE INDEX web_visitors_email ON web_visitors (email_norm);
CREATE INDEX ai_audit_created ON ai_audit (created_at DESC);
CREATE INDEX ai_audit_trace ON ai_audit (trace_id);
