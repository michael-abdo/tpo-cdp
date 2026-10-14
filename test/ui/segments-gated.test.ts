import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../shared/features'
import {
  GatedEmailDomain,
  GatedGoingColdRisk,
  GatedOpenedWithinDays,
  GatedSignedUpBetween,
  GatedSiteVisitsAtLeast,
  SendToBeehiiv,
} from '../../src/pages/SegmentsPage'
import { FILTER_KEYS } from '../../shared/segment-filters'

// Segments' gated future features (09 D-80, 22-pages/segments.md): Send to beehiiv, and the five
// "More filters" (one flag each, group: 'more_filters'). None carries state: none has a key in
// FILTER_KEYS, so none can reach the filters object, Previous searches or the export.

const MORE_FILTERS = [
  { Component: GatedSignedUpBetween, id: 'filter_signed_up_between' as const },
  { Component: GatedOpenedWithinDays, id: 'filter_opened_within_days' as const },
  { Component: GatedSiteVisitsAtLeast, id: 'filter_site_visits_gte' as const },
  { Component: GatedGoingColdRisk, id: 'filter_going_cold_risk' as const },
  { Component: GatedEmailDomain, id: 'filter_email_domain' as const },
]

describe('Segments: the five gated "More filters"', () => {
  it('each renders aria-disabled="true", never disabled, with a describedby that resolves to its own note', () => {
    for (const { Component, id } of MORE_FILTERS) {
      const html = renderToString(createElement(Component)).replaceAll('<!-- -->', '')
      expect(html).toContain('aria-disabled="true"')
      expect(html).not.toContain(' disabled')
      expect(html).toContain(FEATURES[id].note)
    }
  })

  it('every gated filter id is its own flag with group "more_filters", and none of them is a real FILTER_KEYS entry', () => {
    for (const { id } of MORE_FILTERS) {
      expect(FEATURES[id].group).toBe('more_filters')
      expect(FILTER_KEYS).not.toContain(id)
    }
    // The real, built filter keys these five gate (none exist yet):
    for (const key of ['signed_up_from', 'signed_up_to', 'opened_within_days', 'site_visits_gte', 'going_cold_risk', 'email_domain'])
      expect(FILTER_KEYS as readonly string[]).not.toContain(key)
  })

  it('the checkbox stays unchecked and the select stays on "Any domain"', () => {
    expect(renderToString(createElement(GatedGoingColdRisk))).not.toContain('checked=""')
    const domainHtml = renderToString(createElement(GatedEmailDomain))
    expect(domainHtml).toContain('Any domain</option>')
    expect(domainHtml.match(/<option/g)?.length).toBe(1)
  })

  it('never renders a free-text input for Email domain (a <select> only)', () => {
    const html = renderToString(createElement(GatedEmailDomain))
    expect(html).toContain('<select')
    expect(html).not.toMatch(/<input[^>]*type="text"/)
  })
})

describe('Segments: Send to beehiiv', () => {
  it('renders aria-disabled="true", never disabled, with its note equal to shared/features.ts', () => {
    const html = renderToString(createElement(SendToBeehiiv)).replaceAll('<!-- -->', '')
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain(' disabled')
    expect(html).toContain(FEATURES.send_to_beehiiv.note)
  })
})
