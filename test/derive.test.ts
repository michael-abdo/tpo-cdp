import { describe, expect, it } from 'vitest'
import { TODAY } from '../shared/config'
import {
  DEFINITIONS,
  appAfterSignup,
  coldSince,
  daysBetween,
  daysSinceOpen,
  engagementScore,
  goingColdRisk,
  hasApp,
  isCold,
  isNewSubscriber,
  lastMonth,
  lastNDays,
  noOpenInDays,
  wentColdIn,
} from '../shared/derive'

// 02 §Derived and §Time, 09 D-10/D-14/D-30/D-31/D-36/D-46; tests 08 T-DER-1..3 (C6, R5.2).
// Rows are the real demo subjects and hand-computed cases from 02 §Counts.

describe('T-DER-1 derived dates use TODAY (C6)', () => {
  it('TODAY is the constant the brief fixes', () => {
    expect(TODAY).toBe('2026-09-28')
  })

  it('a date after TODAY yields days_since_open 0, not a negative number', () => {
    expect(daysSinceOpen('2026-10-05')).toBe(0)
    expect(daysSinceOpen('2026-09-29T10:15:00Z')).toBe(0)
    expect(daysBetween(TODAY, '2026-10-05')).toBe(7)
  })

  it('counts whole days back from TODAY and is null when never opened', () => {
    expect(daysSinceOpen(TODAY)).toBe(0)
    expect(daysSinceOpen('2026-09-22')).toBe(6)
    expect(daysSinceOpen('2026-09-22 23:59:59')).toBe(6)
    expect(daysSinceOpen(null)).toBeNull()
  })

  it('fails loud on a value that is not a date', () => {
    expect(() => daysSinceOpen('yesterday')).toThrow(/not an ISO date/)
    expect(() => daysSinceOpen('2026-02-30')).toThrow(/not a calendar date/)
  })
})

describe('T-DER-2 cold_since / cold / went_cold_in / new_subscriber (02 §Counts rows)', () => {
  it('joy.hall830: last open 2026-09-22 → cold_since 2026-10-22, not cold', () => {
    const cs = coldSince('2026-09-22', '2026-09-02')
    expect(cs).toBe('2026-10-22')
    expect(isCold(cs)).toBe(false)
    expect(wentColdIn(cs, '2026-10')).toBe(false)
  })

  it('julia.evans230: last open 2026-09-15 → cold_since 2026-10-15, not cold', () => {
    const cs = coldSince('2026-09-15', '2026-09-13')
    expect(cs).toBe('2026-10-15')
    expect(isCold(cs)).toBe(false)
  })

  it('never opened, signup 2026-08-10 → cold_since 2026-09-09, cold, went cold in September', () => {
    const cs = coldSince(null, '2026-08-10')
    expect(cs).toBe('2026-09-09')
    expect(isCold(cs)).toBe(true)
    expect(wentColdIn(cs, '2026-08')).toBe(false)
    expect(wentColdIn(cs, '2026-09')).toBe(true)
  })

  it('never opened, signup 2026-07-01 → went cold in July', () => {
    const cs = coldSince(null, '2026-07-01')
    expect(cs).toBe('2026-07-31')
    expect(wentColdIn(cs, '2026-07')).toBe(true)
    expect(wentColdIn(cs, '2026-08')).toBe(false)
  })

  it('cold is inclusive at TODAY and never true for a future cold date', () => {
    expect(isCold(TODAY)).toBe(true)
    expect(isCold('2026-09-29')).toBe(false)
    expect(wentColdIn('2026-09-29', '2026-09')).toBe(false)
    expect(() => wentColdIn(TODAY, '2026-9')).toThrow(/YYYY-MM/)
  })

  it("the brief's filter differs from cold: never-openers count regardless of signup age (D-30)", () => {
    expect(noOpenInDays('2026-08-29', 30, false)).toBe(true)
    expect(noOpenInDays('2026-08-30', 30, false)).toBe(false)
    expect(noOpenInDays(null, 30, true)).toBe(true)
    expect(noOpenInDays(null, 30, false)).toBe(false)
    // a never-opener who signed up yesterday is not cold but is in the brief's preset
    expect(isCold(coldSince(null, '2026-09-27'))).toBe(false)
    expect(noOpenInDays(null, 30, true)).toBe(true)
  })

  it('new_subscriber: signup 2026-09-02 true, 2026-08-11 false (D-36)', () => {
    expect(isNewSubscriber('2026-09-02')).toBe(true)
    expect(isNewSubscriber('2026-08-11')).toBe(false)
    expect(isNewSubscriber('2026-08-29')).toBe(true)
    expect(isNewSubscriber('2026-08-28')).toBe(false)
  })

  it('has_app / app_after_signup on the demo subjects: joy converted, julia did not', () => {
    expect(hasApp('2026-09-03')).toBe(true)
    expect(hasApp(null)).toBe(false)
    expect(appAfterSignup('2026-09-03', '2026-09-02')).toBe(true)
    expect(appAfterSignup('2026-08-22', '2026-09-13')).toBe(false)
    expect(appAfterSignup('2026-09-13', '2026-09-13')).toBe(false)
    expect(appAfterSignup(null, '2026-09-13')).toBe(false)
  })

  it('going_cold_risk (D-31): opened 15–30 days ago or cold within 7 days; neither demo subject is at risk', () => {
    expect(goingColdRisk('2026-09-15', coldSince('2026-09-15', '2026-09-13'))).toBe(false) // 13 days: still in the last 14
    expect(goingColdRisk('2026-09-22', coldSince('2026-09-22', '2026-09-02'))).toBe(false)
    expect(goingColdRisk('2026-09-10', coldSince('2026-09-10', '2026-08-01'))).toBe(true) // 18 days ago
    expect(goingColdRisk('2026-09-14', coldSince('2026-09-14', '2026-08-01'))).toBe(false) // 14 days: in the last 14
    expect(goingColdRisk('2026-08-29', coldSince('2026-08-29', '2026-08-01'))).toBe(true) // 30 days: "last 30 days" is TODAY − 30 .. TODAY
    expect(goingColdRisk('2026-08-28', coldSince('2026-08-28', '2026-08-01'))).toBe(false) // 31 days: outside the window
    expect(goingColdRisk(null, coldSince(null, '2026-09-01'))).toBe(true)
    expect(goingColdRisk(null, coldSince(null, '2026-09-20'))).toBe(false)
    expect(goingColdRisk('2026-08-01', coldSince('2026-08-01', '2026-07-01'))).toBe(false)
  })
})

describe('T-DER-3 engagement_score (02 §Derived formula, D-14)', () => {
  const grid = (() => {
    const opens: (string | null)[] = [
      null,
      '2026-07-01',
      '2026-08-29',
      '2026-09-13',
      '2026-09-27',
      TODAY,
      '2026-10-02',
    ]
    const rows = []
    for (const last_open_date of opens)
      for (const app_events_last_30d of [0, 1, 5, 10, 25])
        for (const site_visits_last_30d of [0, 1, 3, 5, 12])
          rows.push({ last_open_date, app_events_last_30d, site_visits_last_30d })
    return rows
  })()

  it('is an integer within 0–100 for every combination', () => {
    for (const row of grid) {
      const score = engagementScore(row)
      expect(Number.isInteger(score)).toBe(true)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
    }
  })

  it('never opened with no activity scores 0; max activity and opened today scores 100', () => {
    expect(engagementScore({ last_open_date: null, app_events_last_30d: 0, site_visits_last_30d: 0 })).toBe(0)
    expect(engagementScore({ last_open_date: TODAY, app_events_last_30d: 10, site_visits_last_30d: 5 })).toBe(
      100,
    )
    expect(
      engagementScore({ last_open_date: '2026-10-02', app_events_last_30d: 40, site_visits_last_30d: 9 }),
    ).toBe(100)
  })

  it('each component caps where 02 says: 30 days, 10 app events, 5 site visits', () => {
    expect(
      engagementScore({ last_open_date: '2026-08-29', app_events_last_30d: 0, site_visits_last_30d: 0 }),
    ).toBe(0)
    expect(
      engagementScore({ last_open_date: '2026-09-13', app_events_last_30d: 0, site_visits_last_30d: 0 }),
    ).toBe(25)
    expect(engagementScore({ last_open_date: null, app_events_last_30d: 5, site_visits_last_30d: 0 })).toBe(
      13,
    )
    expect(engagementScore({ last_open_date: null, app_events_last_30d: 0, site_visits_last_30d: 5 })).toBe(
      25,
    )
  })

  it('a more recent open or more activity never lowers the score', () => {
    for (const row of grid) {
      const base = engagementScore(row)
      expect(
        engagementScore({ ...row, app_events_last_30d: row.app_events_last_30d + 1 }),
      ).toBeGreaterThanOrEqual(base)
      expect(
        engagementScore({ ...row, site_visits_last_30d: row.site_visits_last_30d + 1 }),
      ).toBeGreaterThanOrEqual(base)
      const moreRecent = row.last_open_date === null ? '2026-07-01' : TODAY
      expect(engagementScore({ ...row, last_open_date: moreRecent })).toBeGreaterThanOrEqual(base)
    }
  })
})

describe('time windows and the DEFINITIONS object (02 §Derived "One runtime source")', () => {
  it('lastMonth() is August 2026 relative to TODAY (D-10)', () => {
    expect(lastMonth()).toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('lastNDays(n) is TODAY − n .. TODAY', () => {
    expect(lastNDays(30)).toEqual({ from: '2026-08-29', to: TODAY })
    expect(lastNDays(0)).toEqual({ from: TODAY, to: TODAY })
    expect(() => lastNDays(-1)).toThrow(/non-negative/)
  })

  it('has one entry per row of 02 §Derived, each with name, doc, formula and fn', () => {
    expect(Object.keys(DEFINITIONS)).toEqual([
      'days_since_open',
      'cold_since',
      'cold',
      'went_cold_in',
      'no_open_in_days',
      'new_subscriber',
      'going_cold_risk',
      'engagement_score',
      'has_app',
      'app_after_signup',
      'last_month',
      'last_n_days',
    ])
    for (const entry of Object.values(DEFINITIONS)) {
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.doc).toMatch(/^[A-Z].*\.$/)
      expect(entry.formula.length).toBeGreaterThan(0)
      expect(typeof entry.fn).toBe('function')
    }
  })

  it('the SQL fragments compare the stored column against bound dates, never a formula (D-46)', () => {
    expect(DEFINITIONS.cold.sql).toBe('cold_since <= :today')
    expect(DEFINITIONS.days_since_open.sql).toBe('julianday(:today) - julianday(last_open_date)')
    // 09 D-69: the went-cold month and "signed up in the last N days" bind a window derive.ts computes.
    expect(DEFINITIONS.went_cold_in.sql).toBe('cold_since BETWEEN :from AND :to')
    expect(DEFINITIONS.new_subscriber.sql).toBe('signup_date BETWEEN :from AND :to')
    for (const entry of Object.values(DEFINITIONS)) {
      if (!('sql' in entry)) continue
      expect(entry.sql).toMatch(/:today|:from AND :to/)
      expect(entry.sql).not.toMatch(/\+\s*30|'-30 days'|'now'|date\(/)
    }
  })

  it('the entries call the same functions the tests above exercised', () => {
    expect(DEFINITIONS.cold_since.fn('2026-09-22', '2026-09-02')).toBe('2026-10-22')
    expect(DEFINITIONS.cold.fn('2026-09-09')).toBe(true)
    expect(DEFINITIONS.last_month.fn()).toEqual(lastMonth())
  })
})
