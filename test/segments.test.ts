import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { TODAY } from '../shared/config'
import { noOpenInDays } from '../shared/derive'
import { ingestSubscribers } from '../worker/ingest/subscribers'
import { SEGMENT_COLUMNS } from '../worker/segments/compile'
import { documentationIp, loginCookie } from './helpers/auth'
import { realCsvs, seedDatabase } from './helpers/seed'

// POST /api/segments/preview and /api/segments/export.csv (04 §/api/segments/preview,
// §/api/segments/export.csv; 02 §Defaults, §Derived, §Counts; 09 D-07, D-30, D-46).
// T-SEG-1..3 (08). The test D1 holds the real seed of data/*.csv (test/helpers/seed.ts).
// Expected numbers are 02 §Counts: the brief's preset is 177; 93 unsubscribed Instagram (T-SEG-2).
// The independent count re-runs the ingest pipeline over the ?raw CSV (normalize + dedupe) and
// filters in TypeScript with shared/derive.ts noOpenInDays, not with SQL.
// Inputs and where they come from:
// - source "Instagram" is the raw spelling in subscribers.csv (925 rows); the API folds it.
// - error-path inputs: status "unsubscribe" is a removal from a real value per 09 D-47 (the last
//   character of "unsubscribed" removed); filter key "pages_viewed" is not data at all but a
//   parked filter key named in 04 §/api/segments/preview, which this build must reject. Its value
//   16 is the "16 distinct pages" of 02 §Counts (web_events.csv); only the key is under test.
// - the source value "x') OR ('a'='a" is an injection probe string (08 T-SEG-3), not business data:
//   inlined as IN ('…') it would close the list and match every active subscriber; bound, it
//   matches nothing and never reaches sql_shape.

const PRESET = { source: ['instagram'], days_since_open_gte: 30, include_never_opened: true } as const
/** The 04 §/api/segments/export.csv column list, written out here rather than read from the code under test. */
const EXPORT_HEADER = ['email', 'status', 'source', 'signup_date', 'last_open_date', 'engagement_score', 'has_app']
const PRESET_COUNT = 177
const UNSUBSCRIBED_INSTAGRAM = 93
const INJECTION_PROBE = "x') OR ('a'='a"

interface PreviewBody {
  count: number
  hidden_unsubscribed: number
  rows: {
    email: string
    status: string
    source: string | null
    signup_date: string
    last_open_date: string | null
    engagement_score: number
    has_app: boolean
  }[]
  sql_shape: string
}

let cookie: string

beforeAll(async () => {
  await seedDatabase()
  cookie = await loginCookie()
})

/** A fresh documentation address per call keeps these tests off one EXPORT_LIMITER key. */
function post(path: string, body: unknown, headers: Record<string, string> = { cookie }): Promise<Response> {
  return SELF.fetch(`http://cdp.test/api/segments/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': documentationIp(), ...headers },
    body: JSON.stringify(body),
  })
}

async function preview(filters: unknown, limit?: number): Promise<PreviewBody> {
  const res = await post('preview', limit === undefined ? { filters } : { filters, limit })
  expect(res.status, await res.clone().text()).toBe(200)
  return res.json<PreviewBody>()
}

/** RFC 4180 records of an export, header first; fails on a quoted field (none occur in this data). */
async function exportRecords(filters: unknown): Promise<string[][]> {
  const res = await post('export.csv', { filters })
  expect(res.status, await res.clone().text()).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
  const text = await res.text()
  expect(text.endsWith('\r\n')).toBe(true)
  expect(text).not.toContain('"')
  return text
    .slice(0, -2)
    .split('\r\n')
    .map((line) => line.split(','))
}

/** The brief's rule over the ingested CSV, in TypeScript: status, canonical source, days_since_open >= N or never opened. */
function independentCount(status: readonly string[], includeNeverOpened: boolean = PRESET.include_never_opened): number {
  const { subscribers } = ingestSubscribers(realCsvs().subscribers)
  return [...subscribers.values()].filter(
    (s) =>
      status.includes(s.status) &&
      s.source !== null &&
      (PRESET.source as readonly string[]).includes(s.source) &&
      noOpenInDays(s.last_open_date, PRESET.days_since_open_gte, includeNeverOpened),
  ).length
}

describe('T-SEG-1 the brief preset matches 02 §Counts and an independent count', () => {
  it('returns 177, equal to the count computed from the raw CSV in TypeScript', async () => {
    const body = await preview(PRESET)
    expect(body.count).toBe(PRESET_COUNT)
    expect(independentCount(['active'])).toBe(PRESET_COUNT)
  })

  it('defaults status to active, binds every value and returns at most limit rows with emails', async () => {
    const body = await preview(PRESET)
    expect(body.rows).toHaveLength(100)
    expect(body.sql_shape).toContain('s.status IN (?)')
    expect(body.sql_shape).toContain('julianday(?) - julianday(last_open_date) >= ?')
    expect(body.sql_shape).not.toContain(TODAY)
    expect(body.sql_shape).not.toMatch(/instagram|'active'/)
    for (const row of body.rows) {
      expect(row.status).toBe('active')
      expect(row.source).toBe('instagram')
      expect(noOpenInDays(row.last_open_date, PRESET.days_since_open_gte, PRESET.include_never_opened)).toBe(true)
      expect(row.email).toContain('@')
      expect(typeof row.has_app).toBe('boolean')
    }
    expect((await preview(PRESET, 7)).rows).toHaveLength(7)
  })

  it('folds the raw spelling "Instagram" to the canonical source', async () => {
    expect((await preview({ ...PRESET, source: ['Instagram'] })).count).toBe(PRESET_COUNT)
  })

  it('without include_never_opened, never-openers are excluded', async () => {
    const withoutNever = await preview({ ...PRESET, include_never_opened: false })
    expect(withoutNever.count).toBe(independentCount(['active'], false))
    expect(withoutNever.count).toBeLessThan(PRESET_COUNT)
  })

  it('has_app true and false partition the segment', async () => {
    const withApp = await preview({ ...PRESET, has_app: true })
    const withoutApp = await preview({ ...PRESET, has_app: false })
    expect(withApp.count + withoutApp.count).toBe(PRESET_COUNT)
    expect(withApp.rows.every((r) => r.has_app)).toBe(true)
    expect(withoutApp.rows.every((r) => !r.has_app)).toBe(true)
  })
})

describe('T-SEG-2 hidden unsubscribed (02 §Defaults)', () => {
  // hidden_unsubscribed counts unsubscribed rows matching every other filter, so including
  // unsubscribed raises the count by exactly that number (08 T-SEG-2). On this data that is the
  // independent count below, not the 93 in 02 §Counts: 93 is every unsubscribed Instagram
  // subscriber, recency filter ignored (last test). See docs/ai-log.md 2026-10-13 — T3.
  it('equals the independent count of unsubscribed rows matching every other filter', async () => {
    const active = await preview(PRESET)
    expect(active.hidden_unsubscribed).toBe(independentCount(['unsubscribed']))
    expect(active.hidden_unsubscribed).toBe(55) // 02 §Counts, 09 D-51
  })

  it('adding unsubscribed to status raises the count by exactly hidden_unsubscribed', async () => {
    const active = await preview(PRESET)
    const both = await preview({ ...PRESET, status: ['active', 'unsubscribed'] })
    expect(both.count).toBe(active.count + active.hidden_unsubscribed)
    expect(both.hidden_unsubscribed).toBe(0)
  })

  it('the 93 of 02 §Counts is every unsubscribed Instagram subscriber, recency filter ignored', async () => {
    const body = await preview({ source: ['instagram'], status: ['unsubscribed'] })
    expect(body.count).toBe(UNSUBSCRIBED_INSTAGRAM)
  })
})

describe('T-SEG-3 export follows the segment and binds every value', () => {
  it('header is the exact 04 column list and every row carries a status', async () => {
    const [header, ...rows] = await exportRecords(PRESET)
    expect(header).toEqual(EXPORT_HEADER)
    expect([...SEGMENT_COLUMNS]).toEqual(EXPORT_HEADER)
    expect(rows).toHaveLength(PRESET_COUNT)
    for (const row of rows) {
      expect(row).toHaveLength(header.length)
      expect(row[1]).toBe('active')
      expect(['true', 'false']).toContain(row[6])
    }
  })

  it('an export with status active contains no unsubscribed rows; including them exports them', async () => {
    const [, ...activeRows] = await exportRecords({ ...PRESET, status: ['active'] })
    expect(activeRows.some((r) => r[1] === 'unsubscribed')).toBe(false)
    const [, ...allRows] = await exportRecords({ ...PRESET, status: ['active', 'unsubscribed'] })
    expect(allRows.filter((r) => r[1] === 'unsubscribed')).toHaveLength(independentCount(['unsubscribed']))
  })

  it('a source value containing a single quote returns 0 rows with no error', async () => {
    const body = await preview({ source: [INJECTION_PROBE] })
    expect(body.count).toBe(0)
    expect(body.rows).toEqual([])
    expect(body.sql_shape).toContain('s.source IN (?)')
    expect(body.sql_shape).not.toContain("'a'='a")
    // Inlined, the probe would match every active subscriber; that set is not empty.
    expect((await preview({})).count).toBeGreaterThan(0)
    const [header, ...rows] = await exportRecords({ source: [INJECTION_PROBE] })
    expect(header).toEqual(EXPORT_HEADER)
    expect(rows).toEqual([])
  })
})

describe('segment request errors', () => {
  it('an unknown filter key is 400 invalid_filters', async () => {
    for (const path of ['preview', 'export.csv']) {
      const res = await post(path, { filters: { ...PRESET, pages_viewed: 16 } })
      expect(res.status).toBe(400)
      const body = await res.json<{ error: string; details: string[] }>()
      expect(body.error).toBe('invalid_filters')
      expect(body.details).toEqual(['unknown filter: pages_viewed'])
    }
  })

  it('a non-canonical status value is 400 invalid_filters', async () => {
    const res = await post('preview', { filters: { ...PRESET, status: ['unsubscribe'] } })
    expect(res.status).toBe(400)
    expect((await res.json<{ error: string }>()).error).toBe('invalid_filters')
  })

  it('no cookie is 401 on both routes', async () => {
    for (const path of ['preview', 'export.csv']) {
      const res = await post(path, { filters: PRESET }, {})
      expect(res.status).toBe(401)
      expect((await res.json<{ error: string }>()).error).toBe('unauthorized')
    }
  })
})
