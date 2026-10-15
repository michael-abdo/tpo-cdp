import { describe, expect, it } from 'vitest'
import { FILTER_KEYS, type FilterKey, type SegmentFilters } from '../../shared/segment-filters'
import { segmentLabel } from '../../src/labels'
import { BRIEF_EXAMPLE, searchKey } from '../../src/previous-searches'

// T-SEG-5 (08; 09 D-69): segmentLabel is the one home of segment
// names. Every filter object here is canonical, the shape POST /api/segments/preview echoes
// (shared/segment-filters.ts: status and source sorted, has_app present, include_never_opened
// false without days, engagement 0 and 100 dropped). Values are real (09 D-47): sources from
// subscribers.csv's source column, /shadrachs-picks from web_events.csv, read_story from the
// brief's event names, and the spec's own windows (30 days, August 2026, engagement 50).

const ACTIVE: SegmentFilters = { status: ['active'], include_never_opened: false, has_app: null }
const f = (more: Partial<SegmentFilters>): SegmentFilters => ({ ...ACTIVE, ...more })

/** 06 §Vocabulary "Retired anywhere user-facing" (09 D-66, the words T-VOC-1 bans). */
const RETIRED = [/\breaders?\b/i, /\blists?\b/i, /newsletter list/i, /app users/i, /find a reader/i, /build a list/i]

describe('T-SEG-5 segmentLabel names a segment in the brief\'s words', () => {
  it("names the brief's preset exactly", () => {
    expect(segmentLabel(BRIEF_EXAMPLE)).toBe("Instagram subscribers who haven't opened in 30 days")
  })

  it('reads every key as the spec\'s grammar says', () => {
    const rows: Array<[SegmentFilters, string]> = [
      [ACTIVE, 'All active subscribers'],
      [f({ status: ['unsubscribed'] }), 'All unsubscribed subscribers'],
      [f({ status: ['active', 'unsubscribed'] }), 'All subscribers, including unsubscribed'],
      [f({ source: ['instagram'] }), 'Instagram subscribers'],
      [f({ source: ['facebook', 'instagram', 'referral'] }), 'Subscribers from Facebook, Instagram or Referral'],
      [f({ status: ['unsubscribed'], source: ['instagram'], went_cold: 'any' }), 'Unsubscribed Instagram subscribers who have gone cold'],
      [
        f({ status: ['active', 'unsubscribed'], source: ['instagram'], went_cold: 'any' }),
        'Instagram subscribers who have gone cold, including unsubscribed',
      ],
      [f({ status: ['unsubscribed'], source: ['facebook', 'instagram'] }), 'Unsubscribed subscribers from Facebook or Instagram'],
      [f({ days_since_open_gte: 30, include_never_opened: true }), "Subscribers who haven't opened in 30 days"],
      [f({ days_since_open_gte: 30 }), 'Subscribers who last opened 30 or more days ago'],
      [f({ went_cold: 'any' }), 'Subscribers who have gone cold'],
      [f({ went_cold: '2026-08' }), 'Subscribers who went cold in August 2026'],
      [f({ signed_up_within_days: 30 }), 'Subscribers who signed up in the last 30 days'],
      [f({ engagement_gte: 50 }), 'Subscribers who have engagement of 50 or more'],
      [f({ engagement_lte: 75 }), 'Subscribers who have engagement of 75 or less'],
      [f({ engagement_gte: 50, engagement_lte: 75 }), 'Subscribers who have engagement from 50 to 75'],
      [f({ has_app: true }), 'Subscribers who have an app account'],
      [f({ has_app: false }), 'Subscribers who have no app account'],
      [f({ site_visit_within_days: 30 }), 'Subscribers who visited the site in the last 30 days'],
      [f({ site_visit_page: '/shadrachs-picks' }), 'Subscribers who visited /shadrachs-picks'],
      [f({ site_visit_within_days: 30, site_visit_page: '/shadrachs-picks' }), 'Subscribers who visited /shadrachs-picks in the last 30 days'],
      [f({ app_active_within_days: 7 }), 'Subscribers who used the app in the last 7 days'],
      [f({ app_event: 'read_story' }), 'Subscribers who used the app (read_story)'],
      [f({ app_active_within_days: 7, app_event: 'read_story' }), 'Subscribers who used the app (read_story) in the last 7 days'],
      [f({ app_active_within_days: 1 }), 'Subscribers who used the app in the last 1 day'],
      [
        { ...BRIEF_EXAMPLE, site_visit_within_days: 30 },
        "Instagram subscribers who haven't opened in 30 days and visited the site in the last 30 days",
      ],
      [
        f({ source: ['instagram'], went_cold: '2026-08', signed_up_within_days: 30, has_app: false }),
        'Instagram subscribers who went cold in August 2026, signed up in the last 30 days and have no app account',
      ],
    ]
    for (const [filters, label] of rows) expect(segmentLabel(filters), JSON.stringify(filters)).toBe(label)
  })

  it('every FILTER_KEYS key changes the label', () => {
    // One pair per key: the base and the same filters with only that key set or changed.
    const base = f({ source: ['instagram'], days_since_open_gte: 30 })
    const changed: { readonly [K in FilterKey]: SegmentFilters } = {
      status: { ...base, status: ['unsubscribed'] },
      source: { ...base, source: ['facebook'] },
      days_since_open_gte: { ...base, days_since_open_gte: 31 },
      include_never_opened: { ...base, include_never_opened: true },
      went_cold: { ...base, went_cold: 'any' },
      signed_up_within_days: { ...base, signed_up_within_days: 30 },
      engagement_gte: { ...base, engagement_gte: 50 },
      engagement_lte: { ...base, engagement_lte: 50 },
      has_app: { ...base, has_app: true },
      site_visit_within_days: { ...base, site_visit_within_days: 30 },
      site_visit_page: { ...base, site_visit_page: '/shadrachs-picks' },
      app_active_within_days: { ...base, app_active_within_days: 7 },
      app_event: { ...base, app_event: 'read_story' },
    }
    for (const key of FILTER_KEYS) expect(segmentLabel(changed[key]), key).not.toBe(segmentLabel(base))
  })

  it('distinct canonical filters get distinct labels, in no retired word', () => {
    const choices: Partial<SegmentFilters>[][] = [
      [{ status: ['active'] }, { status: ['unsubscribed'] }, { status: ['active', 'unsubscribed'] }],
      [{}, { source: ['instagram'] }, { source: ['facebook', 'instagram'] }],
      [{}, { days_since_open_gte: 30 }, { days_since_open_gte: 30, include_never_opened: true }],
      [{}, { went_cold: 'any' }, { went_cold: '2026-08' }],
      [{}, { signed_up_within_days: 30 }],
      [{}, { engagement_gte: 50 }, { engagement_lte: 50 }, { engagement_gte: 50, engagement_lte: 75 }],
      [{ has_app: null }, { has_app: true }, { has_app: false }],
      [{}, { site_visit_within_days: 30 }, { site_visit_page: '/shadrachs-picks' }, { site_visit_within_days: 30, site_visit_page: '/shadrachs-picks' }],
      [{}, { app_active_within_days: 7 }, { app_event: 'read_story' }, { app_active_within_days: 7, app_event: 'read_story' }],
    ]
    let grid: SegmentFilters[] = [{ ...ACTIVE }]
    for (const options of choices) grid = grid.flatMap((g) => options.map((o) => ({ ...g, ...o })))
    expect(grid.length).toBe(3 * 3 * 3 * 3 * 2 * 4 * 3 * 4 * 4)

    const byLabel = new Map<string, string>()
    for (const filters of grid) {
      const label = segmentLabel(filters)
      const key = searchKey(filters)
      const earlier = byLabel.get(label)
      if (earlier !== undefined && earlier !== key) expect.fail(`"${label}" names both ${earlier} and ${key}`)
      byLabel.set(label, key)
      for (const word of RETIRED) if (word.test(label)) expect.fail(`"${label}" uses a retired word (${word})`)
    }
    expect(byLabel.size).toBe(grid.length)
  })
})
