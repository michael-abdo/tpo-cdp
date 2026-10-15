import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FEATURES, featuresOn, type Feature, type FeatureId } from '../../shared/features'
import { ComingSoonTag, GatedNote } from '../../src/components'
import { isActivatingKey, useGated } from '../../src/use-gated'

// Shared gated-feature wiring: the scaffolding every page's gated controls share
// (T-GATE-1..5). A page's own gate test (test/ui/*-gated.test.ts) checks
// its rendered markup; this file checks the shared hook and note component in isolation, once,
// so every page inherits the same proof instead of re-deriving it.

/** A minimal control using useGated/GatedNote exactly as a real page would. */
function Sample({ feature }: { feature: FeatureId }) {
  const gated = useGated(feature)
  return createElement(
    'div',
    null,
    createElement(
      'button',
      { type: 'button', ...gated.bind, onClick: gated.activate },
      gated.feature.label,
      createElement(ComingSoonTag),
    ),
    createElement(GatedNote, { id: gated.noteId, activated: gated.activated, text: gated.feature.note }),
  )
}

function rendered(feature: FeatureId): string {
  return renderToString(createElement(Sample, { feature }))
}

describe('shared/features.ts', () => {
  it('every entry is comingSoon, keyed by its own id, with a non-empty label and note', () => {
    for (const [key, f] of Object.entries(FEATURES)) {
      expect(f.id).toBe(key)
      expect(f.comingSoon).toBe(true)
      expect(f.label.length).toBeGreaterThan(0)
      expect(f.note.length).toBeGreaterThan(0)
    }
  })

  // One thing in one place: the "Coming soon" chip (ComingSoonTag) is the only place
  // that phrase appears; the note says only what the feature will do, and never retypes this
  // entry's own `label` or any of its `controls` at its very start.
  it('no note says "coming soon" (that is the chip\'s own, only, job)', () => {
    for (const [key, f] of Object.entries(FEATURES)) expect(f.note.toLowerCase(), key).not.toMatch(/coming soon/i)
  })

  it('no note starts with its own label or control text', () => {
    for (const [key, f] of Object.entries(FEATURES) as [string, Feature][])
      for (const words of [f.label, ...(f.controls ?? [])]) expect(f.note.startsWith(words), `${key}: "${f.note}"`).toBe(false)
  })

  // delete_person must say it needs per-person sign-in, not just name a blocker.
  it("delete_person's note says it needs per-person sign-in first", () => {
    expect(FEATURES.delete_person.note).toMatch(/sign(s|ed)? in|sign-in/i)
    expect(FEATURES.delete_person.note).toMatch(/each|their own|per.person/i)
  })

  it('featuresOn groups by page', () => {
    expect(featuresOn('overview').map((f) => f.id)).toEqual(['csv_upload', 'daily_sync', 'definition_settings'])
    expect(featuresOn('segments').length).toBe(6)
    expect(featuresOn('segments').filter((f) => f.group === 'more_filters').length).toBe(5)
  })
})

describe('useGated / GatedNote (T-GATE-1, T-GATE-2)', () => {
  it('renders aria-disabled="true", never the disabled attribute, with an aria-describedby that resolves', () => {
    for (const id of Object.keys(FEATURES) as FeatureId[]) {
      const html = rendered(id)
      expect(html).toContain('aria-disabled="true"')
      expect(html).not.toContain(' disabled')
      const idMatch = /aria-describedby="([^"]+)"/.exec(html)
      expect(idMatch).not.toBeNull()
      expect(html).toContain(`id="${idMatch![1]}"`)
    }
  })

  it("the described note's text equals shared/features.ts's note, before any activation", () => {
    for (const id of Object.keys(FEATURES) as FeatureId[]) {
      const html = rendered(id).replaceAll('<!-- -->', '')
      // renderToString escapes quotes inside text nodes; the note's own words (follow_up_questions)
      // may hold one, so compare against the same escaping rather than the raw string.
      const escaped = FEATURES[id].note.replaceAll('"', '&quot;')
      expect(html).toContain(escaped)
    }
  })

  it('the note starts sr-only (visually hidden) and the chip is always visible', () => {
    const html = rendered('csv_upload')
    expect(html).toContain('sr-only')
    expect(html).toContain('Coming soon')
  })
})

describe('useGated activation (T-GATE-3): shape, not DOM — the live check covers the real click', () => {
  function Shape({ feature }: { feature: FeatureId }) {
    const gated = useGated(feature)
    return createElement('span', { 'data-testid': 'shape' }, Object.keys(gated).join(','))
  }
  it("activate takes no argument it could pass on, so a control can wire only this page's own state to it — never a fetch, a navigation or a route it doesn't already call", () => {
    const html = renderToString(createElement(Shape, { feature: 'csv_upload' }))
    expect(html).toContain('feature,activated,noteId,bind,activate,onKeyDown')
  })
})

describe('GatedNote (T-GATE-2 continued)', () => {
  it('activation drops sr-only from the visible description; the separate live-announcer paragraph stays sr-only (announced, never shown)', () => {
    const before = renderToString(createElement(GatedNote, { id: 'n', activated: false, text: 'X does the thing.' }))
    const after = renderToString(createElement(GatedNote, { id: 'n', activated: true, text: 'X does the thing.' }))
    // Before: both paragraphs are sr-only (the description not yet revealed; the announcer has no
    // text to announce), so the sentence reads zero times visibly.
    expect(before).toMatch(/<p id="n" class="sr-only">/)
    // After: the id="n" paragraph (what aria-describedby names) is the visible one; the announcer
    // (role="status") stays sr-only — the sentence is read twice (description + one announcement)
    // but shown on screen once.
    expect(after).toMatch(/<p id="n" class="flex items-start/)
    expect(after).toMatch(/<p role="status"[^>]*class="sr-only">X does the thing\.<\/p>/)
    expect((after.match(/X does the thing\./g) ?? []).length).toBe(2)
  })
})

describe('isActivatingKey (the Tab-reveals-every-note regression)', () => {
  it('activates on Enter, Space and a single printable character', () => {
    for (const key of ['Enter', ' ', 'a', 'A', '1', '?']) expect(isActivatingKey(key), key).toBe(true)
  })

  it('never activates on Tab or the other navigation/modifier keys', () => {
    for (const key of [
      'Tab',
      'Shift',
      'Alt',
      'Control',
      'Meta',
      'Escape',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ])
      expect(isActivatingKey(key), key).toBe(false)
  })

  it('never activates on a non-printable multi-character key outside that list (Backspace, F1…)', () => {
    for (const key of ['Backspace', 'Delete', 'F1', 'Insert', 'CapsLock']) expect(isActivatingKey(key), key).toBe(false)
  })

  it("useGated's onKeyDown actually gates on isActivatingKey, not a hand-rolled copy (src read as text)", () => {
    const [useGatedSource] = Object.values(
      import.meta.glob<string>('../../src/use-gated.ts', { query: '?raw', import: 'default', eager: true }),
    )
    const start = useGatedSource.indexOf('function onKeyDown(')
    const body = useGatedSource.slice(start, useGatedSource.indexOf('\n  }', start))
    expect(body).toContain('isActivatingKey(e.key)')
  })

  // A hook whose activate also calls fetch('/api/x') would pass every other check (the per-page
  // tests only check markup; T-GATE-3's source scan only walks each PAGE component's body, never
  // the hook's own). activate() is the hook's only state-changing
  // function, so its body is read directly here.
  it('activate() touches nothing but setActivated — no fetch, postJson, request, navigate or window.location', () => {
    const [useGatedSource] = Object.values(
      import.meta.glob<string>('../../src/use-gated.ts', { query: '?raw', import: 'default', eager: true }),
    )
    const start = useGatedSource.indexOf('function activate()')
    const body = useGatedSource.slice(start, useGatedSource.indexOf('\n  }', start))
    expect(body).toContain('setActivated(true)')
    for (const pattern of [/\bfetch\(/, /\bpostJson\(/, /\brequest\(/, /\bnavigate\(/, /window\.location/]) expect(body).not.toMatch(pattern)
  })

  // The check above only reads activate()'s own body; the same banned call can be bolted onto
  // onKeyDown instead (`void fetch('/api/x')` inside useGated's onKeyDown), and
  // every prior check — the per-page markup tests, T-GATE-3's page-component scan, and the
  // activate()-only check above — misses it, since onKeyDown's body was never read. This reads the
  // WHOLE file instead of one named function, so nothing declared in use-gated.ts, present or
  // future, can carry a banned call anywhere.
  it('no function in src/use-gated.ts — onKeyDown included — calls fetch, postJson, request, navigate or touches window.location', () => {
    const [useGatedSource] = Object.values(
      import.meta.glob<string>('../../src/use-gated.ts', { query: '?raw', import: 'default', eager: true }),
    )
    for (const pattern of [/\bfetch\(/, /\bpostJson\(/, /\brequest\(/, /\bnavigate\(/, /window\.location/])
      expect(useGatedSource).not.toMatch(pattern)
  })
})

describe('ComingSoonTag', () => {
  it('renders the fixed chip text once', () => {
    const html = renderToString(createElement(ComingSoonTag))
    expect(html).toContain('Coming soon')
  })
})
