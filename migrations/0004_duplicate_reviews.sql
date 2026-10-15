-- Reviewer decisions on scored possible-duplicate pairs. Fuzzy matches never merge on their own;
-- a person decides.
-- One row per pair, replaced when the reviewer changes their mind (POST /api/duplicates/:pair_id/review).
-- No PII column: the pair is named by its two pseudonymous profile keys only. A decision never
-- changes any other table (nothing merges); no foreign key, so a reset that drops and re-seeds
-- profiles cannot be blocked by it, and pkeys are stable across re-seeds (a keyed hash of the
-- email, shared/pseudonym.ts).

CREATE TABLE duplicate_reviews (
  pair_id    TEXT PRIMARY KEY,                    -- worker/dedupe/score.ts pairId: hash of the two pkeys, order-independent
  pkey_a     TEXT NOT NULL,
  pkey_b     TEXT NOT NULL,
  verdict    TEXT NOT NULL CHECK (verdict IN ('same_person','different_people')),
  score      INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100), -- the score shown when decided
  decided_at TEXT NOT NULL,                       -- UTC, when the reviewer pressed the button
  CHECK (pkey_a < pkey_b)
);
