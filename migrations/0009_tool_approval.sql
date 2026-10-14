-- Human approval for a free-form query_sql pin whose SQL does not pass the D-64b positive grammar
-- (09 D-64b). No new table: "Request approval" stores the SQL as a disabled `query`-type
-- assistant_tools row, flagged by this one column so the approval list can find it; approving
-- flips `enabled` and records who/why in the existing `metadata` JSON column (no new column for
-- that: 0001_core.sql's assistant_tools.metadata already holds free-form JSON).
ALTER TABLE assistant_tools ADD COLUMN requested_from_trace TEXT;
