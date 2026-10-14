-- The insights board (design 01 §insights, 09 D-64): the only table for pinned tiles. One shared
-- board; every tile is re-run on view through the gated tool executor with no model call
-- (worker/insights/board.ts), so no result, dashboard or cache table exists.
-- No PII column: params hold filters, keys and the window only; the PII scanner checks params,
-- prompt and title before insert and every tile result on every run (05 §Scanner, T-INS-9).

CREATE TABLE insights (
  id           TEXT PRIMARY KEY,                    -- uuid; the four built-ins below have fixed ids
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  prompt       TEXT,                                -- the question that produced it; a label, never executed; NULL for built-ins
  tool         TEXT NOT NULL,                       -- an enabled assistant_tools.name, or insight_panel for built-ins
  tool_version INTEGER NOT NULL,                    -- the params shape board.ts wrote (INSIGHT_PARAMS_VERSION)
  params       TEXT NOT NULL CHECK (json_valid(params)),
  chart        TEXT CHECK (chart IS NULL OR chart IN ('number','bar','line','table')), -- NULL = auto (shared/pick-chart.ts)
  sort_order   INTEGER NOT NULL,
  built_in     INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0,1)), -- 1 = a former Growth panel; cannot be deleted
  created_at   TEXT NOT NULL                        -- UTC wall clock, when the tile was pinned or seeded (02 §Time allow-list, 09 D-64)
);

-- The four former /growth panels as built-in tiles (09 D-64). Their numbers come from the panel
-- functions in worker/insights/*.ts through the board-only insight_panel tool; the titles are the
-- ones the Growth page showed, in the brief's words (09 D-66). created_at reads the wall clock ('now'): 02 §Time allows it for
-- insights.created_at (09 D-64); no date rule reads it.
INSERT INTO insights (id, title, prompt, tool, tool_version, params, chart, sort_order, built_in, created_at) VALUES
  ('builtin-source-app-conversion', 'Newsletter subscribers who then got the app', NULL, 'insight_panel', 1,
   '{"panel":"source-app-conversion"}', NULL, 10, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('builtin-funnel', 'Website visitors who subscribed', NULL, 'insight_panel', 1,
   '{"panel":"funnel"}', NULL, 20, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('builtin-going-cold', 'Subscribers at risk of going cold', NULL, 'insight_panel', 1,
   '{"panel":"going-cold"}', NULL, 30, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('builtin-data-quality', 'Gaps in the data', NULL, 'insight_panel', 1,
   '{"panel":"data-quality"}', NULL, 40, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
