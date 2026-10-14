/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { TODAY } from '../shared/config'
import { addDays, COLD_DAYS, coldSince, DEFINITIONS, goingColdRisk, isCold } from '../shared/derive'

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

  it('the Overview footer reads both edges from the GET /api/duplicates response', () => {
    const overview = code['../src/pages/OverviewPage.tsx'] ?? ''
    expect(overview).toContain('data.bands.auto_min')
    expect(overview).toContain('data.bands.review_min')
  })
})
