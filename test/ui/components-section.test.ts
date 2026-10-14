import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Section } from '../../src/components'
import overviewSource from '../../src/pages/OverviewPage.tsx?raw'

// src/components.tsx Section: a caller's `summary` (OverviewPage's FactLine) is a <ul>, which a
// <p> cannot legally contain (invalid nesting, a hydration warning). Section wraps `summary` in a
// <div>, not a <p>, so the rendered markup never has a <ul>/<ol> inside a <p>.

/** Matches an open <p ...> that reaches a <ul or <ol before its own </p> — the invalid nesting. */
const LIST_INSIDE_P = /<p[^>]*>(?:(?!<\/p>).)*?<(ul|ol)[\s>]/s

function rendered(summary = createElement('ul', { 'aria-label': 'facts' }, createElement('li', null, 'fact one'))): string {
  return renderToString(
    createElement(Section, { title: 'Sources', summary } as unknown as Parameters<typeof Section>[0], createElement('p', null, 'body')),
  )
}

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

  it('OverviewPage still wires its FactLine summary through Section (the real usage this guards)', () => {
    const sectionAt = overviewSource.indexOf('<Section')
    expect(sectionAt).toBeGreaterThan(-1)
    const block = overviewSource.slice(sectionAt, overviewSource.indexOf('</Section>', sectionAt))
    const summaryAt = block.indexOf('summary={')
    const factLineAt = block.indexOf('<FactLine')
    expect(summaryAt).toBeGreaterThan(-1)
    expect(factLineAt).toBeGreaterThan(summaryAt)
  })
})
