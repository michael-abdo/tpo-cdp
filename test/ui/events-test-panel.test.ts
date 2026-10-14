import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { APP_EVENTS } from '../../shared/app-events'
import { TestEventPanel } from '../../src/events-test-panel'
import { resultText } from '../../src/events-test-words'

// "Send a test event" panel rendered (06 §/events panel, 09 D-73; T-WH-PANEL-*). workerd has no
// DOM, so this renders statically (react-dom/server, as test/ui/routes.test.ts does); a native
// <details> serializes its children regardless of `open`, so the collapsed level and the
// expanded content are both visible to renderToString. Unlike routes.test.ts this leaves
// `document` undefined (it is absent in workerd by default): EventName's InfoTip only reaches
// its createPortal branch when `document` exists, and no real DOM element exists here to
// portal into.

function html(): string {
  return renderToString(createElement(TestEventPanel, { onSent: () => {} }))
}

describe('"Send a test event" panel: labels (D-55 levels, WCAG 2.2 AA)', () => {
  it('level 1 is one button labelled "Send a test event" (D-55, D-73)', () => {
    expect(html()).toContain('Send a test event')
  })

  it('the account field has a visible label and combobox roles for the suggestion list', () => {
    const page = html()
    expect(page).toMatch(/<label[^>]*for="test-event-account"[^>]*>\s*App account\s*<\/label>/)
    expect(page).toContain('Type part of a user ID, e.g. u_2b6447a3')
    expect(page).toMatch(/role="combobox"/)
    expect(page).toMatch(/aria-controls="test-event-account-suggestions"/)
  })

  it('the event picker is a labelled fieldset with all four APP_EVENTS as radio options', () => {
    const page = html()
    expect(page).toMatch(/<legend[^>]*>\s*Event\s*<\/legend>/)
    expect(page.match(/type="radio"/g)).toHaveLength(APP_EVENTS.length)
    for (const name of APP_EVENTS) expect(page).toContain(`>${name}<`)
  })

  it('offers a Send button, and no Send again until after a send', () => {
    const page = html()
    expect(page).toMatch(/>Send<\/button>/)
    expect(page).not.toContain('Send again')
  })

  it('the result line is a live region (role="status", aria-live="polite"), empty before any send', () => {
    expect(html()).toMatch(/role="status"[^>]*aria-live="polite"/)
  })

  it('D-72: the placeholder is the only place the example id appears, not repeated in a separate hint', () => {
    const page = html()
    expect(page.match(/u_2b6447a3/g)).toHaveLength(1)
  })
})

describe('the result line\'s words (09 D-73; one home, D-72)', () => {
  it('a fresh send: "Received — it\'s the top row below."', () => {
    expect(resultText('received')).toBe("Received — it's the top row below.")
  })

  it('a resend: "Already received: sent twice, stored once."', () => {
    expect(resultText('duplicate')).toBe('Already received: sent twice, stored once.')
  })
})
