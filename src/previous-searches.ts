// Previous searches on /segments: the last 5 filter objects this
// browser previewed, newest first, exactly as the server echoed them (the canonical `filters` of
// the preview response). Only the filters are kept: never rows, emails, counts or timestamps, so a
// count shown later always comes from a fresh preview, never a stale copy. Stored as
// `{"v":1,"items":[{"filters":{…}}]}` under one localStorage key. Storage can throw (private
// mode, blocked site data), so every read and write is guarded the way src/theme.ts guards the
// theme, and the page works without it. Bad JSON or another `v` reads as empty; an item with a
// key outside FILTER_KEYS (or a value of the wrong type), or one missing a key every echo holds, is
// dropped; both are overwritten by the next write.
// The brief's example is never stored by rendering: visibleSearches adds it as the last row
// whenever no stored item has its canonical key, so a new browser sees it first and Clear never
// removes it.

import { FILTER_KEYS, FILTER_SCHEMA, type FilterKey, type SegmentFilters } from '../shared/segment-filters'

export const STORAGE_KEY = 'tpo-cdp-previous-searches'
/** How many previewed filter objects are kept (the example row may add a sixth visible row). */
export const MAX_PREVIOUS_SEARCHES = 5

/** The brief's segment example (177 active on the seed): Instagram, active, no open in 30 days including never-opened. */
export const BRIEF_EXAMPLE: SegmentFilters = {
  status: ['active'],
  source: ['instagram'],
  days_since_open_gte: 30,
  include_never_opened: true,
  has_app: null,
}

/** The part of Storage this module uses; tests pass their own. */
export type SearchStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface PreviousSearch {
  filters: SegmentFilters
  /** The canonical key: the dedupe key and the React key. */
  key: string
  /** Tagged "the brief's example" on screen. */
  example: boolean
}

/**
 * The canonical key of a filter object: its JSON with keys in FILTER_KEYS order, so the same
 * echoed filters always give the same key whatever order a stored copy wrote them in.
 */
export function searchKey(filters: SegmentFilters): string {
  return JSON.stringify(filters, [...FILTER_KEYS])
}

/** The browser's localStorage, or null when reaching it throws (the accessor itself can throw). */
export function browserStore(): SearchStore | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isFilterKey = (k: string): k is FilterKey => (FILTER_KEYS as readonly string[]).includes(k)

/**
 * A value meets every rule FILTER_SCHEMA declares for its key: JSON type, enum, items.enum,
 * pattern, minimum and maximum. Every string key is an enum or a pattern, so a stored
 * or recorded copy can never hold an email, a `%40` one, a raw id or any free text, whichever key
 * it sits in; the server enforces the same schema before it echoes.
 */
function meetsSchema(key: FilterKey, value: unknown): boolean {
  const rule = FILTER_SCHEMA[key]
  return [rule.type].flat().some((t) => {
    if (t === 'array') {
      return (
        Array.isArray(value) &&
        value.length >= (rule.minItems ?? 1) &&
        value.every((v) => typeof v === 'string' && (rule.items === undefined || rule.items.enum.includes(v)))
      )
    }
    if (t === 'integer') {
      return (
        Number.isInteger(value) &&
        (rule.minimum === undefined || (value as number) >= rule.minimum) &&
        (rule.maximum === undefined || (value as number) <= rule.maximum)
      )
    }
    if (t === 'string') {
      return (
        typeof value === 'string' &&
        (rule.enum === undefined || rule.enum.includes(value)) &&
        (rule.pattern === undefined || new RegExp(rule.pattern).test(value))
      )
    }
    if (t === 'null') return value === null
    return typeof value === t
  })
}

/** The keys every echo holds (the server always returns them), so a stored copy without one is not canonical. */
const ECHOED_KEYS = ['status', 'include_never_opened', 'has_app'] as const satisfies readonly FilterKey[]

/**
 * A stored item this page can name and re-run: exactly `{filters}`, every key in FILTER_KEYS
 * meeting its whole schema rule (`meetsSchema`, which leaves no key able to hold an email, a `%40`
 * one or a raw id) and every key an echo always holds (ECHOED_KEYS). Anything else is dropped on read, so a hand-edited copy
 * (BRIEF_EXAMPLE without has_app, say) never shows as a near-duplicate. recordSearch applies the
 * same rule before it writes.
 */
function storedFilters(item: unknown): SegmentFilters | null {
  if (!isRecord(item) || Object.keys(item).length !== 1 || !isRecord(item.filters)) return null
  const f = item.filters
  for (const [key, value] of Object.entries(f)) {
    if (!isFilterKey(key) || !meetsSchema(key, value)) return null
  }
  if (ECHOED_KEYS.some((key) => f[key] === undefined)) return null
  const filters = f as unknown as SegmentFilters
  return filters
}

/** The stored searches, newest first; [] when storage is missing, throws, or holds anything unexpected. */
export function readSearches(store: SearchStore | null = browserStore()): SegmentFilters[] {
  if (store === null) return []
  let raw: string | null
  try {
    raw = store.getItem(STORAGE_KEY)
  } catch {
    return []
  }
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.items)) return []
  const seen = new Set<string>()
  const out: SegmentFilters[] = []
  for (const item of parsed.items) {
    const filters = storedFilters(item)
    if (filters === null) continue
    const key = searchKey(filters)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(filters)
  }
  return out.slice(0, MAX_PREVIOUS_SEARCHES)
}

function write(store: SearchStore, items: SegmentFilters[]): void {
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ v: 1, items: items.map((filters) => ({ filters })) }))
  } catch {
    // not remembered; the preview itself already ran
  }
}

/**
 * Records the filters a 200 preview echoed: moves a repeat to the top, keeps the newest 5.
 * Returns the stored list as it now reads (unchanged when storage is unavailable or `filters`
 * fails the same rule a stored copy must pass, `storedFilters`: the server's schema check means a
 * real echo always passes, but recordSearch takes a typed SegmentFilters directly and must not
 * trust the type alone).
 */
export function recordSearch(filters: SegmentFilters, store: SearchStore | null = browserStore()): SegmentFilters[] {
  if (store === null) return []
  if (storedFilters({ filters }) === null) return readSearches(store)
  const key = searchKey(filters)
  const items = [filters, ...readSearches(store).filter((f) => searchKey(f) !== key)].slice(0, MAX_PREVIOUS_SEARCHES)
  write(store, items)
  return readSearches(store)
}

/** Forgets every stored search in this browser; the brief's example stays (it is never stored). */
export function clearSearches(store: SearchStore | null = browserStore()): void {
  if (store === null) return
  try {
    store.removeItem(STORAGE_KEY)
  } catch {
    // nothing stored can be reached, so nothing shows either
  }
}

/** The rows to show: the stored searches, then the brief's example unless one of them is it. Pure. */
export function visibleSearches(stored: SegmentFilters[]): PreviousSearch[] {
  const exampleKey = searchKey(BRIEF_EXAMPLE)
  const rows = stored.map((filters) => {
    const key = searchKey(filters)
    return { filters, key, example: key === exampleKey }
  })
  if (!rows.some((r) => r.example)) rows.push({ filters: BRIEF_EXAMPLE, key: exampleKey, example: true })
  return rows
}
