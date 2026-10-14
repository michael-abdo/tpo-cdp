/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { TODAY } from '../shared/config'
import { addDays, COLD_DAYS, coldSince, DEFINITIONS, goingColdRisk, isCold, isNewSubscriber, NEW_SUBSCRIBER_DAYS } from '../shared/derive'

// One home per definition (09 D-68, D-46; 18-settings-spec §1 rows 2, 4, 13 and §7 Tier 0;
// 02 §Derived "One runtime source"). Static scans over the product source, read at transform time
// by Vite (works in the workers pool, as T-NORM-3 does), plus runtime checks that the cold window
// constant is the number every cold rule and sentence uses. No number changes: COLD_DAYS stays 30.

const code = import.meta.glob<string>(
  ['../src/**/*.{ts,tsx}', '../worker/**/*.{ts,tsx}', '../shared/**/*.{ts,tsx}', '../scripts/**/*.ts'],
  { query: '?raw', import: 'default', eager: true },
)

/**
 * A line that writes the cold rule's number itself: 30 on a line about cold, "no opens for 30", or
 * `addDays(…, 30)`. The brief's preset ("haven't opened in 30 days", "no open in 30 days") is its own
 * filter (09 D-30), not the cold rule, so it does not match.
 */
function coldRuleLiteral(line: string): boolean {
  if (!/\b30\b/.test(line)) return false
  return /cold/i.test(line) || /\bno opens? for 30\b/i.test(line) || /addDays\([^)]*,\s*30\s*\)/.test(line)
}

/** The one line allowed to hold the number: its home in shared/derive.ts. */
const COLD_HOME = /^export const COLD_DAYS = \d+$/

/**
 * The body of `export function <name>(…) {…}` in a source text: from its signature to the first
 * closing brace at column 0. Fails loud if the function is missing, so a rename cannot empty a check.
 */
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`export function ${name}(`)
  if (start < 0) throw new Error(`one-home: export function ${name} not found`)
  const end = text.indexOf('\n}', start)
  if (end < 0) throw new Error(`one-home: export function ${name} has no closing brace at column 0`)
  return text.slice(start, end + 2)
}

describe('the cold window has one home (09 D-68)', () => {
  it('scans the real tree, not an empty glob', () => {
    for (const path of [
      '../shared/derive.ts',
      '../src/pages/LookupPage.tsx',
      '../src/pages/OverviewPage.tsx',
      '../worker/ingest/link.ts',
      '../worker/insights/going-cold.ts',
    ])
      expect(Object.keys(code)).toContain(path)
  })

  it('the matcher catches the old Lookup line and leaves the brief preset alone', () => {
    expect(
      coldRuleLiteral("return `Gone cold since ${humanDate(coldSince)} (${neverOpened ? 'never opened' : 'no opens for 30 days'})`"),
    ).toBe(true)
    expect(coldRuleLiteral('  return addDays(lastOpenDate ?? signupDate, 30)')).toBe(true)
    expect(coldRuleLiteral("    doc: 'Opened an email in the last 30 days but not in the last 14, or will become cold…'")).toBe(true)
    expect(coldRuleLiteral("          Instagram readers who haven't opened in 30 days")).toBe(false)
    expect(coldRuleLiteral("/** The brief's R3 example (02 §Counts): Instagram, active, no open in 30 days including never-opened. */")).toBe(false)
    expect(coldRuleLiteral('  const window = DEFINITIONS.last_n_days.fn(30)')).toBe(false)
  })

  it('no file in src/, worker/, shared/ or scripts/ writes the cold rule\'s 30 outside COLD_DAYS', () => {
    const offenders: string[] = []
    let homes = 0
    for (const [path, text] of Object.entries(code)) {
      text.split('\n').forEach((line, i) => {
        if (path === '../shared/derive.ts' && COLD_HOME.test(line.trim())) {
          homes += 1
          return
        }
        if (coldRuleLiteral(line)) offenders.push(`${path}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
    expect(homes).toBe(1)
  })

  it('no addDays(…, 30) call anywhere, even one split over several lines', () => {
    const offenders = Object.entries(code)
      .filter(([, text]) => /addDays\([^)]*,\s*30\s*,?\s*\)/.test(text))
      .map(([p]) => p)
    expect(offenders).toEqual([])
  })

  it('coldSince and goingColdRisk write COLD_DAYS, never the number (their bodies, read as text)', () => {
    // A runtime edge test cannot tell COLD_DAYS from a literal 30 while COLD_DAYS === 30, so the
    // two named consumers (09 D-68) are checked as source text too.
    const derive = code['../shared/derive.ts'] ?? ''
    const cold = functionBody(derive, 'coldSince')
    expect(cold).toContain('COLD_DAYS')
    expect(cold).not.toMatch(/\b\d+\b/)
    const risk = functionBody(derive, 'goingColdRisk')
    expect(risk).toContain('lastNDays(COLD_DAYS)')
    expect(risk).not.toMatch(/\b30\b/)
  })

  it('the body checks catch the old goingColdRisk outer window', () => {
    const old = [
      'export function goingColdRisk(lastOpenDate: string | null, coldSinceDate: string): boolean {',
      '  const openedInLast30 = lastOpenDate !== null && inWindow(lastOpenDate, lastNDays(30))',
      '  return openedInLast30',
      '}',
    ].join('\n')
    expect(functionBody(old, 'goingColdRisk')).toMatch(/\b30\b/)
    expect(functionBody(old, 'goingColdRisk')).not.toContain('lastNDays(COLD_DAYS)')
  })

  it('COLD_DAYS is 30 (02 §Derived; no number changes) and coldSince adds exactly it', () => {
    expect(COLD_DAYS).toBe(30)
    expect(coldSince('2026-09-22', '2026-09-02')).toBe(addDays('2026-09-22', COLD_DAYS))
    expect(coldSince(null, '2026-08-10')).toBe(addDays('2026-08-10', COLD_DAYS))
    expect(isCold(addDays(addDays(TODAY, -COLD_DAYS), COLD_DAYS))).toBe(true)
  })

  it("going_cold_risk's outer window is COLD_DAYS: an open exactly COLD_DAYS ago counts, one day more does not", () => {
    const edge = addDays(TODAY, -COLD_DAYS)
    const past = addDays(TODAY, -COLD_DAYS - 1)
    expect(goingColdRisk(edge, coldSince(edge, edge))).toBe(true)
    expect(goingColdRisk(past, coldSince(past, past))).toBe(false)
  })

  it('the DEFINITIONS sentences for the cold rules carry COLD_DAYS (rendered by Lookup, Growth, the prompt, README)', () => {
    const days = `${COLD_DAYS} days`
    expect(DEFINITIONS.cold_since.doc).toContain(days)
    expect(DEFINITIONS.cold_since.formula).toBe(`(last_open_date ?? signup_date) + ${days}`)
    expect(DEFINITIONS.cold.doc).toContain(`${COLD_DAYS} or more days`)
    expect(DEFINITIONS.going_cold_risk.doc).toContain(`last ${days}`)
    expect(DEFINITIONS.going_cold_risk.formula).toContain(`last ${days}`)
  })

  it('the Lookup cold line renders the number from COLD_DAYS', () => {
    const lookup = code['../src/pages/LookupPage.tsx'] ?? ''
    expect(lookup).toContain('no opens for ${COLD_DAYS} days')
    expect(lookup).toMatch(/import \{[^}]*\bCOLD_DAYS\b[^}]*\} from '..\/..\/shared\/derive'/)
  })
})

describe('the new-subscriber window has one home (09 D-10, D-68)', () => {
  it('isNewSubscriber reads NEW_SUBSCRIBER_DAYS, never a literal 30 (its body, read as text)', () => {
    const derive = code['../shared/derive.ts'] ?? ''
    const body = functionBody(derive, 'isNewSubscriber')
    expect(body).toContain('lastNDays(NEW_SUBSCRIBER_DAYS)')
    expect(body).not.toMatch(/\b30\b/)
  })

  it('NEW_SUBSCRIBER_DAYS is 30 (02 §Derived; no number changes) and isNewSubscriber matches it exactly', () => {
    expect(NEW_SUBSCRIBER_DAYS).toBe(30)
    const edge = addDays(TODAY, -NEW_SUBSCRIBER_DAYS)
    const past = addDays(TODAY, -NEW_SUBSCRIBER_DAYS - 1)
    expect(isNewSubscriber(edge)).toBe(true)
    expect(isNewSubscriber(past)).toBe(false)
  })

  it('the DEFINITIONS new_subscriber sentence carries NEW_SUBSCRIBER_DAYS, not a hand-written 30', () => {
    // A runtime comparison cannot tell NEW_SUBSCRIBER_DAYS from a literal 30 while it is 30 (same
    // limit as the COLD_DAYS check above), so the doc/formula source lines are read as text.
    const derive = code['../shared/derive.ts'] ?? ''
    const start = derive.indexOf('new_subscriber: {')
    if (start < 0) throw new Error('one-home: new_subscriber entry not found')
    const block = derive.slice(start, derive.indexOf('},', start) + 2)
    expect(block).toContain('`Signed up within the last ${NEW_SUBSCRIBER_DAYS} days including today.`')
    expect(block).toContain('`signup_date within TODAY − ${NEW_SUBSCRIBER_DAYS} .. TODAY`')
    expect(block).not.toMatch(/\b30\b/)
    expect(DEFINITIONS.new_subscriber.doc).toBe('Signed up within the last 30 days including today.')
    expect(DEFINITIONS.new_subscriber.formula).toBe('signup_date within TODAY − 30 .. TODAY')
  })
})

describe('the duplicate band edges have one home (09 D-62, D-68)', () => {
  const src = Object.entries(code).filter(([path]) => path.startsWith('../src/'))

  it('no browser file names the band constants, so the bundle carries no copy of them', () => {
    const offenders = src.filter(([, text]) => /\b(?:AUTO_MIN_SCORE|REVIEW_MIN_SCORE)\b/.test(text)).map(([p]) => p)
    expect(offenders).toEqual([])
  })

  it('every browser import from worker/dedupe/score is type-only (erased from the bundle)', () => {
    const valueImports: string[] = []
    for (const [path, text] of src) {
      for (const m of text.matchAll(/import\s+(type\s+)?\{[^}]*\}\s*from\s*'[^']*\/dedupe\/score'/g))
        if (m[1] === undefined) valueImports.push(`${path}: ${m[0].replace(/\s+/g, ' ')}`)
    }
    expect(valueImports).toEqual([])
  })

  /** The possible-duplicates band footer: from its first sentence to its closing words. */
  function footer(overview: string): string {
    const start = overview.indexOf('Score {')
    const end = overview.indexOf('Nothing is deduped', start)
    if (start < 0 || end < 0) throw new Error('one-home: Overview band footer not found')
    return overview.slice(start, end)
  }

  it('the Overview footer reads both edges from the GET /api/duplicates response and writes no edge itself', () => {
    const text = footer(code['../src/pages/OverviewPage.tsx'] ?? '')
    expect(text).toContain('{data.bands.auto_min}')
    expect(text).toContain('{data.bands.review_min}')
    expect(text).toContain('{data.bands.auto_min - 1}')
    expect(text).not.toMatch(/\b(?:90|89|50|49)\b/)
  })

  it('no browser file writes band text with a number in it ("Score 90 or more")', () => {
    const offenders: string[] = []
    for (const [path, text] of src)
      text.split('\n').forEach((line, i) => {
        if (/\bScore\s+\d/.test(line) || /\d\s*[–-]\s*\d+\s*:\s*worth a look/.test(line))
          offenders.push(`${path}:${i + 1}: ${line.trim()}`)
      })
    expect(offenders).toEqual([])
  })

  it('the API sends the edges from worker/dedupe/score.ts, not a copy (09 D-62)', () => {
    const route = code['../worker/routes/duplicates.ts'] ?? ''
    expect(route).toContain('bands: { auto_min: AUTO_MIN_SCORE, review_min: REVIEW_MIN_SCORE }')
    expect(route).toMatch(/import \{[^}]*\bAUTO_MIN_SCORE\b[^}]*\bREVIEW_MIN_SCORE\b[^}]*\} from '\.\.\/dedupe\/score'/)
    const offenders = Object.entries(code)
      .filter(([, text]) => /\b(?:auto_min|review_min)\s*:\s*\d/.test(text))
      .map(([p]) => p)
    expect(offenders).toEqual([])
  })
})
