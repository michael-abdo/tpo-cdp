// The words of the pin dialog that are not markup (src/insights/pin-dialog.tsx; 06 §/insights,
// 09 D-64, D-64a), in their own module so the dialog file exports only its component and a render
// test can read them: what a segment's tile keeps, and the next step for each 04 POST
// /api/insights error that has one (the message itself is the envelope's).

/** What the tile of a segment answer keeps, and what it does not (06 §/insights, 09 D-64). */
export const SEGMENT_PIN_NOTE =
  'The tile keeps how many subscribers match these filters and a link to the segment. It does not keep their order or names.'

/** Next steps for the 04 POST /api/insights errors that have one; the message is the envelope's. */
export function pinNext(code: string | null): string | undefined {
  switch (code) {
    case 'nothing_to_pin':
      return 'This answer did not come from a data lookup, so there is nothing to re-run. Ask a question about subscribers, site visits or app activity.'
    case 'not_found':
      return 'Ask the question again, then pin the new answer.'
    case 'invalid_pin':
      return 'The lookup behind this answer has changed since it was asked. Ask the question again, then pin the new answer.'
    case 'not_pinnable':
      return 'You can still ask it in other words: an answer that is a count or a segment can be pinned.'
    case 'internal_error':
      return 'If it fails again, ask the question again and pin the new answer.'
    default:
      return undefined
  }
}
