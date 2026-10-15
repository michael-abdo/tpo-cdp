/// <reference types="vite/client" />
import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import appCsv from '../data/app_users.csv?raw'
import subscribersCsv from '../data/subscribers.csv?raw'
import webCsv from '../data/web_events.csv?raw'
import { TODAY as APP_TODAY } from '../shared/config'
import { BUILTIN_HANDLERS } from '../worker/assistant/tools/builtin-handlers'
import { parseCsv } from '../worker/ingest/csv'
import { buildSeed, type Seed } from '../worker/ingest/link'
import { documentationIp, loginCookie } from './helpers/auth'
import { piiKeySecret, seedDatabase } from './helpers/seed'
import { eventIdPool, sendWebhook } from './helpers/webhook'
import {
  addDays,
  buildExpected,
  canonicalSource,
  damerauLevenshtein,
  type ExpectedPairInput,
  type ExpectedQuarantine,
  engagementScore,
  normalizeEmail,
  type OracleResult,
  parseCsvStrict,
  pkeyForEmailNorm,
  pkeyForUserId,
  resolveAppEvents,
  scoreDuplicates,
  type StoredAppEvent,
  TODAY,
  visitorHash,
} from './parity/oracle'

// Parity: a second, independent
// implementation recomputes every subscriber's expected record straight from the raw CSV bytes
// (test/parity/oracle.ts, never importing worker/, shared/ or src/ product code) and diffs it
// against the real seeded store. T-PAR-1..10 below. Reports name pkeys, visitor_hash, event ids
// and CSV line numbers only, never emails or other raw ids; T-PAR-9 asserts this itself
// by scanning the built report text.

interface Mismatch {
  table: string
  keyKind: string
  key: string
  field: string
  expected: string
  actual: string
}

/** These fields are PII; a mismatch on one prints only the two lengths, never the values. */
const PII_FIELDS = new Set(['email_norm', 'email_raw', 'visitor_id', 'user_id', 'raw_row'])

function shown(field: string, value: unknown): string {
  if (PII_FIELDS.has(field)) return `len ${String(value ?? '').length}`
  return JSON.stringify(value)
}

function reportLine(m: Mismatch): string {
  return `${m.table} · ${m.keyKind} · ${m.key} · ${m.field} · ${m.expected} · ${m.actual}`
}

type Row = Record<string, unknown>

/** Compares two maps keyed by the same report key (pkey / visitor_hash / event id / CSV line),
 * field by field. Pushes one Mismatch per differing field into `out`; returns missing/extra keys. */
function diffByKey<T extends Row>(
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

/**
 * Runs one table's diff, appends every mismatch to the shared `report` (for T-PAR-9's scan) and
 * also asserts right here that *this* comparison alone found none — a field mismatch used to pass
 * T-PAR-2..5 silently and show up only in T-PAR-9's "exit condition" under the wrong test id.
 */
function diffAndAssert<T extends Row>(
  table: string,
  keyKind: string,
  expected: Map<string, T>,
  got: Map<string, T>,
  fields: readonly (keyof T & string)[],
  report: Mismatch[],
): { missing: string[]; extra: string[] } {
  const before = report.length
  const result = diffByKey(table, keyKind, expected, got, fields, report)
  const local = report.slice(before)
  expect(local.map(reportLine), `${table} field mismatches`).toEqual([])
  return result
}

let oracle: OracleResult
let secret: string
const report: Mismatch[] = []

beforeAll(async () => {
  await seedDatabase()
  secret = piiKeySecret()
  oracle = await buildExpected({ subscribers: subscribersCsv, webEvents: webCsv, appUsers: appCsv }, secret)

  // Key probe first: before any diff, check pkey = HMAC(secret, email_norm) on 10
  // profiles, so a wrong secret stops with one line instead of thousands of mismatches.
  const { results: probeRows } = await env.DB.prepare(
    'SELECT pkey, email_norm FROM profiles WHERE email_norm IS NOT NULL LIMIT 10',
  ).all<{ pkey: string; email_norm: string }>()
  let agree = 0
  for (const r of probeRows) if ((await pkeyForEmailNorm(secret, r.email_norm)) === r.pkey) agree++
  if (probeRows.length > 0 && agree === 0) {
    throw new Error('parity: wrong PII_KEY_SECRET for this store (key probe failed 0 of 10)')
  }
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

  /** Catches `import … from '…'`, `export … from '…'` (incl. `export *`) and dynamic
   * `import('…')` / `require('…')` anywhere in the source, not only a leading `import` keyword. */
  function importPaths(source: string): string[] {
    const paths: string[] = []
    const fromRe = /\bfrom\s*['"]([^'"]+)['"]/g
    for (const m of source.matchAll(fromRe)) paths.push(m[1])
    const dynamicRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g
    for (const m of source.matchAll(dynamicRe)) paths.push(m[1])
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

  const hasForbidden = (paths: readonly string[]) =>
    paths.some((p) => FORBIDDEN_PREFIXES.some((pre) => p.startsWith(pre)))

  it('reads the real file, not an empty glob', () => {
    expect(Object.keys(files)).toContain('./parity/oracle.ts')
  })

  it('the matcher catches a planted forbidden import (static, re-export, dynamic, require) and leaves vitest/cloudflare:test alone', () => {
    const planted = [
      "import { normalizeEmail } from '../shared/normalize'",
      "import type { Seed } from '../worker/ingest/link'",
    ].join('\n')
    expect(hasForbidden(importPaths(planted))).toBe(true)

    expect(hasForbidden(importPaths("export * from '../shared/normalize'"))).toBe(true)
    expect(hasForbidden(importPaths("export { normalizeEmail } from '../shared/normalize'"))).toBe(true)
    expect(hasForbidden(importPaths("const link = await import('../worker/ingest/link')"))).toBe(true)
    expect(hasForbidden(importPaths("const sql = require('../scripts/csv2sql')"))).toBe(true)

    const clean = [
      "import { env } from 'cloudflare:test'",
      "import { describe, it } from 'vitest'",
      "const dynamic = await import('./oracle-helpers')",
    ].join('\n')
    expect(hasForbidden(importPaths(clean))).toBe(false)
  })

  it('test/parity/oracle.ts imports nothing from worker/, shared/, src/ or scripts/ (it imports nothing at all)', () => {
    const source = files['./parity/oracle.ts']
    const paths = importPaths(source)
    expect(hasForbidden(paths)).toBe(false)
    expect(paths).toEqual([])
  })

  it("TODAY matches shared/config.ts's TODAY (the oracle's own constant, checked here, 21 §2.1)", () => {
    expect(TODAY).toBe(APP_TODAY)
  })
})

// -------------------------------------------------------------------------------------------
// Shared table builders — one SELECT + expected-map per table, used by T-PAR-2..5 (the real diff)
// and T-PAR-10 (the harness-can-fail check), so the two never drift apart.
// -------------------------------------------------------------------------------------------

const SUBSCRIBER_FIELDS = [
  'email_norm',
  'email_raw',
  'signup_date',
  'status',
  'source',
  'last_open_date',
  'cold_since',
  'merged_count',
] as const

async function subscribersTable() {
  const { results } = await env.DB.prepare(
    `SELECT p.pkey AS pkey, s.email_norm, s.email_raw, s.signup_date, s.status, s.source,
            s.last_open_date, s.cold_since, s.merged_count
     FROM subscribers s JOIN profiles p ON p.email_norm = s.email_norm AND p.kind = 'subscriber'`,
  ).all<Row>()
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
      } as Row,
    ]),
  )
  return { expected, got, fields: SUBSCRIBER_FIELDS }
}

const PROFILE_FIELDS = ['kind', 'created_at', 'engagement_score', 'email_norm'] as const

/**
 * app_events_last_30d by email_norm, read fresh from the store every call (resolved the oracle's
 * own way). On the seed this is empty, so every builder
 * below gives the same answer whether it runs before or after T-PAR-8's webhooks — the stored
 * engagement_score the builders compare against is exactly as live as the one the app keeps.
 */
async function appEventsByEmail(): Promise<Map<string, number>> {
  const { results: events } = await env.DB.prepare(
    'SELECT event_id, user_id, device_id, event_ts FROM app_events',
  ).all<StoredAppEvent>()
  const resolved = resolveAppEvents(events)
  const { results: appUserRows } = await env.DB.prepare(
    'SELECT user_id, email_norm FROM app_users WHERE email_norm IS NOT NULL',
  ).all<{ user_id: string; email_norm: string }>()
  const byEmail = new Map<string, number>()
  for (const r of appUserRows) {
    const count = resolved.countByUserId.get(r.user_id) ?? 0
    if (count === 0) continue
    byEmail.set(r.email_norm, (byEmail.get(r.email_norm) ?? 0) + count)
  }
  return byEmail
}

async function profilesTable() {
  const { results } = await env.DB.prepare(
    `SELECT pkey, email_norm, kind, engagement_score, created_at FROM profiles WHERE kind != 'unknown_user_stub'`,
  ).all<Row>()
  const got = new Map(results.map((r) => [r.pkey as string, r]))
  const appCounts = await appEventsByEmail()
  const expected = new Map<string, Row>()
  for (const [pkey, s] of oracle.subscribers) {
    expected.set(pkey, {
      pkey,
      kind: 'subscriber',
      created_at: s.profile.created_at,
      engagement_score: engagementScore(s.days_since_open, appCounts.get(s.email_norm) ?? 0, s.web.site_visits_30d),
      email_norm: s.email_norm,
    })
  }
  for (const [pkey, a] of oracle.appOnlyProfiles) {
    expected.set(pkey, {
      pkey,
      kind: 'app_only',
      created_at: a.created_at,
      engagement_score: engagementScore(null, appCounts.get(a.email_norm) ?? 0, oracle.siteVisits30d.get(a.email_norm) ?? 0),
      email_norm: a.email_norm,
    })
  }
  return { expected, got, fields: PROFILE_FIELDS }
}

// v_profiles' full 11 non-key columns, not only the app/web half.
const V_PROFILES_FIELDS = [
  'has_app',
  'app_created_at',
  'app_after_signup',
  'first_page',
  'first_utm_source',
  'signup_date',
  'status',
  'source',
  'last_open_date',
  'cold_since',
  'engagement_score',
] as const

async function vProfilesTable() {
  const { results } = await env.DB.prepare(
    `SELECT pkey, kind, has_app, app_created_at, app_after_signup, first_page, first_utm_source,
            signup_date, status, source, last_open_date, cold_since, engagement_score
     FROM v_profiles WHERE kind != 'unknown_user_stub'`,
  ).all<Row>()
  const got = new Map(results.map((r) => [r.pkey as string, r]))
  const appCounts = await appEventsByEmail()
  const expected = new Map<string, Row>()
  for (const [pkey, s] of oracle.subscribers) {
    expected.set(pkey, {
      pkey,
      has_app: s.app.has_app ? 1 : 0,
      app_created_at: s.app.created_at_min,
      app_after_signup: s.app.app_after_signup ? 1 : 0,
      first_page: s.web.first_page,
      first_utm_source: s.web.first_utm_source,
      signup_date: s.signup_date,
      status: s.status,
      source: s.source,
      last_open_date: s.last_open_date,
      cold_since: s.cold_since,
      engagement_score: engagementScore(s.days_since_open, appCounts.get(s.email_norm) ?? 0, s.web.site_visits_30d),
    })
  }
  for (const [pkey, a] of oracle.appOnlyProfiles) {
    // app_only has no subscriber row: v_profiles LEFT JOINs subscribers, so every
    // subscriber-sourced column is NULL (the view holds no formula either way).
    expected.set(pkey, {
      pkey,
      has_app: 1,
      app_created_at: a.created_at,
      app_after_signup: 0,
      first_page: null,
      first_utm_source: null,
      signup_date: null,
      status: null,
      source: null,
      last_open_date: null,
      cold_since: null,
      engagement_score: engagementScore(null, appCounts.get(a.email_norm) ?? 0, oracle.siteVisits30d.get(a.email_norm) ?? 0),
    })
  }
  return { expected, got, fields: V_PROFILES_FIELDS }
}

const QUARANTINE_FIELDS = ['file', 'line_no', 'reason', 'raw_row'] as const

async function quarantineTable() {
  const { results } = await env.DB.prepare('SELECT file, line_no, reason, raw_row FROM quarantine').all<Row>()
  const got = new Map(results.map((r) => [`${r.file}:${r.line_no}`, r]))
  const expected = new Map(oracle.quarantine.map((q) => [`${q.file}:${q.line_no}`, q as unknown as Row]))
  return { expected, got, fields: QUARANTINE_FIELDS }
}

const IMPORT_RUN_FIELDS = ['rows_in', 'rows_out', 'merged', 'quarantined'] as const

async function importRunsTable() {
  const { results } = await env.DB.prepare(
    'SELECT file, rows_in, rows_out, merged, quarantined FROM import_runs',
  ).all<Row>()
  const got = new Map(results.map((r) => [r.file as string, r]))
  const expected = new Map(oracle.importRuns.map((r) => [r.file, r as unknown as Row]))
  return { expected, got, fields: IMPORT_RUN_FIELDS }
}

const WEB_VISITOR_FIELDS = [
  'visitor_id',
  'email_norm',
  'first_seen_ts',
  'first_page',
  'first_utm_source',
  'signup_ts',
] as const

async function webVisitorsTable() {
  const { results } = await env.DB.prepare(
    'SELECT visitor_id, visitor_hash, email_norm, first_seen_ts, first_page, first_utm_source, signup_ts FROM web_visitors',
  ).all<Row>()
  const got = new Map(results.map((r) => [r.visitor_hash as string, r]))
  const expected = new Map([...oracle.visitors].map(([h, v]) => [h, v as unknown as Row]))
  return { expected, got, fields: WEB_VISITOR_FIELDS }
}

const WEB_EVENT_FIELDS = ['visitor_id', 'page', 'event_ts', 'utm_source'] as const

async function webEventsTable() {
  const { results } = await env.DB.prepare('SELECT id, visitor_id, page, event_ts, utm_source FROM web_events').all<Row>()
  const got = new Map(results.map((r) => [String(r.id), r]))
  const expected = new Map(oracle.events.map((e) => [String(e.id), e as unknown as Row]))
  return { expected, got, fields: WEB_EVENT_FIELDS }
}

const APP_USER_FIELDS = ['email_norm', 'created_at', 'from_csv'] as const

async function appUsersTable() {
  const { results } = await env.DB.prepare(
    'SELECT user_id, email_norm, created_at, from_csv FROM app_users WHERE from_csv = 1',
  ).all<{ user_id: string; email_norm: string; created_at: string; from_csv: number }>()
  const lineByUserId = new Map(oracle.appUsers.map((u) => [u.user_id, u.csvLine]))
  const got = new Map<string, Row>()
  const extraUserIds: string[] = []
  for (const r of results) {
    const line = lineByUserId.get(r.user_id)
    if (line === undefined) extraUserIds.push(r.user_id)
    else got.set(String(line), r)
  }
  const expected = new Map(oracle.appUsers.map((u) => [String(u.csvLine), u as unknown as Row]))
  return { expected, got, fields: APP_USER_FIELDS, extraUserIds }
}

// -------------------------------------------------------------------------------------------
// T-PAR-2: subscribers + profiles + v_profiles, 0 mismatches
// -------------------------------------------------------------------------------------------
describe('T-PAR-2 subscribers + profiles + v_profiles', () => {
  it('2,900 subscribers × 8 stored columns, 0 missing / extra / mismatched', async () => {
    const { expected, got, fields } = await subscribersTable()
    const { missing, extra } = diffAndAssert('subscribers', 'pkey', expected, got, fields, report)
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(expected.size).toBe(2900)
  })

  it('profiles: pkey, kind, created_at, engagement_score, email_norm (2,900 subscriber + 30 app_only)', async () => {
    const { expected, got, fields } = await profilesTable()
    const { missing, extra } = diffAndAssert('profiles', 'pkey', expected, got, fields, report)
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(oracle.appOnlyProfiles.size).toBe(30)
    expect(expected.size).toBe(2930)
  })

  it('v_profiles: all 11 non-key columns (has_app, app_created_at, app_after_signup, first_page, first_utm_source, signup_date, status, source, last_open_date, cold_since, engagement_score)', async () => {
    const { expected, got, fields } = await vProfilesTable()
    expect(fields.length).toBe(11)
    const { missing, extra } = diffAndAssert('v_profiles', 'pkey', expected, got, fields, report)
    expect(missing).toEqual([])
    expect(extra).toEqual([])
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-3: quarantine + import_runs exact
// -------------------------------------------------------------------------------------------
describe('T-PAR-3 quarantine + import_runs', () => {
  it('10 quarantine rows: line, reason, raw_row (blank -> missing -> invalid -> missing -> bad_date order)', async () => {
    const { expected, got, fields } = await quarantineTable()
    const { missing, extra } = diffAndAssert('quarantine', 'file:line', expected, got, fields, report)
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(oracle.quarantine.length).toBe(10)
    expect(oracle.quarantine.filter((q) => q.reason === 'blank_row').length).toBe(8)
    expect(oracle.quarantine.filter((q) => q.reason === 'invalid_email').length).toBe(2)
  })

  it('3 import_runs: rows_in, rows_out, merged, quarantined', async () => {
    const { expected, got, fields } = await importRunsTable()
    const { missing, extra } = diffAndAssert('import_runs', 'file', expected, got, fields, report)
    expect(missing).toEqual([])
    expect(extra).toEqual([])
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-3b: one planted case per newer quarantine reason, each a minimal edit of a
// real CSV line, recomputed by the oracle's OWN quarantine rules (test/parity/oracle.ts; no
// import from worker/ingest) and independently by buildSeed (the app's real pipeline) on the
// SAME edited text, then diffed field by field. This never touches the shared seeded store
// (beforeAll's real CSVs): each case parses its own edited copy of the raw text and compares the
// two in memory, so T-PAR-2..10's 0-mismatch store diff above is never at risk.
// -------------------------------------------------------------------------------------------
describe('T-PAR-3b planted D-78 cases, oracle vs. app, independently recomputed', () => {
  /** Replaces one 1-based CSV line's fields (header = line 1) in raw text, by column edit. */
  function plant(csvText: string, lineNo: number, edit: (fields: string[]) => string[]): string {
    const lines = csvText.split('\n')
    const idx = lineNo - 1
    if (idx < 0 || idx >= lines.length) throw new Error(`T-PAR-3b: line ${lineNo} out of range`)
    lines[idx] = edit(lines[idx].split(',')).join(',')
    return lines.join('\n')
  }

  type Planted = Pick<ExpectedQuarantine, 'line_no' | 'reason' | 'raw_row'>

  /** The oracle's and the app's import_runs for the same planted texts must agree on every
   * file's rows_in/rows_out/merged/quarantined-count, and their total event counts must match —
   * not just the one file's quarantine rows plantedQuarantine() diffs above. A rule that quarantines
   * a row but ALSO lets it through as an event (e.g. a conflicting_email rule that still pushes
   * the row onto `events` after queuing it) passes a quarantine-only diff but fails rows_out and
   * events.length here, on both engines reading the SAME edited text. */
  function expectSameLinking(expected: OracleResult, seed: Seed): void {
    for (const run of expected.importRuns) {
      const seedRun = seed.runs.find((r) => r.file === run.file)
      expect(
        seedRun && {
          file: seedRun.file,
          rows_in: seedRun.rows_in,
          rows_out: seedRun.rows_out,
          merged: seedRun.merged,
          quarantined: seedRun.quarantined.length,
        },
      ).toEqual(run)
    }
    expect(seed.events.length).toBe(expected.events.length)
  }

  /** A web-events case's visitor (by its real `visitor_id`, never printed raw here) must carry
   * the same `email_norm`/`signup_ts` in both engines: the linking half a
   * quarantine-row-only diff never recomputes. */
  async function expectSameVisitor(expected: OracleResult, seed: Seed, visitorId: string): Promise<void> {
    const hash = await visitorHash(piiKeySecret(), visitorId)
    const oracleVisitor = expected.visitors.get(hash)
    const seedVisitor = seed.visitors.find((v) => v.visitor_hash === hash)
    expect(oracleVisitor).toBeDefined()
    expect(seedVisitor && { email_norm: seedVisitor.email_norm, signup_ts: seedVisitor.signup_ts }).toEqual({
      email_norm: oracleVisitor!.email_norm,
      signup_ts: oracleVisitor!.signup_ts,
    })
  }

  /** Builds both the oracle's and the app's quarantine rows for `file` from the same edited
   * CSV texts, so a planted case is recomputed twice, never by one engine feeding the other.
   * Also asserts the two engines' import_runs and event counts agree (expectSameLinking) on
   * every call, so every planted case — not just conflicting_email — proves its oracle copy
   * tracks the app on the event/visitor half of the rule, not only the quarantined row. */
  async function plantedQuarantine(
    file: 'subscribers' | 'web_events' | 'app_users',
    texts: { subscribers: string; webEvents: string; appUsers: string },
  ): Promise<{ oracleRows: Planted[]; appRows: Planted[]; expected: OracleResult; seed: Seed }> {
    const secretValue = piiKeySecret()
    const expected = await buildExpected(texts, secretValue)
    const seed = await buildSeed(
      {
        subscribers: parseCsv(texts.subscribers),
        web_events: parseCsv(texts.webEvents),
        app_users: parseCsv(texts.appUsers),
      },
      secretValue,
    )
    expectSameLinking(expected, seed)
    const byLine = (a: Planted, b: Planted) => a.line_no - b.line_no
    return {
      oracleRows: expected.quarantine
        .filter((q) => q.file === file)
        .map(({ line_no, reason, raw_row }) => ({ line_no, reason, raw_row }))
        .sort(byLine),
      appRows: seed.runs
        .find((r) => r.file === file)!
        .quarantined.map(({ line_no, reason, raw_row }) => ({ line_no, reason, raw_row }))
        .sort(byLine),
      expected,
      seed,
    }
  }

  it('unknown_status: subscribers.csv:4 status truncated to "activ" — oracle and app agree, 0 mismatches', async () => {
    const { oracleRows, appRows } = await plantedQuarantine('subscribers', {
      subscribers: plant(subscribersCsv, 4, (f) => [f[0], f[1], 'activ', f[3], f[4]]),
      webEvents: webCsv,
      appUsers: appCsv,
    })
    expect(oracleRows).toEqual(appRows)
    expect(oracleRows.filter((r) => r.reason === 'unknown_status')).toEqual([
      { line_no: 4, reason: 'unknown_status', raw_row: 'megan.walker638@hotmail.com,2026-09-07,activ,Instagram,2026-09-22' },
    ])
  })

  it('duplicate_user_id: app_users.csv:3 given line 2\'s real user_id — oracle and app agree, 0 mismatches', async () => {
    const { oracleRows, appRows, expected, seed } = await plantedQuarantine('app_users', {
      subscribers: subscribersCsv,
      webEvents: webCsv,
      appUsers: plant(appCsv, 3, (f) => ['u_2b6447a3', f[1], f[2]]),
    })
    expect(oracleRows).toEqual(appRows)
    expect(oracleRows).toEqual([
      { line_no: 3, reason: 'duplicate_user_id', raw_row: 'u_2b6447a3,daniel.hill389@gmail.com,2026-09-20' },
    ])
    // Keep-first (worker/ingest/app.ts): the kept app user for u_2b6447a3 is line 2's real email
    // in both engines, never line 3's planted duplicate overwriting it.
    const keptEmail = normalizeEmail('julia.evans230@gmail.com')
    expect(expected.appUsers.find((u) => u.user_id === 'u_2b6447a3')?.email_norm).toBe(keptEmail)
    expect(seed.app_users.find((u) => u.user_id === 'u_2b6447a3')?.email_norm).toBe(keptEmail)
  })

  it('misplaced_email: web_events.csv:5405 (/about, blank email) given a real email — oracle and app agree, 0 mismatches', async () => {
    const { oracleRows, appRows, expected, seed } = await plantedQuarantine('web_events', {
      subscribers: subscribersCsv,
      webEvents: plant(webCsv, 5405, (f) => [f[0], f[1], f[2], f[3], 'julia.evans230@gmail.com']),
      appUsers: appCsv,
    })
    expect(oracleRows).toEqual(appRows)
    expect(oracleRows).toEqual([
      {
        line_no: 5405,
        reason: 'misplaced_email',
        raw_row: 'v_c9e136fd6d,/about,2026-09-02 16:52:04,,julia.evans230@gmail.com',
      },
    ])
    // The planted row never becomes an event or changes the visitor's real email/signup (joy's,
    // from the unedited line 5421) — in both engines, not just plantedQuarantine's quarantine diff.
    await expectSameVisitor(expected, seed, 'v_c9e136fd6d')
  })

  it('conflicting_email: web_events.csv:5442 (a later /subscribe row for joy\'s visitor, blank email) given a different real email — oracle and app agree, 0 mismatches', async () => {
    const { oracleRows, appRows, expected, seed } = await plantedQuarantine('web_events', {
      subscribers: subscribersCsv,
      webEvents: plant(webCsv, 5442, (f) => [f[0], f[1], f[2], f[3], 'julia.evans230@gmail.com']),
      appUsers: appCsv,
    })
    expect(oracleRows).toEqual(appRows)
    expect(oracleRows).toEqual([
      {
        line_no: 5442,
        reason: 'conflicting_email',
        raw_row: 'v_c9e136fd6d,/subscribe,2026-09-03 00:51:44,,julia.evans230@gmail.com',
      },
    ])
    // Only that row is set aside: the visitor keeps joy's first email/signup, never
    // julia's planted one, and (via plantedQuarantine's expectSameLinking) the row never also
    // becomes an event in either engine — the exact bug expectSameLinking guards against.
    await expectSameVisitor(expected, seed, 'v_c9e136fd6d')
  })

  it('a case-only /Subscribe row still links (0 quarantined) — oracle and app agree', async () => {
    const { oracleRows, appRows } = await plantedQuarantine('web_events', {
      subscribers: subscribersCsv,
      webEvents: plant(webCsv, 5421, (f) => [f[0], '/Subscribe', f[2], f[3], f[4]]),
      appUsers: appCsv,
    })
    expect(oracleRows).toEqual(appRows)
    expect(oracleRows).toEqual([])
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-4: web visitors + events; per-subscriber visitors, events, pre-signup (vs the app)
// -------------------------------------------------------------------------------------------
describe('T-PAR-4 web visitors + events', () => {
  it('2,028 visitors × 7 stored columns', async () => {
    const { expected, got, fields } = await webVisitorsTable()
    const { missing, extra } = diffAndAssert('web_visitors', 'visitor_hash', expected, got, fields, report)
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(expected.size).toBe(2028)
  })

  it('10,000 events × 4 stored columns, keyed by id', async () => {
    const { expected, got, fields } = await webEventsTable()
    const { missing, extra } = diffAndAssert('web_events', 'id', expected, got, fields, report)
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

  // The strict `<` at lookup.ts:193 and the pre-signup cut are
  // unguarded if only the raw tables are checked: a lookup.ts bug in how it reads those same
  // rows would still pass T-PAR-4's row-level diff above. This calls the real GET /api/lookup
  // for every linked subscriber and diffs its per-pkey events/pre_signup count against the
  // oracle, so the 1,930 total comes from the app, not only from the oracle itself.
  it('GET /api/lookup per linked subscriber: events and pre-signup events match the oracle (M13 guard: lookup.ts:193 strict <)', async () => {
    // 1,400 real HTTP round trips through the full session + lookup pipeline; vitest's default
    // 5s per-test timeout is tight once `npm test` runs every file's workers concurrently (the
    // budget is 15s for this whole file, measured in isolation at ~2.5s above).
    const cookie = await loginCookie()
    const linked = [...oracle.subscribers.values()].filter((s) => s.web.visitor_hashes.length > 0)
    expect(linked.length).toBe(1400)

    // Hardest case #6 (the exact same-second tie) and case #5 (the 101 visitors whose first
    // /subscribe row shifted pre_signup) must be in the set this actually calls the API for.
    // Named by their CSV emails, not their pkeys: a pkey is HMAC(PII_KEY_SECRET, email), and a fresh
    // clone's .dev.vars holds its own secret (README: any string works). Failures name the case only.
    const mustCover = [
      ['case #6 same-second tie', 'hannah.adams474@gmail.com'],
      ['case #5 pre-signup cut', 'matthew.thomas453@protonmail.com'],
      ['case #5 pre-signup cut', 'john.evans244@gmail.com'],
    ] as const
    for (const [label, email] of mustCover) {
      if (!linked.some((s) => s.email_norm === email)) throw new Error(`parity: the ${label} subscriber is missing from the oracle's linked set`)
    }

    let totalEventsFromApp = 0
    let totalPreSignupFromApp = 0
    const lookupMismatches: Mismatch[] = []
    for (const s of linked) {
      const res = await SELF.fetch(`http://cdp.test/api/lookup?q=${encodeURIComponent(s.pkey)}`, {
        headers: { cookie },
      })
      expect(res.status, await res.clone().text()).toBe(200)
      const body = await res.json<{
        web: { visitors: { events: { event_ts: string; pre_signup: boolean }[] }[] } | null
      }>()
      const visitors = body.web?.visitors ?? []
      const events = visitors.reduce((sum, v) => sum + v.events.length, 0)
      const preSignup = visitors.reduce((sum, v) => sum + v.events.filter((e) => e.pre_signup).length, 0)
      totalEventsFromApp += events
      totalPreSignupFromApp += preSignup
      if (events !== s.web.events) {
        lookupMismatches.push({
          table: 'lookup',
          keyKind: 'pkey',
          key: s.pkey,
          field: 'events',
          expected: JSON.stringify(s.web.events),
          actual: JSON.stringify(events),
        })
      }
      if (preSignup !== s.web.pre_signup_events) {
        lookupMismatches.push({
          table: 'lookup',
          keyKind: 'pkey',
          key: s.pkey,
          field: 'pre_signup_events',
          expected: JSON.stringify(s.web.pre_signup_events),
          actual: JSON.stringify(preSignup),
        })
      }
    }
    expect(lookupMismatches.map(reportLine)).toEqual([])
    expect(totalEventsFromApp).toBe(linked.reduce((sum, s) => sum + s.web.events, 0))
    expect(totalPreSignupFromApp).toBe(1930) // now read from the app, not only the oracle
  }, 30_000)
})

// -------------------------------------------------------------------------------------------
// T-PAR-5: app users exact; 900 linked, 30 app_only
// -------------------------------------------------------------------------------------------
describe('T-PAR-5 app users', () => {
  it('930 CSV-sourced app_users rows; 900 link a subscriber, 30 app_only', async () => {
    const { expected, got, fields, extraUserIds } = await appUsersTable()
    const { missing, extra } = diffAndAssert('app_users', 'csv_line', expected, got, fields, report)
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(extraUserIds.length).toBe(0) // never prints the raw ids themselves
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
// T-PAR-6: every seed count, from the oracle alone (plus two read-time checks against
// the real API/handler, guarding against small changes to the derived-value SQL)
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

  it("web_events.csv: the /subscribe date equals signup_date for all 1,400 linked visitors (02 §Counts line 60)", () => {
    const linked = [...oracle.subscribers.values()].filter((s) => s.web.signup_ts !== null)
    expect(linked.length).toBe(1400)
    const sameDay = linked.filter((s) => (s.web.signup_ts as string).slice(0, 10) === s.signup_date)
    expect(sameDay.length).toBe(1400)
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

  it('GET /api/segments/options-equivalent page counts, most subscribers first: /subscribe 1,400, / 900, /shadrachs-picks 406', () => {
    const pageVisitors = new Map<string, Set<string>>() // page -> visitor_id set
    for (const e of oracle.events) {
      const set = pageVisitors.get(e.page) ?? new Set<string>()
      set.add(e.visitor_id)
      pageVisitors.set(e.page, set)
    }
    const subscribersWhoVisited = (page: string) => {
      const visitorIds = pageVisitors.get(page) ?? new Set<string>()
      return [...oracle.subscribers.values()].filter((s) =>
        s.web.visitor_hashes.some((h) => {
          const v = oracle.visitors.get(h)
          return v !== undefined && visitorIds.has(v.visitor_id)
        }),
      ).length
    }
    expect(subscribersWhoVisited('/subscribe')).toBe(1400)
    expect(subscribersWhoVisited('/')).toBe(900)
    expect(subscribersWhoVisited('/shadrachs-picks')).toBe(406)
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

    // Filters combined: new subscriber + the page, and the brief preset + site visits or the page.
    expect(bySplit((s) => s.new_subscriber && visitedShadrachs(s))).toEqual({ active: 120, unsub: 10 })
    const preset = (s: (typeof subs)[number]) =>
      s.source === 'instagram' && (s.days_since_open === null || s.days_since_open >= 30)
    expect(bySplit((s) => preset(s) && s.web.site_visits_30d > 0)).toEqual({ active: 59, unsub: 19 })
    expect(subs.filter((s) => preset(s) && visitedShadrachs(s) && s.status === 'active').length).toBe(31)
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

  it('02 §Counts line 62: 93 is all unsubscribed Instagram subscribers regardless of the 30-day rule; went_cold_in(2026-08) is 66 across all statuses (D-51)', () => {
    const subs = [...oracle.subscribers.values()]
    const igUnsub = subs.filter((s) => s.source === 'instagram' && s.status === 'unsubscribed').length
    expect(igUnsub).toBe(93)
    const wentColdAugAnyStatus = subs.filter(
      (s) => s.source === 'instagram' && s.cold && s.cold_since.startsWith('2026-08'),
    ).length
    expect(wentColdAugAnyStatus).toBe(66) // = the 46 active + 20 unsubscribed asserted just above
  })

  // Read-time derived values, checked against the real segment endpoints, not only recomputed
  // inside the oracle. Guards against a +1 in days_since_open.sql and a
  // `<=` → `<` in cold.sql: both would move these counts but leave the oracle-only tests above untouched.
  it('the brief preset and the built-in cold metric match the real segment endpoints: 177/55, 147/41', async () => {
    const cookie = await loginCookie()
    const previewRes = await SELF.fetch('http://cdp.test/api/segments/preview', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'cf-connecting-ip': documentationIp() },
      body: JSON.stringify({
        filters: { source: ['instagram'], days_since_open_gte: 30, include_never_opened: true },
      }),
    })
    expect(previewRes.status, await previewRes.clone().text()).toBe(200)
    const previewBody = await previewRes.json<{ count: number; hidden_unsubscribed: number }>()
    expect(previewBody.count).toBe(177)
    expect(previewBody.hidden_unsubscribed).toBe(55)

    const coldActive = await BUILTIN_HANDLERS.aggregate.run(env.DB, {
      metric: 'cold',
      source: ['instagram'],
      status: ['active'],
    })
    const coldUnsub = await BUILTIN_HANDLERS.aggregate.run(env.DB, {
      metric: 'cold',
      source: ['instagram'],
      status: ['unsubscribed'],
    })
    expect((coldActive.rows[0] as { cold: number }).cold).toBe(147)
    expect((coldUnsub.rows[0] as { cold: number }).cold).toBe(41)
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-6b: "absent today, guarded anyway" — a non-zero here names the case and
// fails, so a future CSV cannot silently exercise an unproven merge/edge rule. Non-ASCII bytes,
// quoted fields, a repeated user_id, 2 emails on one visitor and web/app quarantine are already
// guarded: buildExpected() in beforeAll would have thrown on any of them.
// -------------------------------------------------------------------------------------------
describe('T-PAR-6b absent-today guards (21 §3 #17)', () => {
  it('plus-addressing and Gmail dot aliases: 0 on this data', () => {
    const subs = [...oracle.subscribers.values()]
    const plusAddressed = subs.filter((s) => s.email_norm.split('@')[0]?.includes('+')).length
    expect(plusAddressed, 'plus-addressing').toBe(0)

    const byDotless = new Map<string, Set<string>>()
    for (const s of subs) {
      if (!s.email_norm.endsWith('@gmail.com')) continue
      const local = s.email_norm.slice(0, s.email_norm.indexOf('@'))
      const dotless = local.replace(/\./g, '')
      const set = byDotless.get(dotless) ?? new Set<string>()
      set.add(local)
      byDotless.set(dotless, set)
    }
    const aliasGroups = [...byDotless.values()].filter((set) => set.size > 1).length
    expect(aliasGroups, 'Gmail dot aliases').toBe(0)
  })

  it('date ordering: last open before signup, last open after TODAY, signup after TODAY: 0 each', () => {
    const subs = [...oracle.subscribers.values()]
    expect(
      subs.filter((s) => s.last_open_date !== null && s.last_open_date < s.signup_date).length,
      'last open before signup',
    ).toBe(0)
    expect(subs.filter((s) => s.last_open_date !== null && s.last_open_date > TODAY).length, 'last open after TODAY').toBe(0)
    expect(subs.filter((s) => s.signup_date > TODAY).length, 'signup after TODAY').toBe(0)
  })

  it('one email on 2+ visitors, one email on 2+ app accounts, blank source on a kept row: 0 each', () => {
    const subs = [...oracle.subscribers.values()]
    expect(subs.filter((s) => s.web.visitor_hashes.length > 1).length, 'one email on 2+ visitors').toBe(0)
    const accountsByEmail = new Map<string, number>()
    for (const u of oracle.appUsers) accountsByEmail.set(u.email_norm, (accountsByEmail.get(u.email_norm) ?? 0) + 1)
    expect([...accountsByEmail.values()].filter((n) => n > 1).length, 'one email on 2+ app accounts').toBe(0)
    expect(subs.filter((s) => s.source === null).length, 'blank source on a kept row (G4)').toBe(0)
  })

  it('merged (duplicate) subscriber groups that disagree on signup_date, last_open_date, status or source: 0 (merge precedence never fires on this data)', () => {
    const parsed = parseCsvStrict(subscribersCsv, 'subscribers.csv')
    const col = {
      email: parsed.header.indexOf('email'),
      signup: parsed.header.indexOf('signup_date'),
      status: parsed.header.indexOf('status'),
      source: parsed.header.indexOf('acquisition_source'),
      open: parsed.header.indexOf('last_open_date'),
    }
    interface Group {
      signups: Set<string>
      statuses: Set<string>
      sources: Set<string>
      opens: Set<string>
    }
    const groups = new Map<string, Group>()
    for (const row of parsed.rows) {
      const emailNorm = normalizeEmail(row[col.email])
      if (emailNorm === null) continue
      const signup = row[col.signup].trim()
      const status = row[col.status].trim()
      if (signup === '' || status === '') continue
      const g: Group = groups.get(emailNorm) ?? {
        signups: new Set(),
        statuses: new Set(),
        sources: new Set(),
        opens: new Set(),
      }
      g.signups.add(signup)
      g.statuses.add(status)
      const source = canonicalSource(row[col.source])
      if (source !== null) g.sources.add(source)
      const open = row[col.open].trim()
      if (open !== '') g.opens.add(open)
      groups.set(emailNorm, g)
    }
    const disagreeing = [...groups.values()].filter(
      (g) => g.signups.size > 1 || g.statuses.size > 1 || g.sources.size > 1 || g.opens.size > 1,
    ).length
    expect(disagreeing, 'duplicate pairs that disagree on a merged field').toBe(0)
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-6c: the never-opened and TODAY-boundary cases, each a named
// assertion of every count for that case, from the oracle alone.
// -------------------------------------------------------------------------------------------
describe('T-PAR-6c hardest cases #9 and #10 (21 §3)', () => {
  it('#9 never opened: 470 (155 unsubscribed; 325 cold now; 145 not cold yet); 152 still score > 0 from site visits', () => {
    const neverOpened = [...oracle.subscribers.values()].filter((s) => s.last_open_date === null)
    expect(neverOpened.length).toBe(470)
    expect(neverOpened.filter((s) => s.status === 'unsubscribed').length).toBe(155)
    expect(neverOpened.filter((s) => s.cold).length).toBe(325)
    expect(neverOpened.filter((s) => !s.cold).length).toBe(145)
    expect(neverOpened.filter((s) => s.profile.engagement_score > 0).length).toBe(152)
  })

  it('#10 TODAY boundaries: cold_since = TODAY 15 (cold), = TODAY+1 46 (not); 30 days since open 7; opened TODAY 151; signed up TODAY 41 (9 never opened); new_subscriber edge 2026-08-29 in 37 / 2026-08-28 out 39', () => {
    const subs = [...oracle.subscribers.values()]
    expect(subs.filter((s) => s.cold_since === TODAY).length).toBe(15)
    expect(subs.filter((s) => s.cold_since === addDays(TODAY, 1)).length).toBe(46)
    expect(subs.filter((s) => s.days_since_open === 30).length).toBe(7)
    expect(subs.filter((s) => s.last_open_date === TODAY).length).toBe(151)
    const signedUpToday = subs.filter((s) => s.signup_date === TODAY)
    expect(signedUpToday.length).toBe(41)
    expect(signedUpToday.filter((s) => s.last_open_date === null).length).toBe(9)
    expect(subs.filter((s) => s.signup_date === '2026-08-29').length).toBe(37)
    expect(subs.filter((s) => s.signup_date === '2026-08-28').length).toBe(39)
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-6d: partial/fuzzy lookup fixtures. The oracle never
// imports worker/lookup/fuzzy.ts — "partial" is its own substring match over every
// profile email (subscriber + app_only, the same set GET /api/lookup/search's grp 0/1 reads) and
// a matching app_users.user_id prefix (grp 2); "fuzzy" is its own damerauLevenshtein, the same
// metric the fixtures were first computed with.
// -------------------------------------------------------------------------------------------
describe('T-PAR-6d partial/fuzzy lookup fixtures (21 §4.1 item 3)', () => {
  function profileEmails(): string[] {
    const subscriberEmails = [...oracle.subscribers.values()].map((s) => s.email_norm)
    const appOnlyEmails = [...oracle.appOnlyProfiles.values()].map((p) => p.email_norm)
    return [...subscriberEmails, ...appOnlyEmails]
  }

  it("joy.hall -> 3 profiles; hall -> 52 profiles (09 D-52)", () => {
    const emails = profileEmails()
    expect(emails.filter((e) => e.includes('joy.hall')).length).toBe(3)
    expect(emails.filter((e) => e.includes('hall')).length).toBe(52)
  })

  it('u_2b64 -> 1 app account (u_2b6447a3, julia.evans230; 09 D-52)', () => {
    const matches = oracle.appUsers.filter((u) => u.user_id.startsWith('u_2b64'))
    expect(matches.length).toBe(1)
  })

  it('appser17 -> 13 profiles within Damerau-Levenshtein distance 2 (09 D-59)', () => {
    const emails = profileEmails()
    const query = 'appser17'
    const within2 = emails.filter((e) => {
      const local = e.slice(0, e.indexOf('@'))
      return Math.min(damerauLevenshtein(query, e), damerauLevenshtein(query, local)) <= 2
    })
    expect(within2.length).toBe(13)
  })

  it('appuser1 -> 11 partial matches, no suggestions needed (09 D-59)', () => {
    const emails = profileEmails()
    const matches = emails.filter((e) => e.includes('appuser1'))
    expect(matches.length).toBe(11) // appuser1, appuser10..appuser19
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-7: the possible-duplicates table equals GET /api/duplicates
// -------------------------------------------------------------------------------------------
describe('T-PAR-7 D-62 possible duplicates', () => {
  it('1,704 candidate pairs over 788 stems (1,977 emails); 0 auto, 16 review (each 76); the chance check (≈17 by chance, ≈97 without the device weight, the device weight itself ≈ -3.32)', async () => {
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
    const reviewPairs = result.pairs.filter((x) => x.band === 'review')
    for (const p of reviewPairs) expect(p.score).toBe(76)

    // The chance check: pairs agreeing on all three soft fields vs what independence
    // alone would predict, and what the shared_device field alone is worth.
    const allSoftAgree = result.pairs.filter(
      (p) => p.agreement.domain && p.agreement.signup_gap && p.agreement.source,
    ).length
    expect(allSoftAgree).toBe(16)
    const n = result.candidates
    const expectedByChance =
      n * (result.weights.domain.agreeing / n) * (result.weights.signup_gap.agreeing / n) * (result.weights.source.agreeing / n)
    expect(expectedByChance).toBeGreaterThan(15)
    expect(expectedByChance).toBeLessThan(19)
    const deviceWeight = result.weights.shared_device
    const deviceDisagree = Math.log2((1 - deviceWeight.m) / (1 - deviceWeight.u))
    expect(deviceDisagree).toBeCloseTo(-3.32, 1)
    // Every review pair shares the same agreement pattern (all three soft fields, not shared_device).
    const weightWithoutDevice = reviewPairs[0].weight - deviceDisagree
    const scoreWithoutDevice = Math.round(100 / (1 + 2 ** -weightWithoutDevice))
    expect(scoreWithoutDevice).toBeGreaterThanOrEqual(95)
    expect(scoreWithoutDevice).toBeLessThanOrEqual(99)
  })

  it('GET /api/duplicates (seed, 0 webhook events sent yet): candidates/review/hidden/to_review/weights/per-pair scores match the oracle', async () => {
    const cookie = await loginCookie()
    const res = await SELF.fetch('http://cdp.test/api/duplicates', { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = await res.json<{
      candidates: number
      to_review: number
      hidden_below_review: number
      review: { pair_id: string; score: number }[]
      weights: Record<'domain' | 'signup_gap' | 'source' | 'shared_device', { m: number; u: number; agree: number; disagree: number }>
    }>()
    expect(body.candidates).toBe(1704)
    expect(body.hidden_below_review).toBe(1688)
    expect(body.review.length).toBe(16)
    expect(body.to_review).toBe(16) // no decisions submitted yet

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

    // Per-pair scores, exact.
    const expectedScoreByPairId = new Map(
      result.pairs.filter((p) => p.band !== 'hidden').map((p) => [p.pair_id, p.score]),
    )
    const gotScoreByPairId = new Map(body.review.map((p) => [p.pair_id, p.score]))
    expect(gotScoreByPairId).toEqual(expectedScoreByPairId)

    // Weights, within 1e-9.
    for (const field of ['domain', 'signup_gap', 'source', 'shared_device'] as const) {
      const expectedField = result.weights[field]
      const gotField = body.weights[field]
      expect(gotField.m).toBeCloseTo(expectedField.m, 9)
      expect(gotField.u).toBeCloseTo(expectedField.u, 9)
      expect(gotField.agree).toBeCloseTo(Math.log2(expectedField.m / expectedField.u), 9)
      expect(gotField.disagree).toBeCloseTo(Math.log2((1 - expectedField.m) / (1 - expectedField.u)), 9)
    }
  })

  it('a submitted review writes only duplicate_reviews, naming real subscriber pkeys with pkey_a < pkey_b, and changes no other table', async () => {
    const cookie = await loginCookie()
    const listRes = await SELF.fetch('http://cdp.test/api/duplicates', { headers: { cookie } })
    const listBody = await listRes.json<{ review: { pair_id: string }[] }>()
    const target = listBody.review[0]
    if (target === undefined) throw new Error('parity: no review-band pair available to submit a decision on')

    // A review changes no other table: every table a review could plausibly touch,
    // not only subscribers/profiles.
    const countsBefore = await Promise.all(
      ['subscribers', 'profiles', 'web_visitors', 'web_events', 'app_users', 'import_runs', 'quarantine'].map(
        (table) => env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n'),
      ),
    )

    const reviewRes = await SELF.fetch(`http://cdp.test/api/duplicates/${target.pair_id}/review`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'same_person' }),
    })
    expect(reviewRes.status, await reviewRes.clone().text()).toBe(200)

    const row = await env.DB.prepare('SELECT pair_id, pkey_a, pkey_b FROM duplicate_reviews WHERE pair_id = ?')
      .bind(target.pair_id)
      .first<{ pair_id: string; pkey_a: string; pkey_b: string }>()
    if (row === null) throw new Error('parity: the submitted review was not stored')
    expect(row.pkey_a < row.pkey_b).toBe(true)
    const knownPkeys = new Set(oracle.subscribers.keys())
    expect(knownPkeys.has(row.pkey_a)).toBe(true)
    expect(knownPkeys.has(row.pkey_b)).toBe(true)

    const countsAfter = await Promise.all(
      ['subscribers', 'profiles', 'web_visitors', 'web_events', 'app_users', 'import_runs', 'quarantine'].map(
        (table) => env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n'),
      ),
    )
    expect(countsAfter).toEqual(countsBefore)
  })
})

// -------------------------------------------------------------------------------------------
// T-PAR-8: after real signed webhooks, 0 mismatches (stitch, stub, shared device, full re-diff)
// -------------------------------------------------------------------------------------------
describe('T-PAR-8 store-side (webhook) cases', () => {
  const nextEventId = eventIdPool()

  // "Used the app in the last 7 days", computed from the ORACLE's own
  // resolveAppEvents, never from a store SQL count: every event this describe block
  // sends is recorded here in file order, and the count below re-resolves ownership from that
  // in-memory list alone. Before any send it is the CSV-only oracle set (0 app events, by
  // construction); each sendWebhook call below also pushes here, right after a 202.
  const sentAppEvents: StoredAppEvent[] = []

  /** Distinct resolved user_ids with an event at or after TODAY-6 (7 days inclusive), from the
   * oracle's own device resolution over `sentAppEvents` alone (a simplified check of the
   * app_active_within_days segment filter). */
  function activeLast7FromOracle(): number {
    const resolved = resolveAppEvents(sentAppEvents)
    const cutoff = `${addDays(TODAY, -6)}T00:00:00Z`
    const active = new Set<string>()
    for (const e of sentAppEvents) {
      const owner = e.user_id ?? resolved.deviceOwner.get(e.device_id) ?? null
      if (owner !== null && e.event_ts >= cutoff) active.add(owner)
    }
    return active.size
  }

  /** The subscriber a real app_users.csv user_id links to, by the oracle's own fold (never an
   * email local part in the error). */
  function subscriberForUserId(userId: string) {
    const emailNorm = oracle.appUsers.find((u) => u.user_id === userId)?.email_norm
    return emailNorm === undefined
      ? undefined
      : [...oracle.subscribers.values()].find((s) => s.email_norm === emailNorm)
  }

  it("julia.evans230's engagement recomputes exactly (hardest case #1, the .5-tie formula) after one signed read_story: 28 -> 31 (02 §Counts)", async () => {
    // Real app_users.csv row: u_2b6447a3, no web history.
    const userId = 'u_2b6447a3'
    const subscriber = subscriberForUserId(userId)
    if (subscriber === undefined) throw new Error('parity: expected app_users.csv line 1 fixture missing from the oracle')
    const before = await env.DB.prepare('SELECT engagement_score FROM profiles WHERE pkey = ?')
      .bind(subscriber.pkey)
      .first<{ engagement_score: number }>()
    expect(before?.engagement_score).toBe(subscriber.profile.engagement_score)
    expect(before?.engagement_score).toBe(28)

    // "Used the app in the last 7 days: 0 on the seed (no app events)" —
    // from the oracle's own set (0 from the CSV-only oracle set), not a store SQL count.
    expect(activeLast7FromOracle()).toBe(0)

    const eventId = nextEventId()
    const timestamp = `${TODAY}T10:00:00Z`
    const res = await sendWebhook(
      JSON.stringify({
        event_id: eventId,
        event: 'read_story',
        user_id: userId,
        device_id: 'd_2b6447a3',
        timestamp,
        properties: { story: 'supreme-court-ruling-explained' },
      }),
    )
    expect(res.status, await res.clone().text()).toBe(202)
    sentAppEvents.push({ event_id: eventId, user_id: userId, device_id: 'd_2b6447a3', event_ts: timestamp })

    const after = await env.DB.prepare('SELECT engagement_score FROM profiles WHERE pkey = ?')
      .bind(subscriber.pkey)
      .first<{ engagement_score: number }>()
    const expectedAfter = engagementScore(subscriber.days_since_open, 1, subscriber.web.site_visits_30d)
    expect(after?.engagement_score).toBe(expectedAfter)
    expect(after?.engagement_score).toBe(31)

    // 1 right after, by running the oracle's own resolveAppEvents over the sent events,
    // never a store SQL count.
    expect(activeLast7FromOracle()).toBe(1)
  })

  it('F1 repro (hardest case #1, ranked first): emily.green827 at exactly 24 days since open, 0 site visits, scores the exact half-up 13 after one app event, never the float-rounded 12', async () => {
    // Real app_users.csv line 12: u_ffe05a36, last_open_date 2026-09-04 (24 days
    // before TODAY), 0 web history: the .5-tie case's own example data point.
    const userId = 'u_ffe05a36'
    const subscriber = subscriberForUserId(userId)
    if (subscriber === undefined) throw new Error('parity: expected app_users.csv line 12 fixture missing from the oracle')
    expect(subscriber.days_since_open).toBe(24)
    expect(subscriber.web.site_visits_30d).toBe(0)
    expect(subscriber.profile.engagement_score).toBe(10) // seed: 0 app events

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
    const expectedAfter = engagementScore(24, 1, 0)
    expect(expectedAfter).toBe(13) // exact half-up of 12.5; the fixed float formula would give 12
    expect(after?.engagement_score, `pkey ${subscriber.pkey}`).toBe(expectedAfter)
  })

  it('T-PAR-8 app-events cap (M A2 guard): 11 real signed webhooks for one real linked subscriber store the exact capped-at-10 score, never an 11th-event score', async () => {
    // Real app_users.csv line 568: u_9ecb49d6, hope.hall130@gmail.com — a
    // different real linked subscriber than julia.evans230's test above.
    const userId = 'u_9ecb49d6'
    const subscriber = subscriberForUserId(userId)
    if (subscriber === undefined) throw new Error('parity: expected app_users.csv line 568 fixture missing from the oracle')
    expect(subscriber.days_since_open).toBe(5)
    expect(subscriber.web.site_visits_30d).toBe(0)
    expect(subscriber.profile.engagement_score).toBe(42) // seed: 0 app events

    const EVENT_COUNT = 11
    for (let i = 0; i < EVENT_COUNT; i++) {
      const res = await sendWebhook(
        JSON.stringify({
          event_id: nextEventId(),
          event: 'read_story',
          user_id: userId,
          device_id: 'd_9ecb49d6',
          timestamp: `${TODAY}T0${i < 10 ? '0' : '1'}:${String((i % 10) * 5).padStart(2, '0')}:00Z`,
          properties: { story: `cap-guard-story-${i}` },
        }),
      )
      expect(res.status, await res.clone().text()).toBe(202)
    }

    const after = await env.DB.prepare('SELECT engagement_score FROM profiles WHERE pkey = ?')
      .bind(subscriber.pkey)
      .first<{ engagement_score: number }>()
    // The oracle's own cap: min(APP_EVENTS_CAP, 11) === min(APP_EVENTS_CAP, 10), so 11 real events
    // must store exactly the same score as the cap itself (exact arithmetic). A mutant
    // that lowers the app cap below 10 (e.g. Math.min(10 -> 9) in shared/derive.ts) stores a
    // different number here and fails this assertion.
    const expectedAfter = engagementScore(subscriber.days_since_open, EVENT_COUNT, subscriber.web.site_visits_30d)
    const expectedAtCap = engagementScore(subscriber.days_since_open, 10, subscriber.web.site_visits_30d)
    expect(expectedAfter).toBe(expectedAtCap)
    expect(expectedAfter).toBe(67)
    expect(after?.engagement_score, `pkey ${subscriber.pkey}`).toBe(expectedAfter)
  })

  it('an unknown webhook user_id creates a stub profile with no email and a pkey the oracle can reproduce (hardest case #14/#16)', async () => {
    // A real id (app_users.csv u_3380b6e6) with its last character removed: never occurs in the CSVs.
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
    const expectedStubPkey = await pkeyForUserId(secret, unknownUserId)
    const stub = await env.DB.prepare('SELECT pkey, email_norm, kind FROM profiles WHERE pkey = ?')
      .bind(expectedStubPkey)
      .first<{ pkey: string; email_norm: string | null; kind: string }>()
    expect(stub).toMatchObject({ pkey: expectedStubPkey, email_norm: null, kind: 'unknown_user_stub' })
    const anyEmailPkeys = new Set([...oracle.subscribers.keys(), ...oracle.appOnlyProfiles.keys()])
    expect(anyEmailPkeys.has(expectedStubPkey)).toBe(false)

    // v_app_events — the view the assistant's app-activity counts read — resolves
    // this stub's own event to the independently recomputed stub pkey, matching Look up and
    // /events, instead of pkey NULL under the old email-only join (NULL = NULL is never true).
    const { results: stubViewRows } = await env.DB.prepare('SELECT event FROM v_app_events WHERE pkey = ?')
      .bind(expectedStubPkey)
      .all<{ event: string }>()
    expect(stubViewRows).toEqual([{ event: 'app_open' }])
  })

  it('v_app_events: a second stub in the store, and the WHOLE view independently rebuilt and diffed (M5b guard: a stub join must match by user_id, never fan out to every stub)', async () => {
    // A second, distinct unknown user_id: app_users.csv:7's real u_c0d06d19 with its last
    // character removed, unused anywhere earlier in this file.
    const secondUnknown = 'u_c0d06d1'
    const secondDevice = 'd_c0d06d1'
    const res = await sendWebhook(
      JSON.stringify({
        event_id: nextEventId(),
        event: 'login',
        user_id: secondUnknown,
        device_id: secondDevice,
        timestamp: `${TODAY}T10:06:00Z`,
      }),
    )
    expect(res.status, await res.clone().text()).toBe(202)
    const secondStubPkey = await pkeyForUserId(secret, secondUnknown)

    // Independently resolve EVERY stored app_events row to a pkey — the oracle's own
    // resolveAppEvents (device owner + ambiguity, no window) plus the oracle's own
    // pkeyForEmailNorm/pkeyForUserId, reading app_users only to learn each resolved user_id's
    // email_norm (or lack of one), never importing worker/identity/resolve.ts or the view SQL.
    const { results: storedEvents } = await env.DB.prepare(
      'SELECT event_id, user_id, device_id, event_ts, event FROM app_events',
    ).all<StoredAppEvent & { event: string }>()
    const { deviceOwner, ambiguousDevices } = resolveAppEvents(storedEvents)
    const { results: appUserRows } = await env.DB.prepare('SELECT user_id, email_norm FROM app_users').all<{
      user_id: string
      email_norm: string | null
    }>()
    const emailByUserId = new Map(appUserRows.map((r) => [r.user_id, r.email_norm]))
    const pkeyByUserId = new Map<string, string>()
    async function pkeyFor(userId: string): Promise<string> {
      const cached = pkeyByUserId.get(userId)
      if (cached !== undefined) return cached
      const email = emailByUserId.get(userId) ?? null
      const pkey = email === null ? await pkeyForUserId(secret, userId) : await pkeyForEmailNorm(secret, email)
      pkeyByUserId.set(userId, pkey)
      return pkey
    }
    const expectedRows: { pkey: string; event: string; event_ts: string }[] = []
    for (const e of storedEvents) {
      const owner = e.user_id ?? deviceOwner.get(e.device_id) ?? null
      if (owner === null) continue
      if (ambiguousDevices.includes(e.device_id) && e.user_id === null) continue
      expectedRows.push({ pkey: await pkeyFor(owner), event: e.event, event_ts: e.event_ts })
    }

    // A fan-out join (every stub matching the LEFT JOIN, not just its own) inflates the row
    // count beyond app_events' own, which this total catches even before any field is compared.
    expect(storedEvents).toHaveLength(storedEvents.length) // sanity: the SELECT above read them all
    const { results: viewRows } = await env.DB.prepare(
      'SELECT pkey, event, event_ts FROM v_app_events WHERE pkey IS NOT NULL ORDER BY pkey, event_ts, event',
    ).all<{ pkey: string; event: string; event_ts: string }>()
    const sortKey = (r: { pkey: string; event_ts: string; event: string }) => `${r.pkey}|${r.event_ts}|${r.event}`
    expect(viewRows.map(sortKey).sort()).toEqual(expectedRows.map(sortKey).sort())
    expect(viewRows).toHaveLength(expectedRows.length)

    const totalViewRows = await env.DB.prepare('SELECT count(*) AS n FROM v_app_events').first<{ n: number }>()
    expect(totalViewRows?.n).toBe(storedEvents.length) // one view row per app_events row, never fanned out

    // Both stubs resolve to their OWN pkey, not each other's.
    const stubRows = viewRows.filter((r) => r.pkey === secondStubPkey)
    expect(stubRows).toEqual([{ pkey: secondStubPkey, event: 'login', event_ts: `${TODAY}T10:06:00Z` }])
  })

  it('hardest case #16, the stitch: an anonymous app_open then a login on one device, then an anonymous read_story, all resolve to the logged-in user', async () => {
    // Real app_users.csv row: u_baba14aa, daniel.hill389@gmail.com. Never referenced earlier in
    // this file, so this device carries no prior events.
    const userId = 'u_baba14aa'
    const device = 'd_baba14aa'
    const openRes = await sendWebhook(
      JSON.stringify({
        event_id: nextEventId(),
        event: 'app_open',
        device_id: device,
        timestamp: `${TODAY}T12:00:00Z`,
      }),
    )
    expect(openRes.status, await openRes.clone().text()).toBe(202)
    const loginRes = await sendWebhook(
      JSON.stringify({
        event_id: nextEventId(),
        event: 'login',
        user_id: userId,
        device_id: device,
        timestamp: `${TODAY}T12:00:00Z`, // same second as the anonymous app_open
      }),
    )
    expect(loginRes.status, await loginRes.clone().text()).toBe(202)
    const storyRes = await sendWebhook(
      JSON.stringify({
        event_id: nextEventId(),
        event: 'read_story',
        device_id: device,
        timestamp: `${TODAY}T12:00:01Z`, // anonymous again, after the login
        properties: { story: 'stitched-event-repro' },
      }),
    )
    expect(storyRes.status, await storyRes.clone().text()).toBe(202)

    const { results: events } = await env.DB.prepare(
      'SELECT event_id, user_id, device_id, event_ts FROM app_events WHERE device_id = ?',
    )
      .bind(device)
      .all<StoredAppEvent>()
    expect(events.length).toBe(3)
    const resolved = resolveAppEvents(events)
    expect(resolved.ambiguousDevices).toEqual([])
    expect(resolved.deviceOwner.get(device)).toBe(userId)
    expect(resolved.countByUserId.get(userId)).toBe(3)
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
      throw new Error('parity: expected shared-device fixture subscribers missing from the oracle')
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
    if (pair === undefined) throw new Error('parity: expected shared-device pair missing from the oracle candidates')
    expect(pair.score).toBeGreaterThanOrEqual(90)

    const cookie = await loginCookie()
    const res = await SELF.fetch('http://cdp.test/api/duplicates', { headers: { cookie } })
    const body = await res.json<{ review: { pair_id: string; score: number; band: string }[] }>()
    const stored = body.review.find((p) => p.pair_id === pair.pair_id)
    if (stored === undefined) throw new Error('parity: the auto-band shared-device pair is missing from GET /api/duplicates')
    expect(stored.score).toBe(pair.score)
    expect(stored.band).toBe('auto')
  })

  it("the oracle's own device resolution agrees with the store's device_identity for every device seen so far, in both directions", async () => {
    async function mask(value: string): Promise<string> {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
      return [...digest].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('')
    }

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

    // Masked (never printed raw), both directions: the oracle names no device the
    // store lacks, and the store names no device the oracle lacks.
    const resolvedPairs = await Promise.all(
      [...resolved.deviceOwner].map(async ([d, o]) => `${await mask(d)}:${await mask(o)}`),
    )
    const storedPairs = await Promise.all([...storedOwners].map(async ([d, o]) => `${await mask(d)}:${await mask(o)}`))
    expect(new Set(resolvedPairs)).toEqual(new Set(storedPairs))
    expect(resolved.deviceOwner.size).toBe(storedOwners.size)
  })

  it('every one of the 2,930 subscriber/app_only profiles, plus every unknown_user_stub, recomputes exactly after every webhook above (21 §2.6 "diff again"); guards M19 (site visits zeroed on recompute) and M20 (resolve.ts drops a login-stitched anonymous event)', async () => {
    // profilesTable() reads app_events_last_30d fresh from the store (appEventsByEmail), so
    // calling it here — after every T-PAR-8 webhook — re-diffs the subscriber + app_only half
    // of profiles exactly as T-PAR-2 did on the seed, now against the post-webhook state.
    const { expected, got, fields } = await profilesTable()
    const rediff: Mismatch[] = []
    const { missing, extra } = diffByKey('profiles', 'pkey', expected, got, fields, rediff)
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(rediff.map(reportLine)).toEqual([])
    expect(expected.size).toBe(2930)

    // unknown_user_stub profiles: not in profilesTable() (it excludes that kind), checked here.
    const { results: storedEvents } = await env.DB.prepare(
      'SELECT event_id, user_id, device_id, event_ts FROM app_events',
    ).all<StoredAppEvent>()
    const resolved = resolveAppEvents(storedEvents)
    expect(resolved.ambiguousDevices).toEqual([])
    const { results: stubUsers } = await env.DB.prepare(
      'SELECT user_id FROM app_users WHERE email_norm IS NULL',
    ).all<{ user_id: string }>()
    const { results: stubProfileRows } = await env.DB.prepare(
      `SELECT pkey, engagement_score FROM profiles WHERE kind = 'unknown_user_stub'`,
    ).all<{ pkey: string; engagement_score: number }>()
    const stubGot = new Map(stubProfileRows.map((r) => [r.pkey, r as Row]))
    const stubExpected = new Map<string, Row>()
    for (const { user_id: userId } of stubUsers) {
      const pkey = await pkeyForUserId(secret, userId)
      stubExpected.set(pkey, { pkey, engagement_score: engagementScore(null, resolved.countByUserId.get(userId) ?? 0, 0) })
    }
    const stubRediff: Mismatch[] = []
    const stubDiff = diffByKey('profiles', 'pkey', stubExpected, stubGot, ['engagement_score'], stubRediff)
    expect(stubDiff.missing).toEqual([])
    expect(stubDiff.extra).toEqual([])
    expect(stubRediff.map(reportLine)).toEqual([])
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
// T-PAR-10: planted single-value swaps are each reported (the harness can fail), for every
// compared column of every table — not only subscribers.source — all done in memory on a copy
// of the already-fetched rows, so the real test database is never written.
// -------------------------------------------------------------------------------------------
describe('T-PAR-10 the harness can fail', () => {
  /** The first two keys whose real values for `field` differ, or null when every row agrees
   * (e.g. app_users.from_csv, which this data holds as 1 on every row: nothing real to swap in,
   * and inventing one is not allowed). */
  function firstDifferingPair(got: Map<string, Row>, field: string): [string, unknown] | null {
    let first: { key: string; value: unknown } | undefined
    for (const [key, row] of got) {
      const value = row[field]
      if (first === undefined) {
        first = { key, value }
        continue
      }
      if (value !== first.value) return [first.key, value]
    }
    return null
  }

  /** Clones `got`'s row at `key`, swaps `field` to `otherValue`, diffs that one field alone
   * against `expected`, and asserts exactly one mismatch at the right key and field. */
  function assertSwapCaught(
    table: string,
    keyKind: string,
    expected: Map<string, Row>,
    got: Map<string, Row>,
    key: string,
    field: string,
    otherValue: unknown,
  ): void {
    const swapped = new Map(got)
    const original = got.get(key)
    if (original === undefined) throw new Error(`parity: T-PAR-10 lost its own row for ${table} key ${key}`)
    swapped.set(key, { ...original, [field]: otherValue })
    const mutationReport: Mismatch[] = []
    diffByKey(table, keyKind, expected, swapped, [field], mutationReport)
    expect(mutationReport, `${table}.${field}`).toHaveLength(1)
    expect(mutationReport[0]).toMatchObject({ table, key, field })
  }

  async function checkTable(
    label: string,
    build: () => Promise<{ expected: Map<string, Row>; got: Map<string, Row>; fields: readonly string[] }>,
    keyKind: string,
  ) {
    const { expected, got, fields } = await build()
    for (const field of fields) {
      const found = firstDifferingPair(got, field)
      if (found === null) continue // no second real value exists for this column on this data
      const [key, otherValue] = found
      assertSwapCaught(label, keyKind, expected, got, key, field, otherValue)
    }
  }

  it('every compared column of every table: a swap to another real value is caught as exactly one mismatch', async () => {
    await checkTable('subscribers', subscribersTable, 'pkey')
    await checkTable('profiles', profilesTable, 'pkey')
    await checkTable('v_profiles', vProfilesTable, 'pkey')
    await checkTable('quarantine', quarantineTable, 'file:line')
    await checkTable('import_runs', importRunsTable, 'file')
    await checkTable('web_visitors', webVisitorsTable, 'visitor_hash')
    await checkTable('web_events', webEventsTable, 'id')
    await checkTable('app_users', appUsersTable, 'csv_line')
  })

  it('subscribers.source specifically (the original case): swapping one real source for another is caught at the right pkey', async () => {
    const { expected, got } = await subscribersTable()
    const subs = [...oracle.subscribers.values()]
    const distinctSources = [...new Set(subs.map((s) => s.source).filter((s): s is string => s !== null))]
    const a = subs.find((s) => s.source === distinctSources[0])
    const b = subs.find((s) => s.source === distinctSources[1] && s.pkey !== a?.pkey)
    if (a === undefined || b === undefined) throw new Error('parity: could not find two subscribers with different real sources')
    assertSwapCaught('subscribers', 'pkey', expected, got, a.pkey, 'source', b.source)
  })
})
