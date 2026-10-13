/// <reference types="vite/client" />
import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import appCsv from '../data/app_users.csv?raw'
import subscribersCsv from '../data/subscribers.csv?raw'
import webCsv from '../data/web_events.csv?raw'
import { canonicalSource, normalizeEmail } from '../shared/normalize'
import { sanitizeQuestion } from '../worker/assistant/gates/gate1-input-sanitizer'
import { parseCsv } from '../worker/ingest/csv'
import type { Funnel } from '../worker/insights/funnel'
import type { SourceAppConversion } from '../worker/insights/source-app'
import { loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'

// GET /api/insights/source-app-conversion and /api/insights/funnel (04 §GET /api/insights/…,
// 06 §/growth; R6). T-INS-1 and T-INS-2 (08). The test D1 holds the real seed of data/*.csv
// (test/helpers/seed.ts) and no webhook events. Expected totals are 02 §Counts; the per-group
// numbers are checked against independent tallies of the ?raw CSVs in TypeScript (the one
// normalization from shared/normalize.ts, then plain loops), never against SQL.

const SUBSCRIBERS = 2900
const APP_USERS_MATCHING_A_SUBSCRIBER = 900
const APP_CREATED_BEFORE_SIGNUP = 457
const APP_CREATED_AFTER_SIGNUP = 432
const APP_CREATED_SAME_DAY = 11
const VISITORS = 2028
const LINKED_VISITORS = 1400
const ANONYMOUS_VISITORS = 628
const DISTINCT_PAGES = 16

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
    for (const row of body.by_source) expect(row.explain).toContain(`"${row.source}"`)
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
  it('401 without a session cookie on both routes', async () => {
    for (const path of ['source-app-conversion', 'funnel']) {
      const res = await get(path, {})
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Sign in to continue.' })
    }
  })

  it('the parked panels have no route (04 [parked])', async () => {
    for (const path of ['going-cold', 'data-quality']) expect((await get(path)).status).toBe(404)
  })
})
