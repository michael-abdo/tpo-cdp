-- PII-free views: the only relations the model can touch.
-- PII denylist (the code copy is PII_COLUMNS in shared/pii.ts):
--   email_norm, email_raw, user_id, device_id, visitor_id, raw_row, properties
-- No view selects any of them (T-PII-2); they appear only in join conditions.
-- cold_since and engagement_score are stored columns written by shared/derive.ts; SQL holds no
-- formula, so each rule has one home.

CREATE VIEW v_profiles AS
WITH app AS (
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
  CASE WHEN app.created_at IS NULL THEN 0 ELSE 1 END AS has_app,
  app.created_at AS app_created_at,
  CASE WHEN app.created_at > s.signup_date THEN 1 ELSE 0 END AS app_after_signup,
  fv.first_page,
  fv.first_utm_source
FROM profiles p
LEFT JOIN subscribers s ON s.email_norm = p.email_norm
LEFT JOIN app ON app.email_norm = p.email_norm
LEFT JOIN first_visit fv ON fv.email_norm = p.email_norm AND fv.n = 1;

CREATE VIEW v_web_events AS
SELECT
  p.pkey,
  wv.visitor_hash,
  we.page,
  we.event_ts,
  we.utm_source
FROM web_events we
JOIN web_visitors wv ON wv.visitor_id = we.visitor_id
LEFT JOIN profiles p ON p.email_norm = wv.email_norm;

-- Identity resolution at read time: an event's own user_id, or for
-- an anonymous event the device's most recent user, then app_users.email_norm → profiles.
CREATE VIEW v_app_events AS
SELECT
  p.pkey,
  e.event,
  e.event_ts,
  json_extract(e.properties, '$.story') AS story,
  json_extract(e.properties, '$.link') AS link
FROM app_events e
LEFT JOIN device_identity d ON e.user_id IS NULL AND d.device_id = e.device_id
LEFT JOIN app_users u ON u.user_id = COALESCE(e.user_id, d.user_id)
LEFT JOIN profiles p ON p.email_norm = u.email_norm;

CREATE VIEW v_funnel AS
SELECT
  first_page,
  first_utm_source,
  COUNT(*) AS visitors,
  COUNT(email_norm) AS subscribed
FROM web_visitors
GROUP BY first_page, first_utm_source;

-- Funnel direction: converted only if the app account was created after signup.
CREATE VIEW v_source_app_conversion AS
WITH per_subscriber AS (
  SELECT
    s.source,
    EXISTS (
      SELECT 1 FROM app_users a
      WHERE a.email_norm = s.email_norm AND a.created_at > s.signup_date
    ) AS converted
  FROM subscribers s
)
SELECT
  source,
  COUNT(*) AS subscribers,
  SUM(converted) AS with_app_after_signup,
  CAST(SUM(converted) AS REAL) / COUNT(*) AS rate
FROM per_subscriber
GROUP BY source;
