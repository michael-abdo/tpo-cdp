/**
 * Parity oracle. A second, independent
 * recomputation of every subscriber's expected record straight from the raw CSV bytes, written
 * from the data rules, derived definitions, expected counts and pseudonymous-key rule
 * — never from the app's own code. T-PAR-1 (test/parity.test.ts) enforces this by reading this
 * file's text and failing on any import outside vitest, cloudflare:test and Node/Web built-ins:
 * this file imports nothing at all, so that check always passes.
 *
 * Evidence: a throwaway Python prototype of exactly this logic ran against a copy of the local D1
 * and the remote D1 (read-only) on 2026-10-14 and found 0 mismatches over every table. This file
 * is a fresh TypeScript port of the same rules, written from the rules and the expected numbers
 * only — nothing here is copied from the prototype or from the app.
 *
 * Every date is a plain `YYYY-MM-DD` (or `YYYY-MM-DDTHH:MM:SSZ`) string; day arithmetic reads the
 * first 10 characters and uses `Date.UTC`, never `new Date(localString)`.
 */

// ---------------------------------------------------------------------------------------------
// Its own constants
// ---------------------------------------------------------------------------------------------

/** TODAY is a constant for every business-logic comparison. The test file (not this
 * one) asserts this equals shared/config.ts's TODAY. */
export const TODAY = '2026-09-28'

/** cold_since: the fallback + recency window. */
const COLD_DAYS = 30
/** new_subscriber: signed up within the last N days including today. */
const NEW_SUBSCRIBER_DAYS = 30
/** engagement_score: the app-events cap (full credit at 10 events). */
const APP_EVENTS_CAP = 10
/** engagement_score: the site-visits cap (full credit at 5 visits). */
const SITE_VISITS_CAP = 5
// GAP: nothing independent of the app derives these m-values; they are the numbers
// worker/dedupe/score.ts uses and docs/notes.md lists, "a documented assumption".
/** The fuzzy-duplicate m-probabilities (a documented assumption, never measured). */
const M_PROBABILITIES: Record<ScoredFieldName, number> = {
  domain: 0.8,
  signup_gap: 0.5,
  source: 0.8,
  shared_device: 0.9,
}
/** A field with no agreeing (or no disagreeing) candidate counts half a pair short, so the weight stays finite. */
const UNSEEN_AGREEMENT_PAIRS = 0.5
/** Signup dates this many days apart or fewer agree. */
const SIGNUP_GAP_MAX_DAYS = 7
/** Possible-duplicate score bands. */
const AUTO_MIN_SCORE = 90
const REVIEW_MIN_SCORE = 50

// ---------------------------------------------------------------------------------------------
// Its own CSV reader — strict and tiny, ASCII only, no quoted fields (the data has 0)
// ---------------------------------------------------------------------------------------------

export interface ParsedCsv {
  header: string[]
  /** One row per data line, in file order. */
  rows: string[][]
  /** File line number of rows[i] (header is line 1; no quoted newlines in this data). */
  lineNos: number[]
}

/** Decodes and splits one CSV file's text. Fails loud on anything the real data does not have:
 * a non-ASCII byte, a quote character, or a row whose column count does not match the header. */
export function parseCsvStrict(text: string, file: string): ParsedCsv {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 0x7f) throw new Error(`oracle: ${file} has a non-ASCII byte at offset ${i}`)
  }
  if (text.includes('"'))
    throw new Error(`oracle: ${file} contains a quote character; this reader cannot parse one`)
  const lines = text.split(/\r\n|\n|\r/)
  // A trailing newline leaves one empty final "line"; drop it, but only if it is truly empty.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) throw new Error(`oracle: ${file} is empty`)
  const header = lines[0].split(',')
  const rows: string[][] = []
  const lineNos: number[] = []
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',')
    if (row.length !== header.length) {
      throw new Error(`oracle: ${file} line ${i + 1} has ${row.length} fields, header has ${header.length}`)
    }
    rows.push(row)
    lineNos.push(i + 1)
  }
  return { header, rows, lineNos }
}

/** Index of each column by name; throws naming the file and the missing column. */
function columnIndex(
  file: string,
  header: readonly string[],
  names: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const name of names) {
    const at = header.indexOf(name)
    if (at === -1) throw new Error(`oracle: ${file} is missing column "${name}"`)
    out[name] = at
  }
  return out
}

/** Re-serializes one row as a single RFC 4180 CSV record (the quarantine's `raw_row`): a field is
 * quoted only if it holds a comma, quote or line break, with internal quotes doubled. On this
 * data (no quotes, no embedded commas) every field passes through unchanged. */
export function toCsvRecord(row: readonly string[]): string {
  return row.map((f) => (/[",\r\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(',')
}

// ---------------------------------------------------------------------------------------------
// Own email fold, source canonicalization, date validity — restated from the normalization and
// quarantine rules, never imported from shared/normalize.ts
// ---------------------------------------------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** `trim()` then `toLowerCase()`; nothing else. */
export function fold(raw: string): string {
  return raw.trim().toLowerCase()
}

/** `null` unless the folded value matches the subscriber-email shape. */
export function normalizeEmail(raw: string): string | null {
  const folded = fold(raw)
  return EMAIL_RE.test(folded) ? folded : null
}

/**
 * Whether a web_events.csv `page` links like `/subscribe` — its own copy of
 * worker/ingest/web.ts's `isSubscribePage`, never imported. Case-insensitive on the path only;
 * any query string is dropped first and at most one trailing slash is stripped, so
 * `/subscribe?utm_source=x`, `/subscribe/` and `/Subscribe` all match, `/subscribe/about` and
 * `/subscrib` do not.
 */
export function oracleIsSubscribePage(page: string): boolean {
  const query = page.indexOf('?')
  const bare = (query === -1 ? page : page.slice(0, query)).toLowerCase()
  const stripped = bare.endsWith('/') && bare !== '/' ? bare.slice(0, -1) : bare
  return stripped === '/subscribe'
}

/** Trim, lowercase, `twitter → x`; blank → `null`; anything else passes through lowercased. */
export function canonicalSource(raw: string): string | null {
  const folded = raw.trim().toLowerCase()
  if (folded === '') return null
  if (folded === 'twitter') return 'x'
  return folded
}

/**
 * Optimal string alignment distance (Damerau-Levenshtein restricted to one transposition per
 * substring, the same metric the fuzzy-lookup fixtures were first computed with): insert, delete,
 * substitute = 1; a transposition of two adjacent characters = 1.
 * Its own implementation; never imports `worker/lookup/fuzzy.ts`.
 */
export function damerauLevenshtein(a: string, b: string): number {
  const d: number[][] = []
  for (let i = 0; i <= a.length; i++) d[i] = [i]
  for (let j = 0; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[a.length][b.length]
}

/** `YYYY-MM-DD` naming a real calendar day (own implementation; same shape rule as the quarantine's). */
export function isIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const [, y, mo, d] = m.map(Number) as unknown as [number, number, number, number]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

const DAY_MS = 86_400_000

function dayMs(isoDay: string): number {
  if (!isIsoDate(isoDay)) throw new Error(`oracle: not a calendar date: ${JSON.stringify(isoDay)}`)
  const [y, mo, d] = isoDay.split('-').map(Number)
  return Date.UTC(y, mo - 1, d)
}

/** `date + n` calendar days, as `YYYY-MM-DD` (own UTC arithmetic). */
export function addDays(date: string, n: number): string {
  return new Date(dayMs(date) + n * DAY_MS).toISOString().slice(0, 10)
}

/** Whole calendar days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((dayMs(b) - dayMs(a)) / DAY_MS)
}

// ---------------------------------------------------------------------------------------------
// Its own HMAC — WebCrypto directly, never shared/pseudonym.ts
// ---------------------------------------------------------------------------------------------

async function hmacHex16(secret: string, message: string): Promise<string> {
  if (secret === '') throw new Error('oracle: PII_KEY_SECRET is empty')
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
  let hex = ''
  for (const byte of mac.subarray(0, 8)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** `pk_` + HMAC-SHA256(secret, emailNorm)[:16 hex] (the pseudonymous key). */
export async function pkeyForEmailNorm(secret: string, emailNorm: string): Promise<string> {
  return `pk_${await hmacHex16(secret, emailNorm)}`
}

/** The stub key for an unknown webhook user: hashes `user:` + id. */
export async function pkeyForUserId(secret: string, userId: string): Promise<string> {
  return `pk_${await hmacHex16(secret, `user:${userId}`)}`
}

/** `visitor_hash`: hashes `visitor:` + id. */
export async function visitorHash(secret: string, visitorId: string): Promise<string> {
  return `pk_${await hmacHex16(secret, `visitor:${visitorId}`)}`
}

async function sha256Hex16(message: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message)))
  let hex = ''
  for (const byte of digest.subarray(0, 8)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** `dp_` + SHA-256(`lo|hi`)[:16 hex], pkeys sorted (the duplicate pair id). */
export async function pairId(pkeyA: string, pkeyB: string): Promise<string> {
  const [lo, hi] = pkeyA < pkeyB ? [pkeyA, pkeyB] : [pkeyB, pkeyA]
  return `dp_${await sha256Hex16(`${lo}|${hi}`)}`
}

// ---------------------------------------------------------------------------------------------
// Exact arithmetic for the engagement score (in sixtieths, so a .5 tie never rounds down by float error)
// ---------------------------------------------------------------------------------------------

/**
 * `engagement_score`: recency 50 × max(0, 1 − days_since_open/30) + app 25 ×
 * min(1, app_events_last_30d/10) + site 25 × min(1, site_visits_last_30d/5), rounded half up
 * exactly. Everything is carried in sixtieths so no float
 * division ever happens: n = 100·max(0, 30 − d) + 150·min(a, 10) + 300·min(s, 5);
 * score = floor((2n + 60) / 120).
 */
export function engagementScore(daysSinceOpen: number | null, appEvents: number, siteVisits: number): number {
  const recencyPart = daysSinceOpen === null ? 0 : 100 * Math.max(0, 30 - daysSinceOpen)
  const appPart = 150 * Math.min(APP_EVENTS_CAP, Math.max(0, appEvents))
  const sitePart = 300 * Math.min(SITE_VISITS_CAP, Math.max(0, siteVisits))
  const n = recencyPart + appPart + sitePart
  return Math.floor((2 * n + 60) / 120)
}

function daysSinceOpen(lastOpenDate: string | null): number | null {
  if (lastOpenDate === null) return null
  return Math.max(0, daysBetween(lastOpenDate, TODAY))
}

// ---------------------------------------------------------------------------------------------
// Canonical expected record
// ---------------------------------------------------------------------------------------------

export type QuarantineReason =
  | 'blank_row'
  | 'invalid_email'
  | 'missing_field'
  | 'bad_date'
  | 'unknown_status'
  | 'misplaced_email'
  | 'conflicting_email'
  | 'duplicate_user_id'

export interface ExpectedQuarantine {
  file: 'subscribers' | 'web_events' | 'app_users'
  line_no: number
  reason: QuarantineReason
  raw_row: string
}

export interface ExpectedRun {
  file: 'subscribers' | 'web_events' | 'app_users'
  rows_in: number
  rows_out: number
  merged: number
  quarantined: number
}

export interface ExpectedVisitor {
  visitor_id: string
  visitor_hash: string
  email_norm: string | null
  first_seen_ts: string
  first_page: string
  first_utm_source: string | null
  signup_ts: string | null
}

export interface ExpectedEvent {
  id: number
  visitor_id: string
  page: string
  event_ts: string
  utm_source: string | null
}

export interface ExpectedAppUser {
  csvLine: number
  user_id: string
  email_norm: string
  created_at: string
  from_csv: 1
}

export interface ExpectedSubscriber {
  pkey: string
  email_norm: string
  email_raw: string
  /** Every subscribers.csv line collapsed into this record (report only). */
  sourceLines: number[]
  merged_count: number
  signup_date: string
  status: 'active' | 'unsubscribed'
  source: string | null
  last_open_date: string | null
  cold_since: string
  // Read-time values, checked against stored/derived columns, never stored themselves except
  // where noted.
  days_since_open: number | null
  cold: boolean
  new_subscriber: boolean
  profile: { kind: 'subscriber'; created_at: string; engagement_score: number }
  app: { csvLines: number[]; created_at_min: string | null; has_app: boolean; app_after_signup: boolean }
  web: {
    visitor_hashes: string[]
    first_page: string | null
    first_utm_source: string | null
    signup_ts: string | null
    events: number
    pre_signup_events: number
    site_visits_30d: number
  }
}

export interface ExpectedAppOnly {
  pkey: string
  email_norm: string
  created_at: string
  engagement_score: number
}

export interface ScoredField {
  domain: boolean
  signup_gap: boolean
  source: boolean
  shared_device: boolean
}
type ScoredFieldName = keyof ScoredField
const SCORED_FIELD_NAMES: ScoredFieldName[] = ['domain', 'signup_gap', 'source', 'shared_device']

export interface ExpectedPairInput {
  pkey: string
  email_norm: string
  signup_date: string
  source: string | null
}

export interface ExpectedPair {
  pair_id: string
  a_pkey: string
  b_pkey: string
  weight: number
  score: number
  band: 'auto' | 'review' | 'hidden'
  agreement: ScoredField
}

export interface OracleResult {
  subscribers: Map<string, ExpectedSubscriber> // keyed by pkey
  quarantine: ExpectedQuarantine[]
  importRuns: ExpectedRun[]
  visitors: Map<string, ExpectedVisitor> // keyed by visitor_hash
  events: ExpectedEvent[] // events[i].id === i + 1
  appUsers: ExpectedAppUser[] // keyed by csvLine
  appOnlyProfiles: Map<string, ExpectedAppOnly> // keyed by pkey
  /** email_norm -> count of linked web events in [TODAY-30 .. TODAY], uncapped (score caps at 5). */
  siteVisits30d: Map<string, number>
  /** pkey -> count of app_events-table events in the 30-day no-upper-bound app window (seed = 0 for everyone). */
  appEvents30dSeed: Map<string, number>
}

interface MergingSubscriber {
  email_norm: string
  rawByLine: { line: number; raw: string }[]
  signupDates: { signup: string; line: number }[]
  statuses: ('active' | 'unsubscribed')[]
  sourcesBySignup: { signup: string; line: number; source: string }[]
  opens: string[]
}

/** The three raw CSV files' text, unparsed. */
export interface OracleCsvs {
  subscribers: string
  webEvents: string
  appUsers: string
}

/**
 * Builds every expected record from the raw CSV text, independent of the app's ingest, dedupe,
 * link and derive code. `secret` is PII_KEY_SECRET, read by the caller the same way the
 * seed does (env, else `.dev.vars`); this file never reads `.dev.vars` or `env` itself.
 */
export async function buildExpected(csvs: OracleCsvs, secret: string): Promise<OracleResult> {
  // ---- subscribers.csv (quarantine, then dedupe; checked in this order: blank row, blank email,
  // invalid email, other missing fields, bad date)
  const sub = parseCsvStrict(csvs.subscribers, 'subscribers.csv')
  const subCol = columnIndex('subscribers.csv', sub.header, [
    'email',
    'signup_date',
    'status',
    'acquisition_source',
    'last_open_date',
  ])
  const quarantine: ExpectedQuarantine[] = []
  const merging = new Map<string, MergingSubscriber>()

  sub.rows.forEach((row, i) => {
    const lineNo = sub.lineNos[i]
    const q = (reason: QuarantineReason): void => {
      quarantine.push({ file: 'subscribers', line_no: lineNo, reason, raw_row: toCsvRecord(row) })
    }
    if (row.every((f) => f.trim() === '')) return q('blank_row')
    const emailRaw = row[subCol.email]
    const emailTrimmed = emailRaw.trim()
    if (emailTrimmed === '') return q('missing_field')
    const emailNorm = normalizeEmail(emailRaw)
    if (emailNorm === null) return q('invalid_email')
    const signup = row[subCol.signup_date].trim()
    const status = row[subCol.status].trim()
    if (signup === '' || status === '') return q('missing_field')
    const lastOpenRaw = row[subCol.last_open_date].trim()
    if (!isIsoDate(signup) || (lastOpenRaw !== '' && !isIsoDate(lastOpenRaw))) return q('bad_date')
    // A status that is present but not active/unsubscribed is quarantined, not thrown
    // (the oracle's own copy of worker/ingest/quarantine.ts's classifySubscriberRow rule).
    if (status !== 'active' && status !== 'unsubscribed') return q('unknown_status')

    const source = canonicalSource(row[subCol.acquisition_source])
    const group = merging.get(emailNorm) ?? {
      email_norm: emailNorm,
      rawByLine: [],
      signupDates: [],
      statuses: [],
      sourcesBySignup: [],
      opens: [],
    }
    group.rawByLine.push({ line: lineNo, raw: emailRaw })
    group.signupDates.push({ signup, line: lineNo })
    group.statuses.push(status)
    if (source !== null) group.sourcesBySignup.push({ signup, line: lineNo, source })
    if (lastOpenRaw !== '') group.opens.push(lastOpenRaw)
    merging.set(emailNorm, group)
  })

  const subscribers = new Map<string, ExpectedSubscriber>()
  for (const [emailNorm, group] of merging) {
    const pkey = await pkeyForEmailNorm(secret, emailNorm)
    // email_raw: the untrimmed text of the lowest file line ("first spelling seen").
    // GAP: no written rule says email_raw is kept verbatim, untrimmed, and never read; this follows the app.
    const emailRaw = group.rawByLine.reduce((best, r) => (r.line < best.line ? r : best)).raw
    const signupDate = group.signupDates.reduce((a, b) => (b.signup < a.signup ? b : a)).signup
    const status: 'active' | 'unsubscribed' = group.statuses.includes('unsubscribed')
      ? 'unsubscribed'
      : 'active'
    // source: earliest-signup non-blank row; tie -> earlier line (T-HARD-9).
    let source: string | null = null
    if (group.sourcesBySignup.length > 0) {
      const best = group.sourcesBySignup.reduce((a, b) =>
        b.signup < a.signup || (b.signup === a.signup && b.line < a.line) ? b : a,
      )
      source = best.source
    }
    const lastOpenDate = group.opens.length === 0 ? null : group.opens.reduce((a, b) => (b > a ? b : a))
    const coldSince = addDays(lastOpenDate ?? signupDate, COLD_DAYS)
    const dso = daysSinceOpen(lastOpenDate)
    subscribers.set(pkey, {
      pkey,
      email_norm: emailNorm,
      email_raw: emailRaw,
      sourceLines: group.rawByLine.map((r) => r.line).sort((a, b) => a - b),
      merged_count: group.rawByLine.length,
      signup_date: signupDate,
      status,
      source,
      last_open_date: lastOpenDate,
      cold_since: coldSince,
      days_since_open: dso,
      cold: dayMs(coldSince) <= dayMs(TODAY),
      new_subscriber:
        dayMs(signupDate) >= dayMs(addDays(TODAY, -NEW_SUBSCRIBER_DAYS)) && dayMs(signupDate) <= dayMs(TODAY),
      profile: { kind: 'subscriber', created_at: signupDate, engagement_score: 0 }, // filled below
      app: { csvLines: [], created_at_min: null, has_app: false, app_after_signup: false },
      web: {
        visitor_hashes: [],
        first_page: null,
        first_utm_source: null,
        signup_ts: null,
        events: 0,
        pre_signup_events: 0,
        site_visits_30d: 0,
      },
    })
  }

  const subRowsIn = sub.rows.length
  const subMerged = [...merging.values()].reduce((sum, g) => sum + (g.rawByLine.length - 1), 0)

  // ---- web_events.csv (web → subscriber linking; a visitor's first page is its earliest event's)
  const web = parseCsvStrict(csvs.webEvents, 'web_events.csv')
  const webCol = columnIndex('web_events.csv', web.header, [
    'visitor_id',
    'page',
    'timestamp',
    'utm_source',
    'email',
  ])
  const TS_RE = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/
  const events: ExpectedEvent[] = []
  interface VisitorBuild {
    emails: Set<string>
    firstKey: [string, number] | null // [event_ts, line] ascending
    firstPage: string | null
    firstUtm: string | null
    signupTs: string | null
    eventLines: number[]
  }
  const visitorsBuild = new Map<string, VisitorBuild>()

  web.rows.forEach((row, i) => {
    const lineNo = web.lineNos[i]
    const q = (reason: QuarantineReason): void => {
      quarantine.push({ file: 'web_events', line_no: lineNo, reason, raw_row: toCsvRecord(row) })
    }
    if (row.every((field) => field.trim() === '')) return q('blank_row')
    const visitorId = row[webCol.visitor_id].trim()
    const page = row[webCol.page].trim()
    const rawTs = row[webCol.timestamp].trim()
    const emailRaw = row[webCol.email].trim()
    // Order mirrors worker/ingest/web.ts's classifyWebRow, re-derived independently:
    // blank_row, missing_field, invalid_email, bad_date, misplaced_email.
    if (visitorId === '' || page === '' || rawTs === '') return q('missing_field')
    let emailNorm: string | null = null
    if (emailRaw !== '') {
      emailNorm = normalizeEmail(emailRaw)
      if (emailNorm === null) return q('invalid_email')
    }
    const m = TS_RE.exec(rawTs)
    if (!m) return q('bad_date')
    const eventTs = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`
    const utm = canonicalSource(row[webCol.utm_source])
    // A case-insensitive /subscribe match (query string and one trailing slash still
    // count), the oracle's own copy — never worker/ingest/web.ts's isSubscribePage.
    if (emailNorm !== null && !oracleIsSubscribePage(page)) return q('misplaced_email')

    // Stateful (needs the visitor map, so it stays here rather than in the checks above): a
    // second, different /subscribe email for a visitor that already has one is quarantined and
    // not added as an event; the visitor keeps its first email (file order).
    const existing = visitorsBuild.get(visitorId)
    if (emailNorm !== null && existing !== undefined && existing.emails.size > 0 && !existing.emails.has(emailNorm)) {
      return q('conflicting_email')
    }

    // GAP: web_events.id = 1-based index among kept rows; no written rule names this, it follows the app.
    events.push({ id: events.length + 1, visitor_id: visitorId, page, event_ts: eventTs, utm_source: utm })
    const v = existing ?? {
      emails: new Set<string>(),
      firstKey: null,
      firstPage: null,
      firstUtm: null,
      signupTs: null,
      eventLines: [],
    }
    v.eventLines.push(lineNo)
    if (emailNorm !== null) {
      v.emails.add(emailNorm)
      if (v.signupTs === null || eventTs < v.signupTs) v.signupTs = eventTs
    }
    const key: [string, number] = [eventTs, lineNo]
    if (
      v.firstKey === null ||
      key[0] < v.firstKey[0] ||
      (key[0] === v.firstKey[0] && key[1] < v.firstKey[1])
    ) {
      v.firstKey = key
      v.firstPage = page
      v.firstUtm = utm
    }
    visitorsBuild.set(visitorId, v)
  })

  const visitors = new Map<string, ExpectedVisitor>()
  for (const [visitorId, v] of visitorsBuild) {
    // The conflicting_email check above now keeps every visitor's `emails` set at size <= 1 (a
    // conflicting row is quarantined, never merged); this stays as a defense of that invariant.
    if (v.emails.size > 1)
      throw new Error(`oracle: web_events.csv line ${v.eventLines[0]}'s visitor carries 2+ different emails`)
    const emailNorm = v.emails.size === 1 ? [...v.emails][0] : null
    const hash = await visitorHash(secret, visitorId)
    if (v.firstKey === null || v.firstPage === null) throw new Error('oracle: visitor with no events')
    visitors.set(hash, {
      visitor_id: visitorId,
      visitor_hash: hash,
      email_norm: emailNorm,
      first_seen_ts: v.firstKey[0],
      first_page: v.firstPage,
      first_utm_source: v.firstUtm,
      signup_ts: v.signupTs,
    })
  }

  // ---- app_users.csv (app → subscriber linking)
  const app = parseCsvStrict(csvs.appUsers, 'app_users.csv')
  const appCol = columnIndex('app_users.csv', app.header, ['user_id', 'email', 'created_at'])
  const appUsers: ExpectedAppUser[] = []
  const firstLineByUserId = new Map<string, number>()
  app.rows.forEach((row, i) => {
    const lineNo = app.lineNos[i]
    const q = (reason: QuarantineReason): void => {
      quarantine.push({ file: 'app_users', line_no: lineNo, reason, raw_row: toCsvRecord(row) })
    }
    // Order mirrors worker/ingest/app.ts's classifyAppRow: blank_row, missing_field
    // (email), invalid_email, missing_field (user_id/created_at), bad_date — then, once a row
    // can become an app user, the stateful duplicate_user_id check below.
    if (row.every((field) => field.trim() === '')) return q('blank_row')
    const emailRaw = row[appCol.email].trim()
    if (emailRaw === '') return q('missing_field')
    const emailNorm = normalizeEmail(emailRaw)
    if (emailNorm === null) return q('invalid_email')
    const userId = row[appCol.user_id].trim()
    const createdAt = row[appCol.created_at].trim()
    if (userId === '' || createdAt === '') return q('missing_field')
    if (!isIsoDate(createdAt)) return q('bad_date')
    // Never print a raw id; cite both CSV lines instead (this one is now in the
    // quarantine's own raw_row, same as every other reason).
    const firstLine = firstLineByUserId.get(userId)
    if (firstLine !== undefined) return q('duplicate_user_id')
    firstLineByUserId.set(userId, lineNo)
    appUsers.push({
      csvLine: lineNo,
      user_id: userId,
      email_norm: emailNorm,
      created_at: createdAt,
      from_csv: 1,
    })
  })

  // ---- site visits per email in [TODAY-30 .. TODAY], both ends included, by EVENT count
  const windowFrom = addDays(TODAY, -30)
  const emailByVisitorId = new Map<string, string | null>()
  for (const v of visitors.values()) emailByVisitorId.set(v.visitor_id, v.email_norm)
  const siteVisits30d = new Map<string, number>()
  for (const ev of events) {
    const email = emailByVisitorId.get(ev.visitor_id) ?? null
    if (email === null) continue
    const day = ev.event_ts.slice(0, 10)
    if (day >= windowFrom && day <= TODAY) siteVisits30d.set(email, (siteVisits30d.get(email) ?? 0) + 1)
  }

  // ---- fold web + app onto subscribers, compute profiles
  const subscribersByEmail = new Map<string, string>() // email_norm -> pkey
  for (const [pkey, s] of subscribers) subscribersByEmail.set(s.email_norm, pkey)

  for (const v of visitors.values()) {
    if (v.email_norm === null) continue
    const pkey = subscribersByEmail.get(v.email_norm)
    if (pkey === undefined) continue // a web email absent from subscribers.csv (0 on this data)
    const s = subscribers.get(pkey)
    if (s === undefined) continue
    s.web.visitor_hashes.push(v.visitor_hash)
  }
  for (const s of subscribers.values()) {
    const own = s.web.visitor_hashes
      .map((h) => visitors.get(h))
      .filter((v): v is ExpectedVisitor => v !== undefined)
    if (own.length > 0) {
      const earliest = own.reduce((a, b) =>
        b.first_seen_ts < a.first_seen_ts ||
        (b.first_seen_ts === a.first_seen_ts && b.visitor_hash < a.visitor_hash)
          ? b
          : a,
      )
      s.web.first_page = earliest.first_page
      s.web.first_utm_source = earliest.first_utm_source
      const signupTimes = own.map((v) => v.signup_ts).filter((t): t is string => t !== null)
      s.web.signup_ts = signupTimes.length === 0 ? null : signupTimes.reduce((a, b) => (b < a ? b : a))
      let total = 0
      let preSignup = 0
      for (const v of own) {
        const vEvents = events.filter((e) => e.visitor_id === v.visitor_id)
        total += vEvents.length
        if (v.signup_ts !== null)
          preSignup += vEvents.filter((e) => e.event_ts < (v.signup_ts as string)).length
      }
      s.web.events = total
      s.web.pre_signup_events = preSignup
    }
    s.web.site_visits_30d = siteVisits30d.get(s.email_norm) ?? 0
  }

  const appMinByEmail = new Map<string, string>()
  for (const u of appUsers) {
    const cur = appMinByEmail.get(u.email_norm)
    if (cur === undefined || u.created_at < cur) appMinByEmail.set(u.email_norm, u.created_at)
  }
  for (const u of appUsers) {
    const pkey = subscribersByEmail.get(u.email_norm)
    if (pkey === undefined) continue
    subscribers.get(pkey)?.app.csvLines.push(u.csvLine)
  }
  for (const s of subscribers.values()) {
    s.app.csvLines.sort((a, b) => a - b)
    const minCreated = appMinByEmail.get(s.email_norm) ?? null
    s.app.created_at_min = minCreated
    s.app.has_app = minCreated !== null
    s.app.app_after_signup = minCreated !== null && daysBetween(s.signup_date, minCreated) > 0
    s.profile.engagement_score = engagementScore(s.days_since_open, 0, s.web.site_visits_30d)
  }

  const appOnlyProfiles = new Map<string, ExpectedAppOnly>()
  for (const [emailNorm, createdAt] of appMinByEmail) {
    if (subscribersByEmail.has(emailNorm)) continue
    const pkey = await pkeyForEmailNorm(secret, emailNorm)
    appOnlyProfiles.set(pkey, {
      pkey,
      email_norm: emailNorm,
      created_at: createdAt,
      engagement_score: engagementScore(null, 0, siteVisits30d.get(emailNorm) ?? 0),
    })
  }

  const webRowsIn = web.rows.length
  const appRowsIn = app.rows.length
  // `quarantine` now holds every file's rows (web_events and app_users push onto it above too),
  // so each run's count is filtered by file rather than the whole array's length.
  const quarantinedCount = (file: ExpectedQuarantine['file']): number =>
    quarantine.filter((row) => row.file === file).length
  const importRuns: ExpectedRun[] = [
    {
      file: 'subscribers',
      rows_in: subRowsIn,
      rows_out: subscribers.size,
      merged: subMerged,
      quarantined: quarantinedCount('subscribers'),
    },
    {
      file: 'web_events',
      rows_in: webRowsIn,
      rows_out: events.length,
      merged: 0,
      quarantined: quarantinedCount('web_events'),
    },
    {
      file: 'app_users',
      rows_in: appRowsIn,
      rows_out: appUsers.length,
      merged: 0,
      quarantined: quarantinedCount('app_users'),
    },
  ]

  return {
    subscribers,
    quarantine,
    importRuns,
    visitors,
    events,
    appUsers,
    appOnlyProfiles,
    siteVisits30d,
    appEvents30dSeed: new Map(), // the seed carries 0 webhook events; filled by webhook-aware helpers below
  }
}

// ---------------------------------------------------------------------------------------------
// Webhook data in the store — the oracle resolves app_events itself, independent of
// worker/identity/resolve.ts. Not part of buildExpected (which is seed-only); the test file calls
// this after sending real signed webhooks, with the store's own app_events + device_identity rows.
// ---------------------------------------------------------------------------------------------

export interface StoredAppEvent {
  event_id: string
  user_id: string | null
  device_id: string
  event_ts: string
}

export interface ResolvedAppEvents {
  /** user_id -> count of events resolved to them in [TODAY-30 .. +inf) by event day (no upper bound). */
  countByUserId: Map<string, number>
  /** device_id -> resolved owner (the identified event with the latest event_ts). */
  deviceOwner: Map<string, string>
  /** device/user pairs where the resolution is ambiguous (two users tie on event_ts for one device). */
  ambiguousDevices: string[]
}

/**
 * Identity resolution: an event's own user_id, else the device's identified user with
 * the latest event_ts. A same-event_ts tie between two different users on one device cannot be
 * settled from the rows alone (arrival order wins, which the stored rows do not carry); such a
 * device is reported as ambiguous, not diffed as a mismatch.
 */
export function resolveAppEvents(events: readonly StoredAppEvent[]): ResolvedAppEvents {
  const byDevice = new Map<string, StoredAppEvent[]>()
  for (const e of events) {
    if (e.user_id === null) continue
    const list = byDevice.get(e.device_id) ?? []
    list.push(e)
    byDevice.set(e.device_id, list)
  }
  const deviceOwner = new Map<string, string>()
  const ambiguousDevices: string[] = []
  for (const [deviceId, list] of byDevice) {
    const maxTs = list.reduce((max, e) => (e.event_ts > max ? e.event_ts : max), list[0].event_ts)
    const atMax = new Set(list.filter((e) => e.event_ts === maxTs).map((e) => e.user_id as string))
    if (atMax.size > 1) {
      ambiguousDevices.push(deviceId)
      continue
    }
    deviceOwner.set(deviceId, [...atMax][0])
  }
  const windowFrom = addDays(TODAY, -30)
  const countByUserId = new Map<string, number>()
  for (const e of events) {
    const owner = e.user_id ?? deviceOwner.get(e.device_id) ?? null
    if (owner === null) continue
    if (ambiguousDevices.includes(e.device_id) && e.user_id === null) continue
    const day = e.event_ts.slice(0, 10)
    if (day >= windowFrom) countByUserId.set(owner, (countByUserId.get(owner) ?? 0) + 1) // no upper bound
  }
  return { countByUserId, deviceOwner, ambiguousDevices }
}

// ---------------------------------------------------------------------------------------------
// Possible-duplicate review — Fellegi–Sunter scoring, independent of worker/dedupe/score.ts
// ---------------------------------------------------------------------------------------------

/** `first.last` before trailing digits; `null` when nothing is left (the name stem). */
export function nameStem(emailNorm: string): string | null {
  const at = emailNorm.lastIndexOf('@')
  const local = at < 0 ? emailNorm : emailNorm.slice(0, at)
  const stem = local.replace(/\d+$/, '')
  return stem === '' ? null : stem
}

function domainOf(emailNorm: string): string {
  return emailNorm.slice(emailNorm.lastIndexOf('@') + 1)
}

export interface DuplicatesResult {
  candidates: number
  stems: number
  emailsInStems: number
  pairs: ExpectedPair[]
  weights: Record<ScoredFieldName, { m: number; u: number; agreeing: number }>
}

/** Every candidate pair, scored by the oracle's own Fellegi–Sunter port of the duplicate scoring.
 * `sharedDevicePairs`: pkey-pair keys (`a|b`, a<b) seen on one app device (identified events). */
export async function scoreDuplicates(
  readers: readonly ExpectedPairInput[],
  sharedDevicePairs: ReadonlySet<string>,
): Promise<DuplicatesResult> {
  const byStem = new Map<string, ExpectedPairInput[]>()
  for (const r of readers) {
    const stem = nameStem(r.email_norm)
    if (stem === null) continue
    const g = byStem.get(stem) ?? []
    g.push(r)
    byStem.set(stem, g)
  }
  const stemGroups = [...byStem.values()].filter((g) => g.length > 1)
  const emailsInStems = stemGroups.reduce((sum, g) => sum + g.length, 0)

  interface Raw {
    a: ExpectedPairInput
    b: ExpectedPairInput
    agreement: ScoredField
  }
  const raw: Raw[] = []
  for (const group of byStem.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [x, y] = group[i].pkey < group[j].pkey ? [group[i], group[j]] : [group[j], group[i]]
        const gap = Math.abs(daysBetween(x.signup_date, y.signup_date))
        const pairKey = `${x.pkey}|${y.pkey}`
        raw.push({
          a: x,
          b: y,
          agreement: {
            domain: domainOf(x.email_norm) === domainOf(y.email_norm),
            signup_gap: gap <= SIGNUP_GAP_MAX_DAYS,
            source: x.source !== null && x.source === y.source,
            shared_device: sharedDevicePairs.has(pairKey),
          },
        })
      }
    }
  }
  const n = raw.length
  const agreeingCount = (field: ScoredFieldName): number => raw.filter((p) => p.agreement[field]).length
  const weights = {} as Record<ScoredFieldName, { m: number; u: number; agreeing: number }>
  for (const field of SCORED_FIELD_NAMES) {
    const agreeing = agreeingCount(field)
    const clamped =
      n === 0 ? 0 : Math.min(Math.max(agreeing, UNSEEN_AGREEMENT_PAIRS), n - UNSEEN_AGREEMENT_PAIRS)
    const u = n === 0 ? 0.5 : clamped / n
    weights[field] = { m: M_PROBABILITIES[field], u, agreeing }
  }
  const pairs: ExpectedPair[] = []
  for (const p of raw) {
    let weight = 0
    for (const field of SCORED_FIELD_NAMES) {
      const w = weights[field]
      weight += p.agreement[field] ? Math.log2(w.m / w.u) : Math.log2((1 - w.m) / (1 - w.u))
    }
    const score = Math.round(100 / (1 + 2 ** -weight))
    const band: ExpectedPair['band'] =
      score >= AUTO_MIN_SCORE ? 'auto' : score >= REVIEW_MIN_SCORE ? 'review' : 'hidden'
    pairs.push({
      pair_id: await pairId(p.a.pkey, p.b.pkey),
      a_pkey: p.a.pkey,
      b_pkey: p.b.pkey,
      weight,
      score,
      band,
      agreement: p.agreement,
    })
  }
  return { candidates: n, stems: stemGroups.length, emailsInStems, pairs, weights }
}
