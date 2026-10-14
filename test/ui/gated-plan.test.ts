import { describe, expect, it } from 'vitest'
import { FEATURES, type FeatureId } from '../../shared/features'

// T-GATE-1 and T-GATE-5 (00-plan.md §4), read from source/README text (no DOM, no typescript
// package — tests run inside workerd; see one-home.test.ts for the same import.meta.glob pattern).

const SRC = import.meta.glob<string>(['../../src/**/*.tsx'], { query: '?raw', import: 'default', eager: true })
const [README] = Object.values(import.meta.glob<string>('../../README.md', { query: '?raw', import: 'default', eager: true }))

/** How many `useGated('<id>')` call sites exist across every .tsx source file. */
function placementCount(id: FeatureId): number {
  const needle = `useGated('${id}')`
  let n = 0
  for (const text of Object.values(SRC)) n += text.split(needle).length - 1
  return n
}

// 00-plan.md §1: one placement per flag, except the two flags whose control ships in two spots —
// schedules_and_digests (the board header's Send the board + a tile's Set an alert) and
// work_sign_in (the /login button + the top bar's Your account) — which both have two.
const TWO_PLACEMENTS = new Set<FeatureId>(['schedules_and_digests', 'work_sign_in'])

describe('T-GATE-1: every shared/features.ts entry renders on its page exactly once (two named exceptions: twice)', () => {
  it('scans the real tree, not an empty glob', () => {
    expect(Object.keys(SRC).length).toBeGreaterThan(5)
  })

  it('each flag has exactly the placements 00-plan.md §1 names', () => {
    for (const id of Object.keys(FEATURES) as FeatureId[]) {
      const expected = TWO_PLACEMENTS.has(id) ? 2 : 1
      expect(placementCount(id), id).toBe(expected)
    }
  })

  it('a flag missing from every page (0 placements) is caught, not silently passed', () => {
    // Sanity check on the counter itself: a made-up id has zero placements.
    // @ts-expect-error -- deliberately not a real FeatureId, to exercise the zero-count path
    expect(placementCount('not_a_real_feature')).toBe(0)
  })
})

describe('T-GATE-5: README\'s Known gaps names every gated feature, and the count line matches', () => {
  it('reads the real README, not an empty glob', () => {
    expect(README.length).toBeGreaterThan(1000)
    expect(README).toContain('## Known gaps')
  })

  /** The Known gaps section: from its heading to the next `## ` heading. */
  function knownGaps(readme: string): string {
    const start = readme.indexOf('## Known gaps')
    if (start < 0) throw new Error('gated-plan: README has no "## Known gaps" section')
    const end = readme.indexOf('\n## ', start + 1)
    if (end < 0) throw new Error('gated-plan: "## Known gaps" never ends (no following heading)')
    return readme.slice(start, end)
  }

  it('every FEATURES id and label is named in Known gaps', () => {
    const gaps = knownGaps(README)
    const missing: string[] = []
    for (const [id, f] of Object.entries(FEATURES)) {
      if (!gaps.includes(`\`${id}\``)) missing.push(`${id}: missing the flag name`)
      if (!gaps.includes(f.label)) missing.push(`${id}: missing the label "${f.label}"`)
    }
    expect(missing).toEqual([])
  })

  it('the "N future features are gated" count equals Object.keys(FEATURES).length', () => {
    const gaps = knownGaps(README)
    const m = /\*\*(\d+) future features are gated in place/.exec(gaps)
    if (m === null) throw new Error('gated-plan: README has no "N future features are gated in place" line')
    expect(Number(m[1])).toBe(Object.keys(FEATURES).length)
  })

  it('every FEATURES id appears exactly once in Known gaps (one home, not a scattered second mention)', () => {
    const gaps = knownGaps(README)
    for (const id of Object.keys(FEATURES)) {
      const count = gaps.split(`\`${id}\``).length - 1
      expect(count, id).toBe(1)
    }
  })
})
