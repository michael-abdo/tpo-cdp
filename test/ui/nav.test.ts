import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createPath, Router, type To } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { NAV } from '../../src/nav'

// "Techy" (06 §Nav, 09 D-71): App events and AI audit log fold into one dropdown, last in the nav,
// after the WAI-ARIA disclosure-navigation pattern. Two kinds of check:
// (A) the NAV data itself (src/nav.ts NAV, the single source both the desktop and the phone nav
// read) — this is what "a link is missing from the group" or "a link reappeared at top level"
// actually mean, since the rendered nav is a pure map over this array.
// (B) the Techy button's own rendered markup, via a static Router render (as test/ui/routes.test.ts
// does; workerd has no DOM). The button's panel is portalled to document.body (so InfoTip-style
// popovers are never clipped by the header, 09 D-60) and is skipped by the component itself when
// there is no document.body, exactly as this harness has none — this proves the button's own
// attributes and current-section marking without needing a browser; the panel's own markup (the
// two real links, Esc, outside click, closing on a pick) is checked live (06 §Nav build notes).

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

describe('"Techy" nav group: the data (09 D-71 requirement 4, single source)', () => {
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

describe('"Techy" nav group: the rendered button (09 D-71 requirement 1, 2)', () => {
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
