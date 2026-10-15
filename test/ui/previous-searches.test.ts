import { afterEach, describe, expect, it } from 'vitest'
import type { SegmentFilters } from '../../shared/segment-filters'
import { JOY, OWN_ACCOUNT } from '../helpers/shared-ids'
import {
  BRIEF_EXAMPLE,
  browserStore,
  clearSearches,
  MAX_PREVIOUS_SEARCHES,
  readSearches,
  recordSearch,
  type SearchStore,
  searchKey,
  STORAGE_KEY,
  visibleSearches,
} from '../../src/previous-searches'

// T-SEG-4 (08; 09 D-69): Previous searches keep the last 5 echoed filter
// objects in this browser and nothing else. Each filter object is canonical, the shape POST
// /api/segments/preview echoes (shared/segment-filters.ts), with real values (09 D-47): sources
// from subscribers.csv, /shadrachs-picks from web_events.csv, the spec's windows.

/** An in-memory Storage: the test's stand-in for localStorage, which workerd does not have. */
class MemoryStore implements SearchStore {
  readonly data = new Map<string, string>()
  writes = 0
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.writes++
    this.data.set(key, value)
  }
  removeItem(key: string) {
    this.writes++
    this.data.delete(key)
  }
}

/** Storage that throws on every call, as Safari private mode and blocked site data do. */
const THROWING: SearchStore = {
  getItem: () => {
    throw new DOMException('blocked', 'SecurityError')
  },
  setItem: () => {
    throw new DOMException('quota', 'QuotaExceededError')
  },
  removeItem: () => {
    throw new DOMException('blocked', 'SecurityError')
  },
}

const ACTIVE: SegmentFilters = { status: ['active'], include_never_opened: false, has_app: null }
const SEARCHES: SegmentFilters[] = [
  { ...ACTIVE, signed_up_within_days: 30 },
  { ...ACTIVE, source: ['instagram'], went_cold: '2026-08' },
  { ...ACTIVE, engagement_gte: 50 },
  { ...ACTIVE, site_visit_within_days: 30 },
  { ...ACTIVE, site_visit_page: '/shadrachs-picks' },
  { ...ACTIVE, app_active_within_days: 7, app_event: 'read_story' },
]

const stored = (store: MemoryStore) => JSON.parse(store.getItem(STORAGE_KEY) ?? 'null') as unknown

describe('T-SEG-4 Previous searches', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
  })

  it('records newest first, moves a repeat to the top and keeps 5', () => {
    const store = new MemoryStore()
    expect(readSearches(store)).toEqual([])
    recordSearch(SEARCHES[0], store)
    recordSearch(SEARCHES[1], store)
    expect(readSearches(store)).toEqual([SEARCHES[1], SEARCHES[0]])

    // A repeat (same canonical filters, even with keys written in another order) moves to the top.
    const reordered = Object.fromEntries(Object.entries(SEARCHES[0]).reverse()) as unknown as SegmentFilters
    expect(recordSearch(reordered, store).map(searchKey)).toEqual([SEARCHES[0], SEARCHES[1]].map(searchKey))
    // The repeat replaced its older copy in storage too, not only in what a read shows.
    expect((stored(store) as { items: unknown[] }).items.length).toBe(2)

    for (const s of SEARCHES) recordSearch(s, store)
    const kept = readSearches(store)
    expect(kept.length).toBe(MAX_PREVIOUS_SEARCHES)
    expect(kept).toEqual([...SEARCHES].reverse().slice(0, 5))
  })

  it('a stored duplicate (same filters, one in FILTER_KEYS order and one with its keys reversed) reads as one, shows as one row, and a later recordSearch keeps one copy', () => {
    const store = new MemoryStore()
    const reversed = Object.fromEntries(Object.entries(SEARCHES[0]).reverse()) as unknown as SegmentFilters
    store.setItem(STORAGE_KEY, JSON.stringify({ v: 1, items: [{ filters: SEARCHES[0] }, { filters: reversed }] }))
    expect(readSearches(store)).toEqual([SEARCHES[0]])
    const rows = visibleSearches(readSearches(store))
    expect(rows.filter((r) => r.key === searchKey(SEARCHES[0]))).toHaveLength(1)
    recordSearch(SEARCHES[1], store)
    expect(stored(store)).toEqual({ v: 1, items: [{ filters: SEARCHES[1] }, { filters: SEARCHES[0] }] })
  })

  it('reads at most 5, even when storage holds more', () => {
    const store = new MemoryStore()
    store.setItem(STORAGE_KEY, JSON.stringify({ v: 1, items: [...SEARCHES, BRIEF_EXAMPLE].map((filters) => ({ filters })) }))
    expect(readSearches(store)).toEqual(SEARCHES.slice(0, MAX_PREVIOUS_SEARCHES))
  })

  it('stores exactly {v:1,items:[{filters}]}: no rows, counts, timestamps or emails', () => {
    const store = new MemoryStore()
    for (const s of SEARCHES) recordSearch(s, store)
    expect([...store.data.keys()]).toEqual([STORAGE_KEY])
    const json = store.getItem(STORAGE_KEY) ?? ''
    expect(json).not.toContain('@')
    expect(stored(store)).toEqual({ v: 1, items: [...SEARCHES].reverse().slice(0, 5).map((filters) => ({ filters })) })
    const body = stored(store) as { v: number; items: object[] }
    expect(Object.keys(body)).toEqual(['v', 'items'])
    for (const item of body.items) expect(Object.keys(item)).toEqual(['filters'])
  })

  it('clear forgets every stored search; the example stays', () => {
    const store = new MemoryStore()
    recordSearch(SEARCHES[0], store)
    clearSearches(store)
    expect(store.getItem(STORAGE_KEY)).toBeNull()
    expect(readSearches(store)).toEqual([])
    expect(visibleSearches(readSearches(store))).toEqual([{ filters: BRIEF_EXAMPLE, key: searchKey(BRIEF_EXAMPLE), example: true }])
  })

  it('throwing or missing storage gives an empty list and never throws', () => {
    expect(readSearches(THROWING)).toEqual([])
    expect(() => recordSearch(SEARCHES[0], THROWING)).not.toThrow()
    expect(() => clearSearches(THROWING)).not.toThrow()
    expect(recordSearch(SEARCHES[0], null)).toEqual([])
    expect(readSearches(null)).toEqual([])

    // The localStorage accessor itself can throw (blocked site data): no store, no exception.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
    expect(browserStore()).toBeNull()
    expect(readSearches()).toEqual([])
    expect(visibleSearches(readSearches()).map((r) => r.example)).toEqual([true])
  })

  it('drops a stored item whose integer-typed key holds a non-integer number (M31: Number.isInteger, not typeof value === "number")', () => {
    const store = new MemoryStore()
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        items: [
          { filters: { ...ACTIVE, days_since_open_gte: 2.5 } },
          { filters: { ...ACTIVE, engagement_gte: 50.5 } },
          { filters: SEARCHES[3] },
        ],
      }),
    )
    expect(readSearches(store)).toEqual([SEARCHES[3]])
  })

  it('drops a stored item whose source holds a PII-shaped value (email, %40-encoded email or a raw id), and recordSearch never writes one (09 D-69 #6 defense in depth)', () => {
    const store = new MemoryStore()
    const encodedJoy = JOY.replace('@', '%40')
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        items: [
          { filters: { ...ACTIVE, source: [JOY] } },
          { filters: { ...ACTIVE, source: [encodedJoy] } },
          { filters: { ...ACTIVE, source: [OWN_ACCOUNT] } },
          { filters: SEARCHES[3] },
        ],
      }),
    )
    expect(readSearches(store)).toEqual([SEARCHES[3]])

    const writesBefore = store.writes
    expect(recordSearch({ ...ACTIVE, source: [JOY] }, store)).toEqual([SEARCHES[3]])
    expect(recordSearch({ ...ACTIVE, source: [encodedJoy] }, store)).toEqual([SEARCHES[3]])
    expect(recordSearch({ ...ACTIVE, source: [OWN_ACCOUNT] }, store)).toEqual([SEARCHES[3]])
    expect(store.writes).toBe(writesBefore)
  })

  it(
    'drops a stored item whose source is non-canonical, whatever shape it spells (a double-%40 email, an id glued ' +
      "to a word char, a bare known local part, or just an ordinary non-canonical word), and recordSearch never " +
      'writes one (09 D-69 #6: the schema\'s CANONICAL_SOURCES enum, checked by meetsSchema, not pattern ' +
      "matching each PII shape, is what closes this)",
    () => {
      const store = new MemoryStore()
      const doubleEncodedJoy = JOY.replace('@', '%2540')
      const gluedId = `x${OWN_ACCOUNT}` // xu_ceed5f12: RAW_ID_REGEX's \b never fires mid-word
      const bareLocalPart = 'joy.hall830' // a known local part, no "@" at all
      const nonCanonicalWord = 'tiktok'
      const badSources = [doubleEncodedJoy, gluedId, bareLocalPart, nonCanonicalWord]
      store.setItem(
        STORAGE_KEY,
        JSON.stringify({
          v: 1,
          items: [...badSources.map((source) => ({ filters: { ...ACTIVE, source: [source] } })), { filters: SEARCHES[3] }],
        }),
      )
      expect(readSearches(store)).toEqual([SEARCHES[3]])

      const writesBefore = store.writes
      for (const source of badSources) {
        expect(recordSearch({ ...ACTIVE, source: [source] }, store)).toEqual([SEARCHES[3]])
      }
      expect(store.writes).toBe(writesBefore)
    },
  )

  it('every key meets its whole schema rule, not only source: PII or free text in went_cold, site_visit_page, status or app_event, a mixed source list and an out-of-range number are dropped, and recordSearch never writes them (09 D-69 #6)', () => {
    const store = new MemoryStore()
    // Typed loosely on purpose: these are what a hand-edited copy or a bad caller could hold.
    const bad = [
      { ...ACTIVE, went_cold: JOY }, // pattern
      { ...ACTIVE, went_cold: JOY.replace('@', '%40') },
      { ...ACTIVE, went_cold: 'august' }, // free text, no PII shape
      { ...ACTIVE, site_visit_page: `/${OWN_ACCOUNT}` },
      { ...ACTIVE, site_visit_page: '/Shadrachs-Picks' }, // upper case breaks the pattern
      { ...ACTIVE, status: [JOY.replace('@', '%40')] }, // items.enum
      { ...ACTIVE, source: ['instagram', 'tiktok'] }, // every member, not some
      { ...ACTIVE, app_event: 'purchase' }, // enum
      { ...ACTIVE, engagement_gte: 101 }, // maximum
      { ...ACTIVE, signed_up_within_days: 0 }, // minimum
    ] as unknown as SegmentFilters[]
    store.setItem(STORAGE_KEY, JSON.stringify({ v: 1, items: [...bad.map((filters) => ({ filters })), { filters: SEARCHES[3] }] }))
    expect(readSearches(store)).toEqual([SEARCHES[3]])
    const writesBefore = store.writes
    for (const filters of bad) expect(recordSearch(filters, store)).toEqual([SEARCHES[3]])
    expect(store.writes).toBe(writesBefore)
  })

  it('drops bad JSON, another version, an unknown key, a wrong type or a missing echoed key, and the next write replaces them', () => {
    const store = new MemoryStore()
    for (const raw of ['{', '"x"', JSON.stringify({ v: 2, items: [{ filters: SEARCHES[0] }] }), JSON.stringify({ v: 1 })]) {
      store.setItem(STORAGE_KEY, raw)
      expect(readSearches(store), raw).toEqual([])
    }
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        items: [
          { filters: { ...SEARCHES[0], pages_viewed: 3 } },
          { filters: { ...SEARCHES[1], source: 'instagram' } },
          { filters: { ...SEARCHES[2], engagement_gte: '50' } },
          { filters: SEARCHES[3], count: 935 },
          { filters: { include_never_opened: false, has_app: null } },
          // Not canonical: an echo always holds include_never_opened and has_app. Kept, the first
          // would show beside the example row as a near-duplicate with a different key.
          { filters: { status: BRIEF_EXAMPLE.status, source: BRIEF_EXAMPLE.source, days_since_open_gte: BRIEF_EXAMPLE.days_since_open_gte, include_never_opened: true } },
          { filters: { status: ['active'], has_app: null } },
          { filters: SEARCHES[4] },
        ],
      }),
    )
    expect(readSearches(store)).toEqual([SEARCHES[4]])
    expect(visibleSearches(readSearches(store)).filter((r) => r.example)).toHaveLength(1)
    recordSearch(SEARCHES[5], store)
    expect(stored(store)).toEqual({ v: 1, items: [{ filters: SEARCHES[5] }, { filters: SEARCHES[4] }] })
  })

  it("shows the brief's example last when absent, never twice, and never writes it", () => {
    const store = new MemoryStore()
    expect(visibleSearches(readSearches(store))).toEqual([{ filters: BRIEF_EXAMPLE, key: searchKey(BRIEF_EXAMPLE), example: true }])

    recordSearch(SEARCHES[0], store)
    const writes = store.writes
    const rows = visibleSearches(readSearches(store))
    expect(rows.map((r) => [r.key, r.example])).toEqual([
      [searchKey(SEARCHES[0]), false],
      [searchKey(BRIEF_EXAMPLE), true],
    ])
    expect(store.writes).toBe(writes)
    expect(readSearches(store)).toEqual([SEARCHES[0]])

    // Once run, the stored copy takes its place at the top and keeps the tag: one example row.
    recordSearch({ ...BRIEF_EXAMPLE }, store)
    const after = visibleSearches(readSearches(store))
    expect(after.map((r) => [r.key, r.example])).toEqual([
      [searchKey(BRIEF_EXAMPLE), true],
      [searchKey(SEARCHES[0]), false],
    ])

    // With 5 stored searches and none of them the example, it is a sixth row.
    for (const s of SEARCHES) recordSearch(s, store)
    expect(visibleSearches(readSearches(store)).length).toBe(MAX_PREVIOUS_SEARCHES + 1)
  })
})
