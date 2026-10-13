-- ai_audit rows name the signed session that made the request, so the assistant's
-- 100 calls/hour/session limit (04 §Auth, 09 D-40) is counted from ai_audit itself:
-- Workers Rate Limiting only offers 10 s or 60 s periods (wrangler.jsonc). session_sub is the
-- random `sub` of the cdp_session cookie (worker/auth/session.ts), not PII and not a credential:
-- the cookie also needs its HMAC. NULL for rows written outside a session (tests of the writer).
ALTER TABLE ai_audit ADD COLUMN session_sub TEXT;

CREATE INDEX ai_audit_session_created ON ai_audit (session_sub, created_at);
