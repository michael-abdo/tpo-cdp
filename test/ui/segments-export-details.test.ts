import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import segmentsSource from '../../src/pages/SegmentsPage.tsx?raw'
import { ExportFileDetails } from '../../src/pages/SegmentsPage'
import { BRIEF_EXAMPLE } from '../../src/previous-searches'
import { SEGMENT_COLUMNS, SEGMENT_SORT_COLUMN, type SegmentFilters } from '../../shared/segment-filters'

// /segments "What's in the file" (06 §/segments, R3; 09 D-76): beside Export CSV, one short
// level-1 line names the rows and whether unsubscribed subscribers are part of the file, and a
// level-2 disclosure lists the columns in file order, the sort order and the filters the server
// echoed, every piece read from SEGMENT_COLUMNS / SEGMENT_SORT_COLUMN (shared/segment-filters.ts,
// the same array compileSegment reads to build the export's SQL) so the UI can never describe a
// different file than the one Export CSV downloads. D-72: the row count is stated once more, in
// new words, never the heading's exact count sentence or segmentLabel's exact sentence.

/** React's own marker between two adjacent text-ish children; never real content. */
const rendered = (filters: SegmentFilters, count: number): string =>
  renderToString(createElement(ExportFileDetails, { filters, count })).replaceAll('<!-- -->', '')

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')

/** The rendered HTML, tags stripped and entities decoded, for plain substring assertions. */
function text(filters: SegmentFilters, count: number): string {
  return decode(rendered(filters, count).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** The text of every element `tag`, in order (same reading as test/ui/segments-page.test.ts). */
function cells(filters: SegmentFilters, count: number, tag: string): string[] {
  const html = rendered(filters, count)
  return [...html.matchAll(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'g'))].map((m) => decode(m[1].replace(/<[^>]*>/g, '')))
}

const BOTH: SegmentFilters = { ...BRIEF_EXAMPLE, status: ['active', 'unsubscribed'] }
const UNSUBSCRIBED_ONLY: SegmentFilters = { ...BRIEF_EXAMPLE, status: ['unsubscribed'] }

describe('/segments ExportFileDetails: the level-1 line (09 D-76, D-72)', () => {
  it('active only: names the row count and that unsubscribed is not included', () => {
    expect(text(BRIEF_EXAMPLE, 177)).toContain('177 rows. Unsubscribed subscribers are not included.')
  })

  it('unsubscribed only: names the row count and that every row is unsubscribed', () => {
    expect(text(UNSUBSCRIBED_ONLY, 93)).toContain('93 rows, all unsubscribed.')
  })

  it('both statuses: names the row count and that unsubscribed is included', () => {
    expect(text(BOTH, 270)).toContain('270 rows, including unsubscribed subscribers.')
  })

  it('1 row reads "1 row", not "1 rows"', () => {
    expect(text(BRIEF_EXAMPLE, 1)).toContain('1 row. Unsubscribed subscribers are not included.')
  })
})

describe('/segments ExportFileDetails: "What\'s in the file" (09 D-76)', () => {
  it('lists the columns in file order, by their plain word, in SEGMENT_COLUMNS order', () => {
    expect(text(BRIEF_EXAMPLE, 177)).toContain(
      'Columns, in file order: Email, Status, Acquisition source, Signup date, Last open date, Engagement, Uses the app.',
    )
  })

  it('names the sort order by the same column compileSegment sorts by', () => {
    expect(SEGMENT_SORT_COLUMN).toBe('email')
    expect(text(BRIEF_EXAMPLE, 177)).toContain('Sorted by Email, A to Z.')
  })

  it('raw column headers, export order, sit in Technical details, exactly SEGMENT_COLUMNS joined', () => {
    const html = rendered(BRIEF_EXAMPLE, 177)
    expect(html).toContain([...SEGMENT_COLUMNS].join(', '))
    // Inside <details>, not the plain-word level-2 body (level 3, 06 §UI principles 2–5).
    const techAt = html.indexOf('Technical details')
    expect(techAt).toBeGreaterThan(-1)
    expect(html.indexOf([...SEGMENT_COLUMNS].join(', '))).toBeGreaterThan(techAt)
  })

  it('lists the filters the server echoed, by their plain label and value (src/filters-applied.ts)', () => {
    const dt = cells(BRIEF_EXAMPLE, 177, 'dt')
    const dd = cells(BRIEF_EXAMPLE, 177, 'dd')
    expect(dt).toContain('Status')
    expect(dt).toContain('Acquisition source')
    expect(dt).toContain("Haven't opened an email in at least")
    expect(dd).toContain('Active')
    expect(dd).toContain('Instagram')
    expect(dd).toContain('30 days')
  })

  it('count 0 still renders "0 rows" (the page itself never passes 0 in: ExportFileDetails only renders behind `count > 0`, next test)', () => {
    expect(text(BRIEF_EXAMPLE, 0)).toContain('0 rows. Unsubscribed subscribers are not included.')
  })
})

describe('/segments: ExportFileDetails sits beside Export CSV, only once a result exists (09 D-76)', () => {
  it('the page renders it right after the Export CSV button, gated the same as the button', () => {
    const buttonAt = segmentsSource.indexOf("{exporting ? 'Preparing download…' : 'Export CSV'}")
    const detailsAt = segmentsSource.indexOf('<ExportFileDetails filters={ok.filters} count={ok.data.count} />')
    expect(buttonAt).toBeGreaterThan(-1)
    expect(detailsAt).toBeGreaterThan(buttonAt)
    expect(segmentsSource).toContain('{ok.data.count > 0 && <ExportFileDetails filters={ok.filters} count={ok.data.count} />}')
  })

  it("Technical details' CSV columns sentence was retired, not left as a second copy (09 D-72)", () => {
    expect(segmentsSource).not.toContain('CSV columns:')
    expect(segmentsSource).not.toContain('CSV_COLUMNS')
  })

  // The file Export CSV downloads and the file ExportFileDetails describes must be the same
  // file: both read the identical filters expression, so a divergence (e.g. Export CSV sending
  // a wider status list than the disclosure claims it will) cannot pass silently (09 D-76).
  it('Export CSV and ExportFileDetails read the identical filters expression, not two separate copies', () => {
    const onClickMatch = segmentsSource.match(/onClick=\{\(\) => void exportCsv\(([^)]*)\)\}/)
    const detailsMatch = segmentsSource.match(/<ExportFileDetails filters=\{([^}]*)\} count=/)
    expect(onClickMatch).not.toBeNull()
    expect(detailsMatch).not.toBeNull()
    const exportArg = onClickMatch![1]
    const detailsArg = detailsMatch![1]
    expect(exportArg).toBe('ok.filters')
    expect(exportArg).toBe(detailsArg)
  })

  // The previous test pins the FILTERS EXPRESSION the button passes INTO exportCsv (`ok.filters`).
  // It never looks inside exportCsv itself, so exportCsv could still widen what it sends onward to
  // downloadSegmentCsv (e.g. spreading in its own extra status values) while still receiving the
  // same `filters` argument — the disclosure would then describe a narrower file than the one
  // actually downloaded. Pin exportCsv's body too: its one call to downloadSegmentCsv must forward
  // `filters` exactly, with no widening, narrowing or added fields, and must be the only call site.
  it('exportCsv forwards its filters parameter to downloadSegmentCsv unchanged (no widened status list)', () => {
    const fnAt = segmentsSource.indexOf('async function exportCsv(')
    expect(fnAt).toBeGreaterThan(-1)
    const bodyEnd = segmentsSource.indexOf('\n  }\n', fnAt)
    expect(bodyEnd).toBeGreaterThan(fnAt)
    const body = segmentsSource.slice(fnAt, bodyEnd)
    const calls = [...body.matchAll(/downloadSegmentCsv\([^)]*\)/g)].map((m) => m[0])
    expect(calls).toEqual(['downloadSegmentCsv(filters)'])
  })
})
