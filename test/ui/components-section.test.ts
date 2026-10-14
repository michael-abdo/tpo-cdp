import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Section } from '../../src/components'
import { SourcesTable } from '../../src/pages/OverviewPage'
import type { CsvSource } from '../../src/types'

// src/components.tsx Section: a caller's `summary` (OverviewPage's FactLine) is a <ul>, which a
// <p> cannot legally contain (invalid nesting, a hydration warning). Section wraps `summary` in a
// <div>, not a <p>, so the rendered markup never has a <ul>/<ol> inside a <p>.

/**
 * Matches an open <p ...> that reaches a <ul or <ol before its own </p> — the invalid nesting.
 * The lookahead after `<p` requires the tag name to end there (a space or `>`), so it does not
 * false-match `<path`, the SVG element every lucide icon renders.
 */
const LIST_INSIDE_P = /<p(?=[\s>])[^>]*>(?:(?!<\/p>).)*?<(ul|ol)[\s>]/s

function rendered(summary = createElement('ul', { 'aria-label': 'facts' }, createElement('li', null, 'fact one'))): string {
  return renderToString(
    createElement(Section, { title: 'Sources', summary } as unknown as Parameters<typeof Section>[0], createElement('p', null, 'body')),
  )
}

const SOURCE: CsvSource = {
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

/**
 * The real SourcesTable (OverviewPage), the actual caller whose FactLine summary this guards —
 * not a source-text proxy for it. test/ui/overview-last-sync.test.ts:47 renders it the same way.
 */
const SOURCES_TABLE_HTML = renderToString(
  createElement(MemoryRouter, null, createElement(SourcesTable, { sources: [SOURCE], onReviewed: () => {}, refreshError: null })),
).replaceAll('<!-- -->', '')

describe('Section: a <ul>/<ol> summary never nests inside a <p> (hydration warning)', () => {
  it('a <ul> summary renders with no <ul> inside a <p>', () => {
    const html = rendered()
    expect(html).toContain('<ul')
    expect(html).not.toMatch(LIST_INSIDE_P)
  })

  it('the summary wrapper is a <div>, not a <p>', () => {
    const html = rendered()
    const ulAt = html.indexOf('<ul')
    const divAt = html.lastIndexOf('<div', ulAt)
    expect(divAt).toBeGreaterThan(-1)
    // No <p ...> opens between that <div> and the <ul> it holds.
    expect(html.slice(divAt, ulAt)).not.toMatch(/<p[\s>]/)
  })

  it('a plain ReactNode summary (no list) still renders, unaffected', () => {
    const html = renderToString(
      createElement(Section, { title: 'Sources', summary: 'one line' } as unknown as Parameters<typeof Section>[0], createElement('p', null, 'body')),
    )
    expect(html).toContain('one line')
    expect(html).not.toMatch(LIST_INSIDE_P)
  })

  it("the real SourcesTable (OverviewPage's FactLine-through-Section wiring) has no <ul> inside a <p>", () => {
    // Source-text checks on OverviewPage (e.g. "`summary={` comes before `<FactLine`") can't see
    // what OverviewPage puts AROUND that FactLine — e.g. wrapping it in its own <p>, which would
    // reintroduce a <ul> inside a <p> in the real page even though Section itself still uses a
    // <div>. Rendering the real component is the only check that sees the actual nesting hydrated
    // in the browser.
    expect(SOURCES_TABLE_HTML).toContain('<ul')
    expect(SOURCES_TABLE_HTML).not.toMatch(LIST_INSIDE_P)
  })
})
