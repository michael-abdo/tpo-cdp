/// <reference types="vite/client" />
import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import appCsv from '../data/app_users.csv?raw'
import subscribersCsv from '../data/subscribers.csv?raw'
import webCsv from '../data/web_events.csv?raw'
import { TODAY as APP_TODAY } from '../shared/config'
import { loginCookie } from './helpers/auth'
import { piiKeySecret, seedDatabase } from './helpers/seed'
import { eventIdPool, sendWebhook } from './helpers/webhook'
import {
  buildExpected,
  canonicalSource,
  type ExpectedPairInput,
  type OracleResult,
  parseCsvStrict,
  resolveAppEvents,
  scoreDuplicates,
  type StoredAppEvent,
  TODAY,
} from './parity/oracle'

// D-75 (09 decision log; design 21-subscriber-data-parity-spec.md): a second, independent
// implementation recomputes every subscriber's expected record straight from the raw CSV bytes
// (test/parity/oracle.ts, never importing worker/, shared/ or src/ product code) and diffs it
// against the real seeded store. T-PAR-1..10 below. Reports name pkeys, visitor_hash, event ids
// and CSV line numbers only, never emails or other raw ids (21 §2.4); T-PAR-9 asserts this itself
// by scanning the built report text.

interface Mismatch {
  table: string
  keyKind: string
  key: string
  field: string
  expected: string
  actual: string
}

/** 21 §2.4: these fields are PII; a mismatch on one prints only the two lengths, never the values. */
const PII_FIELDS = new Set(['email_norm', 'email_raw', 'visitor_id', 'user_id', 'raw_row'])

function shown(field: string, value: unknown): string {
  if (PII_FIELDS.has(field)) return `len ${String(value ?? '').length}`
  return JSON.stringify(value)
}

function reportLine(m: Mismatch): string {
  return `${m.table} · ${m.keyKind} · ${m.key} · ${m.field} · ${m.expected} · ${m.actual}`
}

/** Compares two maps keyed by the same report key (pkey / visitor_hash / event id / CSV line),
 * field by field. Pushes one Mismatch per differing field into `out`; returns missing/extra keys. */
function diffByKey<T extends Record<string, unknown>>(
  table: string,
  keyKind: string,
  expected: Map<string, T>,
  got: Map<string, T>,
  fields: readonly (keyof T & string)[],
  out: Mismatch[],
): { missing: string[]; extra: string[] } {
  const missing: string[] = []
  const extra: string[] = []
  for (const key of expected.keys()) if (!got.has(key)) missing.push(key)
  for (const key of got.keys()) if (!expected.has(key)) extra.push(key)
  for (const [key, exp] of expected) {
    const gotRow = got.get(key)
    if (gotRow === undefined) continue
    for (const field of fields) {
      const e = exp[field]
      const g = gotRow[field]
      if (e !== g) {
        out.push({ table, keyKind, key, field, expected: shown(field, e), actual: shown(field, g) })
      }
    }
  }
  return { missing, extra }
}

let oracle: OracleResult
let secret: string
const report: Mismatch[] = []

beforeAll(async () => {
  await seedDatabase()
  secret = piiKeySecret()
  oracle = await buildExpected({ subscribers: subscribersCsv, webEvents: webCsv, appUsers: appCsv }, secret)
})

// -------------------------------------------------------------------------------------------
// T-PAR-1: oracle independence — no import from worker/, shared/, src/, scripts/
// -------------------------------------------------------------------------------------------
describe('T-PAR-1 oracle independence', () => {
  const files = import.meta.glob<string>('./parity/oracle.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  })

  function importPaths(source: string): string[] {
    const paths: string[] = []
    const re = /^\s*import\s+(?:type\s+)?(?:[^'"]+?from\s+)?['"]([^'"]+)['"]/gm
    for (const m of source.matchAll(re)) paths.push(m[1])
    return paths
  }

  const FORBIDDEN_PREFIXES = [
    'worker/',
    '../worker',
    'shared/',
    '../shared',
    'src/',
    '../src',
    'scripts/',
    '../scripts',
  ]

  it('reads the real file, not an empty glob', () => {
    expect(Object.keys(files)).toContain('./parity/oracle.ts')
  })

  it('the matcher catches a planted forbidden import and leaves vitest/cloudflare:test alone', () => {
    const planted = [
      "import { normalizeEmail } from '../shared/normalize'",
      "import type { Seed } from '../worker/ingest/link'",
    ].join('\n')
    const paths = importPaths(planted)
    expect(paths.some((p) => FORBIDDEN_PREFIXES.some((pre) => p.startsWith(pre)))).toBe(true)
    const clean = ["import { env } from 'cloudflare:test'", "import { describe, it } from 'vitest'"].join(
      '\n',
    )
    expect(importPaths(clean).some((p) => FORBIDDEN_PREFIXES.some((pre) => p.startsWith(pre)))).toBe(false)
  })

  it('test/parity/oracle.ts imports nothing from worker/, shared/, src/ or scripts/ (it imports nothing at all)', () => {
    const source = files['./parity/oracle.ts']
    const paths = importPaths(source)
    const offenders = paths.filter((p) => FORBIDDEN_PREFIXES.some((pre) => p.startsWith(pre)))
    expect(offenders).toEqual([])
    expect(paths).toEqual([])
  })

  it("TODAY matches shared/config.ts's TODAY (the oracle's own constant, checked here, 21 §2.1)", () => {
    expect(TODAY).toBe(APP_TODAY)
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-2: subscribers + profiles + v_profiles, 0 mismatches
// -------------------------------------------------------------------------------------------
describe('T-PAR-2 subscribers + profiles + v_profiles', () => {
  it('2,900 subscribers × 8 stored columns, 0 missing / extra / mismatched', async () => {
    const { results } = await env.DB.prepare(
      `SELECT p.pkey AS pkey, s.email_norm, s.email_raw, s.signup_date, s.status, s.source,
              s.last_open_date, s.cold_since, s.merged_count
       FROM subscribers s JOIN profiles p ON p.email_norm = s.email_norm AND p.kind = 'subscriber'`,
    ).all<Record<string, unknown>>()
    const got = new Map(results.map((r) => [r.pkey as string, r]))
    const expected = new Map(
      [...oracle.subscribers].map(([pkey, s]) => [
        pkey,
        {
          pkey,
          email_norm: s.email_norm,
          email_raw: s.email_raw,
          signup_date: s.signup_date,
          status: s.status,
          source: s.source,
          last_open_date: s.last_open_date,
          cold_since: s.cold_since,
          merged_count: s.merged_count,
        } as Record<string, unknown>,
      ]),
    )
    const { missing, extra } = diffByKey(
      'subscribers',
      'pkey',
      expected,
      got,
      [
        'email_norm',
        'email_raw',
        'signup_date',
        'status',
        'source',
        'last_open_date',
        'cold_since',
        'merged_count',
      ],
      report,
    )
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(expected.size).toBe(2900)
  })

  it('profiles: pkey, kind, created_at, engagement_score (2,900 subscriber + 30 app_only)', async () => {
    const { results } = await env.DB.prepare(
      `SELECT pkey, email_norm, kind, engagement_score, created_at FROM profiles WHERE kind != 'unknown_user_stub'`,
    ).all<Record<string, unknown>>()
    const got = new Map(results.map((r) => [r.pkey as string, r]))
    const expected = new Map<string, Record<string, unknown>>()
    for (const [pkey, s] of oracle.subscribers) {
      expected.set(pkey, {
        pkey,
        kind: 'subscriber',
        created_at: s.profile.created_at,
        engagement_score: s.profile.engagement_score,
      })
    }
    for (const [pkey, a] of oracle.appOnlyProfiles) {
      expected.set(pkey, {
        pkey,
        kind: 'app_only',
        created_at: a.created_at,
        engagement_score: a.engagement_score,
      })
    }
    const { missing, extra } = diffByKey(
      'profiles',
      'pkey',
      expected,
      got,
      ['kind', 'created_at', 'engagement_score'],
      report,
    )
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(oracle.appOnlyProfiles.size).toBe(30)
    expect(expected.size).toBe(2930)
    // pkey must equal HMAC(secret, email_norm) for every email-bearing profile (key probe, 21 §2.3).
    const probe = results.filter((r) => r.email_norm !== null).slice(0, 10)
    let agree = 0
    for (const r of probe) {
      const { pkeyForEmailNorm } = await import('./parity/oracle')
      if ((await pkeyForEmailNorm(secret, r.email_norm as string)) === r.pkey) agree++
    }
    if (probe.length > 0 && agree === 0)
      throw new Error('parity: wrong PII_KEY_SECRET for this store (key probe failed 0 of 10)')
  })

  it('v_profiles: has_app, app_created_at, app_after_signup, first_page, first_utm_source', async () => {
    const { results } = await env.DB.prepare(
      `SELECT pkey, kind, has_app, app_created_at, app_after_signup, first_page, first_utm_source
       FROM v_profiles WHERE kind != 'unknown_user_stub'`,
    ).all<Record<string, unknown>>()
    const got = new Map(results.map((r) => [r.pkey as string, r]))
    const expected = new Map<string, Record<string, unknown>>()
    for (const [pkey, s] of oracle.subscribers) {
      expected.set(pkey, {
        pkey,
        has_app: s.app.has_app ? 1 : 0,
        app_created_at: s.app.created_at_min,
        app_after_signup: s.app.app_after_signup ? 1 : 0,
        first_page: s.web.first_page,
        first_utm_source: s.web.first_utm_source,
      })
    }
    for (const [pkey, a] of oracle.appOnlyProfiles) {
      expected.set(pkey, {
        pkey,
        has_app: 1,
        app_created_at: a.created_at,
        app_after_signup: 0,
        first_page: null,
        first_utm_source: null,
      })
    }
    const { missing, extra } = diffByKey(
      'v_profiles',
      'pkey',
      expected,
      got,
      ['has_app', 'app_created_at', 'app_after_signup', 'first_page', 'first_utm_source'],
      report,
    )
    expect(missing).toEqual([])
    expect(extra).toEqual([])
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-3: quarantine + import_runs exact
// -------------------------------------------------------------------------------------------
describe('T-PAR-3 quarantine + import_runs', () => {
  it('10 quarantine rows: line, reason, raw_row (blank -> missing -> invalid -> missing -> bad_date order)', async () => {
    const { results } = await env.DB.prepare('SELECT file, line_no, reason, raw_row FROM quarantine').all<
      Record<string, unknown>
    >()
    const got = new Map(results.map((r) => [`${r.file}:${r.line_no}`, r]))
    const expected = new Map(
      oracle.quarantine.map((q) => [`${q.file}:${q.line_no}`, q as unknown as Record<string, unknown>]),
    )
    const { missing, extra } = diffByKey(
      'quarantine',
      'file:line',
      expected,
      got,
      ['file', 'line_no', 'reason', 'raw_row'],
      report,
    )
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(oracle.quarantine.length).toBe(10)
    expect(oracle.quarantine.filter((q) => q.reason === 'blank_row').length).toBe(8)
    expect(oracle.quarantine.filter((q) => q.reason === 'invalid_email').length).toBe(2)
  })

  it('3 import_runs: rows_in, rows_out, merged, quarantined', async () => {
    const { results } = await env.DB.prepare(
      'SELECT file, rows_in, rows_out, merged, quarantined FROM import_runs',
    ).all<Record<string, unknown>>()
    const got = new Map(results.map((r) => [r.file as string, r]))
    const expected = new Map(oracle.importRuns.map((r) => [r.file, r as unknown as Record<string, unknown>]))
    const { missing, extra } = diffByKey(
      'import_runs',
      'file',
      expected,
      got,
      ['rows_in', 'rows_out', 'merged', 'quarantined'],
      report,
    )
    expect(missing).toEqual([])
    expect(extra).toEqual([])
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-4: web visitors + events; per-subscriber visitors, events, pre-signup
// -------------------------------------------------------------------------------------------
describe('T-PAR-4 web visitors + events', () => {
  it('2,028 visitors × 7 stored columns', async () => {
    const { results } = await env.DB.prepare(
      'SELECT visitor_id, visitor_hash, email_norm, first_seen_ts, first_page, first_utm_source, signup_ts FROM web_visitors',
    ).all<Record<string, unknown>>()
    const got = new Map(results.map((r) => [r.visitor_hash as string, r]))
    const expected = new Map(
      [...oracle.visitors].map(([h, v]) => [h, v as unknown as Record<string, unknown>]),
    )
    const { missing, extra } = diffByKey(
      'web_visitors',
      'visitor_hash',
      expected,
      got,
      ['visitor_id', 'email_norm', 'first_seen_ts', 'first_page', 'first_utm_source', 'signup_ts'],
      report,
    )
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(expected.size).toBe(2028)
  })

  it('10,000 events × 4 stored columns, keyed by id', async () => {
    const { results } = await env.DB.prepare(
      'SELECT id, visitor_id, page, event_ts, utm_source FROM web_events',
    ).all<Record<string, unknown>>()
    const got = new Map(results.map((r) => [String(r.id), r]))
    const expected = new Map(
      oracle.events.map((e) => [String(e.id), e as unknown as Record<string, unknown>]),
    )
    const { missing, extra } = diffByKey(
      'web_events',
      'id',
      expected,
      got,
      ['visitor_id', 'page', 'event_ts', 'utm_source'],
      report,
    )
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(expected.size).toBe(10000)
  })

  it('per-subscriber visitors/events/pre-signup: 46 merged subscribers link a visitor (hardest case #4)', () => {
    const withVisitor = [...oracle.subscribers.values()].filter(
      (s) => s.web.visitor_hashes.length > 0 && s.merged_count > 1,
    )
    expect(withVisitor.length).toBe(46)
    const withApp = [...oracle.subscribers.values()].filter((s) => s.app.has_app && s.merged_count > 1)
    expect(withApp.length).toBe(22)
    const withBoth = [...oracle.subscribers.values()].filter(
      (s) => s.web.visitor_hashes.length > 0 && s.app.has_app && s.merged_count > 1,
    )
    expect(withBoth.length).toBe(10)
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-5: app users exact; 900 linked, 30 app_only
// -------------------------------------------------------------------------------------------
describe('T-PAR-5 app users', () => {
  it('930 CSV-sourced app_users rows; 900 link a subscriber, 30 app_only', async () => {
    const { results } = await env.DB.prepare(
      'SELECT user_id, email_norm, created_at, from_csv FROM app_users WHERE from_csv = 1',
    ).all<{
      user_id: string
      email_norm: string
      created_at: string
      from_csv: number
    }>()
    const lineByUserId = new Map(oracle.appUsers.map((u) => [u.user_id, u.csvLine]))
    const got = new Map<string, Record<string, unknown>>()
    const extraUserIds: string[] = []
    for (const r of results) {
      const line = lineByUserId.get(r.user_id)
      if (line === undefined) extraUserIds.push(r.user_id)
      else got.set(String(line), r)
    }
    const expected = new Map(
      oracle.appUsers.map((u) => [String(u.csvLine), u as unknown as Record<string, unknown>]),
    )
    const { missing, extra } = diffByKey(
      'app_users',
      'csv_line',
      expected,
      got,
      ['email_norm', 'created_at', 'from_csv'],
      report,
    )
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(extraUserIds).toEqual([])
    expect(oracle.appUsers.length).toBe(930)
    const subscriberEmails = new Set([...oracle.subscribers.values()].map((s) => s.email_norm))
    const linked = oracle.appUsers.filter((u) => subscriberEmails.has(u.email_norm))
    expect(linked.length).toBe(900)
    expect(oracle.appOnlyProfiles.size).toBe(30)
  })

  it('hardest case #13: app account vs signup order — strict >, 11 same-day are not conversions', () => {
    const before = [...oracle.subscribers.values()].filter(
      (s) => s.app.has_app && s.app.created_at_min! < s.signup_date,
    )
    const after = [...oracle.subscribers.values()].filter((s) => s.app.app_after_signup)
    const sameDay = [...oracle.subscribers.values()].filter(
      (s) => s.app.has_app && s.app.created_at_min === s.signup_date,
    )
    expect(before.length).toBe(457)
    expect(after.length).toBe(432)
    expect(sameDay.length).toBe(11)
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-6: every 02 §Counts number, from the oracle alone
// -------------------------------------------------------------------------------------------
describe('T-PAR-6 02 §Counts numbers reproduced by the oracle alone', () => {
  it('subscribers.csv: 2,995 rows, 8 blank, 2 invalid, 85 merged pairs, 2,900 subscribers, 2,610/290 active/unsub', () => {
    const run = oracle.importRuns.find((r) => r.file === 'subscribers')!
    expect(run.rows_in).toBe(2995)
    expect(run.quarantined).toBe(10)
    expect(run.merged).toBe(85)
    expect(run.rows_out).toBe(2900)
    const active = [...oracle.subscribers.values()].filter((s) => s.status === 'active').length
    const unsub = [...oracle.subscribers.values()].filter((s) => s.status === 'unsubscribed').length
    expect(active).toBe(2610)
    expect(unsub).toBe(290)
  })

  it('subscribers.csv pre-dedupe rows, over every raw row by its own status/last_open columns (02 §Counts counts these before quarantine or dedupe removes anything): 2,691 active, 296 unsubscribed, 494 with no last open', () => {
    const parsed = parseCsvStrict(subscribersCsv, 'subscribers.csv')
    const col = { status: parsed.header.indexOf('status'), open: parsed.header.indexOf('last_open_date') }
    let active = 0,
      unsub = 0,
      noOpen = 0
    for (const row of parsed.rows) {
      const status = row[col.status].trim()
      if (status === 'active') active++
      if (status === 'unsubscribed') unsub++
      if (row[col.open].trim() === '') noOpen++
    }
    expect(active).toBe(2691)
    expect(unsub).toBe(296)
    expect(noOpen).toBe(494)
  })

  it('subscribers.csv pre-dedupe sources over EVERY raw row incl. quarantined (02 §Counts; G4): 925/567/555/354/236/233/117, blank 8', () => {
    const parsed = parseCsvStrict(subscribersCsv, 'subscribers.csv')
    const srcCol = parsed.header.indexOf('acquisition_source')
    const counts = new Map<string, number>()
    for (const row of parsed.rows) {
      const src = canonicalSource(row[srcCol])
      const key = src ?? 'blank'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    expect(counts.get('instagram')).toBe(925)
    expect(counts.get('facebook')).toBe(567)
    expect(counts.get('referral')).toBe(555)
    expect(counts.get('google')).toBe(354)
    expect(counts.get('direct')).toBe(236)
    expect(counts.get('podcast')).toBe(233)
    expect(counts.get('x')).toBe(117)
    expect(counts.get('blank')).toBe(8)
  })

  it('web_events.csv: 10,000 rows, 2,028 visitors, 16 distinct pages', () => {
    expect(oracle.events.length).toBe(10000)
    expect(oracle.visitors.size).toBe(2028)
    expect(new Set(oracle.events.map((e) => e.page)).size).toBe(16)
  })

  it('web_events.csv: 1,400 /subscribe-linked visitors match a subscriber after the fold (1,190 would match raw) — hardest case #2', () => {
    const linked = [...oracle.visitors.values()].filter((v) => v.email_norm !== null)
    expect(linked.length).toBe(1400)
    const linkedToSubscriber = linked.filter((v) =>
      [...oracle.subscribers.values()].some((s) => s.email_norm === v.email_norm),
    )
    expect(linkedToSubscriber.length).toBe(1400)

    // Raw-spelling join (no fold on either side): fewer visitors match, since a case- or
    // space-varied /subscribe email would not equal any subscriber's raw CSV spelling exactly.
    const webParsed = parseCsvStrict(webCsv, 'web_events.csv')
    const wCol = {
      visitor: webParsed.header.indexOf('visitor_id'),
      page: webParsed.header.indexOf('page'),
      email: webParsed.header.indexOf('email'),
    }
    const subParsed = parseCsvStrict(subscribersCsv, 'subscribers.csv')
    const rawSubscriberEmails = new Set(subParsed.rows.map((r) => r[subParsed.header.indexOf('email')]))
    const rawEmailsByVisitor = new Map<string, Set<string>>()
    for (const row of webParsed.rows) {
      const email = row[wCol.email].trim()
      if (email === '') continue
      const bare = row[wCol.page].trim().split('?')[0]
      const stripped = bare.endsWith('/') && bare !== '/' ? bare.slice(0, -1) : bare
      if (stripped !== '/subscribe') continue
      const vid = row[wCol.visitor].trim()
      const set = rawEmailsByVisitor.get(vid) ?? new Set<string>()
      set.add(email)
      rawEmailsByVisitor.set(vid, set)
    }
    const rawMatches = [...rawEmailsByVisitor.values()].filter((emails) =>
      [...emails].some((e) => rawSubscriberEmails.has(e)),
    ).length
    expect(rawEmailsByVisitor.size).toBe(1400)
    expect(rawMatches).toBe(1190)
  })

  it('web_events.csv: 1,144 linked visitors have pre-signup views (1,930 events); 628 anonymous visitors (1,559 events)', () => {
    const linked = [...oracle.subscribers.values()].filter((s) => s.web.visitor_hashes.length > 0)
    const withPreSignup = linked.filter((s) => s.web.pre_signup_events > 0)
    const preSignupEventTotal = linked.reduce((sum, s) => sum + s.web.pre_signup_events, 0)
    expect(withPreSignup.length).toBe(1144)
    expect(preSignupEventTotal).toBe(1930)
    const anon = [...oracle.visitors.values()].filter((v) => v.email_norm === null)
    const anonEvents = oracle.events.filter((e) => {
      const v = [...oracle.visitors.values()].find((x) => x.visitor_id === e.visitor_id)
      return v !== undefined && v.email_norm === null
    })
    expect(anon.length).toBe(628)
    expect(anonEvents.length).toBe(1559)
  })

  it('web_events.csv: 8,030 rows with no UTM; instagram 667, facebook 496, google 393, referral 256, podcast 108, x(twitter) 50', () => {
    const noUtm = oracle.events.filter((e) => e.utm_source === null).length
    expect(noUtm).toBe(8030)
    const by = (s: string) => oracle.events.filter((e) => e.utm_source === s).length
    expect(by('instagram')).toBe(667)
    expect(by('facebook')).toBe(496)
    expect(by('google')).toBe(393)
    expect(by('referral')).toBe(256)
    expect(by('podcast')).toBe(108)
    expect(by('x')).toBe(50)
  })

  it('app_users.csv: 930 accounts, 900 match a subscriber, 30 app_only, 98 unsubscribed app users', () => {
    const matched = oracle.appUsers.filter((u) =>
      [...oracle.subscribers.values()].some((s) => s.email_norm === u.email_norm),
    )
    expect(matched.length).toBe(900)
    expect(oracle.appUsers.length - matched.length).toBe(30)
    const unsubApp = matched.filter((u) => {
      const s = [...oracle.subscribers.values()].find((x) => x.email_norm === u.email_norm)!
      return s.status === 'unsubscribed'
    }).length
    expect(unsubApp).toBe(98)
  })

  it('D-69 filters at TODAY: new_subscriber 889/95, site-visits-30d 935/82, /shadrachs-picks 366/40, engagement>=50 487/27', () => {
    const subs = [...oracle.subscribers.values()]
    const bySplit = (pred: (s: (typeof subs)[number]) => boolean) => ({
      active: subs.filter((s) => pred(s) && s.status === 'active').length,
      unsub: subs.filter((s) => pred(s) && s.status === 'unsubscribed').length,
    })
    expect(bySplit((s) => s.new_subscriber)).toEqual({ active: 889, unsub: 95 })
    expect(bySplit((s) => s.web.site_visits_30d > 0)).toEqual({ active: 935, unsub: 82 })
    expect(bySplit((s) => s.profile.engagement_score >= 50)).toEqual({ active: 487, unsub: 27 })

    const pageVisitors = new Map<string, Set<string>>() // page -> visitor_id set
    for (const e of oracle.events) {
      const set = pageVisitors.get(e.page) ?? new Set<string>()
      set.add(e.visitor_id)
      pageVisitors.set(e.page, set)
    }
    const shadrachs = pageVisitors.get('/shadrachs-picks') ?? new Set<string>()
    const visitedShadrachs = (s: (typeof subs)[number]) =>
      s.web.visitor_hashes.some((h) => {
        const v = oracle.visitors.get(h)
        return v !== undefined && shadrachs.has(v.visitor_id)
      })
    expect(bySplit(visitedShadrachs)).toEqual({ active: 366, unsub: 40 })
  })

  it('brief preset (Instagram, active, no open in 30+ days incl. never-opened): 177, 55 unsubscribed hidden', () => {
    const subs = [...oracle.subscribers.values()]
    const preset = (s: (typeof subs)[number]) =>
      s.source === 'instagram' && (s.days_since_open === null || s.days_since_open >= 30)
    const active = subs.filter((s) => preset(s) && s.status === 'active').length
    const unsub = subs.filter((s) => preset(s) && s.status === 'unsubscribed').length
    expect(active).toBe(177)
    expect(unsub).toBe(55)
    expect(active + unsub).toBe(232)
  })

  it('Instagram active cold: 147 (41 hidden); went_cold_in(2026-08): 46 (20 hidden)', () => {
    const subs = [...oracle.subscribers.values()]
    const cold = (s: (typeof subs)[number]) => s.source === 'instagram' && s.cold
    expect(subs.filter((s) => cold(s) && s.status === 'active').length).toBe(147)
    expect(subs.filter((s) => cold(s) && s.status === 'unsubscribed').length).toBe(41)
    const wentColdAug = (s: (typeof subs)[number]) =>
      s.source === 'instagram' && s.cold_since.startsWith('2026-08') && s.cold
    expect(subs.filter((s) => wentColdAug(s) && s.status === 'active').length).toBe(46)
    expect(subs.filter((s) => wentColdAug(s) && s.status === 'unsubscribed').length).toBe(20)
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-7: D-62 table equals GET /api/duplicates
// -------------------------------------------------------------------------------------------
describe('T-PAR-7 D-62 possible duplicates', () => {
  it('1,704 candidate pairs over 788 stems (1,977 emails); 0 auto, 16 review, 1,688 hidden on the seed', async () => {
    const readers: ExpectedPairInput[] = [...oracle.subscribers.values()].map((s) => ({
      pkey: s.pkey,
      email_norm: s.email_norm,
      signup_date: s.signup_date,
      source: s.source,
    }))
    const result = await scoreDuplicates(readers, new Set())
    expect(result.candidates).toBe(1704)
    expect(result.stems).toBe(788)
    expect(result.emailsInStems).toBe(1977)
    const bands = { auto: 0, review: 0, hidden: 0 }
    for (const p of result.pairs) bands[p.band]++
    expect(bands).toEqual({ auto: 0, review: 16, hidden: 1688 })
    for (const p of result.pairs.filter((x) => x.band === 'review')) expect(p.score).toBe(76)
  })

  it('GET /api/duplicates (seed, 0 webhook events sent yet): candidates/review/hidden match the oracle', async () => {
    const cookie = await loginCookie()
    const res = await SELF.fetch('http://cdp.test/api/duplicates', { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = await res.json<{
      candidates: number
      hidden_below_review: number
      review: { pair_id: string; score: number }[]
    }>()
    expect(body.candidates).toBe(1704)
    expect(body.hidden_below_review).toBe(1688)
    expect(body.review.length).toBe(16)
    const readers: ExpectedPairInput[] = [...oracle.subscribers.values()].map((s) => ({
      pkey: s.pkey,
      email_norm: s.email_norm,
      signup_date: s.signup_date,
      source: s.source,
    }))
    const result = await scoreDuplicates(readers, new Set())
    const expectedPairIds = new Set(result.pairs.filter((p) => p.band !== 'hidden').map((p) => p.pair_id))
    const gotPairIds = new Set(body.review.map((p) => p.pair_id))
    expect(gotPairIds).toEqual(expectedPairIds)
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-8: after real signed webhooks, 0 mismatches (stitch, stub, shared device)
// -------------------------------------------------------------------------------------------
describe('T-PAR-8 store-side (webhook) cases', () => {
  const nextEventId = eventIdPool()

  it("julia.evans230's engagement recomputes exactly (hardest case #1, the .5-tie formula) after one signed read_story", async () => {
    // Real app_users.csv row (09 D-11, D-47): u_2b6447a3, julia.evans230@gmail.com, no web history.
    const userId = 'u_2b6447a3'
    const email = 'julia.evans230@gmail.com'
    const subscriber = [...oracle.subscribers.values()].find((s) => s.email_norm === email)
    if (subscriber === undefined)
      throw new Error('parity: julia.evans230 not found in the oracle subscribers')
    const before = await env.DB.prepare('SELECT engagement_score FROM profiles WHERE pkey = ?')
      .bind(subscriber.pkey)
      .first<{ engagement_score: number }>()
    expect(before?.engagement_score).toBe(subscriber.profile.engagement_score)

    const res = await sendWebhook(
      JSON.stringify({
        event_id: nextEventId(),
        event: 'read_story',
        user_id: userId,
        device_id: 'd_2b6447a3',
        timestamp: `${TODAY}T10:00:00Z`,
        properties: { story: 'supreme-court-ruling-explained' },
      }),
    )
    expect(res.status, await res.clone().text()).toBe(202)

    const after = await env.DB.prepare('SELECT engagement_score FROM profiles WHERE pkey = ?')
      .bind(subscriber.pkey)
      .first<{ engagement_score: number }>()
    const expectedAfter = (await import('./parity/oracle')).engagementScore(
      subscriber.days_since_open,
      1,
      subscriber.web.site_visits_30d,
    )
    expect(after?.engagement_score).toBe(expectedAfter)
  })

  it('F1 repro (hardest case #1, ranked first): emily.green827 at exactly 24 days since open, 0 site visits, scores the exact half-up 13 after one app event, never the float-rounded 12', async () => {
    // Real app_users.csv line 12 (09 D-11, D-47): u_ffe05a36, emily.green827@gmail.com, last_open_date
    // 2026-09-04 (24 days before TODAY), 0 web history. This is 21 §3 case 1's own example data point.
    const userId = 'u_ffe05a36'
    const email = 'emily.green827@gmail.com'
    const subscriber = [...oracle.subscribers.values()].find((s) => s.email_norm === email)
    if (subscriber === undefined) throw new Error('parity: emily.green827 not found in the oracle subscribers')
    expect(subscriber.days_since_open).toBe(24)
    expect(subscriber.web.site_visits_30d).toBe(0)
    expect(subscriber.profile.engagement_score).toBe(10) // seed: 0 app events, matches 21 §3 case 1

    const res = await sendWebhook(
      JSON.stringify({
        event_id: nextEventId(),
        event: 'read_story',
        user_id: userId,
        device_id: 'd_ffe05a36',
        timestamp: `${TODAY}T10:10:00Z`,
        properties: { story: 'church-attendance-study' },
      }),
    )
    expect(res.status, await res.clone().text()).toBe(202)

    const after = await env.DB.prepare('SELECT engagement_score FROM profiles WHERE pkey = ?')
      .bind(subscriber.pkey)
      .first<{ engagement_score: number }>()
    const { engagementScore: oracleEngagementScore } = await import('./parity/oracle')
    const expectedAfter = oracleEngagementScore(24, 1, 0)
    expect(expectedAfter).toBe(13) // exact half-up of 12.5; the fixed float formula would give 12
    expect(after?.engagement_score, `pkey ${subscriber.pkey}`).toBe(expectedAfter)
  })

  it('an unknown webhook user_id creates a stub profile with no email and a pkey the oracle can reproduce (hardest case #14/#16)', async () => {
    // A real id (app_users.csv u_3380b6e6) with its last character removed (09 D-47): never occurs in the CSVs.
    const unknownUserId = 'u_3380b6e'
    const res = await sendWebhook(
      JSON.stringify({
        event_id: nextEventId(),
        event: 'app_open',
        user_id: unknownUserId,
        device_id: 'd_3380b6e',
        timestamp: `${TODAY}T10:05:00Z`,
      }),
    )
    expect(res.status, await res.clone().text()).toBe(202)
    const { pkeyForUserId } = await import('./parity/oracle')
    const expectedStubPkey = await pkeyForUserId(secret, unknownUserId)
    const stub = await env.DB.prepare('SELECT pkey, email_norm, kind FROM profiles WHERE pkey = ?')
      .bind(expectedStubPkey)
      .first<{ pkey: string; email_norm: string | null; kind: string }>()
    expect(stub).toMatchObject({ pkey: expectedStubPkey, email_norm: null, kind: 'unknown_user_stub' })
    const anyEmailPkeys = new Set([...oracle.subscribers.keys(), ...oracle.appOnlyProfiles.keys()])
    expect(anyEmailPkeys.has(expectedStubPkey)).toBe(false)
  })

  it('a shared app device (mark.mitchell424 / mark.mitchell662, 0 soft-field agreement) scores >= 90 and matches GET /api/duplicates (hardest case #12)', async () => {
    const MARK_A = { user: 'u_a6ac1f6c', email: 'mark.mitchell424@gmail.com' }
    const MARK_B = { user: 'u_b9e9a984', email: 'mark.mitchell662@outlook.com' }
    const device = 'd_a6ac1f6c'
    for (const [i, u] of [MARK_A, MARK_B].entries()) {
      const res = await sendWebhook(
        JSON.stringify({
          event_id: nextEventId(),
          event: 'login',
          user_id: u.user,
          device_id: device,
          timestamp: `${TODAY}T11:0${i}:00Z`,
        }),
      )
      expect(res.status, await res.clone().text()).toBe(202)
    }
    const aPkey = [...oracle.subscribers.values()].find((s) => s.email_norm === MARK_A.email)?.pkey
    const bPkey = [...oracle.subscribers.values()].find((s) => s.email_norm === MARK_B.email)?.pkey
    if (aPkey === undefined || bPkey === undefined)
      throw new Error('parity: mark.mitchell subscribers not found')
    const pairKey = aPkey < bPkey ? `${aPkey}|${bPkey}` : `${bPkey}|${aPkey}`
    const readers: ExpectedPairInput[] = [...oracle.subscribers.values()].map((s) => ({
      pkey: s.pkey,
      email_norm: s.email_norm,
      signup_date: s.signup_date,
      source: s.source,
    }))
    const result = await scoreDuplicates(readers, new Set([pairKey]))
    const pair = result.pairs.find(
      (p) => (p.a_pkey === aPkey && p.b_pkey === bPkey) || (p.a_pkey === bPkey && p.b_pkey === aPkey),
    )
    if (pair === undefined) throw new Error('parity: mark.mitchell pair missing from oracle candidates')
    expect(pair.score).toBeGreaterThanOrEqual(90)

    const cookie = await loginCookie()
    const res = await SELF.fetch('http://cdp.test/api/duplicates', { headers: { cookie } })
    const body = await res.json<{ review: { pair_id: string; score: number; band: string }[] }>()
    const stored = body.review.find((p) => p.pair_id === pair.pair_id)
    if (stored === undefined)
      throw new Error('parity: the auto-band mark.mitchell pair is missing from GET /api/duplicates')
    expect(stored.score).toBe(pair.score)
    expect(stored.band).toBe('auto')
  })

  it("the oracle's own device resolution agrees with the store's device_identity for every device seen so far", async () => {
    const { results: events } = await env.DB.prepare(
      'SELECT event_id, user_id, device_id, event_ts FROM app_events',
    ).all<StoredAppEvent>()
    const { results: identity } = await env.DB.prepare('SELECT device_id, user_id FROM device_identity').all<{
      device_id: string
      user_id: string
    }>()
    const resolved = resolveAppEvents(events)
    expect(resolved.ambiguousDevices).toEqual([])
    const storedOwners = new Map(identity.map((r) => [r.device_id, r.user_id]))
    for (const [device, owner] of resolved.deviceOwner) {
      expect(storedOwners.get(device)).toBe(owner)
    }
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-9: the mismatch report scan finds no @ and no raw id
// -------------------------------------------------------------------------------------------
describe('T-PAR-9 report scan', () => {
  it('a report line never carries a raw email or a raw id, even for a planted email-shaped value', () => {
    const planted: Mismatch = {
      table: 'subscribers',
      keyKind: 'pkey',
      key: 'pk_354066fe67b52302',
      field: 'email_norm',
      expected: shown('email_norm', 'someone@example.com'),
      actual: shown('email_norm', 'someone.else@example.com'),
    }
    const line = reportLine(planted)
    expect(line).not.toContain('@')
    expect(line).not.toMatch(/\b(?:u_|d_|v_)[0-9a-f]{4,}\b/)
  })

  it('the real report built by this run (so far) carries no @ and no raw id', () => {
    const lines = report.map(reportLine)
    const blob = lines.join('\n')
    expect(blob).not.toContain('@')
    expect(blob).not.toMatch(/\b(?:u_|d_|v_)[0-9a-f]{4,}\b/)
  })

  it('exit condition: 0 mismatches across every T-PAR-2..5 comparison run before this file', () => {
    expect(report).toEqual([])
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-10: planted single-value swaps are each reported (the harness can fail)
// -------------------------------------------------------------------------------------------
describe('T-PAR-10 the harness can fail', () => {
  it('swapping one real subscriber source for another real subscriber source is caught as exactly one mismatch', async () => {
    const subs = [...oracle.subscribers.values()]
    const distinctSources = [...new Set(subs.map((s) => s.source).filter((s): s is string => s !== null))]
    const a = subs.find((s) => s.source === distinctSources[0])
    const b = subs.find((s) => s.source === distinctSources[1] && s.pkey !== a?.pkey)
    if (a === undefined || b === undefined)
      throw new Error('parity: could not find two subscribers with different real sources')

    await env.DB.prepare('UPDATE subscribers SET source = ? WHERE email_norm = ?')
      .bind(b.source, a.email_norm)
      .run()

    const { results } = await env.DB.prepare(
      `SELECT p.pkey AS pkey, s.email_norm, s.email_raw, s.signup_date, s.status, s.source,
              s.last_open_date, s.cold_since, s.merged_count
       FROM subscribers s JOIN profiles p ON p.email_norm = s.email_norm AND p.kind = 'subscriber'`,
    ).all<Record<string, unknown>>()
    const got = new Map(results.map((r) => [r.pkey as string, r]))
    const expected = new Map(
      subs.map((s) => [
        s.pkey,
        {
          pkey: s.pkey,
          email_norm: s.email_norm,
          email_raw: s.email_raw,
          signup_date: s.signup_date,
          status: s.status,
          source: s.source,
          last_open_date: s.last_open_date,
          cold_since: s.cold_since,
          merged_count: s.merged_count,
        } as Record<string, unknown>,
      ]),
    )
    const mutationReport: Mismatch[] = []
    diffByKey(
      'subscribers',
      'pkey',
      expected,
      got,
      [
        'email_norm',
        'email_raw',
        'signup_date',
        'status',
        'source',
        'last_open_date',
        'cold_since',
        'merged_count',
      ],
      mutationReport,
    )
    expect(mutationReport).toHaveLength(1)
    expect(mutationReport[0]).toMatchObject({
      table: 'subscribers',
      key: a.pkey,
      field: 'source',
      expected: JSON.stringify(a.source),
      actual: JSON.stringify(b.source),
    })
  })
})
