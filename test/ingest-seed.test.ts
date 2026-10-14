/// <reference types="vite/client" />
import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import appCsv from '../data/app_users.csv?raw'
import subscribersCsv from '../data/subscribers.csv?raw'
import webCsv from '../data/web_events.csv?raw'
import { DEFINITIONS, engagementScore } from '../shared/derive'
import { CANONICAL_SOURCES } from '../shared/normalize'
import { PII_COLUMNS, RAW_ID_REGEX } from '../shared/pii'
import { pkeyForEmail, visitorHash } from '../shared/pseudonym'
import { classifyAppRow, ingestApp, APP_COLUMNS } from '../worker/ingest/app'
import { parseCsv, type ParsedCsv } from '../worker/ingest/csv'
import { buildSeed, type Seed } from '../worker/ingest/link'
import { requireHeaders } from '../worker/ingest/quarantine'
import { MAX_ROWS_PER_INSERT, MAX_STATEMENT_BYTES, seedSql, type SeedFile } from '../worker/ingest/sql'
import { ingestSubscribers, toCsvRecord } from '../worker/ingest/subscribers'
import { classifyWebRow, csvTimestampToIso, ingestWeb, WEB_COLUMNS } from '../worker/ingest/web'
import { piiKeySecret, realCsvs, seedDatabase } from './helpers/seed'

// 02 §Linking, §Derived, §Time, §Counts; 11 §Seed; 09 D-08, D-44, D-46. Tests 08 T-ING-1, -5, -6.
// Input is the three real data/*.csv files and the PII_KEY_SECRET from .dev.vars. The pure
// pipeline's SQL is executed into the test D1 by test/helpers/seed.ts, then counts are read
// back from the tables and views. Every expected number is from 02 §Counts.
// Tests that change real rows (09 D-47), and how:
// - missing header: "timestamp" deleted from the real web header, "created_at" from the app header.
// - web missing_field: the timestamp of real web line 5421 emptied.
// - web bad_date: the time part removed from that timestamp, leaving 2026-09-02.
// - web invalid_email: that row's email replaced by "@gmail.com" (subscribers.csv:1788).
// - app missing_field: the created_at of real app line 303 emptied.
// - app invalid_email: that row's email replaced by "not-an-email" (subscribers.csv:1750).
// - import report: the whole real seed rebuilt with web line 5421 date-only and app line 303
//   set to "not-an-email" (the two edits above), to check both reach the emitted quarantine SQL.

const JOY = 'joy.hall830@protonmail.com'
const JULIA = 'julia.evans230@gmail.com'
const ISAAC_RAW = 'ISAAC.TAYLOR434@PROTONMAIL.COM'

const secret = piiKeySecret

let seed: Seed
let files: SeedFile[]
let RAN_AT: string

beforeAll(async () => {
  ;({ seed, files, ranAt: RAN_AT } = await seedDatabase())
})

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...params)
    .first<{ n: number }>()
  if (!row) throw new Error(`no row from: ${sql}`)
  return row.n
}

describe('T-ING-1 the emitted seed loads and its counts equal 02 §Counts', () => {
  it('table counts', async () => {
    expect(await count('SELECT count(*) AS n FROM subscribers')).toBe(2900)
    expect(await count('SELECT count(*) AS n FROM web_events')).toBe(10000)
    expect(await count('SELECT count(*) AS n FROM web_visitors')).toBe(2028)
    expect(await count('SELECT count(*) AS n FROM app_users')).toBe(930)
    expect(await count('SELECT count(*) AS n FROM profiles')).toBe(2930)
    expect(await count("SELECT count(*) AS n FROM profiles WHERE kind = 'subscriber'")).toBe(2900)
    // 09 D-78(b): the seed itself creates no unknown_user_stub profiles (those arrive only by
    // webhook), so migrations/0011's new profiles.user_id column and v_app_events join move no
    // 02 §Counts number on the seed data.
    expect(await count("SELECT count(*) AS n FROM profiles WHERE kind = 'unknown_user_stub'")).toBe(0)
    expect(await count('SELECT count(*) AS n FROM profiles WHERE user_id IS NOT NULL')).toBe(0)
  })

  it('import_runs has one row per file with rows_in, rows_out, merged, quarantined', async () => {
    const { results } = await env.DB.prepare(
      'SELECT file, rows_in, rows_out, merged, quarantined, ran_at FROM import_runs ORDER BY id',
    ).all<{
      file: string
      rows_in: number
      rows_out: number
      merged: number
      quarantined: number
      ran_at: string
    }>()
    expect(results.map(({ ran_at: _ranAt, ...r }) => r)).toEqual([
      { file: 'subscribers', rows_in: 2995, rows_out: 2900, merged: 85, quarantined: 10 },
      { file: 'web_events', rows_in: 10000, rows_out: 10000, merged: 0, quarantined: 0 },
      { file: 'app_users', rows_in: 930, rows_out: 930, merged: 0, quarantined: 0 },
    ])
    for (const r of results) expect(r.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('quarantine holds the 8 blank rows and 2 invalid emails against the subscribers run', async () => {
    const { results } = await env.DB.prepare(
      'SELECT q.reason, count(*) AS n FROM quarantine q JOIN import_runs r ON r.id = q.run_id ' +
        "WHERE r.file = 'subscribers' AND q.file = 'subscribers' GROUP BY q.reason ORDER BY q.reason",
    ).all<{ reason: string; n: number }>()
    expect(results).toEqual([
      { reason: 'blank_row', n: 8 },
      { reason: 'invalid_email', n: 2 },
    ])
    expect(await count('SELECT count(*) AS n FROM quarantine')).toBe(10)
  })

  it('every INSERT has at most 250 rows and stays under 100 KB; no BEGIN/COMMIT', () => {
    expect(files.map((f) => f.name)).toEqual([
      '0001_subscribers.sql',
      '0002_web.sql',
      '0003_app.sql',
      '0004_import_report.sql',
    ])
    const encoder = new TextEncoder()
    for (const file of files) {
      for (const s of file.statements) {
        expect(s.startsWith('INSERT INTO ')).toBe(true)
        expect(encoder.encode(s).length).toBeLessThan(MAX_STATEMENT_BYTES)
      }
      expect(file.statements.join('\n')).not.toMatch(/\b(BEGIN|COMMIT)\b/)
    }
    const perTable = (name: string, table: string) =>
      files.find((f) => f.name === name)!.statements.filter((s) => s.startsWith(`INSERT INTO ${table} `))
        .length
    // ⌈rows / 250⌉ statements per table: 250 is the binding limit on this data.
    expect(MAX_ROWS_PER_INSERT).toBe(250)
    expect(perTable('0002_web.sql', 'web_events')).toBe(10000 / 250)
    expect(perTable('0002_web.sql', 'web_visitors')).toBe(Math.ceil(2028 / 250))
    expect(perTable('0001_subscribers.sql', 'subscribers')).toBe(Math.ceil(2900 / 250))
    expect(perTable('0003_app.sql', 'app_users')).toBe(Math.ceil(930 / 250))
  })

  it('blank UTM is stored as NULL and sources are canonical (twitter → x)', async () => {
    expect(await count('SELECT count(*) AS n FROM web_events WHERE utm_source IS NULL')).toBe(8030)
    expect(await count("SELECT count(*) AS n FROM web_events WHERE utm_source = 'x'")).toBe(50)
    expect(await count("SELECT count(*) AS n FROM web_events WHERE utm_source = 'twitter'")).toBe(0)
    // web_visitors.first_utm_source feeds v_profiles and v_funnel and is canonical too.
    expect(await count("SELECT count(*) AS n FROM web_visitors WHERE first_utm_source = 'twitter'")).toBe(0)
    expect(
      await count("SELECT count(*) AS n FROM web_visitors WHERE first_utm_source = 'x'"),
    ).toBeGreaterThan(0)
    const { results } = await env.DB.prepare(
      'SELECT DISTINCT first_utm_source AS s FROM web_visitors WHERE first_utm_source IS NOT NULL',
    ).all<{ s: string }>()
    const canonical: readonly string[] = CANONICAL_SOURCES
    expect(results.map((r) => r.s).filter((v) => !canonical.includes(v))).toEqual([])
  })

  it('first_seen_ts, first_page and first_utm_source all come from the earliest event (09 D-49)', async () => {
    // first_seen_ts is the visitor's earliest event_ts (v_profiles orders first visits by it).
    expect(
      await count(
        'SELECT count(*) AS n FROM web_visitors v WHERE v.first_seen_ts <> (SELECT min(e.event_ts) FROM web_events e WHERE e.visitor_id = v.visitor_id)',
      ),
    ).toBe(0)
    // Page and UTM are that same event's, NULL UTM included (IS NOT compares NULLs).
    expect(
      await count(
        'SELECT count(*) AS n FROM web_visitors v JOIN web_events e ON e.visitor_id = v.visitor_id AND e.event_ts = v.first_seen_ts WHERE e.utm_source IS NOT v.first_utm_source OR e.page <> v.first_page',
      ),
    ).toBe(0)
    // The rule matters on this data: some visitors landed without a UTM and carried one later,
    // so a "first non-empty UTM" rule would give them a different first_utm_source.
    expect(
      await count(
        'SELECT count(*) AS n FROM web_visitors v WHERE v.first_utm_source IS NULL AND EXISTS (SELECT 1 FROM web_events e WHERE e.visitor_id = v.visitor_id AND e.utm_source IS NOT NULL)',
      ),
    ).toBeGreaterThan(0)
  })

  it('web timestamps are stored as ISO-8601 UTC', async () => {
    expect(csvTimestampToIso('2026-09-02 20:40:04')).toBe('2026-09-02T20:40:04Z')
    const { results } = await env.DB.prepare('SELECT event_ts FROM web_events').all<{ event_ts: string }>()
    expect(results).toHaveLength(10000)
    expect(results.filter((r) => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r.event_ts))).toEqual([])
  })
})

describe('T-ING-5 web → subscriber linking (02 §Linking 2–3, D-08)', () => {
  it('1,400 visitors carry an email_norm and every one matches a subscriber; 628 are anonymous', async () => {
    expect(await count('SELECT count(*) AS n FROM web_visitors WHERE email_norm IS NOT NULL')).toBe(1400)
    expect(
      await count(
        'SELECT count(*) AS n FROM web_visitors v JOIN subscribers s ON s.email_norm = v.email_norm',
      ),
    ).toBe(1400)
    expect(await count('SELECT count(*) AS n FROM web_visitors WHERE email_norm IS NULL')).toBe(628)
    expect(
      await count(
        'SELECT count(*) AS n FROM web_events e JOIN web_visitors v ON v.visitor_id = e.visitor_id WHERE v.email_norm IS NULL',
      ),
    ).toBe(1559)
    expect(seed.subscribe_emails_without_subscriber).toBe(0)
  })

  it(`${ISAAC_RAW} links after normalization`, async () => {
    const parsed = parseCsv(webCsv)
    const i = parsed.rows.findIndex((r) => r[4] === ISAAC_RAW)
    expect(i).toBeGreaterThan(-1)
    const visitorId = parsed.rows[i][0]
    const row = await env.DB.prepare(
      'SELECT v.email_norm, s.email_norm AS subscriber FROM web_visitors v LEFT JOIN subscribers s ON s.email_norm = v.email_norm WHERE v.visitor_id = ?',
    )
      .bind(visitorId)
      .first<{ email_norm: string; subscriber: string | null }>()
    expect(row).toEqual({
      email_norm: 'isaac.taylor434@protonmail.com',
      subscriber: 'isaac.taylor434@protonmail.com',
    })
    const pkey = await pkeyForEmail(secret(), 'isaac.taylor434@protonmail.com')
    expect(await count('SELECT count(*) AS n FROM v_web_events WHERE pkey = ?', pkey)).toBeGreaterThan(0)
  })

  it("joy's visitor v_c9e136fd6d has 9 events, 3 before her /subscribe row, all on her profile", async () => {
    expect(
      await env.DB.prepare('SELECT email_norm FROM web_visitors WHERE visitor_id = ?')
        .bind('v_c9e136fd6d')
        .first('email_norm'),
    ).toBe(JOY)
    const subscribeTs = csvTimestampToIso('2026-09-02 20:40:04') // web_events.csv:5421, her /subscribe row
    expect(await count('SELECT count(*) AS n FROM web_events WHERE visitor_id = ?', 'v_c9e136fd6d')).toBe(9)
    expect(
      await count(
        'SELECT count(*) AS n FROM web_events WHERE visitor_id = ? AND event_ts < ?',
        'v_c9e136fd6d',
        subscribeTs,
      ),
    ).toBe(3)
    // Her visitor row's first_seen_ts is her earliest event, not her /subscribe row or a later one.
    const earliest = await env.DB.prepare('SELECT min(event_ts) AS ts FROM web_events WHERE visitor_id = ?')
      .bind('v_c9e136fd6d')
      .first<string>('ts')
    expect(earliest).not.toBeNull()
    expect(subscribeTs).not.toBeNull()
    expect(earliest! < subscribeTs!).toBe(true)
    expect(
      await env.DB.prepare('SELECT first_seen_ts FROM web_visitors WHERE visitor_id = ?')
        .bind('v_c9e136fd6d')
        .first('first_seen_ts'),
    ).toBe(earliest)
    // Through the PII-free view: the whole history, before and after signup, carries her pkey.
    const pkey = await pkeyForEmail(secret(), JOY)
    expect(await count('SELECT count(*) AS n FROM v_web_events WHERE pkey = ?', pkey)).toBe(9)
    expect(
      await count(
        'SELECT count(*) AS n FROM v_web_events WHERE pkey = ? AND event_ts < ?',
        pkey,
        subscribeTs,
      ),
    ).toBe(3)
  })

  it('visitor_hash is visitorHash(PII_KEY_SECRET, visitor_id); no raw v_ id reaches v_web_events', async () => {
    expect(
      await env.DB.prepare('SELECT visitor_hash FROM web_visitors WHERE visitor_id = ?')
        .bind('v_c9e136fd6d')
        .first('visitor_hash'),
    ).toBe(await visitorHash(secret(), 'v_c9e136fd6d'))
    const { results } = await env.DB.prepare('SELECT DISTINCT visitor_hash FROM v_web_events').all<{
      visitor_hash: string
    }>()
    expect(results).toHaveLength(2028)
    expect(results.filter((r) => RAW_ID_REGEX.test(r.visitor_hash))).toEqual([])
  })

  it('1,144 linked visitors have pre-signup views, 1,930 events in all', async () => {
    // The /subscribe row carrying the email is the signup moment; it comes from the file
    // because the event rows do not keep the email.
    const parsed = parseCsv(webCsv)
    const signupTs = new Map<string, string>()
    parsed.rows.forEach((r) => {
      if (r[4].trim() !== '') signupTs.set(r[0], csvTimestampToIso(r[2])!)
    })
    const { results } = await env.DB.prepare(
      'SELECT e.visitor_id, e.event_ts FROM web_events e JOIN web_visitors v ON v.visitor_id = e.visitor_id WHERE v.email_norm IS NOT NULL',
    ).all<{ visitor_id: string; event_ts: string }>()
    const pre = results.filter((e) => e.event_ts < signupTs.get(e.visitor_id)!)
    expect(new Set(pre.map((e) => e.visitor_id)).size).toBe(1144)
    expect(pre).toHaveLength(1930)
  })
})

describe('T-ING-6 app → subscriber linking and app-only profiles (02 §Linking 1)', () => {
  it('900 app users link to a subscriber; 30 app_only profiles, all appuserN emails', async () => {
    expect(
      await count('SELECT count(*) AS n FROM app_users a JOIN subscribers s ON s.email_norm = a.email_norm'),
    ).toBe(900)
    const { results } = await env.DB.prepare(
      "SELECT p.email_norm, p.created_at, a.created_at AS app_created_at FROM profiles p JOIN app_users a ON a.email_norm = p.email_norm WHERE p.kind = 'app_only'",
    ).all<{ email_norm: string; created_at: string; app_created_at: string }>()
    expect(results).toHaveLength(30)
    expect(await count("SELECT count(*) AS n FROM profiles WHERE kind = 'app_only'")).toBe(30)
    for (const r of results) {
      expect(r.email_norm).toMatch(/^appuser\d+@gmail\.com$/)
      expect(r.created_at).toBe(r.app_created_at) // 09 D-44
    }
    expect(await count('SELECT count(*) AS n FROM app_users WHERE from_csv = 1')).toBe(930)
  })

  it('457 created before signup, 432 after, 11 the same day; 98 unsubscribed from email', async () => {
    const join =
      'SELECT count(*) AS n FROM app_users a JOIN subscribers s ON s.email_norm = a.email_norm WHERE '
    expect(await count(join + 'a.created_at < s.signup_date')).toBe(457)
    expect(await count(join + 'a.created_at > s.signup_date')).toBe(432)
    expect(await count(join + 'a.created_at = s.signup_date')).toBe(11)
    expect(await count(join + "s.status = 'unsubscribed'")).toBe(98)
    // v_profiles counts only strictly-after as app_after_signup: the 11 same-day are not in it.
    expect(
      await count("SELECT count(*) AS n FROM v_profiles WHERE kind = 'subscriber' AND app_after_signup = 1"),
    ).toBe(432)
  })
})

describe('profiles through v_profiles (02 §Derived, §Counts demo subjects; D-44, D-46)', () => {
  it('returns 2,930 rows and no PII column', async () => {
    const { results } = await env.DB.prepare('SELECT * FROM v_profiles').all<Record<string, unknown>>()
    expect(results).toHaveLength(2930)
    const columns = Object.keys(results[0])
    for (const pii of PII_COLUMNS) expect(columns).not.toContain(pii)
    expect(columns.some((c) => c.includes('email'))).toBe(false)
  })

  it("joy: has_app, app after signup, first page '/', first UTM instagram, cold_since 2026-10-22", async () => {
    const row = await env.DB.prepare('SELECT * FROM v_profiles WHERE pkey = ?')
      .bind(await pkeyForEmail(secret(), JOY))
      .first<Record<string, unknown>>()
    expect(row).toMatchObject({
      kind: 'subscriber',
      signup_date: '2026-09-02',
      source: 'instagram',
      last_open_date: '2026-09-22',
      cold_since: '2026-10-22',
      has_app: 1,
      app_created_at: '2026-09-03',
      app_after_signup: 1,
      first_page: '/',
      first_utm_source: 'instagram',
    })
    // 6 days since open → 40 recency; 9 site visits in the last 30 days → 25 site; 0 app events at seed.
    expect(row?.engagement_score).toBe(
      engagementScore({ last_open_date: '2026-09-22', app_events_last_30d: 0, site_visits_last_30d: 9 }),
    )
    expect(row?.engagement_score).toBe(65)
    expect(
      await env.DB.prepare('SELECT created_at FROM profiles WHERE email_norm = ?')
        .bind(JOY)
        .first('created_at'),
    ).toBe('2026-09-02') // 09 D-44: signup_date
  })

  it('every subscriber profile is created_at signup_date (09 D-44), whatever the app date', async () => {
    expect(
      await count(
        'SELECT count(*) AS n FROM profiles p JOIN subscribers s ON s.email_norm = p.email_norm WHERE p.created_at <> s.signup_date',
      ),
    ).toBe(0)
    // julia's app (2026-08-22) predates her signup, so an earlier-of rule would show here.
    expect(
      await env.DB.prepare('SELECT created_at FROM profiles WHERE email_norm = ?')
        .bind(JULIA)
        .first('created_at'),
    ).toBe('2026-09-13')
  })

  it('engagement_score counts only site visits in the last 30 days relative to TODAY (D-46)', async () => {
    // An independent oracle: count each profile's events by date inside DEFINITIONS.last_n_days(30)
    // and score them with engagementScore (app events are 0 at seed).
    const window = DEFINITIONS.last_n_days.fn(30)
    const { results: visits } = await env.DB.prepare(
      'SELECT pkey, sum(CASE WHEN substr(event_ts, 1, 10) BETWEEN ? AND ? THEN 1 ELSE 0 END) AS in_window, ' +
        'count(*) AS all_time FROM v_web_events WHERE pkey IS NOT NULL GROUP BY pkey',
    )
      .bind(window.from, window.to)
      .all<{ pkey: string; in_window: number; all_time: number }>()
    const byPkey = new Map(visits.map((v) => [v.pkey, v]))
    const { results: profiles } = await env.DB.prepare(
      'SELECT pkey, last_open_date, engagement_score FROM v_profiles',
    ).all<{ pkey: string; last_open_date: string | null; engagement_score: number }>()
    expect(profiles).toHaveLength(2930)
    const scoreWith = (p: (typeof profiles)[number], siteVisits: number) =>
      engagementScore({
        last_open_date: p.last_open_date,
        app_events_last_30d: 0,
        site_visits_last_30d: siteVisits,
      })
    const wrong = profiles.filter(
      (p) => p.engagement_score !== scoreWith(p, byPkey.get(p.pkey)?.in_window ?? 0),
    )
    expect(wrong).toEqual([])
    // The window matters on this data: counting every event would change some stored scores.
    const windowMatters = profiles.filter((p) => {
      const v = byPkey.get(p.pkey)
      return v !== undefined && scoreWith(p, v.all_time) !== scoreWith(p, v.in_window)
    })
    expect(windowMatters.length).toBeGreaterThan(0)
  })

  it('julia.evans230: app before signup is not a conversion, and she has no web history', async () => {
    const row = await env.DB.prepare('SELECT * FROM v_profiles WHERE pkey = ?')
      .bind(await pkeyForEmail(secret(), JULIA))
      .first<Record<string, unknown>>()
    expect(row).toMatchObject({
      signup_date: '2026-09-13',
      cold_since: '2026-10-15',
      has_app: 1,
      app_created_at: '2026-08-22',
      app_after_signup: 0,
      first_page: null,
      first_utm_source: null,
    })
    expect(row?.engagement_score).toBe(
      engagementScore({ last_open_date: '2026-09-15', app_events_last_30d: 0, site_visits_last_30d: 0 }),
    )
  })
})

describe('web and app rows fail fast on headers and are quarantined, never dropped (02 §Quarantine)', () => {
  const web = () => parseCsv(webCsv)
  const app = () => parseCsv(appCsv)
  const webRowAt = (lineNo: number) => [...web().rows[web().lineNos.indexOf(lineNo)]]
  const appRowAt = (lineNo: number) => [...app().rows[app().lineNos.indexOf(lineNo)]]

  it('a missing header column names the file and the column', () => {
    const w = web()
    const wHeader = w.header.filter((h) => h !== 'timestamp')
    expect(() => requireHeaders('web_events.csv', wHeader, WEB_COLUMNS)).toThrow(
      'web_events.csv: missing required column "timestamp"',
    )
    expect(() => ingestWeb({ ...w, header: wHeader })).toThrow('missing required column "timestamp"')
    const a = app()
    const aHeader = a.header.filter((h) => h !== 'created_at')
    expect(() => ingestApp({ ...a, header: aHeader })).toThrow(
      'app_users.csv: missing required column "created_at"',
    )
    expect(APP_COLUMNS).toEqual(a.header)
  })

  it('web: emptied timestamp → missing_field, time removed → bad_date, broken email → invalid_email', () => {
    const { header } = web()
    const joyRow = webRowAt(5421)
    expect(joyRow).toEqual(['v_c9e136fd6d', '/subscribe', '2026-09-02 20:40:04', '', JOY])
    expect(classifyWebRow(header, joyRow)).toBeNull()
    const noTs = webRowAt(5421)
    noTs[2] = ''
    expect(classifyWebRow(header, noTs)).toBe('missing_field')
    const dateOnly = webRowAt(5421)
    dateOnly[2] = '2026-09-02'
    expect(classifyWebRow(header, dateOnly)).toBe('bad_date')
    const badEmail = webRowAt(5421)
    badEmail[4] = '@gmail.com'
    expect(classifyWebRow(header, badEmail)).toBe('invalid_email')

    const result = ingestWeb({ header, rows: [webRowAt(5420), dateOnly], lineNos: [5420, 5421] })
    expect(result.events).toHaveLength(1)
    expect(result.quarantined).toEqual([
      { line_no: 5421, reason: 'bad_date', raw_row: `v_c9e136fd6d,/subscribe,2026-09-02,,${JOY}` },
    ])
  })

  it('app: emptied created_at → missing_field, invalid email → invalid_email', () => {
    const { header } = app()
    const joyRow = appRowAt(303)
    expect(joyRow).toEqual(['u_ceed5f12', JOY, '2026-09-03'])
    expect(classifyAppRow(header, joyRow)).toBeNull()
    const noCreated = appRowAt(303)
    noCreated[2] = ''
    expect(classifyAppRow(header, noCreated)).toBe('missing_field')
    const badEmail = appRowAt(303)
    badEmail[1] = 'not-an-email'
    expect(classifyAppRow(header, badEmail)).toBe('invalid_email')

    const result = ingestApp({ header, rows: [badEmail], lineNos: [303] })
    expect(result.users.size).toBe(0)
    expect(result.quarantined).toEqual([
      { line_no: 303, reason: 'invalid_email', raw_row: 'u_ceed5f12,not-an-email,2026-09-03' },
    ])
  })

  it('web and app quarantine rows reach the emitted import report and import_runs (seedSql → D1)', async () => {
    const w = web()
    const webRows = w.rows.map((r) => [...r])
    webRows[w.lineNos.indexOf(5421)][2] = '2026-09-02'
    const a = app()
    const appRows = a.rows.map((r) => [...r])
    appRows[a.lineNos.indexOf(303)][1] = 'not-an-email'
    const edited = await buildSeed(
      {
        subscribers: parseCsv(subscribersCsv),
        web_events: { ...w, rows: webRows },
        app_users: { ...a, rows: appRows },
      },
      secret(),
    )
    const reportOf = (fs: SeedFile[]) => fs.find((f) => f.name === '0004_import_report.sql')!
    // Storage is per test file, not per test, so the real report is put back whatever happens.
    const loadReport = (f: SeedFile) =>
      env.DB.batch([
        env.DB.prepare('DELETE FROM quarantine'),
        env.DB.prepare('DELETE FROM import_runs'),
        ...f.statements.map((st) => env.DB.prepare(st)),
      ])
    await loadReport(reportOf(seedSql(edited, RAN_AT)))
    try {
      const { results: runs } = await env.DB.prepare(
        'SELECT file, rows_in, rows_out, merged, quarantined FROM import_runs ORDER BY id',
      ).all()
      expect(runs).toEqual([
        { file: 'subscribers', rows_in: 2995, rows_out: 2900, merged: 85, quarantined: 10 },
        { file: 'web_events', rows_in: 10000, rows_out: 9999, merged: 0, quarantined: 1 },
        { file: 'app_users', rows_in: 930, rows_out: 929, merged: 0, quarantined: 1 },
      ])
      const { results: rows } = await env.DB.prepare(
        'SELECT q.file, r.file AS run_file, q.line_no, q.reason, q.raw_row FROM quarantine q ' +
          "JOIN import_runs r ON r.id = q.run_id WHERE q.file <> 'subscribers' ORDER BY q.id",
      ).all()
      expect(rows).toEqual([
        {
          file: 'web_events',
          run_file: 'web_events',
          line_no: 5421,
          reason: 'bad_date',
          raw_row: `v_c9e136fd6d,/subscribe,2026-09-02,,${JOY}`,
        },
        {
          file: 'app_users',
          run_file: 'app_users',
          line_no: 303,
          reason: 'invalid_email',
          raw_row: 'u_ceed5f12,not-an-email,2026-09-03',
        },
      ])
      expect(await count('SELECT count(*) AS n FROM quarantine')).toBe(12)
    } finally {
      await loadReport(reportOf(files))
    }
    expect(await count('SELECT count(*) AS n FROM quarantine')).toBe(10)
    expect(await count('SELECT sum(quarantined) AS n FROM import_runs')).toBe(10)
  })
})

// 09 D-78(a): a CSV value the ingest has no rule for is quarantined with its own reason, never
// thrown, and never aborts the seed. Inputs are real rows minimally edited per 09 D-47 — every
// value introduced already occurs in data/*.csv, or is a removal:
// - unknown_status: subscribers.csv:2 (aaron.moore592@yahoo.com, unsubscribed) with its status
//   changed to "unsubscribe" (the real value with its last character removed, as
//   test/segments.test.ts T-SEG-3 already does for the same reason).
// - duplicate_user_id: app_users.csv:3 (daniel.hill389@gmail.com) with its user_id overwritten
//   by app_users.csv:2's real id (u_2b6447a3), so the same id appears on two rows.
// - conflicting_email: web_events.csv:5421 (joy's real /subscribe row) followed by a second
//   /subscribe row for the same visitor (v_c9e136fd6d) carrying julia.evans230@gmail.com (a real
//   subscriber email) and web_events.csv:5440's real timestamp.
describe('T-ING-7 a row with no rule is quarantined, never fatal (09 D-78)', () => {
  it('subscribers: an unknown status is quarantined, not thrown; every other row is unaffected', () => {
    const subs = parseCsv(subscribersCsv)
    const real = [...subs.rows[subs.lineNos.indexOf(2)]]
    expect(real).toEqual(['aaron.moore592@yahoo.com', '2026-09-11', 'unsubscribed', 'Instagram', '2026-09-17'])
    const unknownStatus = [real[0], real[1], 'unsubscribe', real[3], real[4]]
    const other = [...subs.rows[subs.lineNos.indexOf(70)]]
    const result = ingestSubscribers({ header: subs.header, rows: [unknownStatus, other], lineNos: [2, 70] })
    expect(result.quarantined).toEqual([
      { line_no: 2, reason: 'unknown_status', raw_row: toCsvRecord(unknownStatus) },
    ])
    expect(result.subscribers.size).toBe(1)
    expect(result.subscribers.get('chloe.reed603@yahoo.com')).toMatchObject({ merged_count: 1 })
  })

  it('app_users: a repeated user_id is quarantined, keeping the first row; no other row is affected', () => {
    const a = parseCsv(appCsv)
    const first = [...a.rows[a.lineNos.indexOf(2)]]
    const second = [...a.rows[a.lineNos.indexOf(3)]]
    expect(first).toEqual(['u_2b6447a3', 'julia.evans230@gmail.com', '2026-08-22'])
    expect(second).toEqual(['u_baba14aa', 'daniel.hill389@gmail.com', '2026-09-20'])
    const repeated = [first[0], second[1], second[2]]
    const result = ingestApp({ header: a.header, rows: [first, repeated], lineNos: [2, 3] })
    expect(result.quarantined).toEqual([
      { line_no: 3, reason: 'duplicate_user_id', raw_row: toCsvRecord(repeated) },
    ])
    expect(result.users.size).toBe(1)
    expect(result.users.get('u_2b6447a3')).toMatchObject({ email_norm: 'julia.evans230@gmail.com' })
  })

  it('web_events: a visitor with two different /subscribe emails quarantines only the later row', () => {
    const w = parseCsv(webCsv)
    const joyRow = [...w.rows[w.lineNos.indexOf(5421)]]
    expect(joyRow).toEqual(['v_c9e136fd6d', '/subscribe', '2026-09-02 20:40:04', '', JOY])
    const conflicting = [joyRow[0], '/subscribe', '2026-09-03 00:36:15', '', JULIA]
    const result = ingestWeb({ header: w.header, rows: [joyRow, conflicting], lineNos: [5421, 5422] })
    expect(result.quarantined).toEqual([
      { line_no: 5422, reason: 'conflicting_email', raw_row: toCsvRecord(conflicting) },
    ])
    expect(result.events).toHaveLength(1)
    expect(result.visitors.get('v_c9e136fd6d')).toMatchObject({ email_norm: JOY })
  })
})

// 09 D-78: the three slice tests above show each classify*/ingest* function in isolation. This
// block instead runs buildSeed over the FULL real CSVs with exactly one row minimally edited
// (09 D-47), the same pipeline scripts/csv2sql.ts runs, so "the seed completes" and "every other
// 02 §Counts number is unchanged" are shown on the real data, not a 1-2 row slice. Each case
// picks a row whose edit cannot cascade into an unrelated count (confirmed against data/*.csv
// below), so the only numbers that move are the ones named in each assertion.
describe('T-ING-8 the five D-78 cases on the full seed (09 D-47)', () => {
  const subs = () => realCsvs().subscribers
  const web = () => realCsvs().web_events
  const app = () => realCsvs().app_users

  function withRow(csv: ParsedCsv, lineNo: number, edit: (row: string[]) => string[]): ParsedCsv {
    const idx = csv.lineNos.indexOf(lineNo)
    if (idx === -1) throw new Error(`T-ING-8: line ${lineNo} not in this file`)
    const rows = csv.rows.map((r) => [...r])
    rows[idx] = edit(rows[idx])
    return { header: csv.header, rows, lineNos: csv.lineNos }
  }

  it('unknown_status: subscribers.csv:4 (megan.walker638@hotmail.com, active, no app/web row of her own) truncated to "activ"', async () => {
    const real = subs()
    const line = real.rows[real.lineNos.indexOf(4)]
    expect(line).toEqual(['megan.walker638@hotmail.com', '2026-09-07', 'active', 'Instagram', '2026-09-22'])
    const edited = withRow(real, 4, (row) => [row[0], row[1], 'activ', row[3], row[4]])

    const seed = await buildSeed({ subscribers: edited, web_events: web(), app_users: app() }, secret())

    const run = seed.runs.find((r) => r.file === 'subscribers')!
    expect(run).toMatchObject({ rows_in: 2995, rows_out: 2899, merged: 85 })
    // The new unknown_status row (line 4) alongside the real baseline 10 (8 blank_row, 2
    // invalid_email, 09 D-78): quarantining never drops a baseline row, it only adds one.
    expect(run.quarantined).toEqual([
      {
        line_no: 4,
        reason: 'unknown_status',
        raw_row: 'megan.walker638@hotmail.com,2026-09-07,activ,Instagram,2026-09-22',
      },
      { line_no: 235, reason: 'blank_row', raw_row: ',,,,' },
      { line_no: 630, reason: 'blank_row', raw_row: ',,,,' },
      { line_no: 1587, reason: 'blank_row', raw_row: ',,,,' },
      { line_no: 1750, reason: 'invalid_email', raw_row: 'not-an-email,2026-08-14,active,Instagram,' },
      { line_no: 1788, reason: 'invalid_email', raw_row: '@gmail.com,2026-09-02,active,Google,' },
      { line_no: 2391, reason: 'blank_row', raw_row: ',,,,' },
      { line_no: 2402, reason: 'blank_row', raw_row: ',,,,' },
      { line_no: 2674, reason: 'blank_row', raw_row: ',,,,' },
      { line_no: 2722, reason: 'blank_row', raw_row: ',,,,' },
      { line_no: 2864, reason: 'blank_row', raw_row: ',,,,' },
    ])
    // She has no app_users or web_events row of her own (checked against the real files above),
    // so quarantining her cannot create a new app_only profile or move the web-linked count:
    // only subscribers and this one profile move, by exactly 1.
    expect(seed.subscribers).toHaveLength(2899)
    expect(seed.profiles).toHaveLength(2929)
    expect(seed.visitors).toHaveLength(2028)
    expect(seed.events).toHaveLength(10000)
    expect(seed.app_users).toHaveLength(930)
    expect(seed.visitors.filter((v) => v.email_norm !== null)).toHaveLength(1400)
    const baseline = { subscribers: 10, web_events: 0, app_users: 0 } as const
    for (const other of seed.runs) if (other.file !== 'subscribers') expect(other.quarantined).toHaveLength(baseline[other.file])
  })

  it('duplicate_user_id: app_users.csv:3 (daniel.hill389@gmail.com) given line 2\'s real user_id', async () => {
    const real = app()
    const first = real.rows[real.lineNos.indexOf(2)]
    const second = real.rows[real.lineNos.indexOf(3)]
    expect(first).toEqual(['u_2b6447a3', 'julia.evans230@gmail.com', '2026-08-22'])
    expect(second).toEqual(['u_baba14aa', 'daniel.hill389@gmail.com', '2026-09-20'])
    const edited = withRow(real, 3, (row) => [first[0], row[1], row[2]])

    const seed = await buildSeed({ subscribers: subs(), web_events: web(), app_users: edited }, secret())

    const run = seed.runs.find((r) => r.file === 'app_users')!
    expect(run).toMatchObject({ rows_in: 930, rows_out: 929, merged: 0 })
    expect(run.quarantined).toEqual([
      { line_no: 3, reason: 'duplicate_user_id', raw_row: 'u_2b6447a3,daniel.hill389@gmail.com,2026-09-20' },
    ])
    // daniel.hill389 is a real subscriber (data/subscribers.csv:2644), not app_only, so dropping
    // his second app_users row changes no profile: it only drops one app_users row.
    expect(seed.app_users).toHaveLength(929)
    expect(seed.subscribers).toHaveLength(2900)
    expect(seed.profiles).toHaveLength(2930)
    expect(seed.visitors).toHaveLength(2028)
    expect(seed.events).toHaveLength(10000)
    const baseline = { subscribers: 10, web_events: 0, app_users: 0 } as const
    for (const other of seed.runs) if (other.file !== 'app_users') expect(other.quarantined).toHaveLength(baseline[other.file])
  })

  it('misplaced_email: web_events.csv:5405 (joy\'s visitor, page /about, blank email) given a real email', async () => {
    const real = web()
    const line = real.rows[real.lineNos.indexOf(5405)]
    expect(line).toEqual(['v_c9e136fd6d', '/about', '2026-09-02 16:52:04', '', ''])
    const edited = withRow(real, 5405, (row) => [row[0], row[1], row[2], row[3], JULIA])

    const seed = await buildSeed({ subscribers: subs(), web_events: edited, app_users: app() }, secret())

    const run = seed.runs.find((r) => r.file === 'web_events')!
    expect(run).toMatchObject({ rows_in: 10000, rows_out: 9999, merged: 0 })
    expect(run.quarantined).toEqual([
      {
        line_no: 5405,
        reason: 'misplaced_email',
        raw_row: `v_c9e136fd6d,/about,2026-09-02 16:52:04,,${JULIA}`,
      },
    ])
    expect(seed.events).toHaveLength(9999)
    // The visitor keeps every other one of her events and her real, unchanged /subscribe email
    // (joy's, from line 5421): the quarantined row never touches her emails or first_seen_ts.
    const visitor = seed.visitors.find((v) => v.visitor_id === 'v_c9e136fd6d')!
    expect(visitor).toMatchObject({ email_norm: JOY, first_page: '/' })
    expect(seed.subscribers).toHaveLength(2900)
    expect(seed.profiles).toHaveLength(2930)
    expect(seed.visitors).toHaveLength(2028)
    expect(seed.app_users).toHaveLength(930)
    const baseline = { subscribers: 10, web_events: 0, app_users: 0 } as const
    for (const other of seed.runs) if (other.file !== 'web_events') expect(other.quarantined).toHaveLength(baseline[other.file])
  })

  it('conflicting_email: web_events.csv:5442 (the same visitor\'s later /subscribe row, blank email) given a different real email', async () => {
    const real = web()
    const line = real.rows[real.lineNos.indexOf(5442)]
    expect(line).toEqual(['v_c9e136fd6d', '/subscribe', '2026-09-03 00:51:44', '', ''])
    const edited = withRow(real, 5442, (row) => [row[0], row[1], row[2], row[3], JULIA])

    const seed = await buildSeed({ subscribers: subs(), web_events: edited, app_users: app() }, secret())

    const run = seed.runs.find((r) => r.file === 'web_events')!
    expect(run).toMatchObject({ rows_in: 10000, rows_out: 9999, merged: 0 })
    expect(run.quarantined).toEqual([
      {
        line_no: 5442,
        reason: 'conflicting_email',
        raw_row: `v_c9e136fd6d,/subscribe,2026-09-03 00:51:44,,${JULIA}`,
      },
    ])
    expect(seed.events).toHaveLength(9999)
    const visitor = seed.visitors.find((v) => v.visitor_id === 'v_c9e136fd6d')!
    expect(visitor.email_norm).toBe(JOY) // keeps her first (file-order) email, not julia's
    expect(seed.subscribers).toHaveLength(2900)
    expect(seed.profiles).toHaveLength(2930)
    expect(seed.visitors).toHaveLength(2028)
    expect(seed.app_users).toHaveLength(930)
    const baseline = { subscribers: 10, web_events: 0, app_users: 0 } as const
    for (const other of seed.runs) if (other.file !== 'web_events') expect(other.quarantined).toHaveLength(baseline[other.file])
  })

  it('the /subscribe match ignores letter case end to end: web_events.csv:5421 as "/Subscribe" still links, 0 quarantined', async () => {
    const real = web()
    const line = real.rows[real.lineNos.indexOf(5421)]
    expect(line).toEqual(['v_c9e136fd6d', '/subscribe', '2026-09-02 20:40:04', '', JOY])
    const edited = withRow(real, 5421, (row) => [row[0], '/Subscribe', row[2], row[3], row[4]])

    const seed = await buildSeed({ subscribers: subs(), web_events: edited, app_users: app() }, secret())

    const baseline = { subscribers: 10, web_events: 0, app_users: 0 } as const
    for (const run of seed.runs) expect(run.quarantined).toHaveLength(baseline[run.file])
    expect(seed.events).toHaveLength(10000)
    const visitor = seed.visitors.find((v) => v.visitor_id === 'v_c9e136fd6d')!
    expect(visitor).toMatchObject({ email_norm: JOY, signup_ts: '2026-09-02T20:40:04Z' })
    expect(seed.subscribers).toHaveLength(2900)
    expect(seed.profiles).toHaveLength(2930)
    expect(seed.visitors).toHaveLength(2028)
    expect(seed.visitors.filter((v) => v.email_norm !== null)).toHaveLength(1400)
    expect(seed.app_users).toHaveLength(930)
  })
})
