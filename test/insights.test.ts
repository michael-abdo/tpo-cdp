/// <reference types="vite/client" />
import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import appCsv from '../data/app_users.csv?raw'
import subscribersCsv from '../data/subscribers.csv?raw'
import webCsv from '../data/web_events.csv?raw'
import { TODAY } from '../shared/config'
import { goingColdRisk } from '../shared/derive'
import { CANONICAL_SOURCES, canonicalSource, normalizeEmail } from '../shared/normalize'
import type { DataQualityCheckKey as UiCheckKey } from '../src/types'
import { sanitizeQuestion } from '../worker/assistant/gates/gate1-input-sanitizer'
import { parseCsv } from '../worker/ingest/csv'
import { DATA_QUALITY_CHECKS, type DataQuality, type DataQualityCheckKey } from '../worker/insights/data-quality'
import type { Funnel } from '../worker/insights/funnel'
import type { GoingCold } from '../worker/insights/going-cold'
import type { SourceAppConversion } from '../worker/insights/source-app'
import { loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'

// GET /api/insights/source-app-conversion, /funnel, /going-cold and /data-quality (04 §GET
// /api/insights/…, 06 §/growth; R6). T-INS-1, T-INS-2 and T-INS-3 (08), and going_cold_risk
// (02 §Derived, 09 D-31) on the seeded rows. The test D1 holds the real seed of data/*.csv
// (test/helpers/seed.ts) and no webhook events. Expected totals are 02 §Counts; the per-group
// numbers are checked against independent tallies of the ?raw CSVs in TypeScript (the one
// normalization from shared/normalize.ts, then plain loops), never against SQL.

const SUBSCRIBERS = 2900
const ACTIVE = 2610
const APP_USERS_MATCHING_A_SUBSCRIBER = 900
const APP_CREATED_BEFORE_SIGNUP = 457
const APP_CREATED_AFTER_SIGNUP = 432
const APP_CREATED_SAME_DAY = 11
const VISITORS = 2028
const LINKED_VISITORS = 1400
const ANONYMOUS_VISITORS = 628
const DISTINCT_PAGES = 16
const SUBSCRIBER_ROWS_IN = 2995
const SUBSCRIBER_BLANK_ROWS = 8
const SUBSCRIBER_INVALID_EMAILS = 2
const SUBSCRIBERS_MERGED = 85
const WEB_ROWS = 10000
const WEB_ROWS_WITHOUT_UTM = 8030
const APP_ACCOUNTS = 930
const APP_ONLY = 30

let cookie: string

beforeAll(async () => {
  await seedDatabase()
  cookie = await loginCookie()
})

const get = (path: string, headers: Record<string, string> = { cookie }) =>
  SELF.fetch(`http://cdp.test/api/insights/${path}`, { headers })

function column(csv: ReturnType<typeof parseCsv>, name: string): number {
  const i = csv.header.indexOf(name)
  if (i < 0) throw new Error(`insights test: CSV has no ${name} column`)
  return i
}

/** Per canonical source: subscribers, with any app, with an app created after signup; plus the before/same-day split. */
function tallySourceApp() {
  const subs = parseCsv(subscribersCsv)
  const [email, signup, source] = ['email', 'signup_date', 'acquisition_source'].map((n) => column(subs, n))
  const signupByEmail = new Map<string, { signup: string; source: string | null }>()
  for (const row of subs.rows) {
    const e = normalizeEmail(row[email])
    // Invalid and blank emails are quarantined; a duplicate pair agrees on every field (02 §Counts).
    if (e !== null && !signupByEmail.has(e)) signupByEmail.set(e, { signup: row[signup].trim(), source: canonicalSource(row[source]) })
  }
  const apps = parseCsv(appCsv)
  const [appEmail, created] = ['email', 'created_at'].map((n) => column(apps, n))
  const perSource = new Map<string | null, { subscribers: number; with_app: number; with_app_after_signup: number }>()
  for (const s of signupByEmail.values()) {
    const t = perSource.get(s.source) ?? { subscribers: 0, with_app: 0, with_app_after_signup: 0 }
    t.subscribers++
    perSource.set(s.source, t)
  }
  const split = { before: 0, after: 0, same_day: 0 }
  for (const row of apps.rows) {
    const e = normalizeEmail(row[appEmail])
    const sub = e === null ? undefined : signupByEmail.get(e)
    if (sub === undefined) continue
    const createdAt = row[created].trim()
    const t = perSource.get(sub.source)
    if (t === undefined) throw new Error('insights test: tally lost a source')
    t.with_app++
    if (createdAt > sub.signup) {
      t.with_app_after_signup++
      split.after++
    } else if (createdAt < sub.signup) split.before++
    else split.same_day++
  }
  return { perSource, split }
}

/** Per visitor: page and UTM of the earliest event (the earlier line on a tie, 09 D-49), and whether any row carries an email. */
function tallyFunnel() {
  const web = parseCsv(webCsv)
  const [visitor, page, ts, utm, email] = ['visitor_id', 'page', 'timestamp', 'utm_source', 'email'].map((n) => column(web, n))
  const visitors = new Map<string, { ts: string; page: string; utm: string | null; subscribed: boolean }>()
  const pages = new Set<string>()
  for (const row of web.rows) {
    const id = row[visitor].trim()
    pages.add(row[page].trim())
    const hasEmail = row[email].trim() !== ''
    const known = visitors.get(id)
    if (known === undefined) {
      visitors.set(id, { ts: row[ts].trim(), page: row[page].trim(), utm: canonicalSource(row[utm]), subscribed: hasEmail })
      continue
    }
    known.subscribed ||= hasEmail
    if (row[ts].trim() < known.ts) Object.assign(known, { ts: row[ts].trim(), page: row[page].trim(), utm: canonicalSource(row[utm]) })
  }
  const byPage = new Map<string, { visitors: number; subscribed: number }>()
  const byUtm = new Map<string | null, { visitors: number; subscribed: number }>()
  for (const v of visitors.values()) {
    for (const [map, key] of [
      [byPage, v.page],
      [byUtm, v.utm],
    ] as [Map<string | null, { visitors: number; subscribed: number }>, string | null][]) {
      const t = map.get(key) ?? { visitors: 0, subscribed: 0 }
      t.visitors++
      if (v.subscribed) t.subscribed++
      map.set(key, t)
    }
  }
  return { byPage, byUtm, pages }
}

const round4 = (n: number, d: number) => Math.round((n / d) * 10000) / 10000

/** Every explain is a question the assistant accepts: Gate 1 passes it and it names no address. */
function expectAskable(explain: string) {
  expect(explain.endsWith('?')).toBe(true)
  expect(explain).not.toContain('@')
  expect(sanitizeQuestion(explain).ok).toBe(true)
}

describe('T-INS-1 GET /api/insights/source-app-conversion', () => {
  it('counts only apps created after signup: 432 of the 900 subscribers with an app (02 §Counts)', async () => {
    const res = await get('source-app-conversion')
    expect(res.status).toBe(200)
    const body = await res.json<SourceAppConversion>()
    expect(Object.keys(body)).toEqual(['total', 'by_source', 'definitions_used'])
    expect(body.total).toEqual({
      subscribers: SUBSCRIBERS,
      with_app: APP_USERS_MATCHING_A_SUBSCRIBER,
      with_app_after_signup: APP_CREATED_AFTER_SIGNUP,
      rate: round4(APP_CREATED_AFTER_SIGNUP, SUBSCRIBERS),
      explain: body.total.explain,
    })
    // The 468 left out are exactly the apps created before signup or on the signup day.
    expect(body.total.with_app - body.total.with_app_after_signup).toBe(APP_CREATED_BEFORE_SIGNUP + APP_CREATED_SAME_DAY)
    expect(body.definitions_used).toEqual(['app_after_signup', 'has_app'])
  })

  it('each source equals an independent tally of the CSVs, and the tally itself matches 02 §Counts', async () => {
    const { perSource, split } = tallySourceApp()
    expect(split).toEqual({ before: APP_CREATED_BEFORE_SIGNUP, after: APP_CREATED_AFTER_SIGNUP, same_day: APP_CREATED_SAME_DAY })
    const body = await (await get('source-app-conversion')).json<SourceAppConversion>()
    expect(body.by_source.map((r) => r.source).sort()).toEqual([...perSource.keys()].sort())
    for (const row of body.by_source) {
      const t = perSource.get(row.source)
      expect({ source: row.source, ...t, rate: t && round4(t.with_app_after_signup, t.subscribers) }).toEqual({
        source: row.source,
        subscribers: row.subscribers,
        with_app: row.with_app,
        with_app_after_signup: row.with_app_after_signup,
        rate: row.rate,
      })
    }
    const sum = (k: 'subscribers' | 'with_app' | 'with_app_after_signup') => body.by_source.reduce((n, r) => n + r[k], 0)
    expect([sum('subscribers'), sum('with_app'), sum('with_app_after_signup')]).toEqual([
      SUBSCRIBERS,
      APP_USERS_MATCHING_A_SUBSCRIBER,
      APP_CREATED_AFTER_SIGNUP,
    ])
  })

  it('orders sources by conversion rate, and every number carries an askable explain question', async () => {
    const body = await (await get('source-app-conversion')).json<SourceAppConversion>()
    const rates = body.by_source.map((r) => r.rate ?? -1)
    expect(rates).toEqual([...rates].sort((a, b) => b - a))
    const explains = [body.total.explain, ...body.by_source.map((r) => r.explain)]
    explains.forEach(expectAskable)
    expect(new Set(explains).size).toBe(explains.length)
    for (const row of body.by_source) {
      expect(row.explain).toContain(row.source === null ? 'no signup source recorded' : `"${row.source}"`)
    }
    // The panel counts every status, so the question must ask the assistant to as well (02 §Defaults).
    for (const e of explains) expect(e).toContain('including unsubscribed')
  })
})

describe('T-INS-2 GET /api/insights/funnel', () => {
  it('totals equal 02 §Counts: 2,028 visitors, 1,400 subscribed, 628 anonymous', async () => {
    const res = await get('funnel')
    expect(res.status).toBe(200)
    const body = await res.json<Funnel>()
    expect(Object.keys(body)).toEqual(['total', 'by_first_page', 'by_first_utm'])
    expect(body.total).toEqual({
      visitors: VISITORS,
      subscribed: LINKED_VISITORS,
      rate: round4(LINKED_VISITORS, VISITORS),
      explain: body.total.explain,
    })
    expect(body.total.visitors - body.total.subscribed).toBe(ANONYMOUS_VISITORS)
  })

  it('the by-first-page and by-first-UTM rows each sum to the totals and equal an independent tally', async () => {
    const { byPage, byUtm, pages } = tallyFunnel()
    expect(pages.size).toBe(DISTINCT_PAGES)
    const body = await (await get('funnel')).json<Funnel>()
    for (const rows of [body.by_first_page, body.by_first_utm]) {
      expect(rows.reduce((n, r) => n + r.visitors, 0)).toBe(VISITORS)
      expect(rows.reduce((n, r) => n + r.subscribed, 0)).toBe(LINKED_VISITORS)
      for (const r of rows) expect(r.rate).toBe(round4(r.subscribed, r.visitors))
    }
    expect(body.by_first_page.length).toBeLessThanOrEqual(DISTINCT_PAGES)
    expect(Object.fromEntries(body.by_first_page.map((r) => [r.first_page, { visitors: r.visitors, subscribed: r.subscribed }]))).toEqual(
      Object.fromEntries(byPage),
    )
    expect(
      new Map(body.by_first_utm.map((r) => [r.first_utm_source, { visitors: r.visitors, subscribed: r.subscribed }])),
    ).toEqual(byUtm)
  })

  it('orders rows by visitors, and every number carries an askable explain question', async () => {
    const body = await (await get('funnel')).json<Funnel>()
    for (const rows of [body.by_first_page, body.by_first_utm]) {
      const visitors = rows.map((r) => r.visitors)
      expect(visitors).toEqual([...visitors].sort((a, b) => b - a))
    }
    const explains = [body.total.explain, ...body.by_first_page.map((r) => r.explain), ...body.by_first_utm.map((r) => r.explain)]
    explains.forEach(expectAskable)
    expect(new Set(explains).size).toBe(explains.length)
    for (const r of body.by_first_page) expect(r.explain).toContain(`"${r.first_page}"`)
  })
})

describe('insights auth', () => {
  it('401 without a session cookie on every route', async () => {
    for (const path of ['source-app-conversion', 'funnel', 'going-cold', 'data-quality']) {
      const res = await get(path, {})
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Sign in to continue.' })
    }
  })
})

const DAY_MS = 86_400_000
/** Whole days from `a` to `b`, both `YYYY-MM-DD`; the test's own arithmetic, not shared/derive.ts. */
const days = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS

/**
 * 02 §Derived going_cold_risk, read literally: "opened in the last 30 days but not in the last 14,
 * or cold_since within the next 7 days". "Last N days" is TODAY − N .. TODAY; "the next 7 days"
 * is TODAY + 1 .. TODAY + 7.
 */
function goingColdByTheDoc(lastOpen: string | null, coldSince: string) {
  const ago = lastOpen === null ? null : days(lastOpen, TODAY)
  const openedLast30NotLast14 = ago !== null && ago > 14 && ago <= 30 // "> 14" also rules out a future open
  const coldWithinNext7 = days(TODAY, coldSince) >= 1 && days(TODAY, coldSince) <= 7
  return { openedLast30NotLast14, coldWithinNext7, atRisk: openedLast30NotLast14 || coldWithinNext7 }
}

interface SeededSubscriber {
  source: string | null
  status: string
  signup_date: string
  last_open_date: string | null
  cold_since: string
}

describe('going_cold_risk and GET /api/insights/going-cold (02 §Derived, 09 D-31)', () => {
  async function seeded() {
    const { results } = await env.DB.prepare(
      'SELECT source, status, signup_date, last_open_date, cold_since FROM subscribers',
    ).all<SeededSubscriber>()
    expect(results).toHaveLength(SUBSCRIBERS)
    return results
  }

  it('goingColdRisk agrees with the 02 §Derived sentence on every seeded subscriber, and both halves occur', async () => {
    const halves = { opened_15_to_30_days_ago_only: 0, cold_within_7_days_only: 0, both: 0, neither: 0 }
    for (const row of await seeded()) {
      // The stored cold date is 02's cold_since: 30 days after the last open, else after signup.
      expect(days(row.last_open_date ?? row.signup_date, row.cold_since)).toBe(30)
      const doc = goingColdByTheDoc(row.last_open_date, row.cold_since)
      expect({ row, atRisk: goingColdRisk(row.last_open_date, row.cold_since) }).toEqual({ row, atRisk: doc.atRisk })
      if (doc.openedLast30NotLast14 && doc.coldWithinNext7) halves.both++
      else if (doc.openedLast30NotLast14) halves.opened_15_to_30_days_ago_only++
      else if (doc.coldWithinNext7) halves.cold_within_7_days_only++
      else halves.neither++
    }
    // Each half of the "or" decides some rows on its own, so dropping either changes the counts.
    expect(halves.opened_15_to_30_days_ago_only).toBeGreaterThan(0)
    expect(halves.cold_within_7_days_only).toBeGreaterThan(0)
    expect(halves.neither).toBeGreaterThan(0)
  })

  it('counts per source equal the sentence applied row by row: active only, the unsubscribed at risk counted as hidden', async () => {
    const perSource = new Map<string | null, { active: number; at_risk: number }>()
    let hidden = 0
    for (const row of await seeded()) {
      const atRisk = goingColdByTheDoc(row.last_open_date, row.cold_since).atRisk
      if (row.status === 'unsubscribed') {
        if (atRisk) hidden++
        continue
      }
      const t = perSource.get(row.source) ?? { active: 0, at_risk: 0 }
      t.active++
      if (atRisk) t.at_risk++
      perSource.set(row.source, t)
    }
    const res = await get('going-cold')
    expect(res.status).toBe(200)
    const body = await res.json<GoingCold>()
    expect(Object.keys(body)).toEqual(['total', 'hidden_unsubscribed', 'by_source', 'definitions_used'])
    expect(new Map(body.by_source.map((r) => [r.source, { active: r.active, at_risk: r.at_risk }]))).toEqual(perSource)
    for (const r of body.by_source) expect(r.rate).toBe(round4(r.at_risk, r.active))
    const atRisk = [...perSource.values()].reduce((n, t) => n + t.at_risk, 0)
    // The active total is 02 §Counts' 2,610: the panel's rows cover every active subscriber.
    expect(body.total).toEqual({ active: ACTIVE, at_risk: atRisk, rate: round4(atRisk, ACTIVE), explain: body.total.explain })
    expect(body.total.at_risk).toBeGreaterThan(0)
    expect(body.hidden_unsubscribed.count).toBe(hidden)
    expect(hidden).toBeGreaterThan(0)
    expect(body.definitions_used).toEqual(['going_cold_risk', 'cold_since'])
  })

  it('orders sources by readers at risk, and every number carries an askable explain question', async () => {
    const body = await (await get('going-cold')).json<GoingCold>()
    const atRisk = body.by_source.map((r) => r.at_risk)
    expect(atRisk).toEqual([...atRisk].sort((a, b) => b - a))
    const explains = [body.total.explain, body.hidden_unsubscribed.explain, ...body.by_source.map((r) => r.explain)]
    explains.forEach(expectAskable)
    expect(new Set(explains).size).toBe(explains.length)
    // The rule by what it means, from DEFINITIONS, never its code name (06 §UI principles 4; "Explain this" fills the Ask bar).
    for (const e of explains) {
      expect(e).toContain('at risk of going cold (opened an email in the last 30 days but not in the last 14, or will become cold within the next 7 days)')
      expect(e).not.toContain('going_cold_risk')
    }
    for (const row of body.by_source) {
      expect(row.explain).toContain(row.source === null ? 'no signup source recorded' : `"${row.source}"`)
    }
    expect(body.hidden_unsubscribed.explain).toContain('unsubscribed')
  })
})

/** Per deduped subscriber its canonical source, and per web row its canonical UTM, from the ?raw CSVs. */
function tallyDataQuality() {
  const subs = parseCsv(subscribersCsv)
  const [email, source] = ['email', 'acquisition_source'].map((n) => column(subs, n))
  const sourceByEmail = new Map<string, string | null>()
  for (const row of subs.rows) {
    const e = normalizeEmail(row[email])
    if (e !== null && !sourceByEmail.has(e)) sourceByEmail.set(e, canonicalSource(row[source]))
  }
  const web = parseCsv(webCsv)
  const utm = column(web, 'utm_source')
  const known = new Set<string>(CANONICAL_SOURCES)
  const sources = [...sourceByEmail.values()]
  const utms = web.rows.map((row) => canonicalSource(row[utm]))
  return {
    subscribers: sourceByEmail.size,
    without_source: sources.filter((s) => s === null).length,
    unexpected_source: sources.filter((s) => s !== null && !known.has(s)).length,
    page_views: utms.length,
    without_utm: utms.filter((u) => u === null).length,
    unexpected_utm: utms.filter((u) => u !== null && !known.has(u)).length,
  }
}

describe('T-INS-3 GET /api/insights/data-quality', () => {
  it('the import numbers equal import_runs and quarantine, and 02 §Counts', async () => {
    const res = await get('data-quality')
    expect(res.status).toBe(200)
    const body = await res.json<DataQuality>()
    expect(Object.keys(body)).toEqual(['import', 'checks'])
    const { results: runs } = await env.DB.prepare(
      'SELECT file, rows_in, rows_out, merged, quarantined FROM import_runs',
    ).all<{ file: string; rows_in: number; rows_out: number; merged: number; quarantined: number }>()
    const { results: quarantined } = await env.DB.prepare('SELECT file, reason FROM quarantine').all<{ file: string; reason: string }>()
    const sum = (k: 'rows_in' | 'rows_out' | 'merged' | 'quarantined') => runs.reduce((n, r) => n + r[k], 0)
    const groups = new Map<string, number>()
    for (const q of quarantined) groups.set(`${q.file} ${q.reason}`, (groups.get(`${q.file} ${q.reason}`) ?? 0) + 1)
    expect(body.import).toEqual({
      rows_in: sum('rows_in'),
      rows_out: sum('rows_out'),
      merged: sum('merged'),
      quarantined: quarantined.length,
      rate: round4(quarantined.length, sum('rows_in')),
      by_file_reason: [...groups]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, rows]) => ({ file: key.split(' ')[0], reason: key.split(' ')[1], rows })),
    })
    expect(sum('quarantined')).toBe(quarantined.length)
    // 02 §Counts: three files, 2,995 + 10,000 + 930 rows in; the subscribers file's 10 set aside
    // are 8 blank rows and 2 invalid emails, and 85 duplicates merged.
    const subscribers = runs.find((r) => r.file === 'subscribers')
    expect(runs).toHaveLength(3)
    expect(subscribers).toEqual({
      file: 'subscribers',
      rows_in: SUBSCRIBER_ROWS_IN,
      rows_out: SUBSCRIBERS,
      merged: SUBSCRIBERS_MERGED,
      quarantined: SUBSCRIBER_BLANK_ROWS + SUBSCRIBER_INVALID_EMAILS,
    })
    expect(body.import.rows_in).toBe(SUBSCRIBER_ROWS_IN + WEB_ROWS + APP_ACCOUNTS)
    expect(body.import.by_file_reason.filter((g) => g.file === 'subscribers')).toEqual([
      { file: 'subscribers', reason: 'blank_row', rows: SUBSCRIBER_BLANK_ROWS },
      { file: 'subscribers', reason: 'invalid_email', rows: SUBSCRIBER_INVALID_EMAILS },
    ])
  })

  it('the record checks equal 02 §Counts and an independent tally of the CSVs', async () => {
    const t = tallyDataQuality()
    expect([t.subscribers, t.page_views, t.without_utm]).toEqual([SUBSCRIBERS, WEB_ROWS, WEB_ROWS_WITHOUT_UTM])
    const body = await (await get('data-quality')).json<DataQuality>()
    expect(body.checks.map((c) => c.key)).toEqual([...DATA_QUALITY_CHECKS])
    const counts = Object.fromEntries(body.checks.map((c) => [c.key, { count: c.count, of: c.of, rate: c.rate }]))
    const expected = (count: number, of: number) => ({ count, of, rate: round4(count, of) })
    expect(counts).toEqual({
      subscribers_without_source: expected(t.without_source, SUBSCRIBERS),
      subscribers_unexpected_source: expected(t.unexpected_source, SUBSCRIBERS),
      page_views_without_utm: expected(WEB_ROWS_WITHOUT_UTM, WEB_ROWS),
      page_views_unexpected_utm: expected(t.unexpected_utm, WEB_ROWS),
      app_users_not_on_list: expected(APP_ONLY, APP_ACCOUNTS),
    })
  })

  it('every check carries an askable explain question, and the UI union is the worker list', async () => {
    const body = await (await get('data-quality')).json<DataQuality>()
    const explains = body.checks.map((c) => c.explain)
    explains.forEach(expectAskable)
    expect(new Set(explains).size).toBe(explains.length)
    for (const c of body.checks) if (c.key.startsWith('subscribers_')) expect(c.explain).toContain('including unsubscribed')
    // src/types.ts restates the keys (the browser project cannot import the worker module); this fails to compile if they drift.
    const sameKeys: [UiCheckKey] extends [(typeof DATA_QUALITY_CHECKS)[number]]
      ? [(typeof DATA_QUALITY_CHECKS)[number]] extends [UiCheckKey]
        ? true
        : false
      : false = true
    expect(sameKeys).toBe(true)
  })

  // On the seed three checks are 0, so the tests above cannot tell a working check from one that
  // always says 0. Here each gap is made once by editing real rows (09 D-47): a removed source, the
  // raw spelling `twitter` (it occurs in data/web_events.csv; ingest folds it to `x`) stored as if
  // normalization had been skipped, and a copy of a real page view that has no UTM. Every edit is
  // undone in `finally`, so the seed-count tests keep their numbers.
  it('each check counts a gap made from real rows, and only its own: +1 each, page views +1 (09 D-47)', async () => {
    const web = parseCsv(webCsv)
    const utmColumn = column(web, 'utm_source')
    expect(web.rows.some((row) => row[utmColumn] === 'twitter')).toBe(true)
    expect(CANONICAL_SOURCES).not.toContain('twitter')

    const checks = async () => {
      const body = await (await get('data-quality')).json<DataQuality>()
      return Object.fromEntries(body.checks.map((c) => [c.key, { count: c.count, of: c.of }])) as Record<
        DataQualityCheckKey,
        { count: number; of: number }
      >
    }
    const before = await checks()
    const { results: subs } = await env.DB.prepare(
      'SELECT email_norm, source FROM subscribers WHERE source IS NOT NULL ORDER BY email_norm LIMIT 2',
    ).all<{ email_norm: string; source: string }>()
    const tagged = await env.DB.prepare('SELECT id, utm_source FROM web_events WHERE utm_source IS NOT NULL ORDER BY id LIMIT 1').first<{
      id: number
      utm_source: string
    }>()
    const untagged = await env.DB.prepare('SELECT visitor_id, page, event_ts FROM web_events WHERE utm_source IS NULL ORDER BY id LIMIT 1').first<{
      visitor_id: string
      page: string
      event_ts: string
    }>()
    const [noSource, rawSource] = subs
    if (noSource === undefined || rawSource === undefined || tagged === null || untagged === null) {
      throw new Error('insights test: the seed has no rows to edit')
    }

    let copiedId: number | undefined
    try {
      const [, , , copy] = await env.DB.batch([
        env.DB.prepare('UPDATE subscribers SET source = NULL WHERE email_norm = ?').bind(noSource.email_norm),
        env.DB.prepare("UPDATE subscribers SET source = 'twitter' WHERE email_norm = ?").bind(rawSource.email_norm),
        env.DB.prepare("UPDATE web_events SET utm_source = 'twitter' WHERE id = ?").bind(tagged.id),
        env.DB.prepare('INSERT INTO web_events (visitor_id, page, event_ts, utm_source) VALUES (?, ?, ?, NULL)').bind(
          untagged.visitor_id,
          untagged.page,
          untagged.event_ts,
        ),
      ])
      copiedId = copy?.meta.last_row_id
      const plus = (k: DataQualityCheckKey, count: number, of: number) => ({ count: before[k].count + count, of: before[k].of + of })
      expect(await checks()).toEqual({
        subscribers_without_source: plus('subscribers_without_source', 1, 0),
        subscribers_unexpected_source: plus('subscribers_unexpected_source', 1, 0),
        page_views_without_utm: plus('page_views_without_utm', 1, 1),
        page_views_unexpected_utm: plus('page_views_unexpected_utm', 1, 1),
        app_users_not_on_list: plus('app_users_not_on_list', 0, 0),
      })
    } finally {
      await env.DB.batch([
        env.DB.prepare('UPDATE subscribers SET source = ? WHERE email_norm = ?').bind(noSource.source, noSource.email_norm),
        env.DB.prepare('UPDATE subscribers SET source = ? WHERE email_norm = ?').bind(rawSource.source, rawSource.email_norm),
        env.DB.prepare('UPDATE web_events SET utm_source = ? WHERE id = ?').bind(tagged.utm_source, tagged.id),
        env.DB.prepare('DELETE FROM web_events WHERE id = ?').bind(copiedId ?? -1),
      ])
    }
    expect(await checks()).toEqual(before)
  })

  it('fails loud with a 500 when import_runs and quarantine disagree on how many rows were set aside', async () => {
    await env.DB.prepare("UPDATE import_runs SET quarantined = quarantined + 1 WHERE file = 'subscribers'").run()
    try {
      const res = await get('data-quality')
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({
        error: 'internal_error',
        message: 'Something went wrong on the server. The error has been logged.',
      })
    } finally {
      await env.DB.prepare("UPDATE import_runs SET quarantined = quarantined - 1 WHERE file = 'subscribers'").run()
    }
    expect((await get('data-quality')).status).toBe(200)
  })
})
