-- profiles(email_norm) index (design 19 §0 F3, §5.4; 09 D-69). The segment filters on site visits
-- and app activity run `pkey IN (SELECT pkey FROM v_web_events | v_app_events …)`; both views join
-- profiles on email_norm, and without this index SQLite scans profiles for every event row
-- (~300 ms per preview query on the seed, 3–9 ms with it). No table changes.
-- Numbered 0006 because another branch adds 0005.

CREATE INDEX profiles_email ON profiles (email_norm);
