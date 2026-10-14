-- D-77 reverses D-64b (C): the human-approval queue is gone (no approval route, no second
-- password). Nothing else reads or indexes this column (checked: no index, no view names it;
-- 0009_tool_approval.sql added it with no index of its own), so it is dropped outright; migrations
-- are never edited, only added (0001..0009 stay applied as they ran).
ALTER TABLE assistant_tools DROP COLUMN requested_from_trace;
