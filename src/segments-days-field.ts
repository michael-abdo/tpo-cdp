// /segments' "Haven't opened an email in at least" field: its accessible-error state (09 D-72, 06
// principle 8: an error says what to do next). Pulled out of SegmentsPage.tsx so it stays a plain,
// directly tested function (that file must only export its default component, for Fast Refresh;
// `oxlint`'s react(only-export-components) rule enforces it, and the gate's one known warning is
// src/components.tsx's, not a second one here).

/** The shape SegmentsPage's `Result` needs for this: only whether it is an `invalid_filters` error. */
export interface DaysFieldResult {
  status: 'loading' | 'error' | 'ok'
  invalidFilters?: boolean
}

/** The days field's hint id, referenced by the input and, on an invalid value, by the error too. */
export const DAYS_HINT_ID = 'days-hint'
/** The invalid-filters error line's id, added to the days field's aria-describedby (09 D-72: the
 * valid-value rule stays only in DAYS_HINT_ID; the error names the field so it reads on its own). */
export const DAYS_ERROR_ID = 'days-error'
/** The error line's next step for an invalid days value: names the field, not "the box" (a screen
 * reader loses "the box"'s context, and a sighted reader could read it as the checkbox below). */
export const DAYS_INVALID_NEXT = "Change the number in the “Haven't opened an email in at least” box."

/**
 * The `#days` field's accessible-error state: only an `invalid_filters` 400 marks the field
 * invalid, ties the error line to it with `aria-describedby`, and gives a next step naming the
 * field.
 */
export function daysFieldState(result: DaysFieldResult | null): {
  ariaInvalid: true | undefined
  ariaDescribedBy: string
  next: string | undefined
} {
  const invalid = result?.status === 'error' && result.invalidFilters === true
  return {
    ariaInvalid: invalid ? true : undefined,
    ariaDescribedBy: invalid ? `${DAYS_HINT_ID} ${DAYS_ERROR_ID}` : DAYS_HINT_ID,
    next: invalid ? DAYS_INVALID_NEXT : undefined,
  }
}
