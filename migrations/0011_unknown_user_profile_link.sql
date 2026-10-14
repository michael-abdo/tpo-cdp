-- Unknown-user stubs are visible to the assistant (09 D-78(b)). profiles.email_norm stays NULL
-- for an unknown_user_stub profile (01 §Tables), so the old v_app_events join
-- (`profiles p ON p.email_norm = u.email_norm`) never matches one: SQL NULL = NULL is unknown,
-- not true, so a stub's events resolved to pkey NULL in the model's views while Look up and
-- /events (which read app_users/profiles directly, 04) already showed them under the stub.
-- worker/webhooks/ingest.ts keys a stub's pkey as HMAC("user:" + user_id) (shared/pseudonym.ts
-- pkeyForUnknownUser); no existing column joins that pkey back to the app_users row it came
-- from, so this adds one. `user_id` is already in the PII denylist (shared/pii.ts) by name,
-- so no view may select this column either; it exists only to be joined on.
--
-- Numbered 0011: another branch already adds 0010_drop_tool_approval.sql (09 D-77) and is not
-- merged into this branch yet; the orchestrator renumbers nothing and merges that branch first,
-- so 0010 is simply absent here and this migration takes the next free number.

ALTER TABLE profiles ADD COLUMN user_id TEXT; -- PII; set only for kind = 'unknown_user_stub'

DROP VIEW v_app_events;

-- Resolves an event to a person the same way Look up and /events already do (01 §Identity
-- resolution): the event's own user_id, or for an anonymous event the device's most recent
-- user; then that user's email profile (pe, by app_users.email_norm = profiles.email_norm); when
-- the user has no email (a stub created by the webhook, 02 §Linking 4) its unknown_user_stub
-- profile instead (pu, by profiles.user_id = app_users.user_id). The two joins can never both
-- match for the same user: a stub's app_users row always has email_norm NULL, and a known user's
-- profiles row always has user_id NULL (set only on stubs), so COALESCE picks whichever one fired.
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
