-- Unknown-user stubs are visible to the assistant. profiles.email_norm stays NULL
-- for an unknown_user_stub profile, so the old v_app_events join
-- (`profiles p ON p.email_norm = u.email_norm`) never matches one: SQL NULL = NULL is unknown,
-- not true, so a stub's events resolved to pkey NULL in the model's views while Look up and
-- /events (which read app_users/profiles directly) already showed them under the stub.
-- worker/webhooks/ingest.ts keys a stub's pkey as HMAC("user:" + user_id) (shared/pseudonym.ts
-- pkeyForUnknownUser); no existing column joins that pkey back to the app_users row it came
-- from, so this adds one. `user_id` is already in the PII denylist (shared/pii.ts) by name,
-- so no view may select this column either; it exists only to be joined on.

-- v_profiles (0002_views.sql) has the identical gap: its `app` CTE joins app_users to a profile
-- by email_norm only (`WHERE email_norm IS NOT NULL ... app.email_norm = p.email_norm`), so a
-- stub's has_app/app_created_at came back 0/NULL there while GET /api/lookup (worker/routes/
-- lookup.ts) already answered has_app: true for the same stub. Every view that joins an app user
-- to a person by email only has this gap, so it is recreated below too.
ALTER TABLE profiles ADD COLUMN user_id TEXT; -- PII; set only for kind = 'unknown_user_stub'

DROP VIEW v_app_events;
DROP VIEW v_profiles;

-- Resolves an event to a person the same way Look up and /events already do: the event's own
-- user_id, or for an anonymous event the device's most recent
-- user; then that user's email profile (pe, by app_users.email_norm = profiles.email_norm); when
-- the user has no email (a stub created by the webhook) its unknown_user_stub
-- profile instead (pu, by profiles.user_id = app_users.user_id). On the seed (no stubs) and for
-- any known user, at most one of the two joins fires: a stub's app_users row always has
-- email_norm NULL, and a known user's profiles row always has user_id NULL (set only on stubs).
-- The one case where both COULD match the same app_users row is a user_id that started as an
-- unknown-user stub (profiles.user_id set, email_norm NULL) and later gained a CSV/webhook email
-- on the SAME user_id without clearing its stub profile; COALESCE then prefers pe (the email
-- profile) over pu, and each join still yields at most one row, so the result stays a single
-- pkey either way — just not necessarily pu's once an email exists.
CREATE VIEW v_app_events AS
SELECT
  COALESCE(pe.pkey, pu.pkey) AS pkey,
  e.event,
  e.event_ts,
  json_extract(e.properties, '$.story') AS story,
  json_extract(e.properties, '$.link') AS link
FROM app_events e
LEFT JOIN device_identity d ON e.user_id IS NULL AND d.device_id = e.device_id
LEFT JOIN app_users u ON u.user_id = COALESCE(e.user_id, d.user_id)
LEFT JOIN profiles pe ON pe.email_norm = u.email_norm
LEFT JOIN profiles pu ON pu.user_id = u.user_id AND pu.kind = 'unknown_user_stub';

-- Same fix as v_app_events: a stub (kind = 'unknown_user_stub') has no email_norm to join an
-- app_users row on, so it falls back to its own profiles.user_id = app_users.user_id (exactly
-- one row, since both columns are primary-keyed/unique per user). A non-stub profile's user_id
-- column is always NULL, so `stub_au` can only ever match a stub; the seed has none, so every
-- non-stub row of this view stays byte-identical to before.
CREATE VIEW v_profiles AS
WITH app_by_email AS (
  SELECT email_norm, MIN(created_at) AS created_at
  FROM app_users
  WHERE email_norm IS NOT NULL
  GROUP BY email_norm
),
first_visit AS (
  SELECT email_norm, first_page, first_utm_source,
         ROW_NUMBER() OVER (PARTITION BY email_norm ORDER BY first_seen_ts, visitor_hash) AS n
  FROM web_visitors
  WHERE email_norm IS NOT NULL
)
SELECT
  p.pkey,
  p.kind,
  s.signup_date,
  s.status,
  s.source,
  s.last_open_date,
  s.cold_since,
  p.engagement_score,
  CASE WHEN COALESCE(abe.created_at, stub_au.created_at) IS NULL THEN 0 ELSE 1 END AS has_app,
  COALESCE(abe.created_at, stub_au.created_at) AS app_created_at,
  CASE WHEN abe.created_at > s.signup_date THEN 1 ELSE 0 END AS app_after_signup,
  fv.first_page,
  fv.first_utm_source
FROM profiles p
LEFT JOIN subscribers s ON s.email_norm = p.email_norm
LEFT JOIN app_by_email abe ON abe.email_norm = p.email_norm
LEFT JOIN app_users stub_au ON stub_au.user_id = p.user_id AND p.kind = 'unknown_user_stub'
LEFT JOIN first_visit fv ON fv.email_norm = p.email_norm AND fv.n = 1;
