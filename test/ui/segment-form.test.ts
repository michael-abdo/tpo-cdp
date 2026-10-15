import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import segmentsSource from '../../src/pages/SegmentsPage.tsx?raw'
import { FILTER_KEYS, type FilterKey, type SegmentFilters } from '../../shared/segment-filters'
import { DaysBox, PreviewError } from '../../src/pages/SegmentsPage'
import { BRIEF_EXAMPLE } from '../../src/previous-searches'
import {
  DEFAULT_FORM,
  FIELD_ID,
  FIELD_OF,
  type Form,
  type FormField,
  filterProblems,
  moreFiltersOn,
  toFilters,
  toForm,
} from '../../src/segment-form'

// The /segments form as data (T-SEG-4, T-SEG-6, T-SEG-7, T-SEG-9).
// Every filter object here is canonical, as POST /api/segments/preview echoes it (T-SEG-6), with
// real values: sources from subscribers.csv, /shadrachs-picks from web_events.csv, the
// seed's windows and counts (30 days, Aug 2026, engagement 50,
// read_story in the last 7 days). The server's own problem lines and their plain words are pinned
// against the real Worker in test/segments.test.ts; here they are rendered.

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

  it('moreFiltersOn counts 1 for each More filters field set alone, and 1 (not 2) when both fields of one group are set', () => {
    const alone: Record<'engagementFrom' | 'engagementTo' | 'signedUpDays' | 'wentCold' | 'siteDays' | 'sitePage' | 'appDays' | 'appEvent', Form> = {
      engagementFrom: { ...DEFAULT_FORM, engagementFrom: '25' },
      engagementTo: { ...DEFAULT_FORM, engagementTo: '40' },
      signedUpDays: { ...DEFAULT_FORM, signedUpDays: '30' },
      wentCold: { ...DEFAULT_FORM, wentCold: 'any' },
      siteDays: { ...DEFAULT_FORM, siteDays: '30' },
      sitePage: { ...DEFAULT_FORM, sitePage: '/shadrachs-picks' },
      appDays: { ...DEFAULT_FORM, appDays: '7' },
      appEvent: { ...DEFAULT_FORM, appEvent: 'read_story' },
    }
    for (const [field, form] of Object.entries(alone)) expect(moreFiltersOn(form), field).toBe(1)

    expect(moreFiltersOn({ ...DEFAULT_FORM, engagementFrom: '25', engagementTo: '40' })).toBe(1)
    expect(moreFiltersOn({ ...DEFAULT_FORM, siteDays: '30', sitePage: '/shadrachs-picks' })).toBe(1)
    expect(moreFiltersOn({ ...DEFAULT_FORM, appDays: '7', appEvent: 'read_story' })).toBe(1)
  })

  it('a box is sent as typed, never range-checked in the browser', () => {
    for (const value of ['0', '-5', '2.5', '99999'])
      expect(toFilters({ ...DEFAULT_FORM, signedUpDays: value }).signed_up_within_days).toBe(Number(value))
  })
})

/** The rendered HTML, and its text with tags removed and entities decoded. */
function render(element: ReturnType<typeof createElement>): { html: string; text: string } {
  const html = renderToString(element)
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  return { html, text }
}

// The server's lines as worker/segments/compile.ts writes them; test/segments.test.ts pins that the
// real Worker sends exactly these for these values and that the page turns them into these words.
const SIGNED_UP_LINE = 'signed_up_within_days must be a whole number from 1 to 3650'
const ORDER_LINE = 'engagement_gte must not be greater than engagement_lte'

describe('T-SEG-7, T-SEG-9 a rejected preview names the field and the limit on screen', () => {
  it('the error line says the search did not run and lists each problem in plain words', () => {
    const { text } = render(
      createElement(PreviewError, {
        result: {
          status: 'error',
          message: 'The segment filters are not valid.',
          problems: filterProblems([SIGNED_UP_LINE, ORDER_LINE]),
        },
      }),
    )
    expect(text).toBe(
      "This search didn't run. Signed up in the last: enter a whole number of days from 1 to 3,650. Engagement: “from” must not be higher than “to”.",
    )
    expect(text).not.toMatch(/_|not valid/)
  })

  it('with no field-level problem the server message shows as it is', () => {
    const { text } = render(
      createElement(PreviewError, {
        result: { status: 'error', message: 'Too many requests.', problems: [] },
      }),
    )
    expect(text).toBe('Too many requests.')
  })

  it('the box with the problem shows it under itself, marked invalid and tied by aria-describedby', () => {
    const [problem] = filterProblems([SIGNED_UP_LINE])
    const { html, text } = render(
      createElement(DaysBox, {
        id: 'signed-up-days',
        label: 'Signed up in the last',
        value: '0',
        onChange: () => {},
        hint: 'hint',
        error: problem.message,
      }),
    )
    expect(text).toContain('Signed up in the last: enter a whole number of days from 1 to 3,650.')
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('aria-describedby="signed-up-days-hint signed-up-days-error"')
    expect(html).toContain('id="signed-up-days-error"')
    const clean = render(
      createElement(DaysBox, {
        id: 'signed-up-days',
        label: 'Signed up in the last',
        value: '30',
        onChange: () => {},
        hint: 'hint',
      }),
    )
    expect(clean.html).not.toContain('aria-invalid')
    expect(clean.html).not.toContain('signed-up-days-error')
  })

  it('a line the page cannot read keeps the server words and names no field', () => {
    expect(filterProblems(['filters must be an object', 42])).toEqual([
      { field: null, message: 'filters must be an object' },
    ])
  })

  it("the page puts every field's problem next to its box, and keeps none of its own limits", () => {
    for (const field of Object.keys(FIELD_ID) as FormField[]) {
      const shown =
        segmentsSource.includes(`message={fieldError.${field}}`) ||
        segmentsSource.includes(`error={fieldError.${field}}`)
      expect(shown, field).toBe(true)
    }
    // The old fixed hint restated the limits (and missed the 3,650 days); the server's words replace it.
    expect(segmentsSource).not.toContain('Check the filters: days are whole numbers')
  })
})

describe('T-SEG-4 the page records a search only through previewAndRecord', () => {
  it('SegmentsPage previews with previewAndRecord and never calls recordSearch itself', () => {
    expect(segmentsSource).toContain('await previewAndRecord(')
    expect(segmentsSource).not.toMatch(/\brecordSearch\b/)
  })
})
