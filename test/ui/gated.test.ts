import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FEATURES, featuresOn, type FeatureId } from '../../shared/features'
import { ComingSoonTag, GatedNote } from '../../src/components'
import { useGated } from '../../src/use-gated'

// Shared gated-feature wiring (09 D-80): the scaffolding every page's gated controls share
// (T-GATE-1..5, 22-pages/00-plan.md §4). A page's own gate test (test/ui/*-gated.test.ts) checks
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
    const before = renderToString(createElement(GatedNote, { id: 'n', activated: false, text: 'X — coming soon.' }))
    const after = renderToString(createElement(GatedNote, { id: 'n', activated: true, text: 'X — coming soon.' }))
    // Before: both paragraphs are sr-only (the description not yet revealed; the announcer has no
    // text to announce), so the sentence reads zero times visibly.
    expect(before).toMatch(/<p id="n" class="sr-only">/)
    // After: the id="n" paragraph (what aria-describedby names) is the visible one; the announcer
    // (role="status") stays sr-only — the sentence is read twice (description + one announcement)
    // but shown on screen once.
    expect(after).toMatch(/<p id="n" class="flex items-start/)
    expect(after).toMatch(/<p role="status"[^>]*class="sr-only">X — coming soon\.<\/p>/)
    expect((after.match(/coming soon/g) ?? []).length).toBe(2)
  })
})

describe('ComingSoonTag', () => {
  it('renders the fixed chip text once', () => {
    const html = renderToString(createElement(ComingSoonTag))
    expect(html).toContain('Coming soon')
  })
})
