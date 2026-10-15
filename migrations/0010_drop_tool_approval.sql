-- The human-approval queue from 0009 is gone (no approval route, no second password): a pin is
-- now a shape the server can verify, or it is refused. First the rows the queue left behind: a
-- request was a disabled row flagged with the trace it came from (an approved one was enabled,
-- and stays), and with no route left they are dead data. They are found by that flag, not by
-- name, before the flag column goes. Nothing else reads or indexes the column (checked: no
-- index, no view names it; 0009 added it with no index), so it is then dropped outright. The SQL
-- of an applied migration never changes; 0001..0009 stay as they ran.
DELETE FROM assistant_tools WHERE requested_from_trace IS NOT NULL AND enabled = 0;
ALTER TABLE assistant_tools DROP COLUMN requested_from_trace;
