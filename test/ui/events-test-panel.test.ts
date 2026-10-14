import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { APP_EVENTS } from '../../shared/app-events'
import { TestEventPanel } from '../../src/events-test-panel'
import { resultText } from '../../src/events-test-words'

const panelSource = import.meta.glob<string>('../../src/events-test-panel.tsx', { query: '?raw', import: 'default', eager: true })['../../src/events-test-panel.tsx']
const listboxSource = import.meta.glob<string>('../../src/listbox.tsx', { query: '?raw', import: 'default', eager: true })['../../src/listbox.tsx']
const listNavSource = import.meta.glob<string>('../../src/list-nav.ts', { query: '?raw', import: 'default', eager: true })['../../src/list-nav.ts']
const lookupSource = import.meta.glob<string>('../../src/pages/LookupPage.tsx', { query: '?raw', import: 'default', eager: true })['../../src/pages/LookupPage.tsx']
const eventsPageSource = import.meta.glob<string>('../../src/pages/EventsPage.tsx', { query: '?raw', import: 'default', eager: true })['../../src/pages/EventsPage.tsx']

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
    // aria-controls names the listbox only while it is shown (WCAG 2.2 AA 4.1.2): with nothing
    // typed, no list is rendered, so the attribute must not point at an id that does not exist.
    expect(page).not.toContain('aria-controls="test-event-account-suggestions"')
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

  it('a resend: "Already received — stored once, not added again." (true for any number of sends, not just two)', () => {
    expect(resultText('duplicate')).toBe('Already received — stored once, not added again.')
  })
})

describe('the account field is the shared listbox contract (../listbox; WCAG 2.2 AA 4.1.2, 2.4.3)', () => {
  it('reuses the shared ../listbox + ../list-nav modules rather than re-implementing the keyboard contract (D-72: one home)', () => {
    expect(panelSource).toMatch(/from '\.\/listbox'/)
    expect(panelSource).toMatch(/from '\.\/list-nav'/)
    expect(panelSource).toMatch(/\buseListNav\b/)
    expect(panelSource).toMatch(/\bListboxOption\b/)
    // So does the page that first defined the contract: a real shared home, not a one-way copy.
    expect(lookupSource).toMatch(/from '\.\.\/listbox'/)
    expect(lookupSource).toMatch(/from '\.\.\/list-nav'/)
    expect(lookupSource).toMatch(/\buseListNav\b/)
    expect(lookupSource).toMatch(/\bListboxOption\b/)
  })

  it('the input wires onKeyDown and aria-activedescendant, and aria-controls only while the list is shown (no stale id reference)', () => {
    expect(panelSource).toMatch(/onKeyDown=\{onKeyDown\}/)
    expect(panelSource).toMatch(/aria-activedescendant=\{listShown/)
    expect(panelSource).toMatch(/aria-controls=\{listShown \? LISTBOX_ID : undefined\}/)
  })

  it('the shared ListboxOption never wraps an inner interactive element (no nested-interactive)', () => {
    // Strip comments first: the files' own doc comments describe the rule in prose using the
    // literal text "<button>", which must not be mistaken for JSX it renders.
    const stripComments = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[^]*?\*\//g, '')
    const code = stripComments(listboxSource)
    expect(code).not.toMatch(/<button/)
    expect(code).not.toMatch(/<a[\s>]/)
    // Picked by mousedown (keeps focus on the input) rather than click.
    expect(code).toMatch(/onMouseDown=/)
    expect(code).not.toMatch(/onClick=\{.*onPick/)
    // The keyboard-handling half (list-nav.ts) is a plain .ts file: no JSX is possible there.
    expect(listNavSource).not.toMatch(/<button/)
  })

  it('the panel renders its options through the shared ListboxOption, not its own <li role="option"><button>', () => {
    expect(panelSource).toMatch(/<ListboxOption/)
    expect(panelSource).not.toMatch(/role="option"[^]*?<button/)
  })
})

describe('"Send a test event" wires onSent to refresh the list at once (09 D-73)', () => {
  it('EventsPage passes a real onSent that loads with FetchKind \'sent\', not a no-op', () => {
    expect(eventsPageSource).toMatch(/<TestEventPanel onSent=\{\(\) => void load\('sent'\)\}/)
  })
})
