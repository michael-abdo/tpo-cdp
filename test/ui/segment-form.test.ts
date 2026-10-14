import { describe, expect, it } from 'vitest'
import { FILTER_KEYS, type FilterKey, type SegmentFilters } from '../../shared/segment-filters'
import { BRIEF_EXAMPLE } from '../../src/previous-searches'
import { DEFAULT_FORM, FIELD_OF, moreFiltersOn, toFilters, toForm } from '../../src/segment-form'

// The /segments form as data (09 D-69 review gap 3; 08 T-SEG-6).
// Every filter object here is canonical, as POST /api/segments/preview echoes it (T-SEG-6), with
// real values (09 D-47): sources from subscribers.csv, /shadrachs-picks from web_events.csv, the
// windows and counts of 02 §Counts and 19-segments-spec §3 (30 days, Aug 2026, engagement 50,
// read_story in the last 7 days).

/** The canonical echo of `{}` (T-SEG-6): the defaults every echo holds. */
const BASE: SegmentFilters = { status: ['active'], include_never_opened: false, has_app: null }

/** One case per way a key can be set; together they set every FILTER_KEYS key. */
const CASES: Record<string, SegmentFilters> = {
  'status: both': { ...BASE, status: ['active', 'unsubscribed'] },
  'status: unsubscribed only': { ...BASE, status: ['unsubscribed'] },
  'source: one': { ...BASE, source: ['instagram'] },
  'source: two': { ...BASE, source: ['facebook', 'instagram'] },
  "days_since_open_gte: haven't opened in 30": { ...BASE, days_since_open_gte: 30 },
  'include_never_opened: the brief example': BRIEF_EXAMPLE,
  'went_cold: Aug 2026': { ...BASE, source: ['instagram'], went_cold: '2026-08' },
  'went_cold: any': { ...BASE, went_cold: 'any' },
  'signed_up_within_days: 30': { ...BASE, signed_up_within_days: 30 },
  'engagement_gte: 50': { ...BASE, engagement_gte: 50 },
  'engagement_lte: 40': { ...BASE, engagement_lte: 40 },
  'engagement: 25 to 40': { ...BASE, engagement_gte: 25, engagement_lte: 40 },
  'has_app: true': { ...BASE, has_app: true },
  'has_app: false': { ...BASE, has_app: false },
  'site_visit_within_days: 30': { ...BASE, site_visit_within_days: 30 },
  'site_visit_page: /shadrachs-picks': { ...BASE, site_visit_page: '/shadrachs-picks' },
  'new subscribers who visited /shadrachs-picks': {
    ...BASE,
    signed_up_within_days: 30,
    site_visit_page: '/shadrachs-picks',
  },
  'app_active_within_days: 7': { ...BASE, app_active_within_days: 7 },
  'app_event: read_story': { ...BASE, app_event: 'read_story' },
  'app_event: login in the last 7 days': { ...BASE, app_active_within_days: 7, app_event: 'login' },
  'every key at once': {
    status: ['active', 'unsubscribed'],
    source: ['facebook', 'instagram'],
    days_since_open_gte: 30,
    include_never_opened: true,
    went_cold: '2026-08',
    signed_up_within_days: 30,
    engagement_gte: 25,
    engagement_lte: 40,
    has_app: true,
    site_visit_within_days: 30,
    site_visit_page: '/shadrachs-picks',
    app_active_within_days: 7,
    app_event: 'read_story',
  },
}

/** The keys a filter object sets away from BASE. */
function setKeys(f: SegmentFilters): FilterKey[] {
  return FILTER_KEYS.filter((k) => JSON.stringify(f[k]) !== JSON.stringify(BASE[k]))
}

describe('T-SEG-6 the form round-trips every filter key (toFilters, toForm)', () => {
  it('the cases set every FILTER_KEYS key, so a new key needs a case here', () => {
    const covered = new Set(Object.values(CASES).flatMap(setKeys))
    expect([...covered].sort()).toEqual([...FILTER_KEYS].sort())
  })

  for (const [name, filters] of Object.entries(CASES)) {
    it(`${name}: toFilters(toForm(f)) is f, and toForm(toFilters(form)) is the form`, () => {
      const form = toForm(filters)
      expect(toFilters(form)).toEqual(filters)
      expect(toForm(toFilters(form))).toEqual(form)
      // Each set key moves its own form field off the default, so the form shows it.
      for (const key of setKeys(filters))
        expect(form[FIELD_OF[key]], key).not.toEqual(DEFAULT_FORM[FIELD_OF[key]])
    })
  }

  it('the default form sends the canonical defaults and nothing else', () => {
    expect(toFilters(DEFAULT_FORM)).toEqual(BASE)
    expect(toForm(BASE)).toEqual(DEFAULT_FORM)
    expect(moreFiltersOn(DEFAULT_FORM)).toBe(0)
    expect(moreFiltersOn(toForm(CASES['every key at once']))).toBe(5)
  })

  it('a box is sent as typed, never range-checked in the browser (02 §Normalization)', () => {
    for (const value of ['0', '-5', '2.5', '99999'])
      expect(toFilters({ ...DEFAULT_FORM, signedUpDays: value }).signed_up_within_days).toBe(Number(value))
  })
})
