import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../shared/features'
import { AccountButton } from '../../src/App'
import LoginPage from '../../src/pages/LoginPage'
import {
  describedByResolvesTo,
  gatedControlTags,
  hasDisabledAttribute,
  showsComingSoonChip,
  wearsGatedLook,
} from '../helpers/gated-assertions'

// "Your own sign-in" (work_sign_in): one flag, two placements — the
// /login button and the top bar's "Your account". Both render the exact same canonical note
// (shared/features.ts), with no extra fact appended on either page (one home for the
// shared-team-password fact).

function rendered(): string {
  return renderToString(createElement(MemoryRouter, null, createElement(LoginPage))).replaceAll('<!-- -->', '')
}

describe('/login: Sign in with your work account', () => {
  it('renders after Sign in, type="button" (it can never submit the form), aria-disabled, never disabled', () => {
    const html = rendered()
    const signIn = html.indexOf('>Sign in<')
    const sso = html.indexOf(FEATURES.work_sign_in.controls![0])
    expect(signIn).toBeGreaterThan(-1)
    expect(sso).toBeGreaterThan(signIn)
    const ssoButtonStart = html.lastIndexOf('<button', sso)
    const ssoButtonEnd = html.indexOf('>', ssoButtonStart) + 1
    const ssoButtonTag = html.slice(ssoButtonStart, ssoButtonEnd)
    expect(ssoButtonTag).toContain('type="button"')
    expect(ssoButtonTag).toContain('aria-disabled="true"')
    expect(hasDisabledAttribute(ssoButtonTag)).toBe(false)
    expect(hasDisabledAttribute(html.slice(ssoButtonStart, html.indexOf('</button>', ssoButtonEnd)))).toBe(false)
  })

  it("the note equals shared/features.ts's own work_sign_in.note, with no extra fact on this page, and the describedby resolves", () => {
    const html = rendered()
    expect(html).toContain(FEATURES.work_sign_in.note)
    expect(html).not.toContain('Today everyone shares the team password')
    expect(describedByResolvesTo(html, FEATURES.work_sign_in.note)).toBe(true)
  })

  it("the divider is aria-hidden (the button's own label already says enough)", () => {
    const html = rendered()
    expect(html).toMatch(/<div aria-hidden="true"[^>]*>[\s\S]{0,120}?\bor\b[\s\S]{0,120}?<\/div>/)
  })
})

describe('Top bar: Your account (work_sign_in)', () => {
  it('renders aria-disabled="true", never disabled, with no aria-expanded/aria-controls while gated', () => {
    const html = renderToString(createElement(AccountButton)).replaceAll('<!-- -->', '')
    expect(html).toContain('aria-disabled="true"')
    expect(hasDisabledAttribute(html)).toBe(false)
    expect(html).not.toContain('aria-expanded')
    expect(html).not.toContain('aria-controls')
  })

  it('shows the canonical note alone, with no extra fact appended, and the describedby resolves to just that sentence', () => {
    const html = renderToString(createElement(AccountButton))
    expect(html).toContain(FEATURES.work_sign_in.note)
    expect(describedByResolvesTo(html, FEATURES.work_sign_in.note)).toBe(true)
  })

  it('never states the shared-team-password fact twice in the rendered note', () => {
    const html = renderToString(createElement(AccountButton))
    const occurrences = html.split('team password').length - 1
    expect(occurrences).toBe(1)
  })

  it('names no person (there is none), shows no sample session or access-log row, and its label comes from shared/features.ts', () => {
    const html = renderToString(createElement(AccountButton))
    expect(html).toContain(FEATURES.work_sign_in.controls![1])
    expect(html).not.toMatch(/@/)
  })
})

describe('Your own sign-in: no "Coming soon" chip; every gated control wears the shared greyed look', () => {
  const cases: [string, () => string][] = [
    ['/login: Sign in with your work account', rendered],
    ['Top bar: Your account', () => renderToString(createElement(AccountButton))],
  ]
  for (const [name, render] of cases)
    it(name, () => {
      const html = render()
      expect(showsComingSoonChip(html)).toBe(false)
      for (const tag of gatedControlTags(html)) expect(wearsGatedLook(tag), tag).toBe(true)
    })
})
