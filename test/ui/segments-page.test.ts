import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import componentsSource from '../../src/components.tsx?raw'
import segmentsSource from '../../src/pages/SegmentsPage.tsx?raw'
import { TODAY } from '../../shared/config'
import { addDays, DEFINITIONS, isNewSubscriber, NEW_SUBSCRIBER_DAYS } from '../../shared/derive'
import { DEFINITION_LABEL, explain, GLOSSARY, isGlossaryKey } from '../../shared/glossary'
import { BRIEF_EXAMPLE } from '../../src/previous-searches'
import { DaysBox, MatchingRows, NEW_SUBSCRIBERS_HINT, RowDetails, SearchOutcome } from '../../src/pages/SegmentsPage'
import type { SegmentRow } from '../../src/types'

// /segments rendered (06 §/segments, §Vocabulary, §UI principles 4; 09 D-66, D-69; 19-segments-spec
// §2, §7), fixes from the D-69 review, round 1. React's server renderer cannot render the whole
// page (InfoTip portals to document.body), so this renders its exported parts and reads the
// page's source for where they sit and which InfoTips it shows.
// Inputs: julia.evans230's row of subscribers.csv (line 373: signed up 2026-09-13, active,
// Instagram, last open 2026-09-15) with her seeded engagement_score 28 and app account (02
// §Counts demo subject); 46 is Instagram went cold in 2026-08 (02 §Counts); the filters are the
// brief's example (src/previous-searches.ts) and the same with both statuses.

const JULIA: SegmentRow = {
  email: 'julia.evans230@gmail.com',
  status: 'active',
  source: 'instagram',
  signup_date: '2026-09-13',
  last_open_date: '2026-09-15',
  engagement_score: 28,
  has_app: true,
}

/** The rendered HTML, and its text with tags removed and entities decoded. */
function render(element: ReturnType<typeof createElement>): { html: string; text: string } {
  const html = renderToString(element)
  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
  return { html, text }
}

/** The text of every element `tag` in `html`, in order. */
const cells = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'g'))].map((m) => m[1].replace(/<[^>]*>/g, ''))

/** 06 §Vocabulary "subscriber fields": the brief's words, the only labels a subscriber field may have. */
const SUBSCRIBER_FIELDS = ['Email', 'Signup date', 'Status', 'Acquisition source', 'Last open date']

describe('/segments: a search run from Previous searches shows its count beside the list (19 §2)', () => {
  it('SearchOutcome says the count and links to the result heading, from which Tab reaches Export CSV', () => {
    const { html, text } = render(createElement(SearchOutcome, { outcome: { status: 'ok', count: 46 } }))
    expect(text.trim()).toBe('46 subscribers match. See them and export the CSV')
    expect(html).toContain('href="#result-heading"')
    expect(render(createElement(SearchOutcome, { outcome: { status: 'ok', count: 1 } })).text.trim()).toBe('1 subscriber matches. See them and export the CSV')
    expect(render(createElement(SearchOutcome, { outcome: { status: 'ok', count: 0 } })).text.trim()).toBe('No subscribers match. See the result')
    expect(render(createElement(SearchOutcome, { outcome: { status: 'loading' } })).text.trim()).toBe('Counting matching subscribers…')
    const error = render(createElement(SearchOutcome, { outcome: { status: 'error' } }))
    expect(error.text.trim()).toBe("This search didn't run. See why")
    expect(error.html).toContain('href="#preview-error"')
    // Not a live region: the page's one Announcer reads the count, so it is never heard twice.
    expect(html).not.toMatch(/role="status"|aria-live/)
  })

  it('the outcome sits inside the Previous searches section, after the list, and the link targets exist', () => {
    const start = segmentsSource.indexOf('<section aria-labelledby="previous-heading"')
    expect(start).toBeGreaterThan(0)
    const section = segmentsSource.slice(start, segmentsSource.indexOf('</section>', start))
    expect(section.indexOf('<SearchOutcome outcome={outcome} />')).toBeGreaterThan(section.indexOf('</ul>'))
    // The page fills it for a previous search or "Open list" only, and the targets carry the ids.
    expect(segmentsSource).toContain("result === null || origin === 'form' || cleared")
    expect(segmentsSource).toContain("load(row.filters, 'previous')")
    expect(segmentsSource).toContain("preview(toFilters(toForm(opened)), 'opened')")
    expect(segmentsSource).toContain("const RESULT_HEADING_ID = 'result-heading'")
    expect(segmentsSource).toContain('<h2 id={RESULT_HEADING_ID} tabIndex={-1}')
    expect(segmentsSource).toContain("const PREVIEW_ERROR_ID = 'preview-error'")
    expect(segmentsSource).toContain('id={PREVIEW_ERROR_ID}')
  })

  it('while counting, one live region speaks: <Loading>, never the Announcer as well', () => {
    expect(segmentsSource).toContain('<Loading label="Counting matching subscribers…" />')
    expect(segmentsSource).toContain("if (result?.status === 'loading') announcement = ''")
    expect(segmentsSource).not.toMatch(/announcement = 'Counting/)
  })

  it('"Went cold" left blank reads "Don\'t filter", never "Any subscriber" beside "Any time (cold now)"', () => {
    const select = segmentsSource.slice(segmentsSource.indexOf('id="went-cold"'), segmentsSource.indexOf('</select>', segmentsSource.indexOf('id="went-cold"')))
    expect(select).toContain('<option value="">Don\'t filter</option>')
    expect(select).toContain('<option value="any">Any time (cold now)</option>')
    expect(select).not.toContain('Any subscriber')
  })

  it('More filters starts open, so the brief\'s Growth filters need no extra click (19 §7 note)', () => {
    expect(segmentsSource).toContain('const [moreOpen, setMoreOpen] = useState(true)')
  })
})

describe('/segments names "new subscribers" at level 1, beside "Signed up in the last" (19 §3 row 2, 06 §Vocabulary)', () => {
  it('the box renders the hint under it, tied to the input by aria-describedby', () => {
    const { html, text } = render(
      createElement(DaysBox, { id: 'signed-up-days', label: 'Signed up in the last', value: '', onChange: () => {}, hint: NEW_SUBSCRIBERS_HINT }),
    )
    expect(text).toContain('new subscribers')
    expect(html).toMatch(/<input[^>]*id="signed-up-days"[^>]*aria-describedby="signed-up-days-hint"/)
    expect(html).toMatch(/<p id="signed-up-days-hint"[^>]*>30 days = new subscribers\.<\/p>/)
    // A box with no hint describes nothing.
    const plain = render(createElement(DaysBox, { id: 'site-days', label: 'Visited the site in the last', value: '', onChange: () => {} }))
    expect(plain.html).not.toContain('aria-describedby')
  })

  it('the 30 in the hint is the new_subscriber window: day 30 before TODAY is new, day 31 is not', () => {
    expect(NEW_SUBSCRIBERS_HINT.startsWith(`${NEW_SUBSCRIBER_DAYS} days`)).toBe(true)
    expect(isNewSubscriber(addDays(TODAY, -NEW_SUBSCRIBER_DAYS))).toBe(true)
    expect(isNewSubscriber(addDays(TODAY, -NEW_SUBSCRIBER_DAYS - 1))).toBe(false)
  })

  it('the page gives the hint to the "Signed up in the last" box, in the Newsletter info group', () => {
    const start = segmentsSource.indexOf('<DaysBox\n                id="signed-up-days"')
    expect(start).toBeGreaterThan(segmentsSource.indexOf('>Newsletter info</legend>'))
    const box = segmentsSource.slice(start, segmentsSource.indexOf('/>', segmentsSource.indexOf('hint=', start)) + 2)
    expect(box).toContain('label="Signed up in the last"')
    expect(box).toContain('hint={NEW_SUBSCRIBERS_HINT}')
  })
})

describe('/segments: subscriber fields in the brief\'s words (06 §Vocabulary, 09 D-66)', () => {
  it('the table headers and the row Details use the vocabulary\'s subscriber fields', () => {
    const both = render(createElement(MatchingRows, { filters: { ...BRIEF_EXAMPLE, status: ['active', 'unsubscribed'], source: undefined }, rows: [JULIA] }))
    expect(cells(both.html, 'th').filter((h) => h !== 'Details')).toEqual(['Email', 'Status', 'Acquisition source', 'Last open date', 'Engagement'])
    // One source: the source column would repeat the filter, so it is left out (principle 5).
    const one = render(createElement(MatchingRows, { filters: BRIEF_EXAMPLE, rows: [JULIA] }))
    expect(cells(one.html, 'th').filter((h) => h !== 'Details')).toEqual(['Email', 'Last open date', 'Engagement'])
    // Phones: the same words as card labels.
    expect(cells(both.html, 'dt')).toEqual(['Email', 'Status', 'Acquisition source', 'Last open date', 'Engagement'])

    const details = render(createElement(RowDetails, { row: JULIA }))
    expect(cells(details.html, 'dt')).toEqual(['Signup date', 'Acquisition source', 'App account'])
    expect(details.text).toContain('Instagram')

    for (const label of [...cells(both.html, 'th'), ...cells(details.html, 'dt')]) {
      expect(label).not.toMatch(/reader|Signed up|Last opened/i)
    }
    for (const field of SUBSCRIBER_FIELDS.filter((f) => f !== 'Signup date')) expect(cells(both.html, 'th')).toContain(field)
    expect(cells(details.html, 'dt')).toContain('Signup date')
  })

  it('the filter form calls the source "Acquisition source", the same words as the rows', () => {
    expect(segmentsSource).toContain('<legend className={labelClass}>Acquisition source</legend>')
  })
})

describe('/segments InfoTips name each term in plain words, never a raw name (06 §UI principles 4, 09 D-66)', () => {
  it('every InfoTip on /segments names a known term whose words hold no "_", and its accessible name uses those words', () => {
    const all = [...segmentsSource.matchAll(/<InfoTip\b/g)].length
    const terms = [...segmentsSource.matchAll(/<InfoTip term="([a-z_]+)" \/>/g)].map((m) => m[1])
    // Every InfoTip on the page names its term literally, so this list is all of them.
    expect(terms.length).toBe(all)
    expect(terms).toEqual(['previous_searches', 'engagement_score', 'new_subscriber', 'cold'])
    for (const term of terms) {
      const words = explain(term).term
      const plain = isGlossaryKey(term) ? GLOSSARY[term].term : DEFINITION_LABEL[term as keyof typeof DEFINITIONS]
      expect(words, term).toBe(plain)
      expect(words, term).not.toMatch(/_/)
      expect(`What “${words}” means`, term).not.toMatch(/_/)
    }
    expect(terms.map((t) => explain(t).term)).toEqual(['Previous searches', 'Engagement', 'New subscriber', 'Cold'])
    // The button's accessible name is built from explain()'s words, not from the key.
    expect(componentsSource).toContain('const { term: words, text } = explain(term)')
    expect(componentsSource).toContain('What “{words}” means')
  })
})
