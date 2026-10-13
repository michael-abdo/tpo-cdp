-- web_visitors.signup_ts: the event_ts of the /subscribe row that carried the visitor's email,
-- i.e. the signup moment of 02 §Linking 2 (09 D-08). /api/lookup marks a web event pre_signup
-- when its event_ts is earlier (04 §/api/lookup). It cannot be derived from the other stored
-- columns: in data/*.csv 521 visitors have more than one /subscribe row, 1,033 /subscribe rows
-- carry no email, and the emailed row is not the earliest /subscribe row for 101 visitors.
-- NULL exactly when email_norm is NULL (anonymous visitor); written by the seed
-- (worker/ingest/web.ts). Nullable with no CHECK so it applies to a database that already
-- holds rows; such rows must be re-seeded (11 §Reset), and /api/lookup fails loud on a linked
-- visitor whose signup_ts is NULL.
ALTER TABLE web_visitors ADD COLUMN signup_ts TEXT;
