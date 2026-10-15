import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createPath, Router, type To } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { closesOnPointer, escapeAction, NAV, nextOpen } from '../../src/nav'

// "Techy": App events and AI audit log fold into one dropdown, last in the nav,
// after the WAI-ARIA disclosure-navigation pattern. Three kinds of check, with different reach:
// (A) the NAV data itself (src/nav.ts NAV, the single source both the desktop and the phone nav
// read) — this is what "a link is missing from the group" or "a link reappeared at top level"
// actually mean, since the rendered nav is a pure map over this array.
// (B) the Techy button and panel's own rendered markup, via a static Router render (as
// test/ui/routes.test.ts does; workerd has no DOM). The panel is no longer portalled (App.tsx
// NavGroupMenu), so it renders in this same server markup right after the button — this proves DOM
// order, the hidden attribute, aria-controls naming the panel's real id, and the two real links,
// with no browser needed.
// (C) the disclosure's decision logic (src/nav.ts escapeAction, closesOnPointer, nextOpen),
// unit-tested directly with no DOM. This pins only the pure functions' own input→output mapping —
// it does NOT pin that App.tsx's NavGroupMenu actually wires them up (the onKeyDown that calls
// escapeAction and e.stopPropagation(), the button.current?.focus() on refocus, the document
// pointerdown listener that calls closesOnPointer, the NavLink onClick that closes on pick, or the
// button onClick that calls nextOpen). workerd has no DOM, so none of (A)/(B)/(C) can render a real
// keydown, pointerdown or click and observe React's handler run; that wiring is covered by the live browser
// check recorded in docs/notes.md "Known gaps" → "Techy nav: the DOM wiring has no automated test".

function renderAt(url: string): string {
  const navigator = {
    createHref: (to: To) => (typeof to === 'string' ? to : createPath(to)),
    go: () => {},
    push: () => {},
    replace: () => {},
  }
  const [pathname, search = ''] = url.split('?')
  const location = {
    pathname,
    search: search === '' ? '' : `?${search}`,
    hash: '',
    state: null,
    key: 'default',
  }
  return renderToString(createElement(Router, { location, navigator, static: true }, createElement(App)))
}

/** The Techy <button>…</button> markup, the one immediately wrapping the "Techy" text. */
function techyButton(html: string): string {
  const textAt = html.indexOf('>Techy')
  if (textAt === -1) throw new Error('no "Techy" text in the rendered nav')
  const start = html.lastIndexOf('<button', textAt)
  if (start === -1) throw new Error('no <button> before "Techy"')
  const end = html.indexOf('</button>', textAt)
  if (end === -1) throw new Error('no closing </button> after "Techy"')
  return html.slice(start, end + '</button>'.length)
}

/**
 * The markup strictly between the Techy button's closing tag and the next real NavLink after the
 * whole group (the panel's own links sit right after the button in the DOM,
 * not at the end of <body> through a portal). Fails the same way `techyButton` does when either
 * boundary is missing, so a regression back to a portal (nothing between the button and whatever
 * unrelated markup follows it) shows up as a missing "AI audit log" link, not a thrown error.
 */
function afterTechyButton(html: string): string {
  const button = techyButton(html)
  const from = html.indexOf(button) + button.length
  // Wide enough to hold the panel's two links with their lucide-react <svg> icons (each icon's own
  // markup runs several hundred characters); still tiny next to the live portal bug's 26-Tabs'-worth
  // of unrelated markup (routes.test.ts's full-page render runs to tens of thousands of characters).
  return html.slice(from, from + 2000)
}

describe('"Techy" nav group: the data (single source)', () => {
  it('Overview, Look up, Segments and Insights stay top-level; Techy is last', () => {
    expect(NAV.map((entry) => entry.label)).toEqual(['Overview', 'Look up', 'Segments', 'Insights', 'Techy'])
  })

  it('Techy is a group holding exactly App events (/events) then AI audit log (/audit)', () => {
    const techy = NAV.at(-1)
    if (techy === undefined || techy.kind !== 'group')
      throw new Error('the last NAV entry must be the Techy group')
    expect(techy.items.map((item) => [item.label, item.to])).toEqual([
      ['App events', '/events'],
      ['AI audit log', '/audit'],
    ])
  })

  it('App events and AI audit log never sit at top level (only inside the Techy group)', () => {
    const topLevelLabels = NAV.filter((entry) => entry.kind === 'link').map((entry) => entry.label)
    expect(topLevelLabels).not.toContain('App events')
    expect(topLevelLabels).not.toContain('AI audit log')
  })
})

describe('"Techy" nav group: the rendered button', () => {
  beforeEach(() => {
    // workerd has no DOM; the shell's theme switch reads document/window while rendering, as
    // test/ui/routes.test.ts already does for the same reason.
    vi.stubGlobal('document', { documentElement: { dataset: {} } })
    vi.stubGlobal('window', {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('starts closed, with aria-expanded and aria-controls naming a real id', () => {
    const button = techyButton(renderAt('/'))
    expect(button).toContain('aria-expanded="false"')
    expect(button).toMatch(/aria-controls="[^"]+"/)
  })

  it('is never marked aria-current itself (only a real page gets aria-current="page")', () => {
    for (const path of ['/', '/lookup', '/segments', '/insights', '/events', '/audit', '/audit/abc123']) {
      expect(techyButton(renderAt(path))).not.toContain('aria-current')
    }
  })

  it.each(['/events', '/audit', '/audit/abc123'])(
    'reads as current on %s: soft-fill styling plus a visually-hidden "(current section)"',
    (path) => {
      const button = techyButton(renderAt(path))
      expect(button).toContain('bg-accent-soft')
      expect(button).toContain('font-semibold')
      expect(button).toContain('text-accent-strong')
      expect(button).toContain('<span class="sr-only"> (current section)</span>')
    },
  )

  it.each(['/', '/lookup', '/segments', '/insights'])(
    'does not read as current on %s: no soft fill, no "(current section)"',
    (path) => {
      const button = techyButton(renderAt(path))
      expect(button).not.toContain('bg-accent-soft')
      expect(button).not.toContain('(current section)')
    },
  )
})

describe('"Techy" nav group: the panel sits right after the button, not portalled (keyboard reachability)', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { documentElement: { dataset: {} } })
    vi.stubGlobal('window', {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('a real <ul> whose id equals the button\'s aria-controls starts within a few characters of the button', () => {
    const html = renderAt('/')
    const button = techyButton(html)
    const controls = /aria-controls="([^"]+)"/.exec(button)?.[1]
    if (controls === undefined) throw new Error('the button has no aria-controls')
    const after = afterTechyButton(html)
    const panelAt = after.indexOf(`id="${controls}"`)
    // Portalled markup sits at the end of <body>, thousands of characters and many elements away
    // (26 Tabs' worth, live); inline markup sits in the handful of characters of its own opening tag.
    expect(panelAt).toBeGreaterThanOrEqual(0)
    expect(panelAt).toBeLessThan(40)
  })

  it('is hidden when closed (the default) and holds exactly App events then AI audit log, as real links', () => {
    const after = afterTechyButton(renderAt('/'))
    const ulAt = after.indexOf('<ul')
    const ulTagEnd = after.indexOf('>', ulAt)
    expect(after.slice(ulAt, ulTagEnd)).toContain('hidden')
    const eventsAt = after.indexOf('href="/events"')
    const auditAt = after.indexOf('href="/audit"')
    expect(eventsAt).toBeGreaterThan(ulAt)
    expect(auditAt).toBeGreaterThan(eventsAt)
  })

  it('the desktop panel sizes to its content (w-max), never a fixed pixel width that leaves empty space', () => {
    const after = afterTechyButton(renderAt('/'))
    const ulAt = after.indexOf('<ul')
    const ulTagEnd = after.indexOf('>', ulAt)
    const ulTag = after.slice(ulAt, ulTagEnd)
    expect(ulTag).toMatch(/\bw-max\b/)
    expect(ulTag).not.toMatch(/\bw-\[\d+px\]/)
  })
})

describe('"Techy" nav group: decision logic (src/nav.ts) — no DOM needed', () => {
  it('nextOpen toggles: closed opens, open closes', () => {
    expect(nextOpen(false)).toBe(true)
    expect(nextOpen(true)).toBe(false)
  })

  it('escapeAction closes and refocuses only on Escape while open', () => {
    expect(escapeAction('Escape', true)).toEqual({ close: true, refocus: true })
    expect(escapeAction('Escape', false)).toEqual({ close: false, refocus: false })
    expect(escapeAction('Enter', true)).toEqual({ close: false, refocus: false })
    expect(escapeAction('a', true)).toEqual({ close: false, refocus: false })
  })

  it('closesOnPointer: true outside every root, false inside any one of them', () => {
    const inside = {} as Node
    const outside = {} as Node
    const empty = { contains: () => false } as unknown as Node
    const holding = { contains: (n: Node) => n === inside } as unknown as Node
    expect(closesOnPointer(outside, [empty, holding])).toBe(true)
    expect(closesOnPointer(inside, [empty, holding])).toBe(false)
    expect(closesOnPointer(outside, [null, null])).toBe(true)
  })
})
