import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FEATURES, featuresOn, type Feature, type FeatureId } from '../../shared/features'
import { ComingSoonContext, type ComingSoon } from '../../src/coming-soon'
import { ComingSoonTag, GatedNote } from '../../src/components'
import { GATED_LOOK, isActivatingKey, useGated } from '../../src/use-gated'
import { showsComingSoonChip, wearsGatedLook } from '../helpers/gated-assertions'

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
      { type: 'button', ...gated.bind, onClick: gated.activate, className: GATED_LOOK },
      gated.feature.label,
    ),
    createElement(GatedNote, { id: gated.noteId, text: gated.feature.note }),
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

  // One thing in one place: the pop-up's "Coming soon" chip (ComingSoonTag) and the hidden cue
  // (GatedNote) say that phrase; the note says only what the feature will do, and never retypes this
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
  it('renders aria-disabled="true" and aria-haspopup="dialog", never the disabled attribute, with an aria-describedby that resolves', () => {
    for (const id of Object.keys(FEATURES) as FeatureId[]) {
      const html = rendered(id)
      expect(html).toContain('aria-disabled="true"')
      expect(html).toContain('aria-haspopup="dialog"')
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

  it('the description is sr-only and starts with the hidden "Coming soon." cue; no chip shows beside the control', () => {
    const html = rendered('csv_upload')
    expect(html).toMatch(/<p id="[^"]+" class="sr-only">Coming soon\. /)
    expect(showsComingSoonChip(html)).toBe(false)
  })

  it('GATED_LOOK greys the control (muted ink, not-allowed pointer) with no hover colour of its own', () => {
    expect(GATED_LOOK.split(' ')).toEqual(expect.arrayContaining(['cursor-not-allowed', 'text-ink-subtle']))
    expect(GATED_LOOK).not.toMatch(/hover:|active:/)
    expect(wearsGatedLook(`<button class="px-2 ${GATED_LOOK}">`)).toBe(true)
    expect(wearsGatedLook('<button class="px-2 text-ink">')).toBe(false)
  })
})

describe('useGated activation (T-GATE-3): shape, not DOM — the live check covers the real click', () => {
  function Shape({ feature }: { feature: FeatureId }) {
    const gated = useGated(feature)
    return createElement('span', { 'data-testid': 'shape' }, Object.keys(gated).join(','))
  }
  it("activate takes no argument it could pass on, so a control can wire only this page's own state to it — never a fetch, a navigation or a route it doesn't already call", () => {
    const html = renderToString(createElement(Shape, { feature: 'csv_upload' }))
    expect(html).toContain('feature,noteId,bind,activate,onKeyDown')
  })
})

describe('GatedNote (T-GATE-2 continued)', () => {
  it('is one always-sr-only paragraph: the "Coming soon." cue then the note, once, with no live region of its own (the pop-up is read when it opens)', () => {
    const html = renderToString(createElement(GatedNote, { id: 'n', text: 'X does the thing.' }))
    expect(html).toBe('<p id="n" class="sr-only">Coming soon. X does the thing.</p>')
    expect(html).not.toContain('role="status"')
  })
})

/**
 * Drives the real hook with a stand-in pop-up: renders a control inside a ComingSoonContext whose
 * `open` records each call, keeps the hook's own result, and then calls its handlers the way the
 * browser would (no DOM inside workerd, so the handlers are called directly).
 */
/** A gated button that hands its hook result to `keep` (a prop call, so nothing outside is reassigned). */
function Control({ feature, keep }: { feature: FeatureId; keep: (gated: ReturnType<typeof useGated>) => void }) {
  const gated = useGated(feature)
  keep(gated)
  return createElement('button', { type: 'button', ...gated.bind, onClick: gated.activate }, gated.feature.label)
}

function driven(feature: FeatureId): { gated: ReturnType<typeof useGated>; opened: FeatureId[] } {
  const opened: FeatureId[] = []
  const popUp: ComingSoon = { open: (f) => opened.push(f) }
  const kept: ReturnType<typeof useGated>[] = []
  renderToString(
    createElement(ComingSoonContext, { value: popUp }, createElement(Control, { feature, keep: (g) => kept.push(g) })),
  )
  if (kept.length !== 1) throw new Error('gated test: the control did not render exactly once')
  return { gated: kept[0], opened }
}

/** A keydown as the hook sees it, recording whether its default was prevented. */
function key(k: string): { key: string; preventDefault: () => void; prevented: boolean } {
  const e = {
    key: k,
    prevented: false,
    preventDefault() {
      e.prevented = true
    },
  }
  return e
}

describe('activating a gated control opens the shared pop-up on its own feature', () => {
  it('a click (activate) opens the pop-up on exactly this feature, once per click, for every feature', () => {
    for (const id of Object.keys(FEATURES) as FeatureId[]) {
      const { gated, opened } = driven(id)
      expect(opened).toEqual([])
      gated.activate()
      expect(opened).toEqual([id])
    }
  })

  it('Enter and Space open it, and their default is prevented (no form submit, no checkbox toggle)', () => {
    for (const k of ['Enter', ' ']) {
      const { gated, opened } = driven('filter_opened_within_days')
      const e = key(k)
      gated.onKeyDown(e)
      expect(opened, JSON.stringify(k)).toEqual(['filter_opened_within_days'])
      expect(e.prevented, JSON.stringify(k)).toBe(true)
    }
  })

  it('Tab, Escape, arrows and a typed character open nothing and keep their default (a gated input stays read-only)', () => {
    for (const k of ['Tab', 'Escape', 'ArrowDown', 'Shift', 'a', 'Z', '1', '?']) {
      const { gated, opened } = driven('follow_up_questions')
      const e = key(k)
      gated.onKeyDown(e)
      expect(opened, k).toEqual([])
      expect(e.prevented, k).toBe(false)
    }
  })

  it('outside a ComingSoonProvider, activating fails loud instead of silently doing nothing', () => {
    const kept: ReturnType<typeof useGated>[] = []
    renderToString(createElement(Control, { feature: 'csv_upload', keep: (g) => kept.push(g) }))
    expect(kept).toHaveLength(1)
    expect(() => kept[0].activate()).toThrow(/ComingSoonProvider/)
  })
})

describe('isActivatingKey (the Tab-opens-every-pop-up regression)', () => {
  it('activates on Enter and Space only', () => {
    for (const key of ['Enter', ' ']) expect(isActivatingKey(key), key).toBe(true)
  })

  it('never activates on a typed character (a gated text input stays read-only, no pop-up per keystroke)', () => {
    for (const key of ['a', 'A', '1', '?', '.']) expect(isActivatingKey(key), key).toBe(false)
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
  it("activate() only calls the pop-up's open(feature) — no fetch, postJson, request, navigate or window.location", () => {
    const [useGatedSource] = Object.values(
      import.meta.glob<string>('../../src/use-gated.ts', { query: '?raw', import: 'default', eager: true }),
    )
    const start = useGatedSource.indexOf('function activate()')
    const body = useGatedSource.slice(start, useGatedSource.indexOf('\n  }', start))
    expect(body.replace('function activate() {', '').trim()).toBe('open(feature)')
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

  it('only the pop-up renders the chip: no page or control in src renders <ComingSoonTag>', () => {
    const sources = import.meta.glob<string>('../../src/**/*.tsx', { query: '?raw', import: 'default', eager: true })
    const sites = Object.entries(sources).flatMap(([p, text]) =>
      (text.match(/<ComingSoonTag\b/g) ?? []).map(() => p.replace(/^(\.\.\/)+/, '')),
    )
    expect(sites).toEqual(['src/coming-soon-dialog.tsx'])
  })
})
