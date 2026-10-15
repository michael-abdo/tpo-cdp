import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { humanDate, humanDateTime } from '../../src/format'
import { SourcesTable } from '../../src/pages/OverviewPage'
import type { CsvSource, WebhookSource } from '../../src/types'

// Overview's Sources table, Last sync column: a CSV's last sync is a
// date (one run a day at most), but the webhook's row must show date AND time, so a reader can tell
// an event arrived moments ago rather than merely "today".

const CSV: CsvSource = {
  id: 'subscribers',
  name: 'beehiiv',
  kind: 'csv',
  unit: 'subscribers',
  unit_one: 'subscriber',
  loads_by: 'seed',
  checks: [],
  records: 2900,
  status: 'ok',
  last_sync: '2026-09-28T14:30:45Z',
  runs: [],
}

const WEBHOOK: WebhookSource = {
  id: 'app_events',
  name: 'App events',
  kind: 'webhook',
  unit: 'events',
  unit_one: 'event',
  loads_by: 'webhook',
  checks: [],
  records: 40,
  status: 'live',
  today: 3,
  last_received: '2026-09-28T14:30:45Z',
  runs: [],
}

function rendered(sources: (CsvSource | WebhookSource)[]): string {
  return renderToString(
    createElement(
      MemoryRouter,
      null,
      createElement(SourcesTable, { sources, onReviewed: () => {}, refreshError: null }),
    ),
  ).replaceAll('<!-- -->', '')
}

describe('Overview Sources table: Last sync column (R4)', () => {
  it('a CSV source shows the date only', () => {
    const html = rendered([CSV])
    expect(html).toContain(humanDate(CSV.last_sync!))
    expect(html).not.toContain(humanDateTime(CSV.last_sync!))
  })

  it('the webhook source shows the date AND time, so a just-arrived event reads as just arrived', () => {
    const html = rendered([WEBHOOK])
    expect(html).toContain(humanDateTime(WEBHOOK.last_received!))
    // humanDateTime always carries humanDate's own text as a prefix; the real failure mode this
    // guards is reverting to humanDate alone, which this positive assertion above already catches.
    expect(humanDateTime(WEBHOOK.last_received!)).not.toBe(humanDate(WEBHOOK.last_received!))
  })

  it('a source with no sync yet still reads "None yet", for either kind', () => {
    expect(rendered([{ ...CSV, last_sync: null }])).toContain('None yet')
    expect(rendered([{ ...WEBHOOK, last_received: null }])).toContain('None yet')
  })
})
