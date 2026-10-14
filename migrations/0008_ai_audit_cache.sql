-- ai_audit stores the two extra usage meters prompt caching adds (09 D-74; design 20-token-usage-spec.md
-- §3 R2): how many of a model_request's prompt tokens were an ephemeral cache write vs. a cache
-- read. tokens_in keeps meaning "prompt tokens sent" (input + cache read + cache write, loop.ts);
-- these two columns are this lever's proof surface — 0 (or NULL, for rows written before this
-- migration) on a cold call, > 0 once a call lands inside the 5-minute cache TTL.
ALTER TABLE ai_audit ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE ai_audit ADD COLUMN cache_write_tokens INTEGER;
