/**
 * Parity harness, local mode: runs `test/parity/oracle.ts` against a throwaway LOCAL
 * D1, never the dev database and never the remote one (a remote mode is out of scope —
 * recorded below and in docs/notes.md "Known gaps": it needs production
 * D1 credentials, which stay out of a developer-facing npm script).
 *
 * Steps: a fresh `--persist-to` directory under the OS temp dir → `wrangler d1 migrations apply
 * --local` → `scripts/csv2sql.ts` (data/*.csv → seed/*.sql) → every seed/*.sql loaded into that
 * same directory → SELECT every seed-only table via `wrangler d1 execute --local --json` → the
 * key probe → a field-by-field diff against the oracle → the PII report scan
 * → exit 0 only when the report is empty.
 *
 * This is a Node/tsx script (not a vitest/workerd test), so every D1 access goes through the
 * `wrangler d1 execute` CLI, the same way `scripts/db-remote.ts` already does for the remote
 * database. It imports only `test/parity/oracle.ts` (a remote mode would import the same
 * oracle); the diff and report logic below is its own copy of the same small shape
 * `test/parity.test.ts` uses, since a `.test.ts` file is not an importable module for a plain
 * Node script.
 *
 * Usage: `npm run parity -- --local` (`--remote` is refused, naming the descope above).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildExpected,
  type OracleResult,
  pkeyForEmailNorm,
  type ExpectedQuarantine,
  type ExpectedRun,
  type ExpectedVisitor,
  type ExpectedEvent,
  type ExpectedAppUser,
} from './oracle'

// This file is test/parity/run.ts: its own directory (dirname once) is test/parity, so two more
// dirname calls (three total) reach the repo root. Built from fileURLToPath(import.meta.url) (a
// string), never `new URL(...)`, because this file is compiled under tsconfig.worker.json (it
// lives under test/ for the one-home scans), whose ambient Workers-runtime `URL` type
// is not the same `URL` node:url's fileURLToPath expects.
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const DB = 'cdp'
const SECRET_NAME = 'PII_KEY_SECRET'

/** The secret from the environment, else the one PII_KEY_SECRET line of .dev.vars — same
 * precedence `scripts/csv2sql.ts` uses; never printed. */
function piiKeySecret(): string {
  const fromEnv = process.env[SECRET_NAME]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const path = join(ROOT, '.dev.vars')
  if (!existsSync(path)) throw new Error(`${SECRET_NAME} is not set and .dev.vars does not exist`)
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*PII_KEY_SECRET\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const value = match[1].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    if (value === '') break
    return value
  }
  throw new Error(`${SECRET_NAME} is not set in the environment or .dev.vars`)
}

/** Runs a command with inherited output; throws naming the step on a non-zero exit. */
function run(step: string, cmd: string, args: string[]): void {
  console.log(`\n▶ ${step}`)
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
  if (res.error) throw new Error(`${step}: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`${step}: exited with ${res.status ?? res.signal}`)
}

/** `wrangler d1 execute --local --persist-to <dir> --json --command`; every statement must
 * succeed; returns the last one's rows. Read-only by construction (every call here is a
 * SELECT); a remote mode (not built) would additionally check each response's `changed_db`/
 * `rows_written`. */
function query<T>(persistTo: string, step: string, sql: string): T[] {
  const res = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, '--local', `--persist-to=${persistTo}`, '--json', '--command', sql],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (res.error) throw new Error(`${step}: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`${step}: exited with ${res.status ?? res.signal}: ${res.stdout}`)
  const start = res.stdout.indexOf('[')
  if (start < 0) throw new Error(`${step}: no JSON in wrangler output: ${res.stdout}`)
  const parsed = JSON.parse(res.stdout.slice(start)) as { results: T[]; success: boolean }[]
  if (parsed.length === 0 || parsed.some((r) => !r.success)) throw new Error(`${step}: query failed: ${res.stdout}`)
  return parsed[parsed.length - 1].results
}

// ---------------------------------------------------------------------------------------------
// Reporting — a smaller copy of test/parity.test.ts's report machinery, kept in step
// with it by comparing the same field sets T-PAR-2/3 use. See that file's comment for why a
// second small copy lives here (a .test.ts file is not an importable module for a plain script).
// ---------------------------------------------------------------------------------------------

interface Mismatch {
  table: string
  key: string
  field: string
  expected: string
  actual: string
}

const PII_FIELDS = new Set(['email_norm', 'email_raw', 'raw_row'])
const REPORT_CAP = 20

function shown(field: string, value: unknown): string {
  if (PII_FIELDS.has(field)) return `len ${String(value ?? '').length}`
  return JSON.stringify(value)
}

type Row = Record<string, unknown>

function diff(table: string, expected: Map<string, Row>, got: Map<string, Row>, fields: readonly string[]): {
  missing: string[]
  extra: string[]
  mismatches: Mismatch[]
} {
  const missing: string[] = []
  const extra: string[] = []
  const mismatches: Mismatch[] = []
  for (const key of expected.keys()) if (!got.has(key)) missing.push(key)
  for (const key of got.keys()) if (!expected.has(key)) extra.push(key)
  for (const [key, exp] of expected) {
    const gotRow = got.get(key)
    if (gotRow === undefined) continue
    for (const field of fields) {
      if (exp[field] !== gotRow[field]) {
        mismatches.push({ table, key, field, expected: shown(field, exp[field]), actual: shown(field, gotRow[field]) })
      }
    }
  }
  return { missing, extra, mismatches }
}

function reportLine(m: Mismatch): string {
  return `${m.table} · pkey · ${m.key} · ${m.field} · ${m.expected} · ${m.actual}`
}

/** Fail closed: before printing, the report is scanned for @ and raw ids. */
function reportBlocked(lines: readonly string[]): boolean {
  const text = lines.join('\n')
  if (text.includes('@')) return true
  if (/\b[ud]_[0-9a-f]{6,}\b/.test(text)) return true
  return false
}

function printCapped(lines: readonly string[]): void {
  const shownLines = lines.slice(0, REPORT_CAP)
  for (const l of shownLines) console.log(`  ${l}`)
  if (lines.length > REPORT_CAP) console.log(`  … and ${lines.length - REPORT_CAP} more`)
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const mode = process.argv.slice(2).find((a) => a.startsWith('--'))
  if (mode === '--remote') {
    throw new Error(
      'remote mode (--remote) is out of scope: it needs production D1 ' +
        'credentials; this script only runs against a throwaway local store. Use ' +
        '`wrangler d1 execute cdp --remote` by hand for a one-off remote parity check.',
    )
  }
  if (mode !== '--local') throw new Error('usage: npm run parity -- --local')

  const persistTo = mkdtempSync(join(tmpdir(), 'cdp-parity-'))
  console.log(`throwaway local D1: ${persistTo} (never the dev database)`)
  try {
    run('apply migrations (fresh local D1)', 'npx', [
      'wrangler', 'd1', 'migrations', 'apply', DB, '--local', `--persist-to=${persistTo}`,
    ])
    run('csv2sql: data/*.csv → seed/*.sql', 'npx', ['tsx', 'scripts/csv2sql.ts'])
    const seedDir = join(ROOT, 'seed')
    const seedFiles = readdirSync(seedDir).filter((f) => f.endsWith('.sql')).sort()
    if (seedFiles.length === 0) throw new Error('csv2sql wrote no seed/*.sql files')
    for (const file of seedFiles) {
      run(`load seed/${file}`, 'npx', [
        'wrangler', 'd1', 'execute', DB, '--local', `--persist-to=${persistTo}`, `--file=seed/${file}`,
      ])
    }

    const secret = piiKeySecret()
    const [subscribersCsv, webCsv, appCsv] = ['subscribers.csv', 'web_events.csv', 'app_users.csv'].map((f) =>
      readFileSync(join(ROOT, 'data', f), 'utf8'),
    )
    const oracle: OracleResult = await buildExpected(
      { subscribers: subscribersCsv, webEvents: webCsv, appUsers: appCsv },
      secret,
    )

    // Key probe first.
    const probeRows = query<{ pkey: string; email_norm: string }>(
      persistTo,
      'key probe',
      'SELECT pkey, email_norm FROM profiles WHERE email_norm IS NOT NULL LIMIT 10',
    )
    let agree = 0
    for (const r of probeRows) if ((await pkeyForEmailNorm(secret, r.email_norm)) === r.pkey) agree++
    if (probeRows.length > 0 && agree === 0) {
      throw new Error('parity: wrong PII_KEY_SECRET for this store (key probe failed 0 of 10)')
    }
    console.log(`key probe: ${agree}/${probeRows.length} agree`)

    const report: Mismatch[] = []
    let missingTotal = 0
    let extraTotal = 0

    // subscribers (test/parity.test.ts's SUBSCRIBER_FIELDS).
    {
      const fields = ['email_norm', 'email_raw', 'signup_date', 'status', 'source', 'last_open_date', 'cold_since', 'merged_count']
      const rows = query<Row>(
        persistTo,
        'select subscribers',
        `SELECT p.pkey AS pkey, s.email_norm, s.email_raw, s.signup_date, s.status, s.source,
                s.last_open_date, s.cold_since, s.merged_count
         FROM subscribers s JOIN profiles p ON p.email_norm = s.email_norm AND p.kind = 'subscriber'`,
      )
      const got = new Map(rows.map((r) => [r.pkey as string, r]))
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
      const { missing, extra, mismatches } = diff('subscribers', expected, got, fields)
      missingTotal += missing.length
      extraTotal += extra.length
      report.push(...mismatches)
    }

    // profiles (seed-only: no webhook in mode B, so app_events_last_30d is 0 for everyone).
    {
      const fields = ['kind', 'created_at', 'engagement_score', 'email_norm']
      const rows = query<Row>(
        persistTo,
        'select profiles',
        `SELECT pkey, email_norm, kind, engagement_score, created_at FROM profiles WHERE kind != 'unknown_user_stub'`,
      )
      const got = new Map(rows.map((r) => [r.pkey as string, r]))
      const expected = new Map<string, Row>()
      for (const [pkey, s] of oracle.subscribers) {
        expected.set(pkey, { pkey, kind: 'subscriber', created_at: s.profile.created_at, engagement_score: s.profile.engagement_score, email_norm: s.email_norm })
      }
      for (const [pkey, a] of oracle.appOnlyProfiles) {
        expected.set(pkey, { pkey, kind: 'app_only', created_at: a.created_at, engagement_score: a.engagement_score, email_norm: a.email_norm })
      }
      const { missing, extra, mismatches } = diff('profiles', expected, got, fields)
      missingTotal += missing.length
      extraTotal += extra.length
      report.push(...mismatches)
    }

    // quarantine (10 rows).
    {
      const fields = ['reason', 'raw_row']
      const rows = query<Row>(persistTo, 'select quarantine', 'SELECT file, line_no, reason, raw_row FROM quarantine')
      const got = new Map(rows.map((r) => [`${r.file}:${r.line_no}`, r]))
      const expected = new Map(
        oracle.quarantine.map((q: ExpectedQuarantine) => [`${q.file}:${q.line_no}`, q as unknown as Row]),
      )
      const { missing, extra, mismatches } = diff('quarantine', expected, got, fields)
      missingTotal += missing.length
      extraTotal += extra.length
      report.push(...mismatches)
    }

    // import_runs (3 rows).
    {
      const fields = ['rows_in', 'rows_out', 'merged', 'quarantined']
      const rows = query<Row>(persistTo, 'select import_runs', 'SELECT file, rows_in, rows_out, merged, quarantined FROM import_runs')
      const got = new Map(rows.map((r) => [r.file as string, r]))
      const expected = new Map(oracle.importRuns.map((r: ExpectedRun) => [r.file, r as unknown as Row]))
      const { missing, extra, mismatches } = diff('import_runs', expected, got, fields)
      missingTotal += missing.length
      extraTotal += extra.length
      report.push(...mismatches)
    }

    // v_profiles (all 11 non-key columns, same oracle fields T-PAR-2 uses).
    {
      const fields = [
        'has_app', 'app_created_at', 'app_after_signup', 'first_page', 'first_utm_source',
        'signup_date', 'status', 'source', 'last_open_date', 'cold_since', 'engagement_score',
      ]
      const rows = query<Row>(
        persistTo,
        'select v_profiles',
        `SELECT pkey, kind, has_app, app_created_at, app_after_signup, first_page, first_utm_source,
                signup_date, status, source, last_open_date, cold_since, engagement_score
         FROM v_profiles WHERE kind != 'unknown_user_stub'`,
      )
      const got = new Map(rows.map((r) => [r.pkey as string, r]))
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
          engagement_score: s.profile.engagement_score,
        })
      }
      for (const [pkey, a] of oracle.appOnlyProfiles) {
        // app_only has no subscriber row: v_profiles LEFT JOINs subscribers, so every
        // subscriber-sourced column is NULL (same as test/parity.test.ts's vProfilesTable()).
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
          engagement_score: a.engagement_score,
        })
      }
      const { missing, extra, mismatches } = diff('v_profiles', expected, got, fields)
      missingTotal += missing.length
      extraTotal += extra.length
      report.push(...mismatches)
    }

    // web_visitors (2,028 visitors × 7 stored columns, keyed by visitor_hash).
    {
      const fields = ['visitor_id', 'email_norm', 'first_seen_ts', 'first_page', 'first_utm_source', 'signup_ts']
      const rows = query<Row>(
        persistTo,
        'select web_visitors',
        'SELECT visitor_id, visitor_hash, email_norm, first_seen_ts, first_page, first_utm_source, signup_ts FROM web_visitors',
      )
      const got = new Map(rows.map((r) => [r.visitor_hash as string, r]))
      const expected = new Map([...oracle.visitors].map(([h, v]: [string, ExpectedVisitor]) => [h, v as unknown as Row]))
      const { missing, extra, mismatches } = diff('web_visitors', expected, got, fields)
      missingTotal += missing.length
      extraTotal += extra.length
      report.push(...mismatches)
    }

    // web_events (10,000 events × 4 stored columns, keyed by id).
    {
      const fields = ['visitor_id', 'page', 'event_ts', 'utm_source']
      const rows = query<Row>(persistTo, 'select web_events', 'SELECT id, visitor_id, page, event_ts, utm_source FROM web_events')
      const got = new Map(rows.map((r) => [String(r.id), r]))
      const expected = new Map(oracle.events.map((e: ExpectedEvent) => [String(e.id), e as unknown as Row]))
      const { missing, extra, mismatches } = diff('web_events', expected, got, fields)
      missingTotal += missing.length
      extraTotal += extra.length
      report.push(...mismatches)
    }

    // app_users (930 rows × 3 stored columns, keyed by CSV line — user_id is PII).
    {
      const fields = ['email_norm', 'created_at', 'from_csv']
      const rows = query<Row>(
        persistTo,
        'select app_users',
        'SELECT user_id, email_norm, created_at, from_csv FROM app_users WHERE from_csv = 1',
      )
      const lineByUserId = new Map(oracle.appUsers.map((u: ExpectedAppUser) => [u.user_id, u.csvLine]))
      const got = new Map<string, Row>()
      let extraUserIds = 0
      for (const r of rows) {
        const line = lineByUserId.get(r.user_id as string)
        if (line === undefined) extraUserIds++
        else got.set(String(line), r)
      }
      const expected = new Map(oracle.appUsers.map((u: ExpectedAppUser) => [String(u.csvLine), u as unknown as Row]))
      const { missing, extra, mismatches } = diff('app_users', expected, got, fields)
      missingTotal += missing.length
      extraTotal += extra.length + extraUserIds
      report.push(...mismatches)
    }

    const lines = report.map(reportLine)
    if (reportBlocked(lines)) {
      console.error('parity: report blocked (an @ or a raw id reached the report text)')
      process.exitCode = 1
      return
    }

    console.log(`\nmissing ${missingTotal} · extra ${extraTotal} · field mismatches ${report.length}`)
    if (lines.length > 0) {
      const byField = new Map<string, string[]>()
      for (const l of lines) {
        const field = l.split(' · ')[3] ?? l
        const g = byField.get(field) ?? []
        g.push(l)
        byField.set(field, g)
      }
      for (const [, group] of byField) printCapped(group)
    }

    const ok = missingTotal === 0 && extraTotal === 0 && report.length === 0
    console.log(ok ? '\nparity: PASS' : '\nparity: FAIL')
    process.exitCode = ok ? 0 : 1
  } finally {
    rmSync(persistTo, { recursive: true, force: true })
  }
}

main().catch((err: unknown) => {
  console.error(`parity (mode B) failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
