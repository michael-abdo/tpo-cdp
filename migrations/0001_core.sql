-- Core tables. DDL home: design 01 §Tables and §Indexes; derived columns stored per 09 D-46;
-- assistant_tools and ai_audit translated from 14 §4.1 with 01's enums.
-- Timestamps are ISO-8601 TEXT in UTC (02 §Time). Columns marked PII are in 01 §PII denylist
-- and are never selected by a v_* view (0002_views.sql, T-PII-2).
-- CHECK constraints cover the enums whose home is 01. Sets owned elsewhere (the canonical
-- source set and the quarantine reasons, both 02) are enforced by their single module.

CREATE TABLE profiles (
  pkey             TEXT PRIMARY KEY,                -- 05 §Pseudonymous key (shared/pseudonym.ts)
  email_norm       TEXT,                            -- PII; NULL for unknown_user_stub profiles
  kind             TEXT NOT NULL CHECK (kind IN ('subscriber','app_only','unknown_user_stub')),
  engagement_score INTEGER NOT NULL CHECK (engagement_score BETWEEN 0 AND 100), -- shared/derive.ts, D-46
  created_at       TEXT NOT NULL                    -- source per 09 D-44
);

CREATE TABLE subscribers (
  email_norm     TEXT PRIMARY KEY,                  -- PII
  email_raw      TEXT NOT NULL,                     -- PII, first spelling seen
  signup_date    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active','unsubscribed')),
  source         TEXT,                              -- canonical (02 §Normalization); NULL = blank
  last_open_date TEXT,                              -- NULL = never opened
  cold_since     TEXT NOT NULL,                     -- shared/derive.ts, D-46
  merged_count   INTEGER NOT NULL DEFAULT 1 CHECK (merged_count >= 1)
);

CREATE TABLE web_visitors (
  visitor_id       TEXT PRIMARY KEY,                -- PII
  visitor_hash     TEXT NOT NULL UNIQUE,            -- shared/pseudonym.ts visitorHash, set at ingest
  email_norm       TEXT,                            -- PII; from the /subscribe row
  first_seen_ts    TEXT NOT NULL,
  first_page       TEXT NOT NULL,
  first_utm_source TEXT,                            -- canonical
  -- event_ts of the /subscribe row that carried the email (02 §Linking 2): /api/lookup marks
  -- earlier events pre_signup (04). Not derivable from web_events, where a visitor can have
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
  event_id    TEXT PRIMARY KEY,                     -- idempotency key (04 §Webhook)
  event       TEXT NOT NULL CHECK (event IN ('app_open','read_story','link_click','login')),
  user_id     TEXT,                                 -- PII; as sent, NULL when anonymous
  device_id   TEXT NOT NULL,                        -- PII
  event_ts    TEXT NOT NULL,                        -- payload timestamp, the ordering key
  received_at TEXT NOT NULL,                        -- wall clock (02 §Time)
  properties  TEXT CHECK (properties IS NULL OR json_valid(properties)) -- PII possible
);

CREATE TABLE device_identity (
  device_id    TEXT PRIMARY KEY,                    -- PII
  user_id      TEXT NOT NULL,                       -- PII; most recent user by event_ts (09 D-43)
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
  reason  TEXT NOT NULL,                            -- enum in 02 §Quarantine
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
  created_at    TEXT NOT NULL                       -- wall clock (02 §Time)
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
