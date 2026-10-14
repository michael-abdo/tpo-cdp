// The insights board's level-1 sentences (09 D-64, D-64a; 04 §/api/insights), one home for the
// server (worker/insights/board.ts) and the tests that render what the page shows. Plain words only:
// the technical reasons go to a tile's error_details or the server log (06 §UI principles 2, 4).

/**
 * The plain sentence of 400 `not_pinnable` for free-form SQL and the board's own tool (09 D-64a,
 * verbatim), also returned with an answer as `pin_refusal` so the answer card offers no Pin for it.
 */
export const NOT_PINNABLE_MESSAGE = "Answers written as free-form queries can't be pinned. Ask the Growth team to add this as a saved question type."
/**
 * 400 `not_pinnable` for any other tool that is not a count, a segment or a saved question type
 * (09 D-64a), e.g. describe_schema, whose answer is no query at all, so D-64a's sentence would be untrue.
 */
export const NOT_PINNABLE_OTHER_MESSAGE = 'Only counts, segments and saved question types can be pinned, and this answer is none of them.'
/** A tile whose lookup failed on the server side (a query the database refused, any other error): a retry may help (09 D-64a). */
export const TILE_RUN_FAILED_MESSAGE = 'This tile could not run right now. Press Refresh to try again.'
/** A pin whose first run or store failed on the server side (09 D-64a). */
export const PIN_FAILED_MESSAGE = 'The answer could not be pinned because of a server error. Try Pin to board again.'
