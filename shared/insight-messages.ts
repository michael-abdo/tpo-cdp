// The insights board's level-1 sentences (09 D-64, D-64a, D-64b, D-77; 04 §/api/insights), one
// home for the server (worker/insights/board.ts) and the tests that render what the page shows.
// Plain words only: the technical reasons go to a tile's error_details, an ApiError's `details`
// or the server log (06 §UI principles 2, 4).

/**
 * The plain sentence of 400 `not_pinnable` for the board's own tool, a builtin row that aliases
 * query_sql under another name (09 D-64a, verbatim), and a query_sql answer with no SQL to
 * classify, also returned with an answer as `pin_refusal` so the answer card offers no Pin for
 * it. A free-form query_sql answer with SQL is instead judged by NOT_PINNABLE_SHAPE_MESSAGE below.
 */
export const NOT_PINNABLE_MESSAGE = "Answers written as free-form queries can't be pinned. Ask the Growth team to add this as a saved question type."
/**
 * 400 `not_pinnable` for any other tool that is not a count, a segment or a saved question type
 * (09 D-64a), e.g. describe_schema, whose answer is no query at all, so D-64a's sentence would be untrue.
 */
export const NOT_PINNABLE_OTHER_MESSAGE = 'Only counts, segments and saved question types can be pinned, and this answer is none of them.'
/**
 * 400 `not_pinnable` for a free-form query_sql answer whose SQL does not match the D-64b positive
 * grammar (a totals query, or a plain list of people): the grammar's own problems ride in the
 * ApiError's `details`, so this sentence says only that it can't be pinned and, in general terms,
 * why. There is no approval queue to offer instead (09 D-77 reverses D-64b (C)): this is the whole
 * refusal, at preview (pinPeriod's `pin_refusal`) and at the POST itself, with nothing queued
 * either time.
 */
export const NOT_PINNABLE_SHAPE_MESSAGE = "This free-form query doesn't match an allowed shape (a total, or a plain list of people), so it can't be pinned."
/** A tile whose lookup failed on the server side (a query the database refused, any other error): a retry may help (09 D-64a). */
export const TILE_RUN_FAILED_MESSAGE = 'This tile could not run right now. Press Refresh to try again.'
/** A pin whose first run or store failed on the server side (09 D-64a). */
export const PIN_FAILED_MESSAGE = 'The answer could not be pinned because of a server error. Try Pin to board again.'
