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
 * Why a free-form query_sql answer does not match the D-64b positive grammar (totals, or a person
 * list): the one clause REQUEST_APPROVAL_MESSAGE and REQUEST_APPROVAL_OFFER_MESSAGE share, written
 * once (09 D-72 "say one thing in one place") since each needs it under a different ending.
 */
const GRAMMAR_REFUSAL = "This free-form query doesn't match an allowed shape (a total, or a plain list of people), so it can't pin itself."
/**
 * 400 `not_pinnable` for a free-form query_sql answer, returned ONLY once `pin()` has itself
 * called requestApproval and so actually queued it: the one point where "has been sent" is true.
 * Never reused as a preview, or the sentence would promise something that has not happened yet.
 */
export const REQUEST_APPROVAL_MESSAGE = `${GRAMMAR_REFUSAL} It has been sent to the Growth team's approval list instead; once approved there, it pins like any saved question.`
/**
 * The answer card's preview (`pin_refusal` of POST /api/assistant; pinPeriod only reads, never
 * writes): the same grammar refusal as REQUEST_APPROVAL_MESSAGE, before anything is queued, so
 * the card offers a "Request approval" action instead of claiming the queue already happened
 * (09 D-64b finding).
 */
export const REQUEST_APPROVAL_OFFER_MESSAGE = `${GRAMMAR_REFUSAL} Send it to the Growth team for approval instead; once approved there, it pins like any saved question.`
/** A tile whose lookup failed on the server side (a query the database refused, any other error): a retry may help (09 D-64a). */
export const TILE_RUN_FAILED_MESSAGE = 'This tile could not run right now. Press Refresh to try again.'
/** A pin whose first run or store failed on the server side (09 D-64a). */
export const PIN_FAILED_MESSAGE = 'The answer could not be pinned because of a server error. Try Pin to board again.'
