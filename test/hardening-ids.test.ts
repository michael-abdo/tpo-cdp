import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { pkeyForEmail } from '../shared/pseudonym'
import type { Lookup } from '../src/types'
import { buildSeed } from '../worker/ingest/link'
import { seedSql } from '../worker/ingest/sql'
import { ingestSubscribers } from '../worker/ingest/subscribers'
import { csvTimestampToIso, ingestWeb } from '../worker/ingest/web'
import { loginCookie } from './helpers/auth'
import { piiKeySecret, realCsvs } from './helpers/seed'
import { JOY, rowAt, SECOND_ACCOUNT, SECOND_VISITOR, sharedIdCsvs } from './helpers/shared-ids'

// 09 D-70 items 4 and 9, tests 08 T-HARD-4 and T-HARD-9 (item 8 is T-HARD-8 in
// test/normalize.test.ts, beside T-NORM-3; the page half of item 4 is test/ui/lookup-profile.test.ts).
// 02 §Counts is unchanged by both items: the real seed has no shared identifier, no /subscribe
// variant and no blank source on a real row, which T-ING-1..6 and the count tests prove on the real
// files. Inputs, all derived from real rows (09 D-47: every value introduced occurs in data/*.csv
// or is a removal):
// - T-HARD-4: joy.hall830 with a second app account and a second web visitor, as
//   test/helpers/shared-ids.ts derives them.
// - T-HARD-9 /subscribe variants: joy's /subscribe row with the page given a query built from
//   the file's own column name and value (`?utm_source=instagram`) or a trailing slash; every
//   /subscribe row of the real file rewritten the same way; real pages (/about, /), real pages
//   joined under /subscribe (/subscribe/about) and /subscribe with a letter removed, with an email.
// - T-HARD-9 sources: chloe.reed603's real pair (subscribers.csv:70 and :2269, 2026-08-12,
//   Instagram) with the source removed from one row and the signup set to 2026-07-01 or
//   2026-07-20 (both occur in subscribers.csv), or the source set to Facebook (also in the file).

const JOY_SUBSCRIBE_TS = csvTimestampToIso('2026-09-02 20:40:04')

let cookie: string

beforeAll(async () => {
  // The production seed path (parseCsv → buildSeed → seedSql), as test/helpers/seed.ts takes it,
  // on the derived files instead of the real ones. Storage is isolated per test file.
  const seed = await buildSeed(sharedIdCsvs(), piiKeySecret())
  const ranAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  for (const file of seedSql(seed, ranAt)) await env.DB.batch(file.statements.map((s) => env.DB.prepare(s)))
  cookie = await loginCookie()
})

async function get<T>(path: string): Promise<T> {
  const res = await SELF.fetch(`http://cdp.test${path}`, { headers: { cookie } })
  expect(res.status, path).toBe(200)
  return res.json<T>()
}

const lookup = (q: string) => get<Lookup>(`/api/lookup?${new URLSearchParams({ q })}`)

describe('T-HARD-4 lookup returns every app account and web visitor of one profile (09 D-70 item 4)', () => {
  it('the derived seed holds two app accounts and two linked visitors for joy', async () => {
    const n = (sql: string) => env.DB.prepare(sql).bind(JOY).first<number>('n')
    expect(await n('SELECT count(*) AS n FROM app_users WHERE email_norm = ?')).toBe(2)
    expect(await n('SELECT count(*) AS n FROM web_visitors WHERE email_norm = ?')).toBe(2)
  })

  it('by email: app.accounts and web.visitors list both, earliest first; the single-object fields are the first', async () => {
    const body = await lookup(JOY)
    expect(body.profile.pkey).toBe(await pkeyForEmail(piiKeySecret(), JOY))

    const app = body.app!
    expect(app.accounts.map((a) => [a.user_id, a.created_at, a.from_csv])).toEqual([
      [SECOND_ACCOUNT, '2026-08-22', true],
      ['u_ceed5f12', '2026-09-03', true],
    ])
    const { accounts, ...firstAccount } = app
    expect(firstAccount).toEqual(accounts[0])

    const web = body.web!
    expect(web.visitors.map((v) => v.visitor_id)).toEqual([SECOND_VISITOR, 'v_c9e136fd6d'])
    const { visitors, ...firstVisitor } = web
    expect(firstVisitor).toEqual(visitors[0])
    const [other, own] = visitors
    expect(own.events).toHaveLength(9)
    expect(own.events.filter((e) => e.pre_signup)).toHaveLength(3)
    expect(other.events).toHaveLength(3) // its 1 real row + the copied '/' and /subscribe rows
    // The earliest is neither the lowest id nor the first inserted (test/helpers/shared-ids.ts).
    expect(SECOND_ACCOUNT > 'u_ceed5f12' && SECOND_VISITOR > 'v_c9e136fd6d').toBe(true)
    for (const v of visitors)
      for (const e of v.events) expect(e.pre_signup, `${v.visitor_id} ${e.event_ts}`).toBe(e.event_ts < JOY_SUBSCRIBE_TS!)
  })

  it('has_app, app_after_signup and the first page read the earliest account and visitor, as v_profiles does', async () => {
    const body = await lookup(JOY)
    const view = await env.DB.prepare(
      'SELECT has_app, app_after_signup, first_page, first_utm_source FROM v_profiles WHERE pkey = ?',
    )
      .bind(body.profile.pkey)
      .first<{ has_app: number; app_after_signup: number; first_page: string; first_utm_source: string | null }>()
    expect(view).toEqual({ has_app: 1, app_after_signup: 0, first_page: '/', first_utm_source: null })
    expect(body.profile.has_app).toBe(true)
    // The earliest account (2026-08-22) predates her 2026-09-02 signup.
    expect(body.profile.app_after_signup).toBe(false)
    expect([body.web!.first_page, body.web!.first_utm_source]).toEqual([view!.first_page, view!.first_utm_source])
  })

  it('each account id and each visitor id opens the same whole profile', async () => {
    const byEmail = await lookup(JOY)
    for (const q of [SECOND_ACCOUNT, 'u_ceed5f12', SECOND_VISITOR, 'v_c9e136fd6d']) expect(await lookup(q), q).toEqual(byEmail)
  })

  it('partial lookup lists the profile once: by email with its earliest account, by a user id prefix with the lowest matching id', async () => {
    type Search = { matches: { pkey: string; email: string | null; user_id: string | null }[] }
    const pkey = await pkeyForEmail(piiKeySecret(), JOY)
    const byEmail = await get<Search>('/api/lookup/search?q=joy.hall830')
    expect(byEmail.matches).toEqual([expect.objectContaining({ pkey, email: JOY, user_id: SECOND_ACCOUNT })])
    // Both accounts start with u_ceed5f; 04 names the lowest matching user_id for this group.
    const byUser = await get<Search>('/api/lookup/search?q=u_ceed5f')
    expect(byUser.matches).toEqual([expect.objectContaining({ pkey, email: JOY, user_id: 'u_ceed5f12' })])
    const bySecond = await get<Search>(`/api/lookup/search?q=${SECOND_ACCOUNT}`)
    expect(bySecond.matches).toEqual([expect.objectContaining({ pkey, email: JOY, user_id: SECOND_ACCOUNT })])
  })
})

describe('T-HARD-9 seed robustness: /subscribe variants link, earliest non-blank source wins (09 D-70 item 9)', () => {
  const visitorOf = (rows: string[][]) => {
    const web = realCsvs().web_events
    return ingestWeb({ header: web.header, rows, lineNos: rows.map((_, i) => 5421 + i) })
  }

  it('a /subscribe row with a query string or a trailing slash links its visitor; the page is stored as written', () => {
    const subscribe = rowAt(realCsvs().web_events, 5421)
    for (const page of ['/subscribe?utm_source=instagram', '/subscribe/', '/subscribe/?utm_source=instagram']) {
      const result = visitorOf([[subscribe[0], page, ...subscribe.slice(2)]])
      expect(result.visitors.get('v_c9e136fd6d'), page).toMatchObject({ email_norm: JOY, signup_ts: JOY_SUBSCRIBE_TS })
      expect(result.events[0].page).toBe(page)
    }
  })

  it('an email on any other page still fails the seed loudly, even one that starts with /subscribe', () => {
    const subscribe = rowAt(realCsvs().web_events, 5421)
    // Real pages, real pages joined under /subscribe, and /subscribe with its last letter removed:
    // only the exact path /subscribe (query string and one trailing slash removed) links.
    const pages = ['/about', '/', '/about?utm_source=instagram', '/subscribe/about', '/subscribe/news/ai-regulation-bill']
    pages.push('/subscribe/about?utm_source=instagram', '/subscrib', '/subscrib?utm_source=instagram', '/subscrib/')
    for (const page of pages)
      expect(() => visitorOf([[subscribe[0], page, ...subscribe.slice(2)]]), page).toThrow('only /subscribe rows link')
  })

  it('every real /subscribe row rewritten as /subscribe/ or with a query links the same 1,400 visitors', () => {
    const real = ingestWeb(realCsvs().web_events)
    const linked = (r: ReturnType<typeof ingestWeb>) =>
      [...r.visitors.values()].filter((v) => v.email_norm !== null).map((v) => [v.visitor_id, v.email_norm, v.signup_ts])
    expect(linked(real)).toHaveLength(1400)
    for (const suffix of ['/', '?utm_source=instagram']) {
      const web = realCsvs().web_events
      const page = web.header.indexOf('page')
      web.rows = web.rows.map((r) => (r[page] === '/subscribe' ? r.map((f, i) => (i === page ? f + suffix : f)) : r))
      expect(linked(ingestWeb(web)), suffix).toEqual(linked(real))
    }
  })

  describe('source = the earliest-signup row whose source is not blank', () => {
    const subscribers = realCsvs().subscribers
    const merged = (rows: string[][]) =>
      ingestSubscribers({ header: subscribers.header, rows, lineNos: rows.map((_, i) => 70 + i) }).subscribers.get(
        'chloe.reed603@yahoo.com',
      )
    const real70 = rowAt(subscribers, 70)
    const real2269 = rowAt(subscribers, 2269)
    /** Line 70 with the earliest signup and its source removed. */
    const earliestBlank = [real70[0], '2026-07-01', real70[2], '', real70[4]]
    /** Line 70 with a middle signup and another real source. */
    const middleFacebook = [real70[0], '2026-07-20', real70[2], 'Facebook', real70[4]]

    it('starts from the real pair: both rows 2026-08-12, Instagram', () => {
      expect([real70[1], real70[3], real2269[1], real2269[3]]).toEqual(['2026-08-12', 'Instagram', '2026-08-12', 'Instagram'])
    })

    it('a blank source on the earliest row loses to a later real one, in either order', () => {
      for (const rows of [[earliestBlank, real2269], [real2269, earliestBlank]]) {
        expect(merged(rows)).toMatchObject({ signup_date: '2026-07-01', source: 'instagram', merged_count: 2 })
      }
    })

    it('among non-blank rows the earliest signup still wins, whatever the order of three rows', () => {
      const rows = [earliestBlank, middleFacebook, real2269]
      for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
        expect(merged(order.map((i) => rows[i])), order.join()).toMatchObject({
          signup_date: '2026-07-01',
          source: 'facebook',
          merged_count: 3,
        })
      }
    })

    it('on a signup tie the earlier-seen non-blank row wins, in either order', () => {
      // The real pair shares 2026-08-12; line 70 given Facebook (in the file) instead of Instagram.
      const facebook70 = [real70[0], real70[1], real70[2], 'Facebook', real70[4]]
      expect(merged([facebook70, real2269])?.source).toBe('facebook')
      expect(merged([real2269, facebook70])?.source).toBe('instagram')
    })

    it('blank only when every row is blank', () => {
      const blank2269 = [...real2269.slice(0, 3), '', real2269[4]]
      expect(merged([earliestBlank, blank2269])?.source).toBeNull()
      expect(merged([blank2269, earliestBlank])?.source).toBeNull()
    })
  })
})
