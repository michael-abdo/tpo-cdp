-- D-77 reverses D-64b (C); 0010 dropped the flag column (requested_from_trace) but left any row
-- it had flagged in place. Only the removed requestApproval() ever minted a name with this exact
-- "pending_" prefix (freshToolName('pending'), board.ts, removed in b831ef8), always disabled
-- (enabled = 0) and always handler_type 'query'. An approved row was renamed to the approver's
-- own tool_name (never starting with "pending_") and enabled, so it is not touched. There is no
-- approval route left to reach these rows, and the model-facing loader never selects a disabled
-- row, so they are dead data, not a disabled feature; removed outright rather than left to look
-- like a deliberately-parked Growth row.
DELETE FROM assistant_tools WHERE handler_type = 'query' AND enabled = 0 AND name LIKE 'pending\_%' ESCAPE '\';
