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
import { FILTER_KEYS, type SegmentFilters } from '../../shared/segment-filters'
import { describedByResolvesTo, hasDisabledAttribute } from '../helpers/gated-assertions'
import { DEFAULT_FORM, toFilters } from '../../src/segment-form'
import { recordSearch, type SearchStore } from '../../src/previous-searches'

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
  it('each renders aria-disabled="true", never disabled, with a describedby that resolves exactly to its own note', () => {
    for (const { Component, id } of MORE_FILTERS) {
      const html = renderToString(createElement(Component)).replaceAll('<!-- -->', '')
      expect(html).toContain('aria-disabled="true"')
      expect(hasDisabledAttribute(html)).toBe(false)
      expect(describedByResolvesTo(html, FEATURES[id].note)).toBe(true)
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

/** An in-memory SearchStore (never the real localStorage), so a direct test can see exactly what
 * recordSearch would persist, with no browser. */
function memoryStore(): SearchStore {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('T-GATE-4 (direct): toFilters and recordSearch never carry a gated key', () => {
  it('toFilters(DEFAULT_FORM) holds only real FILTER_KEYS entries', () => {
    const filters = toFilters(DEFAULT_FORM)
    for (const key of Object.keys(filters)) expect(FILTER_KEYS as readonly string[], key).toContain(key)
  })

  it('a fully-filled form still produces only real FILTER_KEYS entries (no gated key sneaks in with the rest set)', () => {
    const filled = {
      ...DEFAULT_FORM,
      sources: ['instagram'],
      days: '30',
      includeNeverOpened: true,
      hasApp: 'yes' as const,
      signedUpDays: '14',
      wentCold: '2026-09',
      engagementFrom: '10',
      engagementTo: '90',
      siteDays: '7',
      sitePage: '/pricing',
      appDays: '3',
      appEvent: 'app_open' as const,
    }
    const filters = toFilters(filled)
    for (const key of Object.keys(filters)) expect(FILTER_KEYS as readonly string[], key).toContain(key)
    for (const id of MORE_FILTERS.map((m) => m.id)) expect(Object.keys(filters)).not.toContain(id)
  })

  it("a filters object carrying a gated key is refused whole by recordSearch — it never reaches Previous searches", () => {
    const store = memoryStore()
    const withGatedKey = { status: ['active'], include_never_opened: false, has_app: null, filter_email_domain: 'gmail.com' } as unknown as SegmentFilters
    expect(recordSearch(withGatedKey, store)).toEqual([])
    expect(store.getItem('tpo-cdp-previous-searches')).toBeNull()
  })

  it('a clean filters object with the same real keys IS recorded (the refusal above is about the gated key, not the store)', () => {
    const store = memoryStore()
    const clean: SegmentFilters = { status: ['active'], include_never_opened: false, has_app: null }
    expect(recordSearch(clean, store)).toEqual([clean])
  })
})

describe('Segments: Send to beehiiv', () => {
  it('renders aria-disabled="true", never disabled, with a describedby that resolves exactly to its note', () => {
    const html = renderToString(createElement(SendToBeehiiv)).replaceAll('<!-- -->', '')
    expect(html).toContain('aria-disabled="true"')
    expect(hasDisabledAttribute(html)).toBe(false)
    expect(describedByResolvesTo(html, FEATURES.send_to_beehiiv.note)).toBe(true)
  })
})
