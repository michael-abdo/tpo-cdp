import { describe, expect, it } from 'vitest'
import { FEATURES, type Feature, type FeatureId } from '../../shared/features'
import { literalOccursIn } from '../helpers/gated-assertions'

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

  // The hook-call count above only proves the flag is wired in SOMEWHERE: useGated(...) lives once
  // in the component's own defining file no matter how many times, or how few, <Component /> is
  // actually rendered, and from which page. A component dropped from its page, mounted twice, or
  // mounted on the wrong page moves none of the counts above. This block closes that gap by
  // counting the real JSX render sites and pinning each one to its feature's own page.

  /** One gated component's JSX tag, the feature it gates, the files (that feature's page's module
   * graph) it may legitimately render from, and the total render sites expected (1, except
   * AccountButton's two homes — the desktop row and the phone menu, both in src/App.tsx, the shell
   * that hosts every page's top bar for work_sign_in's second placement). */
  const RENDER_SITES: { tag: string; feature: FeatureId; files: string[]; count?: number }[] = [
    { tag: 'LoadBar', feature: 'csv_upload', files: ['src/pages/OverviewPage.tsx'] },
    { tag: 'SettingsButton', feature: 'definition_settings', files: ['src/pages/OverviewPage.tsx'] },
    { tag: 'AppRevenue', feature: 'profile_revenue', files: ['src/pages/LookupPage.tsx'] },
    { tag: 'DeletePerson', feature: 'delete_person', files: ['src/pages/LookupPage.tsx'] },
    { tag: 'SendToBeehiiv', feature: 'send_to_beehiiv', files: ['src/pages/SegmentsPage.tsx'] },
    { tag: 'GatedSignedUpBetween', feature: 'filter_signed_up_between', files: ['src/pages/SegmentsPage.tsx'] },
    { tag: 'GatedOpenedWithinDays', feature: 'filter_opened_within_days', files: ['src/pages/SegmentsPage.tsx'] },
    { tag: 'GatedSiteVisitsAtLeast', feature: 'filter_site_visits_gte', files: ['src/pages/SegmentsPage.tsx'] },
    { tag: 'GatedGoingColdRisk', feature: 'filter_going_cold_risk', files: ['src/pages/SegmentsPage.tsx'] },
    { tag: 'GatedEmailDomain', feature: 'filter_email_domain', files: ['src/pages/SegmentsPage.tsx'] },
    { tag: 'SendTheBoardButton', feature: 'schedules_and_digests', files: ['src/pages/InsightsPage.tsx'] },
    { tag: 'SetAlertItem', feature: 'schedules_and_digests', files: ['src/insights/board.tsx'] },
    { tag: 'FollowUpField', feature: 'follow_up_questions', files: ['src/insights/ask.tsx'] },
    { tag: 'AccountButton', feature: 'work_sign_in', files: ['src/App.tsx'], count: 2 },
  ]

  /** Every `<Tag` JSX render site for `tag` across the real source tree, by file (repo-relative). */
  function renderSites(tag: string): Record<string, number> {
    const counts: Record<string, number> = {}
    const needle = new RegExp(`<${tag}\\b`, 'g')
    for (const [path, text] of Object.entries(SRC)) {
      const n = text.match(needle)?.length ?? 0
      if (n > 0) counts[path.replace(/^(\.\.\/)+/, '')] = n
    }
    return counts
  }

  it('the render-site scanner sees the real tree (sanity: LoadBar is found at least once)', () => {
    expect(Object.keys(renderSites('LoadBar')).length).toBeGreaterThan(0)
  })

  it("every gated component with its own JSX tag renders exactly once (twice for AccountButton), only from its feature's own page", () => {
    const offenders: string[] = []
    for (const { tag, files, count = 1 } of RENDER_SITES) {
      const sites = renderSites(tag)
      const total = Object.values(sites).reduce((a, b) => a + b, 0)
      if (total !== count) offenders.push(`${tag}: ${total} render site(s) (expected ${count}): ${JSON.stringify(sites)}`)
      for (const file of Object.keys(sites)) {
        if (!files.includes(file)) offenders.push(`${tag}: rendered from ${file}, outside its page's module graph (${files.join(', ')})`)
      }
    }
    expect(offenders).toEqual([])
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

describe('T-GATE-6 (D-72, one home): no features.ts label/controls string is hand-typed again in src/**/*.tsx', () => {
  // A component that reads `gated.feature.label` never has that exact string sitting anywhere
  // else in its own JSX (that string only ever shows up as the dynamic reference), so a mutant
  // that swaps the dynamic read for a hardcoded copy of the SAME words — invisible to the
  // equality checks each *-gated.test.ts file runs, since the rendered text still matches —
  // leaves a second home for the fact. That second home is exactly what this scans for: the
  // literal words sitting in source, not merely what ends up on screen.
  //
  // Two words collide on purpose. `ask.tsx`'s own, pre-existing "Ask" button (AskSection's real,
  // working submit button, 06 §/insights R5) is not derived from follow_up_questions at all — it
  // predates that flag and shares the single word by coincidence. "Details" is `components.tsx`'s
  // generic Disclosure default (`detailsLabel = 'Details'`) and the per-row toggles built from it
  // on /audit and three unrelated rows of /lookup (visits, app events, and Disclosure's own
  // default) — every one of them a REAL, working, already-built toggle, none derived from
  // profile_revenue's gated "Details" (read only through `gated.feature.controls![0]`, never
  // hand-typed). Keeping this list named and tiny (rather than skipping the scan file-wide, or
  // picking different words for these flags) means every OTHER literal leak still fails here;
  // only these reviewed, unrelated reuses are spared.
  const KNOWN_UNRELATED_REUSE: { file: string; literal: string }[] = [
    { file: '../../src/insights/ask.tsx', literal: 'Ask' },
    { file: '../../src/components.tsx', literal: 'Details' },
    { file: '../../src/pages/AuditPage.tsx', literal: 'Details' },
    { file: '../../src/pages/LookupPage.tsx', literal: 'Details' },
  ]

  it('scans the real tree, not an empty glob', () => {
    expect(Object.keys(SRC).length).toBeGreaterThan(5)
  })

  it('no label or controls string is duplicated as a hand-typed literal anywhere in src/**/*.tsx', () => {
    const offenders: string[] = []
    for (const [id, f] of Object.entries(FEATURES) as [FeatureId, Feature][]) {
      for (const phrase of [f.label, ...(f.controls ?? [])]) {
        for (const [path, text] of Object.entries(SRC)) {
          if (KNOWN_UNRELATED_REUSE.some((k) => k.file === path && k.literal === phrase)) continue
          if (literalOccursIn(text, phrase)) offenders.push(`${id}: "${phrase}" is hand-typed in ${path}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the known-reuse sanity check itself still finds "Ask" in ask.tsx (so the exception is real, not stale)', () => {
    const [askSource] = Object.entries(SRC).filter(([p]) => p.endsWith('insights/ask.tsx'))
    expect(askSource).toBeDefined()
    expect(literalOccursIn(askSource![1], 'Ask')).toBe(true)
  })
})
