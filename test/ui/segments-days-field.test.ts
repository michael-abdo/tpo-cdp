/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { DEFINITIONS } from '../../shared/derive'
import { DAYS_ERROR_ID, DAYS_HINT_ID, daysFieldState, DAYS_INVALID_NEXT } from '../../src/segments-days-field'

const segmentsPageSource = import.meta.glob<string>('../../src/pages/SegmentsPage.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
})['../../src/pages/SegmentsPage.tsx']

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

// A level-1 hint says only what the control's own label doesn't (09 D-72, D-55, 06 principle 2/4);
// the full DEFINITIONS doc, for a non-technical reader, belongs in the level-2 "How these filters
// work" disclosure (restored from main), not retyped beside the field. Found by the W-UI review:
// 22cdff6 put all three .doc sentences into always-visible level-1 helper text.
describe('/segments level-1 hints vs the level-2 "How these filters work" disclosure (09 D-72)', () => {
  it('days-hint and the never-opened hint never render a DEFINITIONS .doc (the long, edge-case definition)', () => {
    expect(segmentsPageSource).toBeDefined()
    const hints = segmentsPageSource.slice(
      segmentsPageSource.indexOf('id={DAYS_HINT_ID}'),
      segmentsPageSource.indexOf('<Button type="submit"'),
    )
    for (const key of ['days_since_open', 'no_open_in_days', 'cold'] as const)
      expect(hints).not.toContain(`DEFINITIONS.${key}.doc`)
    expect(hints).toContain('DEFINITIONS.no_open_in_days.plain')
    expect(hints).toContain('DEFINITIONS.cold.plain')
  })

  it('the disclosure shows only days_since_open\'s plain words; no_open_in_days and cold show only their raw formulas (the D-30 reconciliation lives at level 1, once)', () => {
    const definitionsArray = segmentsPageSource.slice(
      segmentsPageSource.indexOf('const FOOTER_PLAIN'),
      segmentsPageSource.indexOf('/** The CSV'),
    )
    // Every one of the three still shows up somewhere in this block (FOOTER_PLAIN or
    // FOOTER_DEFINITIONS), but only days_since_open is in the plain, dt/dd-rendering array.
    for (const key of ['days_since_open', 'no_open_in_days', 'cold'] as const) expect(definitionsArray).toContain(`DEFINITIONS.${key}`)
    const plainArray = segmentsPageSource.slice(
      segmentsPageSource.indexOf('const FOOTER_PLAIN'),
      segmentsPageSource.indexOf('const FOOTER_DEFINITIONS'),
    )
    expect(plainArray).toContain('DEFINITIONS.days_since_open')
    for (const key of ['no_open_in_days', 'cold'] as const) expect(plainArray).not.toContain(`DEFINITIONS.${key}`)
    const footer = segmentsPageSource.slice(segmentsPageSource.lastIndexOf('<Disclosure label="How these filters work"'))
    expect(footer).toContain('FOOTER_PLAIN.map(({ label, def })')
    expect(footer).toContain('{def.doc}')
    expect(footer).toContain('FOOTER_DEFINITIONS.map((def)')
    expect(footer).toContain('{def.formula}')
  })

  it("no_open_in_days.plain and cold.plain are short, new facts, not a retyping of the field's or checkbox's own label", () => {
    const plain = `${DEFINITIONS.no_open_in_days.plain} ${DEFINITIONS.cold.plain}`.toLowerCase()
    expect(plain).not.toContain('also include people who never opened')
    expect(plain).not.toContain("haven't opened an email in at least")
    expect(DEFINITIONS.no_open_in_days.plain?.length).toBeLessThan(DEFINITIONS.no_open_in_days.doc.length)
    expect(DEFINITIONS.cold.plain?.length).toBeLessThan(DEFINITIONS.cold.doc.length)
  })
})
