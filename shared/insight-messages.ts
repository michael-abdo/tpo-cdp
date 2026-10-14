// The insights board's level-1 sentences (09 D-64, D-64a; 04 §/api/insights), one home for the
// server (worker/insights/board.ts) and the tests that render what the page shows. Plain words only:
// the technical reasons go to a tile's error_details or the server log (06 §UI principles 2, 4).

/**
 * The plain sentence of 400 `not_pinnable` for the board's own tool and a builtin row that aliases
 * query_sql under another name (09 D-64a, verbatim), also returned with an answer as
 * `pin_refusal` so the answer card offers no Pin for it. A free-form query_sql answer itself is no
 * longer always this sentence: D-64b lets it pin when its SQL passes the positive grammar
 * (REQUEST_APPROVAL_MESSAGE below is its refusal).
 */
export const NOT_PINNABLE_MESSAGE = "Answers written as free-form queries can't be pinned. Ask the Growth team to add this as a saved question type."
/**
 * 400 `not_pinnable` for any other tool that is not a count, a segment or a saved question type
 * (09 D-64a), e.g. describe_schema, whose answer is no query at all, so D-64a's sentence would be untrue.
 */
export const NOT_PINNABLE_OTHER_MESSAGE = 'Only counts, segments and saved question types can be pinned, and this answer is none of them.'
/**
 * 400 `not_pinnable` for a free-form query_sql answer whose SQL does not pass the D-64b positive
 * grammar (totals, or a person list). The SQL is sent to the Growth team's approval list instead
 * of being discarded (09 D-64b "Request approval"); once a teammate approves it there, it pins
 * like any saved question type.
 */
export const REQUEST_APPROVAL_MESSAGE =
  "This free-form query doesn't match an allowed shape (a total, or a plain list of people), so it can't pin itself. " +
  "It has been sent to the Growth team's approval list instead; once approved there, it pins like any saved question."
/** A tile whose lookup failed on the server side (a query the database refused, any other error): a retry may help (09 D-64a). */
export const TILE_RUN_FAILED_MESSAGE = 'This tile could not run right now. Press Refresh to try again.'
/** A pin whose first run or store failed on the server side (09 D-64a). */
export const PIN_FAILED_MESSAGE = 'The answer could not be pinned because of a server error. Try Pin to board again.'
