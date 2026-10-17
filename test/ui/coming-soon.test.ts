import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FEATURES, type FeatureId } from '../../shared/features'
import { createComingSoonStore, type Focusable } from '../../src/coming-soon'
import { ComingSoonDialog, ComingSoonProvider } from '../../src/coming-soon-dialog'
import { literalOccursIn } from '../helpers/gated-assertions'

// The one "Coming soon" pop-up (src/coming-soon-dialog.tsx, state in src/coming-soon.ts). No DOM
// inside workerd: the store is driven directly, the dialog's markup is read with renderToString,
// and what only a browser does (showModal, Esc, the backdrop) is pinned in the source here and
// checked live in a real browser.

const SRC = import.meta.glob<string>(['../../src/**/*.tsx', '../../src/**/*.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

function source(path: string): string {
  const entry = Object.entries(SRC).find(([p]) => p.endsWith(path))
  if (entry === undefined) throw new Error(`coming-soon test: ${path} not found`)
  return entry[1]
}

/** A stand-in control focus can go back to, counting each time it is focused. */
function control(connected = true): Focusable & { focused: number } {
  const c = {
    isConnected: connected,
    focused: 0,
    focus() {
      c.focused++
    },
  }
  return c
}

describe('the pop-up store: open, close, and focus back to the opener', () => {
  it('open shows the feature and remembers the focused control; close clears it and focuses that control again', () => {
    const opener = control()
    const store = createComingSoonStore(() => opener)
    expect(store.get()).toBeNull()
    store.open('delete_person')
    expect(store.get()).toEqual({ feature: 'delete_person', opener })
    expect(opener.focused).toBe(0)
    store.close()
    expect(store.get()).toBeNull()
    expect(opener.focused).toBe(1)
  })

  it('closing twice (Got it, then the native close event) clears once and focuses once', () => {
    const opener = control()
    const store = createComingSoonStore(() => opener)
    let changes = 0
    store.subscribe(() => changes++)
    store.open('csv_upload')
    store.close()
    store.close()
    expect(changes).toBe(2)
    expect(opener.focused).toBe(1)
  })

  it('a second open while one is shown keeps the first (a checkbox fires click and change together)', () => {
    const first = control()
    let active: Focusable = first
    const store = createComingSoonStore(() => active)
    store.open('filter_going_cold_risk')
    active = control()
    store.open('csv_upload')
    expect(store.get()).toEqual({ feature: 'filter_going_cold_risk', opener: first })
  })

  it('a control that has left the page is not focused (nothing to go back to)', () => {
    const gone = control(false)
    const store = createComingSoonStore(() => gone)
    store.open('send_to_beehiiv')
    store.close()
    expect(gone.focused).toBe(0)
  })

  it('an unsubscribed listener hears nothing more', () => {
    const store = createComingSoonStore(() => null)
    let changes = 0
    const stop = store.subscribe(() => changes++)
    stop()
    store.open('daily_sync')
    expect(changes).toBe(0)
  })
})

/** The dialog's markup for one feature, React's text separators removed. */
function dialog(feature: FeatureId | null): string {
  return renderToString(createElement(ComingSoonDialog, { feature, onClose: () => {} })).replaceAll(
    '<!-- -->',
    '',
  )
}

/** The text inside the element carrying `id="<id>"`, tags stripped and quotes unescaped. */
function textOf(html: string, id: string): string {
  const m = new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</(h2|p)>`).exec(html)
  if (m === null) throw new Error(`coming-soon test: no element with id ${id}`)
  return m[1]
    .replace(/<[^>]*>/g, '')
    .replaceAll('&quot;', '"')
    .trim()
}

describe('the pop-up shows each feature exactly as shared/features.ts writes it', () => {
  it('title = the feature label, body = the feature note, for every feature; aria-labelledby/-describedby name them', () => {
    for (const id of Object.keys(FEATURES) as FeatureId[]) {
      const html = dialog(id)
      const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)![1]
      const describedBy = /aria-describedby="([^"]+)"/.exec(html)![1]
      expect(textOf(html, labelledBy), id).toBe(FEATURES[id].label)
      expect(textOf(html, describedBy), id).toBe(FEATURES[id].note)
    }
  })

  it('shows the "Coming soon" chip once and a "Got it" submit button inside a method="dialog" form (closes natively)', () => {
    const html = dialog('csv_upload')
    expect(html.split('Coming soon').length - 1).toBe(1)
    expect(html).toMatch(
      /<form [^>]*method="dialog"[^>]*><button type="submit"[^>]*>Got it<\/button><\/form>/,
    )
  })

  it('closed (no feature), it holds no label, note or chip', () => {
    const html = dialog(null)
    expect(html).toContain('<dialog')
    expect(html).not.toContain('Coming soon')
    for (const f of Object.values(FEATURES)) expect(html).not.toContain(f.label)
  })

  it('no feature note is hand-typed anywhere in src (the pop-up and every page read shared/features.ts)', () => {
    const offenders: string[] = []
    for (const [path, text] of Object.entries(SRC))
      for (const f of Object.values(FEATURES))
        if (literalOccursIn(text, f.note)) offenders.push(`${f.id} in ${path}`)
    expect(offenders).toEqual([])
  })
})

describe('one pop-up per page, never two', () => {
  it('the provider renders its children and exactly one <dialog>', () => {
    const html = renderToString(createElement(ComingSoonProvider, null, createElement('p', null, 'page')))
    expect(html).toContain('<p>page</p>')
    expect(html.split('<dialog').length - 1).toBe(1)
  })

  it('src mounts <ComingSoonProvider> once (src/App.tsx) and <ComingSoonDialog> once (inside the provider)', () => {
    const count = (needle: RegExp) =>
      Object.entries(SRC).flatMap(([p, text]) =>
        (text.match(needle) ?? []).map(() => p.replace(/^(\.\.\/)+/, '')),
      )
    expect(count(/<ComingSoonProvider\b/g)).toEqual(['src/App.tsx'])
    expect(count(/<ComingSoonDialog\b/g)).toEqual(['src/coming-soon-dialog.tsx'])
    expect(count(/<dialog\s/g).filter((p) => p === 'src/coming-soon-dialog.tsx')).toHaveLength(1)
  })

  it('the one provider wraps every route, /login (outside the shell) included', () => {
    const app = source('src/App.tsx')
    const open = app.indexOf('<ComingSoonProvider>')
    const close = app.indexOf('</ComingSoonProvider>')
    expect(open).toBeGreaterThan(-1)
    expect(app.indexOf('<Routes>')).toBeGreaterThan(open)
    expect(app.indexOf('path="/login"')).toBeGreaterThan(open)
    expect(app.indexOf('</Routes>')).toBeLessThan(close)
  })
})

describe('what only a browser does, pinned in the source (checked live too)', () => {
  const dialogSource = source('src/coming-soon-dialog.tsx')

  it('opens with showModal and then focuses "Got it"', () => {
    const at = dialogSource.indexOf('dialog.showModal()')
    expect(at).toBeGreaterThan(-1)
    expect(dialogSource.indexOf('gotIt.current?.focus()', at)).toBeGreaterThan(at)
  })

  it('every close (Got it, Esc, the backdrop) runs onClose through the native close event, and Esc is never cancelled', () => {
    expect(dialogSource).toMatch(/onClose=\{onClose\}/)
    expect(dialogSource).not.toMatch(/onCancel=/)
    expect(dialogSource).toMatch(/onClose=\{store\.close\}/)
  })

  it('a click closes it only when it landed on the backdrop (the dialog element itself), not on its content', () => {
    expect(dialogSource).toMatch(/if \(e\.target === e\.currentTarget\) e\.currentTarget\.close\(\)/)
  })

  it('neither pop-up file sends a request, navigates or touches window.location', () => {
    for (const path of ['src/coming-soon.ts', 'src/coming-soon-dialog.tsx'])
      for (const pattern of [
        /\bfetch\(/,
        /\bpostJson\(/,
        /\bpatchJson\(/,
        /\brequest\(/,
        /\bnavigate\(/,
        /window\.location/,
      ])
        expect(source(path), `${path} ${pattern}`).not.toMatch(pattern)
  })
})
