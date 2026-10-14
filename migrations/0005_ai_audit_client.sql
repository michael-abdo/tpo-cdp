-- ai_audit rows also name the client network that made the request, so the assistant's
-- 100 calls/hour limit (04 §Auth, 09 D-40) counts per client as well as per session and signing
-- in again does not reset it (09 D-70 #6). client_key is `ck_` + 16 hex chars of
-- HMAC-SHA256(PII_KEY_SECRET, "client:" + CF-Connecting-IP) (shared/pseudonym.ts clientKeyHash):
-- keyed, so the raw address is never stored and cannot be recomputed without the secret.
-- NULL for rows written outside a request (tests of the writer) and for rows written before 0005.
ALTER TABLE ai_audit ADD COLUMN client_key TEXT;

CREATE INDEX ai_audit_client_created ON ai_audit (client_key, created_at);
