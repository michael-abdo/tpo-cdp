import { describe, expect, it } from 'vitest'
import { DAYS_ERROR_ID, DAYS_HINT_ID, daysFieldState, DAYS_INVALID_NEXT } from '../../src/segments-days-field'

// /segments' days field accessible-error state (09 D-72, 06 principle 8: an error says what to do
// next). Found by the W-UI review: an invalid days value (0, 2.5) gave an error line with no fix
// ("Check the box", no next step naming the field) and no aria-invalid/aria-describedby link from
// #days to that error, so a screen-reader user heard no fix at all.

describe("/segments #days field: aria-invalid + aria-describedby + the error's next step (09 D-72)", () => {
  it('no result: only the hint describes the field, nothing is invalid', () => {
    expect(daysFieldState(null)).toEqual({ ariaInvalid: undefined, ariaDescribedBy: DAYS_HINT_ID, next: undefined })
  })

  it('loading: still only the hint, not invalid', () => {
    expect(daysFieldState({ status: 'loading' })).toEqual({ ariaInvalid: undefined, ariaDescribedBy: DAYS_HINT_ID, next: undefined })
  })

  it('an ok result (no error at all): only the hint, not invalid', () => {
    expect(daysFieldState({ status: 'ok' })).toEqual({ ariaInvalid: undefined, ariaDescribedBy: DAYS_HINT_ID, next: undefined })
  })

  it('a non-filter error (e.g. a network failure): the field itself is not marked invalid', () => {
    expect(daysFieldState({ status: 'error', invalidFilters: false })).toEqual({
      ariaInvalid: undefined,
      ariaDescribedBy: DAYS_HINT_ID,
      next: undefined,
    })
  })

  it('an invalid_filters error (days=0 or days=2.5): aria-invalid, both ids, and a next step naming the field', () => {
    const state = daysFieldState({ status: 'error', invalidFilters: true })
    expect(state.ariaInvalid).toBe(true)
    expect(state.ariaDescribedBy).toBe(`${DAYS_HINT_ID} ${DAYS_ERROR_ID}`)
    expect(state.next).toBe(DAYS_INVALID_NEXT)
    // The fix names the field a screen reader can act on, not "the box" (the next control down is
    // a checkbox, so "the box" could be read as asking to tick it).
    expect(state.next).toContain("Haven't opened an email in at least")
    expect(state.next?.toLowerCase()).not.toContain('check the')
  })
})
