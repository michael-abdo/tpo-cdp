/// <reference types="vite/client" />
import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import appCsv from '../data/app_users.csv?raw'
import subscribersCsv from '../data/subscribers.csv?raw'
import webCsv from '../data/web_events.csv?raw'
import { engagementScore } from '../shared/derive'
import { PII_COLUMNS } from '../shared/pii'
import { pkeyForEmail } from '../shared/pseudonym'
import { classifyAppRow, ingestApp, APP_COLUMNS } from '../worker/ingest/app'
import { parseCsv } from '../worker/ingest/csv'
import { buildSeed, type Seed, type SeedCsvs } from '../worker/ingest/link'
import { requireHeaders } from '../worker/ingest/quarantine'
import { MAX_ROWS_PER_INSERT, MAX_STATEMENT_BYTES, seedSql, type SeedFile } from '../worker/ingest/sql'
import { classifyWebRow, csvTimestampToIso, ingestWeb, WEB_COLUMNS } from '../worker/ingest/web'

// 02 §Linking, §Derived, §Time, §Counts; 11 §Seed; 09 D-08, D-44, D-46. Tests 08 T-ING-1, -5, -6.
// Input is the three real data/*.csv files and the PII_KEY_SECRET from .dev.vars. The pure
// pipeline's SQL is executed into the test D1 (migrations applied by test/setup.ts), then
// counts are read back from the tables and views. Every expected number is from 02 §Counts.
// Tests that change real rows (09 D-47), and how:
// - missing header: "timestamp" deleted from the real web header, "created_at" from the app header.
// - web missing_field: the timestamp of real web line 5421 emptied.
// - web bad_date: the time part removed from that timestamp, leaving 2026-09-02.
// - web invalid_email: that row's email replaced by "@gmail.com" (subscribers.csv:1788).
// - app missing_field: the created_at of real app line 303 emptied.
// - app invalid_email: that row's email replaced by "not-an-email" (subscribers.csv:1750).

const JOY = 'joy.hall830@protonmail.com'
const JULIA = 'julia.evans230@gmail.com'
const ISAAC_RAW = 'ISAAC.TAYLOR434@PROTONMAIL.COM'

function secret(): string {
  const value = env.PII_KEY_SECRET
  if (!value) throw new Error('PII_KEY_SECRET missing from .dev.vars; the test cannot run')
  return value
}

function csvs(): SeedCsvs {
  return { subscribers: parseCsv(subscribersCsv), web_events: parseCsv(webCsv), app_users: parseCsv(appCsv) }
}

let seed: Seed
let files: SeedFile[]

beforeAll(async () => {
  seed = await buildSeed(csvs(), secret())
  files = seedSql(seed, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
  for (const file of files) {
    await env.DB.batch(file.statements.map((s) => env.DB.prepare(s)))
  }
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
})
