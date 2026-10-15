import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { DEFINITIONS } from '../../shared/derive'
import SegmentsPage from '../../src/pages/SegmentsPage'
import type { SegmentFilters } from '../../src/types'

// /segments: each fact once per screen across levels. The
// never-opened toggle's contrast with "Cold" is the level-1 hint beside the days field;
// "How these filters work" (level 2) no longer repeats no_open_in_days' or cold's plain words, only
// their raw formulas in Technical details (level 3). A days value is routed in via location.state,
// the same way "Open segment" on /insights arrives (SegmentsPage's own opened-filters path), so the
// hint renders without a days value typed in by a user.

const FILTERS: SegmentFilters = {
  status: ['active'],
  source: ['instagram'],
  days_since_open_gte: 30,
  include_never_opened: true,
  has_app: null,
}

/** What a person reads: React's <!-- --> between adjacent text nodes removed, and the HTML entities
 * React escapes (quotes, `>=`, `&`) turned back into plain text so a string comparison matches. */
function rendered(): string {
  const html = renderToString(
    createElement(
      MemoryRouter,
      { initialEntries: [{ pathname: '/segments', state: { filters: FILTERS } }] },
      createElement(SegmentsPage),
    ),
  ).replaceAll('<!-- -->', '')
  return html
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
}

describe('T-UI-ONE /segments: the Cold reconciliation appears exactly once (09 D-72, D-30)', () => {
  const html = rendered()

  it('the level-1 hint beside the days field states the reconciliation', () => {
    expect(html).toContain(`${DEFINITIONS.no_open_in_days.plain} ${DEFINITIONS.cold.plain}`)
  })

  it('cold.plain is written exactly once on the screen', () => {
    const count = html.split(DEFINITIONS.cold.plain).length - 1
    expect(count).toBe(1)
  })

  it('no_open_in_days.plain is written exactly once on the screen', () => {
    const count = html.split(DEFINITIONS.no_open_in_days.plain).length - 1
    expect(count).toBe(1)
  })

  it('"How these filters work" shows days_since_open in plain words only; cold and no_open_in_days plain words are gone from it', () => {
    expect(html).toContain('Days since last open')
    expect(html).toContain(DEFINITIONS.days_since_open.doc)
    expect(html).not.toContain(DEFINITIONS.cold.doc)
    expect(html).not.toContain(DEFINITIONS.no_open_in_days.doc)
  })

  it('Technical details still names every formula, cold and no_open_in_days included', () => {
    expect(html).toContain(DEFINITIONS.days_since_open.formula)
    expect(html).toContain(DEFINITIONS.no_open_in_days.formula)
    expect(html).toContain(DEFINITIONS.cold.formula)
  })
})
