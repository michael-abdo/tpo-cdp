import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { APP_EVENTS } from '../../shared/app-events'
import { TestEventPanel } from '../../src/events-test-panel'
import { resultText } from '../../src/events-test-words'
import { ListboxOption } from '../../src/listbox'

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
    expect(page).toContain('Type the start of a user ID or an email, e.g. u_2b64')
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

  it('the placeholder names only what /api/lookup/search actually matches: the start of a user ID, or an email', () => {
    const page = html()
    expect(page).toContain('Type the start of a user ID or an email, e.g. u_2b64')
    // No separate helper line repeats or contradicts it (D-72: one thing in one place).
    expect(page).not.toContain('Type part of a user ID')
    expect(page.match(/e\.g\. u_/g)).toHaveLength(1)
  })

  it('never sets the native `disabled` attribute on Send or Send again for `sending` (keeps focus; 06 "Refresh stays focusable while it works")', () => {
    // Native disabled only for userId === null on Send; `sending` must drive aria-disabled instead,
    // exactly like InsightsPage's Refresh button, so a focused button never drops to <body> mid-press.
    // The negative lookbehind keeps this from matching inside "aria-disabled={sending}" itself.
    expect(panelSource).not.toMatch(/(?<!aria-)disabled=\{[^}]*\bsending\b[^}]*\}/)
    expect(panelSource).toMatch(/aria-disabled=\{sending\}/g)
    expect(panelSource).toMatch(/aria-disabled:cursor-wait aria-disabled:opacity-60/)
    // Each send() call ignores a press already in flight instead of relying on native disabled.
    expect(panelSource).toMatch(/async function send\([^)]*\)[^{]*\{\s*if \(sending\) return/)
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
  it('both callers pass the real highlighted index to ListboxOption, so the bar and fill follow the arrow keys (WCAG 2.4.7)', () => {
    // The render test above proves ListboxOption styles active=true; this pins that each caller
    // computes active from its own keyboard index rather than a constant.
    expect(panelSource).toMatch(/<ListboxOption[\s\S]{0,400}?active=\{i === nav\.active\}/)
    expect(lookupSource).toMatch(/const isActive = i === active\b/)
    expect(lookupSource).toMatch(/<ListboxOption[\s\S]{0,400}?active=\{isActive\}/)
  })

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

  it('the active option gets the shared LookupPage treatment — a left bar plus a fill, not a surface tint alone (06 §UI principles 7)', () => {
    // Behaviour, not source text: render the real ListboxOption both ways and read its actual
    // class list. This kills a mutant that swaps the ternary branches (active <-> inactive) or
    // that drops the active classes and always renders className unchanged — both would still
    // leave the literal strings 'border-l-4', 'border-blue-600' and 'bg-blue-50' somewhere in
    // the source, which a text-presence check alone cannot tell apart from the real behaviour.
    const activeHtml = renderToString(createElement(ListboxOption, { active: true, onPick: () => {} }, 'x'))
    const inactiveHtml = renderToString(createElement(ListboxOption, { active: false, onPick: () => {} }, 'x'))
    const classOf = (html: string): string => /class="([^"]*)"/.exec(html)?.[1] ?? ''
    const activeClasses = classOf(activeHtml).split(/\s+/)
    const inactiveClasses = classOf(inactiveHtml).split(/\s+/)
    expect(activeClasses).toEqual(expect.arrayContaining(['border-l-4', 'border-blue-600', 'bg-blue-50']))
    expect(inactiveClasses).not.toContain('border-blue-600')
    expect(inactiveClasses).not.toContain('bg-blue-50')

    // Pin the exact expression, too, so the two render calls above and a future refactor stay
    // honest about which file owns this: ACTIVE_CLASSES is the ternary's true branch.
    expect(listboxSource).toMatch(/const ACTIVE_CLASSES = 'border-l-4 border-blue-600 bg-blue-50'/)
    expect(listboxSource).toMatch(/active \? ACTIVE_CLASSES : INACTIVE_CLASSES/)
    // Neither caller re-implements it: no page-local "active ?" ternary picking its own fill.
    expect(panelSource).not.toMatch(/active\s*\?\s*'[^']*'\s*:\s*''/)
    expect(panelSource).not.toMatch(/nav\.active\s*\?/)
    expect(lookupSource).not.toMatch(/border-blue-600/)
    expect(lookupSource).not.toMatch(/bg-blue-50/)
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

  it('the panel itself calls onSent(data.event) after a successful send, inside send() — a mutant that drops this call (e.g. `void data`) must fail here even though EventsPage\'s own wiring above still reads fine', () => {
    const send = /async function send\([^]*?\n  \}\n/.exec(panelSource)?.[0]
    expect(send, 'send() was not found in the panel source').toBeDefined()
    expect(send).toMatch(/postJson<TestEventResult>\('\/api\/events\/test'/)
    expect(send).toMatch(/onSent\(data\.event\)/)
    // The call sits after the result is captured and before the catch, not inside a comment.
    const stripComments = (s: string) => s.replace(/\/\/.*$/gm, '')
    expect(stripComments(send as string)).toMatch(/const data = await postJson[^]*?onSent\(data\.event\)[^]*?catch/)
  })
})

describe('/events empty state matches 06 §Empty and error states verbatim (D-72, curly quotes)', () => {
  it('"No events yet — send one with “Send a test event” above." — not straight quotes, not a paraphrase', () => {
    expect(eventsPageSource).toContain('No events yet — send one with “Send a test event” above.')
  })
})

describe('Enter in the account field (06 keyboard contract): an exact single match picks it; otherwise the box says what to do', () => {
  it("Enter with nothing highlighted picks the lone match when there's exactly one", () => {
    expect(panelSource).toMatch(/if \(matches\.length === 1\) pick\(matches\[0\]\)/)
  })

  it('Enter with zero or more than one match says "Pick an account from the list" instead of doing nothing', () => {
    expect(panelSource).toContain("setError('Pick an account from the list')")
  })

  it('a different pick clears any stale "Pick an account" error (pick() resets error, not just userId)', () => {
    const pick = /const pick = \([^]*?\n  \}\n/.exec(panelSource)?.[0]
    expect(pick, 'pick() was not found in the panel source').toBeDefined()
    expect(pick).toMatch(/setError\(null\)/)
  })
})

describe('a truncated account search shows the same line /lookup shows (D-72, D-66: one wording)', () => {
  it('the panel reads LookupSearch.truncated and renders "+ more — keep typing", the exact text ../pages/LookupPage.tsx uses', () => {
    expect(panelSource).toMatch(/\btruncated\b/)
    expect(panelSource).toContain('+ more — keep typing')
    expect(lookupSource).toContain('+ more — keep typing')
  })
})

describe('Send is the only primary button while the panel is open (06 §UI principles 1: one main action per screen)', () => {
  it('the panel tells the page when it opens/closes, and EventsPage demotes Refresh to secondary while open', () => {
    expect(panelSource).toMatch(/onOpenChange\?\.\(open\)/)
    expect(eventsPageSource).toMatch(/<TestEventPanel onSent=\{\(\) => void load\('sent'\)\} onOpenChange=\{setTestPanelOpen\}/)
    expect(eventsPageSource).toMatch(/variant=\{testPanelOpen \? 'secondary' : 'primary'\}/)
  })
})
