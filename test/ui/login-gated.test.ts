import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../shared/features'
import { AccountButton } from '../../src/App'
import LoginPage from '../../src/pages/LoginPage'
import { describedByResolvesTo, hasDisabledAttribute } from '../helpers/gated-assertions'

// "Your own sign-in" (work_sign_in, 09 D-80, 22-pages/login.md): one flag, two placements — the
// /login button and the top bar's "Your account". Same canonical note; the top bar appends one
// extra fact, written once in src/App.tsx (TOPBAR_SSO_EXTRA), never copied back into
// shared/features.ts.

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

  it('shows the canonical note plus the one extra fact, written once in src/App.tsx, and the describedby resolves to the whole sentence', () => {
    const html = renderToString(createElement(AccountButton))
    expect(html).toContain(FEATURES.work_sign_in.note)
    expect(html).toContain('Today everyone shares the team password.')
    expect(describedByResolvesTo(html, `${FEATURES.work_sign_in.note} Today everyone shares the team password.`)).toBe(true)
  })

  it('names no person (there is none), shows no sample session or access-log row, and its label comes from shared/features.ts', () => {
    const html = renderToString(createElement(AccountButton))
    expect(html).toContain(FEATURES.work_sign_in.controls![1])
    expect(html).not.toMatch(/@/)
  })
})
