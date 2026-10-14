import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { TOOL_SEEDS } from '../scripts/tool-seeds'
import { TODAY } from '../shared/config'
import { isNewSubscriber, noOpenInDays } from '../shared/derive'
import { CANONICAL_SOURCES, normalizeEmail } from '../shared/normalize'
import { JOY, OWN_ACCOUNT } from './helpers/shared-ids'
import { toApiError } from '../src/api-error'
import { BRIEF_EXAMPLE, readSearches, type SearchStore, searchKey, STORAGE_KEY } from '../src/previous-searches'
import { DEFAULT_FORM, fieldMessages, type Form, toFilters } from '../src/segment-form'
import { type PreviewRequest, previewAndRecord } from '../src/segment-preview'
import type { SegmentPreview } from '../src/types'
import { EMAIL_REGEX, RAW_ID_REGEX } from '../shared/pii'
import { FILTER_KEYS, FILTER_SCHEMA, type SegmentFilters } from '../shared/segment-filters'
import { inputSchemaProblems } from '../worker/assistant/gates/gate2-tool-authorizer'
import { respond } from '../worker/assistant/respond'
import { BUILTIN_HANDLERS } from '../worker/assistant/tools/builtin-handlers'
import { ingestSubscribers } from '../worker/ingest/subscribers'
import { compileModelSegment, compileSegment, parseFilters, SEGMENT_COLUMNS } from '../worker/segments/compile'
import { documentationIp, loginCookie } from './helpers/auth'
import { realCsvs, seedDatabase } from './helpers/seed'
import { eventIdPool, sendWebhook } from './helpers/webhook'

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
//   filter key this build must reject: 19 §5.7 dropped it from 04's parked list (site_visit_page
//   covers it), so it is now simply unknown, like every parked key (signup_between,
//   opened_within_days, site_visits_gte, going_cold_risk, email_domain). Its value 16 is the
//   "16 distinct pages" of 02 §Counts (web_events.csv); only the key is under test.
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
  filters: Record<string, unknown>
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

  it('a source value with a single quote is 400 invalid_filters (09 D-69 #6, 19 §0 F7): source is now a subset of CANONICAL_SOURCES, so it never reaches SQL at all', async () => {
    for (const path of ['preview', 'export.csv']) {
      const res = await post(path, { filters: { source: [INJECTION_PROBE] } })
      expect(res.status).toBe(400)
      const body = await res.json<{ error: string; details: string[] }>()
      expect(body.error).toBe('invalid_filters')
      expect(body.details).toEqual([`source values must be one of ${CANONICAL_SOURCES.join(', ')}`])
      expect(body.details.some((d) => d.includes(INJECTION_PROBE))).toBe(false)
    }
    // A canonical source stays bound, never inlined: the one remaining SQL-injection surface.
    const body = await preview({ source: ['instagram'] })
    expect(body.sql_shape).toContain('s.source IN (?)')
    expect(body.count).toBeGreaterThan(0)
  })

  it('every canonical source together is exactly CANONICAL_SOURCES.length unique values and still passes', async () => {
    const res = await post('preview', { filters: { source: [...CANONICAL_SOURCES] } })
    expect(res.status).toBe(200)
    expect((await res.json<{ filters: SegmentFilters }>()).filters.source).toEqual([...CANONICAL_SOURCES].sort())
  })

  it('a source array with more distinct values than CANONICAL_SOURCES.length is 400 invalid_filters before the membership check even runs (09 D-69 #6: caps the bound SQL variables)', async () => {
    // Eight distinct, non-blank, non-canonical values (none of them INJECTION_PROBE, so this is a
    // different code path from the single-value membership rejection above): the cap problem fires
    // on their count alone, naming no value and never reaching the membership check's problem.
    const tooMany = Array.from({ length: CANONICAL_SOURCES.length + 1 }, (_, i) => `probe-source-${i}`)
    const res = await post('preview', { filters: { source: tooMany } })
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string; details: string[] }>()
    expect(body.error).toBe('invalid_filters')
    expect(body.details).toEqual([`source must name at most ${CANONICAL_SOURCES.length} sources`])
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

  it('an email-shaped unknown top-level body key is redacted in the response and never reaches console.warn raw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await post('preview', { filters: PRESET, [JOY]: true })
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string; details: string[] }>()
    expect(body.details).toEqual(['unknown field: [email]'])
    expect(body.details.some((d) => d.includes('@'))).toBe(false)
    for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain(JOY)
    warn.mockRestore()
  })

  it('an email-shaped unknown filter key is redacted in the response and never reaches console.warn raw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const path of ['preview', 'export.csv']) {
      const res = await post(path, { filters: { [JOY]: 1 } })
      expect(res.status).toBe(400)
      const body = await res.json<{ error: string; details: string[] }>()
      expect(body.details).toEqual(['unknown filter: [email]'])
      expect(body.details.some((d) => d.includes('@'))).toBe(false)
    }
    for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain(JOY)
    warn.mockRestore()
  })

  it('a %40-encoded unknown filter key and a raw id unknown body field are redacted in the response and never reach console.warn raw (09 D-70 item 1, fixer round 2)', async () => {
    const encodedJoy = JOY.replace('@', '%40')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const path of ['preview', 'export.csv']) {
      const res = await post(path, { filters: { [encodedJoy]: 1 } })
      expect(res.status).toBe(400)
      const body = await res.json<{ error: string; details: string[] }>()
      expect(body.details).toEqual(['unknown filter: [email]'])
      expect(body.details.some((d) => d.includes('%40') || d.includes('@'))).toBe(false)
    }
    // OWN_ACCOUNT (u_ceed5f12, a real app user id, 09 D-47) spelled as an unknown top-level field.
    const res2 = await post('preview', { filters: PRESET, [OWN_ACCOUNT]: true })
    expect(res2.status).toBe(400)
    const body2 = await res2.json<{ error: string; details: string[] }>()
    expect(body2.details).toEqual(['unknown field: [id]'])
    expect(body2.details.some((d) => d.includes(OWN_ACCOUNT))).toBe(false)
    for (const call of warn.mock.calls) {
      const logged = JSON.stringify(call)
      expect(logged).not.toContain(encodedJoy)
      expect(logged).not.toContain(JOY)
      expect(logged).not.toContain(OWN_ACCOUNT)
    }
    warn.mockRestore()
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

// ── 09 D-69: the five new filters (19 §3–§6; 08 T-SEG-6..12) ──────────────────────────────
// Expected numbers are 19 §3 / §6 (to be listed in 02 §Counts). Each one is also computed here
// independently of the SQL under test: subscribers come from the ingest pipeline over the ?raw CSV
// (as T-SEG-1), site visits are read straight from web_events.csv by the 02 §Linking rule (a
// visitor's events belong to the email on its /subscribe row), and the cold date, the new-subscriber
// window and engagement_score are written out by hand from 02 §Derived rather than imported.
// Inputs and where they come from:
// - pages "/shadrachs-picks" and the 16 pages are web_events.csv values; event names are the four
//   app events (R4.3); months are 2026-08 (02 §Counts "went_cold_in(2026-08)") and 2026-09 (TODAY's).
// - error-path inputs (09 D-47, edits of real values): "2026-10" is TODAY's month + 1; "August" is
//   2026-08 written as the month's name; a page made from a real email (julia.evans230's) or a real
//   user id (u_2b6447a3) behind "/", and a real page with its leading "/" removed; "purchase" is
//   04 §Webhook's own example of a rejected event name (T-WH-4 uses it too); 0 and 3651 are one
//   past each end of 1–3650, -1 and 101 of 0–100, and 2.5 a non-whole N (numbers, not business data).
// - webhooks (09 D-11): signed brief-shaped events for real app_users.csv ids — u_2b6447a3
//   (julia.evans230, active), u_ceed5f12 (joy.hall830, active), u_f2411d1c (john.turner61,
//   active), u_baba14aa (daniel.hill389, unsubscribed). Devices are `d_` + the user id's hex;
//   event ids come from eventIdPool(). Times: the brief's 2026-09-28T14:22:05Z, and for the "after
//   TODAY" case the wall clock, the time a live sender stamps (T-WH-7 does the same).

const DAY_MS = 86_400_000
const JULIA = 'julia.evans230@gmail.com'
const BRIEF_TS = '2026-09-28T14:22:05Z'

/** `date` minus `n` days, written out with Date.UTC (not derive.ts). */
function minusDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10)
}

const daysFrom = (from: string, to: string) => (Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / DAY_MS

interface CsvSubscriber {
  email: string
  status: string
  source: string | null
  signup_date: string
  last_open_date: string | null
}

function csvSubscribers(): CsvSubscriber[] {
  return [...ingestSubscribers(realCsvs().subscribers).subscribers.values()].map((s) => ({
    email: s.email_norm,
    status: s.status,
    source: s.source,
    signup_date: s.signup_date,
    last_open_date: s.last_open_date,
  }))
}

/** Every web_events.csv row as (linked email or null, page, date), by the /subscribe link rule. */
function csvVisits(): { email: string | null; page: string; date: string }[] {
  const csv = realCsvs().web_events
  const col = (name: string) => {
    const i = csv.header.indexOf(name)
    if (i < 0) throw new Error(`web_events.csv has no ${name} column`)
    return i
  }
  const [visitor, page, timestamp, email] = [col('visitor_id'), col('page'), col('timestamp'), col('email')]
  const emailOf = new Map<string, string>()
  for (const row of csv.rows) {
    if (row[page].trim() !== '/subscribe' || row[email].trim() === '') continue
    const norm = normalizeEmail(row[email])
    if (norm === null) throw new Error('web_events.csv: a /subscribe email does not normalize')
    emailOf.set(row[visitor].trim(), norm)
  }
  return csv.rows.map((row) => ({ email: emailOf.get(row[visitor].trim()) ?? null, page: row[page].trim(), date: row[timestamp].trim().slice(0, 10) }))
}

/** Emails with a site visit matching `keep`. */
function visitedBy(keep: (v: { page: string; date: string }) => boolean): Set<string> {
  return new Set(csvVisits().flatMap((v) => (v.email !== null && keep(v) ? [v.email] : [])))
}

/** 02 §Derived cold_since, by hand: (last_open_date ?? signup_date) + 30 days. */
const coldSinceOf = (s: CsvSubscriber) => minusDays(s.last_open_date ?? s.signup_date, -30)

/** 02 §Derived engagement_score, by hand, at seed (no app events): recency 50 + site visits 25. */
function engagementOf(s: CsvSubscriber, visitsLast30: Map<string, number>, appEventsLast30 = 0): number {
  const recency = s.last_open_date === null ? 0 : 50 * Math.max(0, 1 - Math.max(0, daysFrom(s.last_open_date, TODAY)) / 30)
  return Math.round(recency + 25 * Math.min(1, appEventsLast30 / 10) + 25 * Math.min(1, (visitsLast30.get(s.email) ?? 0) / 5))
}

function visitsLast30d(): Map<string, number> {
  const from = minusDays(TODAY, 30)
  const counts = new Map<string, number>()
  for (const v of csvVisits()) {
    if (v.email !== null && v.date >= from && v.date <= TODAY) counts.set(v.email, (counts.get(v.email) ?? 0) + 1)
  }
  return counts
}

/** Active and unsubscribed counts of the CSV subscribers matching `keep`. */
function split(keep: (s: CsvSubscriber) => boolean): { active: number; hidden: number } {
  const matched = csvSubscribers().filter(keep)
  return { active: matched.filter((s) => s.status === 'active').length, hidden: matched.filter((s) => s.status === 'unsubscribed').length }
}

const isInstagram = (s: CsvSubscriber) => s.source === 'instagram'
const presetMatch = (s: CsvSubscriber) => isInstagram(s) && noOpenInDays(s.last_open_date, PRESET.days_since_open_gte, PRESET.include_never_opened)

async function expectInvalid(filters: unknown, problem: string): Promise<void> {
  const res = await post('preview', { filters })
  expect(res.status, JSON.stringify(filters)).toBe(400)
  const body = await res.json<{ error: string; details: string[] }>()
  expect(body.error).toBe('invalid_filters')
  expect(body.details.join(' | ')).toContain(problem)
}

describe('T-SEG-6 the preview echoes the canonical filters', () => {
  it('folds and dedupes sources, sorts lists and applies the defaults', async () => {
    expect((await preview({ source: ['Instagram', 'instagram'] })).filters).toEqual({
      status: ['active'],
      source: ['instagram'],
      include_never_opened: false,
      has_app: null,
    })
    expect((await preview({})).filters).toEqual({ status: ['active'], include_never_opened: false, has_app: null })
    const both = await preview({ status: ['unsubscribed', 'active', 'active'], source: ['Referral', 'facebook', 'Facebook'] })
    expect(both.filters).toEqual({ status: ['active', 'unsubscribed'], source: ['facebook', 'referral'], include_never_opened: false, has_app: null })
  })

  it('equal bodies give byte-equal echoes, keys in FILTER_KEYS order, whatever order they were sent in', async () => {
    const a = await preview({ app_event: 'read_story', site_visit_page: '/shadrachs-picks', went_cold: 'any', ...PRESET })
    const b = await preview({ ...PRESET, went_cold: 'any', site_visit_page: '/shadrachs-picks', app_event: 'read_story', has_app: null })
    expect(JSON.stringify(a.filters)).toBe(JSON.stringify(b.filters))
    expect(Object.keys(a.filters)).toEqual(FILTER_KEYS.filter((k) => k in a.filters))
    // The echo is itself canonical: sending it back returns it unchanged.
    expect((await preview(a.filters)).filters).toEqual(a.filters)
  })

  it('the brief\'s preset echoes as BRIEF_EXAMPLE, so Previous searches never shows the example twice (19 §2)', async () => {
    // visibleSearches adds the example row unless a stored echo has BRIEF_EXAMPLE's key; the page
    // stores the server's echo, so the echo of the preset, sent bare or as the row sends it, must be it.
    for (const sent of [PRESET, BRIEF_EXAMPLE, { ...PRESET, source: ['Instagram'], status: ['active'] }]) {
      expect(searchKey((await preview(sent)).filters as unknown as SegmentFilters), JSON.stringify(sent)).toBe(searchKey(BRIEF_EXAMPLE))
    }
  })

  it('include_never_opened without days is false; engagement 0 and 100 are dropped as no filter', async () => {
    expect((await preview({ include_never_opened: true })).filters).toEqual({ status: ['active'], include_never_opened: false, has_app: null })
    const full = await preview({ engagement_gte: 0, engagement_lte: 100 })
    expect(full.filters).toEqual({ status: ['active'], include_never_opened: false, has_app: null })
    expect(full.count).toBe((await preview({})).count)
  })
})

describe('T-SEG-7 signed up in the last N days', () => {
  it('30 days = the new_subscriber count, 889 active and 95 hidden, from the CSV', async () => {
    const expected = split((s) => s.signup_date >= minusDays(TODAY, 30) && s.signup_date <= TODAY)
    expect(expected).toEqual({ active: 889, hidden: 95 })
    expect(split((s) => isNewSubscriber(s.signup_date))).toEqual(expected)
    const body = await preview({ signed_up_within_days: 30 })
    expect({ active: body.count, hidden: body.hidden_unsubscribed }).toEqual(expected)
    for (const row of body.rows) expect(row.signup_date >= '2026-08-29').toBe(true)
  })

  it('binds the window start 2026-08-29 and TODAY; neither is in the SQL text', () => {
    const compiled = compileSegment(parseFilters({ signed_up_within_days: 30 }))
    expect(compiled.params).toEqual(['active', '2026-08-29', TODAY])
    expect(compiled.sql_shape).toContain('s.signup_date BETWEEN ? AND ?')
    expect(compiled.sql_shape).not.toMatch(/2026-/)
  })

  it('a different N is a different window, counted the same way', async () => {
    const expected = split((s) => s.signup_date >= minusDays(TODAY, 7) && s.signup_date <= TODAY)
    const body = await preview({ signed_up_within_days: 7 })
    expect({ active: body.count, hidden: body.hidden_unsubscribed }).toEqual(expected)
    expect(body.count).toBeLessThan(889)
  })

  it('0 and 3651 are 400 invalid_filters', async () => {
    await expectInvalid({ signed_up_within_days: 0 }, 'signed_up_within_days must be a whole number from 1 to 3650')
    await expectInvalid({ signed_up_within_days: 3651 }, 'signed_up_within_days must be a whole number from 1 to 3650')
    await expectInvalid({ signed_up_within_days: 2.5 }, 'signed_up_within_days')
  })
})

describe('T-SEG-8 went cold', () => {
  it('Instagram + went_cold 2026-08 = 46 active, 20 hidden, 66 across statuses (02 §Counts)', async () => {
    const expected = split((s) => isInstagram(s) && coldSinceOf(s).startsWith('2026-08') && coldSinceOf(s) <= TODAY)
    expect(expected).toEqual({ active: 46, hidden: 20 })
    const body = await preview({ source: ['instagram'], went_cold: '2026-08' })
    expect({ active: body.count, hidden: body.hidden_unsubscribed }).toEqual(expected)
    expect((await preview({ source: ['instagram'], went_cold: '2026-08', status: ['active', 'unsubscribed'] })).count).toBe(66)
  })

  it('the aggregate tool counts the same 46 for the last-month window', async () => {
    const out = await BUILTIN_HANDLERS.aggregate.run(env.DB, {
      metric: 'went_cold',
      source: ['instagram'],
      window_from: '2026-08-01',
      window_to: '2026-08-31',
    })
    expect(out.rows).toEqual([{ went_cold: 46 }])
  })

  it('TODAY\'s month counts only cold dates up to TODAY', async () => {
    const expected = split((s) => coldSinceOf(s).startsWith('2026-09') && coldSinceOf(s) <= TODAY)
    const body = await preview({ went_cold: '2026-09' })
    expect({ active: body.count, hidden: body.hidden_unsubscribed }).toEqual(expected)
    // Without the TODAY bound, 2026-09-29 and 2026-09-30 cold dates would count too; the data has some.
    expect(split((s) => coldSinceOf(s).startsWith('2026-09')).active).toBeGreaterThan(expected.active)
  })

  it('Instagram + any = cold now = 147 (02 §Counts)', async () => {
    const expected = split((s) => isInstagram(s) && coldSinceOf(s) <= TODAY)
    expect(expected.active).toBe(147)
    const body = await preview({ source: ['instagram'], went_cold: 'any' })
    expect({ active: body.count, hidden: body.hidden_unsubscribed }).toEqual(expected)
  })

  it('a month after TODAY\'s and a month by name are 400 invalid_filters', async () => {
    await expectInvalid({ went_cold: '2026-10' }, 'went_cold must not be a month after 2026-09')
    await expectInvalid({ went_cold: 'August' }, 'went_cold must be "any" or a month written YYYY-MM')
    await expectInvalid({ went_cold: '2026-13' }, 'went_cold must be')
  })
})

describe('T-SEG-9 engagement range', () => {
  it('engagement ≥ 50 = 487 active, 27 hidden, recomputed from the CSVs', async () => {
    const visits = visitsLast30d()
    const expected = split((s) => engagementOf(s, visits) >= 50)
    expect(expected).toEqual({ active: 487, hidden: 27 })
    const body = await preview({ engagement_gte: 50 })
    expect({ active: body.count, hidden: body.hidden_unsubscribed }).toEqual(expected)
    for (const row of body.rows) expect(row.engagement_score).toBeGreaterThanOrEqual(50)
  })

  it('a closed range counts the scores inside it, both ends included', async () => {
    const visits = visitsLast30d()
    const expected = split((s) => engagementOf(s, visits) >= 25 && engagementOf(s, visits) <= 40)
    const body = await preview({ engagement_gte: 25, engagement_lte: 40 })
    expect({ active: body.count, hidden: body.hidden_unsubscribed }).toEqual(expected)
    const lte = split((s) => engagementOf(s, visits) <= 40)
    expect((await preview({ engagement_lte: 40 })).count).toBe(lte.active)
  })

  it('gte above lte and values outside 0–100 are 400 invalid_filters', async () => {
    await expectInvalid({ engagement_gte: 60, engagement_lte: 50 }, 'engagement_gte must not be greater than engagement_lte')
    await expectInvalid({ engagement_gte: 101 }, 'engagement_gte must be a whole number from 0 to 100')
    await expectInvalid({ engagement_lte: -1 }, 'engagement_lte must be a whole number from 0 to 100')
  })
})

describe('T-SEG-10 site visits', () => {
  it('visited in the last 30 days = 935 active, 82 hidden, from web_events.csv', async () => {
    const visited = visitedBy((v) => v.date >= minusDays(TODAY, 30))
    const expected = split((s) => visited.has(s.email))
    expect(expected).toEqual({ active: 935, hidden: 82 })
    const body = await preview({ site_visit_within_days: 30 })
    expect({ active: body.count, hidden: body.hidden_unsubscribed }).toEqual(expected)
    for (const row of body.rows) expect(visited.has(row.email)).toBe(true)
  })

  it('/shadrachs-picks = 366 active, 40 hidden; with 30 days it is the same visit', async () => {
    const page = visitedBy((v) => v.page === '/shadrachs-picks')
    expect(split((s) => page.has(s.email))).toEqual({ active: 366, hidden: 40 })
    const body = await preview({ site_visit_page: '/shadrachs-picks' })
    expect({ active: body.count, hidden: body.hidden_unsubscribed }).toEqual({ active: 366, hidden: 40 })
    // Same visit: a page view inside the window, not any page view plus any recent visit.
    const sameVisit = visitedBy((v) => v.page === '/shadrachs-picks' && v.date >= minusDays(TODAY, 7))
    const recent = visitedBy((v) => v.date >= minusDays(TODAY, 7))
    const both = await preview({ site_visit_page: '/shadrachs-picks', site_visit_within_days: 7 })
    expect(both.count).toBe(split((s) => sameVisit.has(s.email)).active)
    expect(split((s) => page.has(s.email) && recent.has(s.email)).active).toBeGreaterThan(both.count)
  })

  it('the brief\'s preset + visited in the last 30 days = 59 ("cold on email, active on the site"); + the page = 31', async () => {
    const visited = visitedBy((v) => v.date >= minusDays(TODAY, 30))
    const expected = split((s) => presetMatch(s) && visited.has(s.email))
    expect(expected.active).toBe(59)
    const body = await preview({ ...PRESET, site_visit_within_days: 30 })
    expect({ active: body.count, hidden: body.hidden_unsubscribed }).toEqual(expected)
    const page = visitedBy((v) => v.page === '/shadrachs-picks')
    expect(split((s) => presetMatch(s) && page.has(s.email)).active).toBe(31)
    expect((await preview({ ...PRESET, site_visit_page: '/shadrachs-picks' })).count).toBe(31)
  })

  it('new subscribers who visited /shadrachs-picks = 120 active, 10 hidden (the README\'s Growth task)', async () => {
    const page = visitedBy((v) => v.page === '/shadrachs-picks')
    const expected = split((s) => isNewSubscriber(s.signup_date) && page.has(s.email))
    expect(expected).toEqual({ active: 120, hidden: 10 })
    const body = await preview({ signed_up_within_days: 30, site_visit_page: '/shadrachs-picks' })
    expect({ active: body.count, hidden: body.hidden_unsubscribed }).toEqual(expected)
  })

  it('a page holding an email, a raw id or no leading "/" is 400 invalid_filters', async () => {
    for (const page of [`/${JULIA}`, '/u_2b6447a3', 'news/church-attendance-study']) {
      await expectInvalid({ site_visit_page: page }, 'site_visit_page must be a site path')
    }
    await expectInvalid({ site_visit_within_days: 0 }, 'site_visit_within_days must be a whole number from 1 to 3650')
  })

  it('GET /api/segments/options lists the 16 pages, most-visited by subscribers first, then A–Z', async () => {
    const res = await SELF.fetch('http://cdp.test/api/segments/options', { headers: { cookie } })
    expect(res.status).toBe(200)
    const { pages } = await res.json<{ pages: string[] }>()
    const visitors = new Map<string, Set<string>>()
    for (const v of csvVisits()) {
      const set = visitors.get(v.page) ?? new Set<string>()
      if (v.email !== null) set.add(v.email)
      visitors.set(v.page, set)
    }
    const expected = [...visitors.entries()]
      .sort(([a, x], [b, y]) => y.size - x.size || (a < b ? -1 : a > b ? 1 : 0))
      .map(([page]) => page)
    expect(expected).toHaveLength(16)
    expect(pages).toEqual(expected)
  })

  it('GET /api/segments/options fails loud on a stored page the filter would refuse', async () => {
    // A copy of a real row (09 D-47): web_events.csv line 2's visitor and time, its page with the
    // leading "/" removed. The seed never stores such a page; offering it would only 400 later.
    const real = await env.DB.prepare("SELECT visitor_id, event_ts FROM web_events WHERE page = '/news/church-attendance-study' ORDER BY id LIMIT 1").first<{ visitor_id: string; event_ts: string }>()
    if (real === null) throw new Error('web_events has no /news/church-attendance-study row')
    const { meta } = await env.DB.prepare('INSERT INTO web_events (visitor_id, page, event_ts) VALUES (?, ?, ?)')
      .bind(real.visitor_id, 'news/church-attendance-study', real.event_ts)
      .run()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const res = await SELF.fetch('http://cdp.test/api/segments/options', { headers: { cookie } })
      expect(res.status).toBe(500)
      expect((await res.json<{ error: string }>()).error).toBe('internal_error')
      expect(JSON.stringify(logged.mock.calls)).toContain('do not match the site_visit_page pattern')
    } finally {
      logged.mockRestore()
      await env.DB.prepare('DELETE FROM web_events WHERE id = ?').bind(meta.last_row_id).run()
    }
    expect((await SELF.fetch('http://cdp.test/api/segments/options', { headers: { cookie } })).status).toBe(200)
  })

  it('GET /api/segments/options ranks by distinct subscribers: repeat visits by one subscriber move nothing', async () => {
    // Copies of a real row (09 D-47): one linked visitor's own /our-staff visit (web_events.csv),
    // repeated until /our-staff has more visit rows, and more rows with a pkey, than the page
    // ranked just above it. Its distinct subscribers do not change, so neither may its rank; a
    // ranking by count(*) or count(pkey) (mutant M15) would move it up.
    const rank = async () => (await (await SELF.fetch('http://cdp.test/api/segments/options', { headers: { cookie } })).json<{ pages: string[] }>()).pages
    const before = await rank()
    const at = before.indexOf('/our-staff')
    expect(at).toBeGreaterThan(0)
    const above = before[at - 1]
    const counts = (page: string) =>
      env.DB.prepare('SELECT count(DISTINCT pkey) AS subscribers, count(pkey) AS linked, count(*) AS visits FROM v_web_events WHERE page = ?')
        .bind(page)
        .first<{ subscribers: number; linked: number; visits: number }>()
    const [staff, upper] = [await counts('/our-staff'), await counts(above)]
    if (staff === null || upper === null) throw new Error('v_web_events lost a page')
    expect(staff.subscribers).toBeLessThan(upper.subscribers)
    const real = await env.DB.prepare(
      "SELECT we.visitor_id, we.event_ts FROM web_events we JOIN web_visitors wv ON wv.visitor_id = we.visitor_id JOIN profiles p ON p.email_norm = wv.email_norm WHERE we.page = '/our-staff' ORDER BY we.id LIMIT 1",
    ).first<{ visitor_id: string; event_ts: string }>()
    if (real === null) throw new Error('no linked /our-staff visit in web_events')
    const copies = Math.max(upper.visits - staff.visits, upper.linked - staff.linked) + 1
    const insert = env.DB.prepare('INSERT INTO web_events (visitor_id, page, event_ts) VALUES (?, ?, ?)')
    const inserted = await env.DB.batch(Array.from({ length: copies }, () => insert.bind(real.visitor_id, '/our-staff', real.event_ts)))
    try {
      const after = await counts('/our-staff')
      expect(after?.subscribers).toBe(staff.subscribers)
      // The data now ranks /our-staff above `above` by visits and by linked visits, not by subscribers.
      expect(after?.visits).toBeGreaterThan(upper.visits)
      expect(after?.linked).toBeGreaterThan(upper.linked)
      expect(await rank()).toEqual(before)
    } finally {
      for (const r of inserted) await env.DB.prepare('DELETE FROM web_events WHERE id = ?').bind(r.meta.last_row_id).run()
    }
    expect(await rank()).toEqual(before)
  })

  it('GET /api/segments/options without a session is 401', async () => {
    const res = await SELF.fetch('http://cdp.test/api/segments/options')
    expect(res.status).toBe(401)
    expect((await res.json<{ error: string }>()).error).toBe('unauthorized')
  })
})

/** The MVP filter examples of 19 §3, each a different segment. */
const MVP_EXAMPLES: Record<string, unknown>[] = [
  { source: ['instagram'], went_cold: '2026-08' },
  { source: ['instagram'], went_cold: 'any' },
  { signed_up_within_days: 30 },
  { engagement_gte: 50 },
  { engagement_gte: 25, engagement_lte: 40 },
  { site_visit_within_days: 30 },
  { site_visit_page: '/shadrachs-picks' },
  { ...PRESET, site_visit_within_days: 30 },
  { ...PRESET, site_visit_page: '/shadrachs-picks', site_visit_within_days: 30 },
  { app_active_within_days: 7 },
  { app_event: 'login', app_active_within_days: 7 },
]

describe('T-SEG-12 every new filter keeps the segment rules', () => {
  it('for every MVP example: both statuses = active + hidden (D-51) and the tool counts what the builder counts', async () => {
    for (const filters of MVP_EXAMPLES) {
      const active = await preview(filters)
      const both = await preview({ ...filters, status: ['active', 'unsubscribed'] })
      expect({ filters, both: both.count }).toEqual({ filters, both: active.count + active.hidden_unsubscribed })
      const tool = await BUILTIN_HANDLERS.segment.run(env.DB, filters)
      expect({ filters, count: tool.summary.count, hidden: tool.summary.hidden_unsubscribed }).toEqual({
        filters,
        count: active.count,
        hidden: active.hidden_unsubscribed,
      })
    }
  })

  it('the segment tool names the definitions each new filter applied (19 §4 "Assistant")', async () => {
    const used = async (filters: Record<string, unknown>) => (await BUILTIN_HANDLERS.segment.run(env.DB, filters)).summary.definitions_used
    expect(await used({ source: ['instagram'], went_cold: '2026-08' })).toEqual(['went_cold_in', 'cold_since'])
    expect(await used({ source: ['instagram'], went_cold: 'any' })).toEqual(['cold', 'cold_since'])
    // 30 days is the new_subscriber window (02 §Derived); 7 days is only a last-N-days window.
    expect(await used({ signed_up_within_days: 30 })).toEqual(['new_subscriber', 'last_n_days'])
    expect(await used({ signed_up_within_days: 7 })).toEqual(['last_n_days'])
    expect(await used({ engagement_gte: 50 })).toEqual(['engagement_score'])
    expect(await used({ engagement_lte: 40 })).toEqual(['engagement_score'])
    expect(await used({ site_visit_within_days: 30 })).toEqual(['last_n_days'])
    expect(await used({ app_active_within_days: 7 })).toEqual(['last_n_days'])
    // A page or an event alone sets no window, so it names no definition.
    expect(await used({ site_visit_page: '/shadrachs-picks' })).toEqual([])
    expect(await used({ ...PRESET, went_cold: '2026-08', signed_up_within_days: 30, site_visit_within_days: 30 })).toEqual([
      'no_open_in_days',
      'days_since_open',
      'went_cold_in',
      'cold_since',
      'new_subscriber',
      'last_n_days',
    ])
  })

  it('the brief\'s preset is still 177 / 55 with every new key absent', async () => {
    const body = await preview(PRESET)
    expect({ count: body.count, hidden: body.hidden_unsubscribed }).toEqual({ count: PRESET_COUNT, hidden: 55 })
  })

  it('the model\'s SQL names only v_* views and no SQL text holds a filter value', () => {
    for (const filters of MVP_EXAMPLES) {
      const parsed = parseFilters(filters)
      const model = compileModelSegment(parsed)
      for (const sql of [model.rowsSql, model.countSql]) {
        const relations = [...sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)].map((m) => m[1])
        expect(relations.length).toBeGreaterThan(0)
        for (const name of relations) expect(name, sql).toMatch(/^v_/)
      }
      const builder = compileSegment(parsed)
      for (const value of builder.params.filter((p): p is string => typeof p === 'string')) {
        expect(builder.sql_shape, value).not.toContain(value)
        expect(model.countSql, value).not.toContain(value)
      }
    }
  })

  it('a model segment that differs from the counted one in any new key is not that segment (T-AI-3)', async () => {
    const counted = { ...PRESET, went_cold: '2026-08', signed_up_within_days: 30, engagement_gte: 10, engagement_lte: 40, site_visit_within_days: 30, site_visit_page: '/shadrachs-picks', app_active_within_days: 7, app_event: 'read_story' }
    const output = await BUILTIN_HANDLERS.segment.run(env.DB, counted)
    const answer = (filters: unknown) =>
      respond({
        modelText: `\n\n\`\`\`json\n${JSON.stringify({ type: 'segment', text: 'Here they are.', window: null, filters_applied: {}, definitions_used: [], segment: { filters } })}\n\`\`\``,
        outputs: [output],
        capped: false,
      }).result
    const oneKeyOff: Array<[string, unknown]> = [
      ['went_cold', 'any'],
      ['signed_up_within_days', 31],
      ['engagement_gte', 11],
      ['engagement_lte', 41],
      ['site_visit_within_days', 7],
      ['site_visit_page', '/about'],
      ['app_active_within_days', 30],
      ['app_event', 'login'],
    ]
    for (const [key, value] of oneKeyOff) {
      const result = answer({ ...counted, [key]: value })
      expect({ key, partial: result.partial, segment: result.segment }).toEqual({ key, partial: true, segment: null })
    }
    // The same filters in another key order: still the counted segment.
    const reordered = Object.fromEntries(Object.entries(counted).reverse())
    expect(answer(reordered).segment?.count).toBe(output.summary.count)
  })

  it('the segment tool schema declares exactly FILTER_KEYS, from the contract fragment', () => {
    const segment = TOOL_SEEDS.find((t) => t.name === 'segment')!
    const properties = segment.inputSchema.properties as Record<string, Record<string, unknown>>
    expect(Object.keys(properties)).toEqual([...FILTER_KEYS])
    for (const key of FILTER_KEYS) {
      const { description, ...schema } = properties[key]
      expect(typeof description).toBe('string')
      expect(schema).toEqual(FILTER_SCHEMA[key])
    }
    expect(properties.source).toMatchObject({ items: { enum: ['instagram', 'facebook', 'referral', 'google', 'direct', 'podcast', 'x'] } })
  })

  it('no string filter accepts an email or a raw id, at the API or at Gate 2', async () => {
    const segment = TOOL_SEEDS.find((t) => t.name === 'segment')!
    const probes = [JULIA, `/${JULIA}`, 'u_2b6447a3', '/u_2b6447a3', `any ${JULIA}`, `2026-08 u_2b6447a3`]
    for (const probe of probes) expect(EMAIL_REGEX.test(probe) || RAW_ID_REGEX.test(probe), probe).toBe(true)
    const stringKeys = FILTER_KEYS.filter((key) => {
      const schema = FILTER_SCHEMA[key]
      return schema.type === 'string' || schema.items?.type === 'string'
    })
    expect(stringKeys).toEqual(['status', 'source', 'went_cold', 'site_visit_page', 'app_event'])
    for (const key of stringKeys) {
      const schema = FILTER_SCHEMA[key]
      expect(schema.enum !== undefined || schema.pattern !== undefined || schema.items?.enum !== undefined, key).toBe(true)
      for (const probe of probes) {
        const value = schema.type === 'array' ? [probe] : probe
        expect(inputSchemaProblems(segment.inputSchema, { [key]: value }), `${key} ${probe}`).not.toEqual([])
        if (key === 'source') continue // the API folds any source and binds it: 0 rows, never a match (T-SEG-3)
        const res = await post('preview', { filters: { [key]: value } })
        expect(res.status, `${key} ${probe}`).toBe(400)
      }
    }
  })
})

describe('T-SEG-11 + T-SEG-9 webhook events move segment counts with no restart (09 D-69 amends D-53)', () => {
  // These run last: each signed event changes the stored data the tests above count.
  const nextEventId = eventIdPool()
  const send = (fields: Record<string, unknown>) =>
    sendWebhook(JSON.stringify({ event_id: nextEventId(), timestamp: BRIEF_TS, ...fields }))

  async function counts(filters: Record<string, unknown>): Promise<{ active: number; hidden: number }> {
    const body = await preview(filters)
    return { active: body.count, hidden: body.hidden_unsubscribed }
  }

  it('app activity is 0 on the seed: app events arrive only by webhook', async () => {
    expect(await counts({ app_active_within_days: 7 })).toEqual({ active: 0, hidden: 0 })
    for (const event of ['app_open', 'read_story', 'link_click', 'login']) {
      expect(await counts({ app_event: event })).toEqual({ active: 0, hidden: 0 })
    }
  })

  it('julia\'s read_story at TODAY: app activity 0 → 1, engagement ≥ 31 rises by exactly 1 (28 → 31)', async () => {
    // 28 and 31 by the 02 §Derived formula on her CSV row and visits, with 0 and then 1 app event.
    const csvJulia = csvSubscribers().find((s) => s.email === JULIA)
    if (csvJulia === undefined) throw new Error(`${JULIA} is not in subscribers.csv`)
    const scoreBefore = engagementOf(csvJulia, visitsLast30d())
    const scoreAfter = engagementOf(csvJulia, visitsLast30d(), 1)
    expect([scoreBefore, scoreAfter]).toEqual([28, 31])
    const before = await counts({ engagement_gte: scoreAfter })
    const julia = async () =>
      (await preview({ source: ['instagram'], signed_up_within_days: 30, engagement_gte: scoreBefore, engagement_lte: scoreAfter }, 1000)).rows.find((r) => r.email === JULIA)
    expect((await julia())?.engagement_score).toBe(scoreBefore)
    const res = await send({ event: 'read_story', user_id: 'u_2b6447a3', device_id: 'd_2b6447a3', properties: { story: 'supreme-court-ruling-explained' } })
    expect(res.status).toBe(202)
    expect((await julia())?.engagement_score).toBe(scoreAfter)
    expect(await counts({ engagement_gte: scoreAfter })).toEqual({ active: before.active + 1, hidden: before.hidden })
    expect(await counts({ app_active_within_days: 7 })).toEqual({ active: 1, hidden: 0 })
    expect(await counts({ app_active_within_days: 7, app_event: 'read_story' })).toEqual({ active: 1, hidden: 0 })
    expect(await counts({ app_active_within_days: 7, app_event: 'login' })).toEqual({ active: 0, hidden: 0 })
    const rows = (await preview({ app_active_within_days: 7 })).rows
    expect(rows.map((r) => r.email)).toEqual([JULIA])
  })

  it('the N of app_active_within_days is the window: an event 8 days before TODAY counts for 8 and 30 days, not 7', async () => {
    // john.turner61 (u_f2411d1c, app_users.csv line 9) reads a story at TODAY − 8 days, BRIEF_TS's
    // time of day. lastNDays(7) starts 2026-09-21 and lastNDays(8) starts 2026-09-20 (02 §Derived).
    const eightDaysAgo = `${minusDays(TODAY, 8)}${BRIEF_TS.slice(10)}`
    expect(eightDaysAgo).toBe('2026-09-20T14:22:05Z')
    expect(compileSegment(parseFilters({ app_active_within_days: 7 })).params).toEqual(['active', minusDays(TODAY, 7)])
    expect(minusDays(TODAY, 7)).toBe('2026-09-21')
    const before = { 7: await counts({ app_active_within_days: 7 }), 8: await counts({ app_active_within_days: 8 }), 30: await counts({ app_active_within_days: 30 }) }
    const res = await send({ event: 'read_story', user_id: 'u_f2411d1c', device_id: 'd_f2411d1c', timestamp: eightDaysAgo, properties: { story: 'supreme-court-ruling-explained' } })
    expect(res.status).toBe(202)
    expect(await counts({ app_active_within_days: 7 })).toEqual(before[7])
    expect(await counts({ app_active_within_days: 8 })).toEqual({ active: before[8].active + 1, hidden: before[8].hidden })
    expect(await counts({ app_active_within_days: 30 })).toEqual({ active: before[30].active + 1, hidden: before[30].hidden })
    expect((await preview({ app_active_within_days: 8, app_event: 'read_story' })).rows.map((r) => r.email).sort()).toEqual(['john.turner61@gmail.com', JULIA])
  })

  it('an anonymous app_open counts for joy.hall830 once a login stitches its device', async () => {
    expect((await send({ event: 'app_open', user_id: null, device_id: 'd_ceed5f12' })).status).toBe(202)
    expect(await counts({ app_event: 'app_open' })).toEqual({ active: 0, hidden: 0 })
    expect((await send({ event: 'login', user_id: 'u_ceed5f12', device_id: 'd_ceed5f12' })).status).toBe(202)
    const rows = (await preview({ app_event: 'app_open' })).rows
    expect(rows.map((r) => r.email)).toEqual(['joy.hall830@protonmail.com'])
    expect(await counts({ app_event: 'login' })).toEqual({ active: 1, hidden: 0 })
  })

  it('an event dated after TODAY counts (09 D-01); an unsubscribed user moves the hidden count', async () => {
    const before = await counts({ app_active_within_days: 1 })
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    expect(now > TODAY).toBe(true)
    expect((await send({ event: 'link_click', user_id: 'u_f2411d1c', device_id: 'd_f2411d1c', timestamp: now })).status).toBe(202)
    expect(await counts({ app_active_within_days: 1 })).toEqual({ active: before.active + 1, hidden: before.hidden })
    expect((await preview({ app_event: 'link_click' })).rows.map((r) => r.email)).toEqual(['john.turner61@gmail.com'])
    expect((await send({ event: 'app_open', user_id: 'u_baba14aa', device_id: 'd_baba14aa' })).status).toBe(202)
    const after = await counts({ app_active_within_days: 1 })
    expect(after).toEqual({ active: before.active + 1, hidden: before.hidden + 1 })
    expect((await preview({ app_active_within_days: 1, status: ['active', 'unsubscribed'] })).count).toBe(after.active + after.hidden)
  })

  it('an event name outside the four is 400 invalid_filters', async () => {
    await expectInvalid({ app_event: 'purchase' }, 'app_event must be one of app_open, read_story, link_click, login')
    await expectInvalid({ app_active_within_days: 3651 }, 'app_active_within_days must be a whole number from 1 to 3650')
  })
})

// The page's side of a preview, against the real Worker (09 D-69 review gaps 2 and 4). previewAndRecord
// (src/segment-preview.ts) is what /segments runs; pagePost is postJson's rule (2xx → JSON, else
// the envelope as the same ApiError, src/api-error.ts toApiError). The form values are the review's
// error-path values (0, -5, 2.5, 99999; engagement from above to) and the brief's preset.

/** postJson for POST /api/segments/preview, over SELF. */
async function pagePost(body: PreviewRequest): Promise<SegmentPreview> {
  const res = await post('preview', body)
  if (!res.ok) throw await toApiError(res)
  return res.json<SegmentPreview>()
}

/** An in-memory Storage that counts writes, for Previous searches (workerd has no localStorage). */
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

/** The page's flow for a form: toFilters, then previewAndRecord through the real route. */
function submitForm(form: Partial<Form>, store: SearchStore | null = new MemoryStore()) {
  return previewAndRecord({ filters: toFilters({ ...DEFAULT_FORM, ...form }), limit: 100 }, pagePost, store)
}

/** The plain problems of a rejected form, as the page shows them. */
async function problemsOf(form: Partial<Form>) {
  const { result, stored } = await submitForm(form)
  expect(stored).toBeNull()
  if (result.status !== 'error') throw new Error(`expected a 400 for ${JSON.stringify(form)}`)
  return result.problems
}

describe('T-SEG-4 Previous searches record only a 200 preview, as the server echoed it', () => {
  it('records the canonical echo, not what the browser sent', async () => {
    const store = new MemoryStore()
    // The browser sends Instagram as subscribers.csv spells it, twice; the server folds and dedupes it.
    const sent = { status: ['active'] as const, source: ['Instagram', 'instagram'], days_since_open_gte: 30, include_never_opened: true, has_app: null }
    const { result, stored } = await previewAndRecord({ filters: { ...sent, status: [...sent.status] }, limit: 100 }, pagePost, store)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.count).toBe(PRESET_COUNT)
    expect(result.filters).toEqual(BRIEF_EXAMPLE)
    expect(stored).toEqual([BRIEF_EXAMPLE])
    expect(JSON.parse(store.data.get(STORAGE_KEY) ?? 'null')).toEqual({ v: 1, items: [{ filters: BRIEF_EXAMPLE }] })
    expect(store.data.get(STORAGE_KEY)).not.toContain('Instagram')
  })

  it('a rejected preview records nothing and leaves the earlier searches as they were', async () => {
    const store = new MemoryStore()
    await submitForm({ signedUpDays: '30' }, store)
    const before = store.data.get(STORAGE_KEY)
    const writes = store.writes
    expect(readSearches(store)).toEqual([{ status: ['active'], include_never_opened: false, signed_up_within_days: 30, has_app: null }])
    const { result, stored } = await submitForm({ signedUpDays: '0' }, store)
    expect(result.status).toBe('error')
    expect(stored).toBeNull()
    expect(store.writes).toBe(writes)
    expect(store.data.get(STORAGE_KEY)).toBe(before)
  })
})

describe('T-SEG-7 a rejected days value names the field and its limit in plain words', () => {
  const SIGNED_UP = 'Signed up in the last: enter a whole number of days from 1 to 3,650.'
  for (const value of ['0', '-5', '2.5', '99999']) {
    it(`Signed up in the last ${value} days → "${SIGNED_UP}"`, async () => {
      const problems = await problemsOf({ signedUpDays: value })
      expect(problems).toEqual([{ field: 'signedUpDays', message: SIGNED_UP }])
      expect(fieldMessages(problems)).toEqual({ signedUpDays: SIGNED_UP })
    })
  }

  it('the same words for the other day boxes, each naming its own field', async () => {
    expect(await problemsOf({ siteDays: '0' })).toEqual([
      { field: 'siteDays', message: 'Visited the site in the last: enter a whole number of days from 1 to 3,650.' },
    ])
    expect(await problemsOf({ appDays: '99999' })).toEqual([
      { field: 'appDays', message: 'Used the app in the last: enter a whole number of days from 1 to 3,650.' },
    ])
    for (const value of ['0', '-5', '2.5'])
      expect(await problemsOf({ days: value })).toEqual([
        { field: 'days', message: "Haven't opened an email in at least: enter a whole number of days, 1 or more." },
      ])
    // No upper limit on "haven't opened in" (09 D-01): 99999 runs.
    expect((await submitForm({ days: '99999' })).result.status).toBe('ok')
  })

  it('every problem of one request is named, in the server\'s order', async () => {
    expect(await problemsOf({ days: '0', signedUpDays: '-5' })).toEqual([
      { field: 'days', message: "Haven't opened an email in at least: enter a whole number of days, 1 or more." },
      { field: 'signedUpDays', message: 'Signed up in the last: enter a whole number of days from 1 to 3,650.' },
    ])
  })

  it('a month after TODAY\'s names the last month allowed', async () => {
    expect(await problemsOf({ wentCold: '2026-10' })).toEqual([{ field: 'wentCold', message: 'Went cold: choose September 2026 or an earlier month.' }])
  })
})

describe('T-SEG-9 a rejected engagement range names the field and the limit in plain words', () => {
  it('from above to', async () => {
    const problems = await problemsOf({ engagementFrom: '60', engagementTo: '40' })
    expect(problems).toEqual([{ field: 'engagementFrom', message: 'Engagement: “from” must not be higher than “to”.' }])
  })

  it('outside 0 to 100', async () => {
    expect(await problemsOf({ engagementTo: '101' })).toEqual([
      { field: 'engagementTo', message: 'Engagement to: enter a whole number from 0 to 100.' },
    ])
    expect(await problemsOf({ engagementFrom: '-5' })).toEqual([
      { field: 'engagementFrom', message: 'Engagement from: enter a whole number from 0 to 100.' },
    ])
  })
})
