// The words of the pin dialog that are not markup (src/insights/pin-dialog.tsx; 06 §/insights,
// 09 D-64, D-64a), in their own module so the dialog file exports only its component and a render
// test can read them: what a segment's tile keeps, and the next step for each 04 POST
// /api/insights error that has one (the message itself is the envelope's).

/** What the tile of a segment answer keeps, and what it does not (06 §/insights, 09 D-64). */
export const SEGMENT_PIN_NOTE =
  'The tile keeps how many subscribers match these filters and a link to the segment. It does not keep their order or names.'

/** The next step two pin errors share, written once (09 D-72). */
const ASK_AGAIN = 'Ask the question again, then pin the new answer.'

/** Next steps for the 04 POST /api/insights errors that have one; the message is the envelope's. */
export function pinNext(code: string | null): string | undefined {
  switch (code) {
    case 'nothing_to_pin':
      return 'This answer did not come from a data lookup, so there is nothing to re-run. Ask a question about subscribers, site visits or app activity.'
    case 'not_found':
      return ASK_AGAIN
    case 'invalid_pin':
      return `The lookup behind this answer has changed since it was asked. ${ASK_AGAIN}`
    case 'not_pinnable':
      return 'You can still ask it in other words: an answer that is a count, a segment or a saved question type can be pinned.'
    case 'internal_error':
      return 'If it fails again, ask the question again and pin the new answer.'
    default:
      return undefined
  }
}

/**
 * The body of POST /api/insights (04): the trace id and, only when the person changed the title, the
 * title. An unchanged title is left to the server, which names the tile after the Gate 1-redacted
 * question, so a question that held an email or a known local part still pins.
 */
export function pinBody(auditId: string, title: string, question: string): { audit_id: string; title?: string } {
  return title === question ? { audit_id: auditId } : { audit_id: auditId, title }
}
