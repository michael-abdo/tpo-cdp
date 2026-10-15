import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createPath, Router, type To } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'

// The old paths /assistant and /growth redirect to /insights and keep the query string, so an old
// "Explain this" link (?q=) still fills the Ask bar (src/App.tsx ToInsights).
// A server render never runs <Navigate>'s effect, but it resolves the target while rendering and
// asks the router's navigator for its href, so a recording navigator reads where each path lands.
// A path with no route falls to the catch-all, which sends to "/" and renders no page chrome.

/** Every href the router was asked to build while the real App routes rendered `url`. */
function hrefsRendered(url: string): { hrefs: string[]; html: string } {
  const hrefs: string[] = []
  const navigator = {
    createHref: (to: To) => {
      const href = typeof to === 'string' ? to : createPath(to)
      hrefs.push(href)
      return href
    },
    go: () => {},
    push: () => {},
    replace: () => {},
  }
  const [pathname, search = ''] = url.split('?')
  const location = { pathname, search: search === '' ? '' : `?${search}`, hash: '', state: null, key: 'default' }
  const html = renderToString(createElement(Router, { location, navigator, static: true }, createElement(App)))
  return { hrefs, html }
}

describe('/assistant and /growth redirect to /insights, keeping the query string', () => {
  // workerd has no DOM; the shell's theme switch reads the document and the colour-scheme query while rendering.
  beforeEach(() => {
    vi.stubGlobal('document', { documentElement: { dataset: {} } })
    vi.stubGlobal('window', {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(['/assistant', '/growth'])('%s?q=… lands on /insights?q=… inside the page chrome', (path) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}) // <Navigate> in a static router warns that it is a no-op
    const { hrefs, html } = hrefsRendered(`${path}?q=how%20many%20went%20cold`)
    expect(hrefs, path).toContain('/insights?q=how%20many%20went%20cold')
    expect(html, 'the redirect sits under the shell (its nav), not the catch-all').toContain('Skip to content')
  })

  it.each(['/assistant', '/growth'])('%s with no query lands on plain /insights, not on the catch-all', (path) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { hrefs, html } = hrefsRendered(path)
    expect(html).toContain('Skip to content')
    expect(hrefs.filter((h) => h === '/insights').length).toBeGreaterThan(1) // the nav link, and the redirect
  })

  it('a path with no route goes to the catch-all, outside the shell', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { html } = hrefsRendered('/no-such-page?q=x')
    expect(html).not.toContain('Skip to content')
  })
})
