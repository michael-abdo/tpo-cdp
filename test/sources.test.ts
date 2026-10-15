/// <reference types="vite/client" />
import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import subscribersCsv from '../data/subscribers.csv?raw'
import overviewSource from '../src/pages/OverviewPage.tsx?raw'
import { TODAY } from '../shared/config'
import { DEFINITIONS } from '../shared/derive'
import { explain, GLOSSARY, isGlossaryKey } from '../shared/glossary'
import { DEFINITION_LABEL } from '../src/labels'
import { CHECK_KINDS, LOADS_BY_LABEL, SOURCES } from '../shared/sources'
import type { Duplicates, DuplicateReview, Sources } from '../src/types'
import { parseCsv } from '../worker/ingest/csv'
import { QUARANTINE_REASONS } from '../worker/ingest/quarantine'
import { ingestSubscribers } from '../worker/ingest/subscribers'
import { loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'
import { SCAN_FIXTURES, type ScanFixture } from './helpers/screen-text'
import { eventIdPool, sendWebhook } from './helpers/webhook'

// GET /api/sources (T-SRC-1, T-SRC-3) and the Overview's
// glossary and registry discipline (T-SRC-2). The test D1 holds the real seed of data/*.csv
// (test/helpers/seed.ts); every expected number is the seed's. Webhook inputs: the user
// is app_users.csv line 2 (u_2b6447a3, julia.evans230, the PDF's sample), the brief's sample device
// d_4b21e8, event ids from eventIdPool(); event times are the brief's 2026-09-28T14:22:05Z (on
// TODAY) and web_events.csv line 3's 2026-06-30 20:45:52 (not on TODAY).

const BRIEF_TS = '2026-09-28T14:22:05Z'
const OLDER_TS = '2026-06-30T20:45:52Z'
const nextEventId = eventIdPool()
let cookie: string
let ranAt: string

beforeAll(async () => {
  cookie = await loginCookie()
})

const fetchSources = (headers: Record<string, string> = { cookie }) =>
  SELF.fetch('http://cdp.test/api/sources', { headers })

async function sources(): Promise<Sources['sources']> {
  const res = await fetchSources()
  expect(res.status).toBe(200)
  const body = await res.json<Sources>()
  expect(Object.keys(body)).toEqual(['sources'])
  return body.sources
}

async function postEvent(timestamp: string): Promise<void> {
  const body = {
    event_id: nextEventId(),
    event: 'read_story',
    user_id: 'u_2b6447a3',
    device_id: 'd_4b21e8',
    timestamp,
  }
  expect((await sendWebhook(JSON.stringify(body))).status).toBe(202)
}

/** The subscribers source's checks, in its registry order. */
const subscriberChecks = (rows_to_fix: number, possible_duplicates: number) => [
  { kind: 'rows_to_fix', count: rows_to_fix },
  { kind: 'possible_duplicates', count: possible_duplicates },
]

/** A CSV source with only the rows_to_fix check (web_events, app_users). */
const fixChecks = (rows_to_fix: number) => [{ kind: 'rows_to_fix', count: rows_to_fix }]

const csvRun = (rows_in: number, rows_out: number, merged: number, rejected: number, needs_review: number) => ({
  id: expect.any(Number),
  ran_at: ranAt,
  rows_in,
  rows_out,
  merged,
  rejected,
  needs_review,
})

// Runs first: the test D1 has the migrations (test/setup.ts) and no seed yet.
describe('GET /api/sources before the first seed', () => {
  it('each CSV source is not_loaded with 0 records, no last sync and no runs; the webhook is live with 0', async () => {
    const list = await sources()
    expect(list.map((s) => [s.id, s.status, s.records, s.runs, s.checks])).toEqual([
      ['subscribers', 'not_loaded', 0, [], subscriberChecks(0, 0)],
      ['web_events', 'not_loaded', 0, [], fixChecks(0)],
      ['app_users', 'not_loaded', 0, [], fixChecks(0)],
      ['app_events', 'live', 0, [], []],
    ])
    for (const s of list) expect(s.kind === 'csv' ? s.last_sync : s.last_received).toBeNull()
  })
})

describe('GET /api/sources (T-SRC-1)', () => {
  beforeAll(async () => {
    ;({ ranAt } = await seedDatabase())
  })

  it('4 sources in registry order with the 02 §Counts runs; names, kinds and units from shared/sources.ts', async () => {
    const list = await sources()
    expect(list.map((s) => s.id)).toEqual(['subscribers', 'web_events', 'app_users', 'app_events'])
    expect(list.map((s) => s.id)).toEqual(SOURCES.map((s) => s.id))
    for (const [i, s] of list.entries()) {
      const entry = SOURCES[i]
      expect([s.name, s.kind, s.unit, s.unit_one, s.loads_by]).toEqual([entry.name, entry.kind, entry.unit[1], entry.unit[0], entry.loads_by])
    }
    const [subscribers, web, app] = list
    expect(subscribers).toEqual({
      id: 'subscribers',
      name: 'beehiiv',
      kind: 'csv',
      unit: 'subscribers',
      unit_one: 'subscriber',
      loads_by: 'seed',
      status: 'needs_review',
      checks: subscriberChecks(2, 16),
      records: 2900,
      last_sync: ranAt,
      runs: [csvRun(2995, 2900, 85, 10, 2)],
    })
    expect(web).toMatchObject({ status: 'ok', checks: fixChecks(0), records: 10000, last_sync: ranAt, runs: [csvRun(10000, 10000, 0, 0, 0)] })
    expect(app).toMatchObject({ status: 'ok', checks: fixChecks(0), records: 930, last_sync: ranAt, runs: [csvRun(930, 930, 0, 0, 0)] })
    // The API's key order, for each kind.
    expect(Object.keys(subscribers)).toEqual([
      'id', 'name', 'kind', 'unit', 'unit_one', 'loads_by', 'status', 'checks', 'records', 'last_sync', 'runs',
    ])
    expect(Object.keys(subscribers.runs[0] ?? {})).toEqual([
      'id', 'ran_at', 'rows_in', 'rows_out', 'merged', 'rejected', 'needs_review',
    ])
    expect(new Set(list.slice(0, 3).map((s) => s.runs[0]?.id)).size).toBe(3)
  })

  it('app_events is live and counts what real signed webhooks stored; "today" is TODAY by event time', async () => {
    const before = (await sources())[3]
    expect(before).toEqual({
      id: 'app_events',
      name: 'App events',
      kind: 'webhook',
      unit: 'events',
      unit_one: 'event',
      loads_by: 'webhook',
      status: 'live',
      checks: [],
      records: 0,
      today: 0,
      last_received: null,
      runs: [],
    })
    // The API's key order for the webhook entry (toEqual above ignores order).
    expect(Object.keys(before ?? {})).toEqual([
      'id', 'name', 'kind', 'unit', 'unit_one', 'loads_by', 'status', 'checks', 'records', 'today', 'last_received', 'runs',
    ])

    await postEvent(BRIEF_TS)
    await postEvent(OLDER_TS)
    const after = (await sources())[3]
    const stored = await env.DB.prepare('SELECT count(*) AS n, max(received_at) AS last FROM app_events').first<{
      n: number
      last: string
    }>()
    expect(stored?.n).toBe(2)
    expect(after).toMatchObject({ status: 'live', records: stored?.n, today: 1, last_received: stored?.last })
    expect(after?.kind === 'webhook' && after.last_received).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(TODAY).toBe(BRIEF_TS.slice(0, 10))
  })

  it('a run whose set-aside rows are all blank has 0 rows to fix; the 16 possible duplicates keep it needs_review (09 D-47: the 2 real invalid-email rows relabelled)', async () => {
    const relabel = (from: string, to: string) =>
      env.DB.prepare('UPDATE quarantine SET reason = ?2 WHERE reason = ?1').bind(from, to).run()
    const ids = await env.DB.prepare("SELECT id FROM quarantine WHERE reason = 'invalid_email'").all<{ id: number }>()
    expect(ids.results).toHaveLength(2)
    await relabel('invalid_email', 'blank_row')
    try {
      const [subscribers] = await sources()
      expect(subscribers).toMatchObject({
        status: 'needs_review',
        checks: subscriberChecks(0, 16),
        runs: [csvRun(2995, 2900, 85, 10, 0)],
      })
    } finally {
      for (const { id } of ids.results)
        await env.DB.prepare("UPDATE quarantine SET reason = 'invalid_email' WHERE id = ?").bind(id).run()
    }
    expect((await sources())[0]).toMatchObject({ status: 'needs_review' })
  })

  it('needs_review counts every non-blank reason: bad_date and missing_field too (09 D-61, D-63)', async () => {
    // Real quarantine rows keep their raw_row; only the reason code moves to another
    // quarantine code. The seed holds blank_row and invalid_email only, so this is the one way
    // the route ever sees the other two reasons.
    const rows = await env.DB.prepare(
      "SELECT id, reason FROM quarantine WHERE file = 'subscribers' ORDER BY line_no",
    ).all<{ id: number; reason: string }>()
    const invalid = rows.results.filter((r) => r.reason === 'invalid_email')
    const blank = rows.results.filter((r) => r.reason === 'blank_row')
    expect([invalid.length, blank.length]).toEqual([2, 8])
    const [first, second] = invalid
    const [firstBlank] = blank
    if (first === undefined || second === undefined || firstBlank === undefined) throw new Error('seed changed')
    const setReason = (id: number, reason: string) =>
      env.DB.prepare('UPDATE quarantine SET reason = ?2 WHERE id = ?1').bind(id, reason).run()
    try {
      // invalid_email + bad_date + missing_field (a blank row relabelled) = 3 a person can fix.
      await setReason(second.id, 'bad_date')
      await setReason(firstBlank.id, 'missing_field')
      const [three] = await sources()
      expect(three).toMatchObject({ status: 'needs_review', checks: subscriberChecks(3, 16), runs: [csvRun(2995, 2900, 85, 10, 3)] })

      // The only non-blank reject is bad_date: still 1 to review, still needs_review.
      await setReason(first.id, 'blank_row')
      await setReason(firstBlank.id, 'blank_row')
      const [onlyBadDate] = await sources()
      expect(onlyBadDate).toMatchObject({ status: 'needs_review', checks: subscriberChecks(1, 16), runs: [csvRun(2995, 2900, 85, 10, 1)] })

      // The only non-blank reject is missing_field.
      await setReason(second.id, 'missing_field')
      const [onlyMissing] = await sources()
      expect(onlyMissing).toMatchObject({ status: 'needs_review', checks: subscriberChecks(1, 16), runs: [csvRun(2995, 2900, 85, 10, 1)] })
    } finally {
      for (const r of rows.results) await setReason(r.id, r.reason)
    }
    expect((await sources())[0]).toMatchObject({ status: 'needs_review', runs: [csvRun(2995, 2900, 85, 10, 2)] })
  })

  it('status, records and last sync come from the newest run; runs are newest first', async () => {
    // A second, later load of real subscribers rows (a removal): the first 1,500 data rows
    // of data/subscribers.csv minus the lines the seed set aside, run through the production ingest
    // (worker/ingest/subscribers.ts), so its read/kept/merged numbers are the code's, not typed in.
    // Its kept count differs from the seed run's 2,900, so `records` shows which run it came from.
    // ran_at is the wall-clock time a run happened (one of the few wall-clock reads): a minute later.
    const full = parseCsv(subscribersCsv)
    const setAside = new Set(ingestSubscribers(full).quarantined.map((q) => q.line_no))
    expect(setAside.size).toBe(10)
    const keep = full.rows.map((_, i) => i).filter((i) => i < 1500 && !setAside.has(full.lineNos[i] ?? -1))
    const subset = ingestSubscribers({
      header: full.header,
      rows: keep.map((i) => full.rows[i] ?? []),
      lineNos: keep.map((i) => full.lineNos[i] ?? -1),
    })
    expect(subset.quarantined).toEqual([])
    const rowsIn = keep.length
    const rowsOut = subset.subscribers.size
    const merged = rowsIn - rowsOut
    expect(rowsOut).not.toBe(2900)

    const seedRun = await env.DB.prepare("SELECT id FROM import_runs WHERE file = 'subscribers'").first<{ id: number }>()
    const top = await env.DB.prepare('SELECT max(id) AS id FROM import_runs').first<{ id: number }>()
    if (seedRun === null || top === null) throw new Error('seed holds no subscribers run')
    const newId = top.id + 1
    const laterRanAt = new Date(Date.parse(ranAt) + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    expect(laterRanAt > ranAt).toBe(true)
    await env.DB.prepare(
      "INSERT INTO import_runs (id, file, rows_in, rows_out, merged, quarantined, ran_at) VALUES (?1, 'subscribers', ?2, ?3, ?4, 0, ?5)",
    )
      .bind(newId, rowsIn, rowsOut, merged, laterRanAt)
      .run()
    try {
      // The later run set nothing aside, so 0 rows to fix; the possible duplicates still count.
      const [subscribers] = await sources()
      expect(subscribers).toMatchObject({
        status: 'needs_review',
        checks: subscriberChecks(0, 16),
        records: rowsOut,
        last_sync: laterRanAt,
      })
      expect(subscribers?.runs).toEqual([
        { id: newId, ran_at: laterRanAt, rows_in: rowsIn, rows_out: rowsOut, merged, rejected: 0, needs_review: 0 },
        { ...csvRun(2995, 2900, 85, 10, 2), id: seedRun.id },
      ])
    } finally {
      await env.DB.prepare('DELETE FROM import_runs WHERE id = ?').bind(newId).run()
    }
    expect((await sources())[0]).toMatchObject({
      status: 'needs_review',
      records: 2900,
      last_sync: ranAt,
      runs: [csvRun(2995, 2900, 85, 10, 2)],
    })
  })

  it('fails loud with a 500 when import_runs and quarantine disagree on the rows set aside', async () => {
    await env.DB.prepare("UPDATE import_runs SET quarantined = quarantined + 1 WHERE file = 'subscribers'").run()
    try {
      const res = await fetchSources()
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({
        error: 'internal_error',
        message: 'Something went wrong on the server. The error has been logged.',
      })
    } finally {
      await env.DB.prepare("UPDATE import_runs SET quarantined = quarantined - 1 WHERE file = 'subscribers'").run()
    }
    expect((await fetchSources()).status).toBe(200)
  })

  it('401 without a session cookie', async () => {
    const res = await fetchSources({})
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Sign in to continue.' })
  })
})

const getDuplicates = async (): Promise<Duplicates> => {
  const res = await SELF.fetch('http://cdp.test/api/duplicates', { headers: { cookie } })
  expect(res.status).toBe(200)
  return res.json<Duplicates>()
}

async function review(pairId: string): Promise<void> {
  const res = await SELF.fetch(`http://cdp.test/api/duplicates/${pairId}/review`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ verdict: 'different_people' }),
  })
  expect(res.status).toBe(200)
  expect((await res.json<DuplicateReview>()).pair_id).toBe(pairId)
}

// Runs after T-SRC-1 on the same seeded D1. Each test puts back what it changed (reviews, reasons,
// run counts), so the file's later tests see the plain seed.
describe('GET /api/sources checks (T-SRC-3, 09 D-65)', () => {
  it('subscribers = [rows_to_fix 2, possible_duplicates 16] and needs_review; web_events, app_users = [rows_to_fix 0]; app_events none', async () => {
    const list = await sources()
    expect(list.map((s) => [s.id, s.checks])).toEqual([
      ['subscribers', subscriberChecks(2, 16)],
      ['web_events', fixChecks(0)],
      ['app_users', fixChecks(0)],
      ['app_events', []],
    ])
    expect(list[0]?.status).toBe('needs_review')
  })

  it('check kinds come from the registry, in its order, and each kind has glossary words', async () => {
    const list = await sources()
    for (const [i, s] of list.entries()) expect(s.checks.map((c) => c.kind)).toEqual(SOURCES[i]?.checks)
    for (const kind of CHECK_KINDS) expect(isGlossaryKey(kind)).toBe(true)
    // Every declared check is a known kind, listed in CHECK_KINDS order.
    for (const entry of SOURCES) {
      const declared: readonly string[] = entry.checks
      expect(declared).toEqual(CHECK_KINDS.filter((k) => declared.includes(k)))
      // Every CSV source declares rows_to_fix, so a fixable row in any file reaches a screen.
      if (entry.kind === 'csv') expect(declared).toContain('rows_to_fix')
    }
  })

  it('possible_duplicates is GET /api/duplicates to_review; after one review it is 15, and back to 16 once the review is gone', async () => {
    const before = await getDuplicates()
    expect(before.to_review).toBe(16)
    const first = before.review[0]
    if (first === undefined) throw new Error('the seed has no pair to review')
    await review(first.pair_id)
    try {
      const [subscribers] = await sources()
      expect(subscribers?.checks).toEqual(subscriberChecks(2, 15))
      expect(subscribers?.status).toBe('needs_review')
      expect((await getDuplicates()).to_review).toBe(15)
      // Re-posting replaces the decision: still one pair decided.
      await review(first.pair_id)
      expect((await sources())[0]?.checks).toEqual(subscriberChecks(2, 15))
    } finally {
      await env.DB.prepare('DELETE FROM duplicate_reviews').run()
    }
    expect((await sources())[0]?.checks).toEqual(subscriberChecks(2, 16))
  })

  it('status is ok only when every check counts 0: all 16 pairs reviewed and the 2 invalid emails relabelled blank (09 D-47)', async () => {
    const pairs = (await getDuplicates()).review
    expect(pairs).toHaveLength(16)
    const ids = await env.DB.prepare("SELECT id FROM quarantine WHERE reason = 'invalid_email'").all<{ id: number }>()
    expect(ids.results).toHaveLength(2)
    try {
      for (const p of pairs) await review(p.pair_id)
      const [reviewed] = await sources()
      expect(reviewed).toMatchObject({ status: 'needs_review', checks: subscriberChecks(2, 0) })

      await env.DB.prepare("UPDATE quarantine SET reason = 'blank_row' WHERE reason = 'invalid_email'").run()
      const [clean] = await sources()
      expect(clean).toMatchObject({ status: 'ok', checks: subscriberChecks(0, 0) })
    } finally {
      await env.DB.prepare('DELETE FROM duplicate_reviews').run()
      for (const { id } of ids.results)
        await env.DB.prepare("UPDATE quarantine SET reason = 'invalid_email' WHERE id = ?").bind(id).run()
    }
    expect((await sources())[0]).toMatchObject({ status: 'needs_review', checks: subscriberChecks(2, 16) })
  })

  it('a row a person can fix in another CSV file shows as that source\'s rows_to_fix chip, not a 500', async () => {
    // One of the seed's real invalid-email rows moved to the Website run, with both
    // runs' set-aside counts moved with it so import_runs and quarantine still agree.
    const runOf = (file: string) =>
      env.DB.prepare('SELECT id FROM import_runs WHERE file = ?').bind(file).first<{ id: number }>()
    const [subRun, webRun] = [await runOf('subscribers'), await runOf('web_events')]
    const row = await env.DB.prepare("SELECT id FROM quarantine WHERE reason = 'invalid_email' ORDER BY line_no").first<{
      id: number
    }>()
    if (subRun === null || webRun === null || row === null) throw new Error('seed changed')
    const move = (file: string, from: number, to: number) =>
      env.DB.batch([
        env.DB.prepare('UPDATE quarantine SET file = ?1, run_id = ?2 WHERE id = ?3').bind(file, to, row.id),
        env.DB.prepare('UPDATE import_runs SET quarantined = quarantined - 1 WHERE id = ?').bind(from),
        env.DB.prepare('UPDATE import_runs SET quarantined = quarantined + 1 WHERE id = ?').bind(to),
      ])
    await move('web_events', subRun.id, webRun.id)
    try {
      const res = await fetchSources()
      expect(res.status).toBe(200)
      const [subscribers, web] = (await res.json<Sources>()).sources
      expect(subscribers).toMatchObject({ status: 'needs_review', checks: subscriberChecks(1, 16) })
      expect(web).toMatchObject({ status: 'needs_review', checks: fixChecks(1), runs: [csvRun(10000, 10000, 0, 1, 1)] })
    } finally {
      await move('subscribers', webRun.id, subRun.id)
    }
    const [subscribers, web] = await sources()
    expect(subscribers).toMatchObject({ status: 'needs_review', checks: subscriberChecks(2, 16) })
    expect(web).toMatchObject({ status: 'ok', checks: fixChecks(0) })
  })

  it('the Overview has no standalone Needs review or Possible duplicates section: both open only as tabs of a source row', () => {
    for (const gone of ['Needs review', 'NeedsReview', 'Possible duplicates —', ' to review', '<Disclosure'])
      expect(overviewCode).not.toContain(gone)
    // The two panels are mounted once each, inside SourceTabs' tab panels.
    expect(overviewCode.match(/<PossibleDuplicates\b/g)?.length).toBe(1)
    expect(overviewCode.match(/<RowsToFix\b/g)?.length).toBe(1)
    const tabs = overviewCode.slice(overviewCode.indexOf('function SourceTabs('), overviewCode.indexOf('function SourcesTable('))
    expect(tabs).toContain('<PossibleDuplicates')
    expect(tabs).toContain('<RowsToFix')
    // The WAI-ARIA tabs pattern.
    for (const attr of ['role="tablist"', 'role="tab"', 'role="tabpanel"', 'aria-selected=', 'aria-controls=', 'aria-labelledby=', "'ArrowRight'", "'ArrowLeft'", "'Home'", "'End'"])
      expect(tabs).toContain(attr)
  })
})

/** The Overview's code with comments removed, so the scan reads only what can reach the screen. */
const overviewCode = overviewSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * What a page's text says that only the registry may say (T-SRC-2): a source's name,
 * unit (one or many), file name or bare id, or a count of files. `texts` are a file's JSX text runs,
 * string literals and template chunks from the TypeScript AST (test/helpers/screen-text.ts), so text
 * beside an interpolation ("{n} files", "{x} subscribers") is scanned like any other. A run that
 * starts with "file(s)" follows an interpolated or computed count. Paths ('/events',
 * '/api/quarantine?file=') name routes, not sources.
 */
function sourceTextOffences(texts: readonly string[]): string[] {
  const offences: string[] = []
  for (const text of texts.filter((t) => !t.startsWith('/'))) {
    for (const s of SOURCES) {
      for (const word of [s.name, s.unit[0], s.unit[1], ...(s.file === null ? [] : [s.file])])
        if (new RegExp(`\\b${word.replace('.', '\\.')}\\b`, 'i').test(text)) offences.push(`"${word}" in "${text}"`)
      if (text.trim() === s.id) offences.push(`source id ${s.id} as a literal`)
    }
    if (/\b(?:\d+|one|two|three|four) files?\b/i.test(text) || /^\s*files?\b/i.test(text))
      offences.push(`file count in "${text}"`)
  }
  return offences
}

describe('Overview terms and source text (T-SRC-2)', () => {
  it('every InfoTip / Metric term the Overview names exists in the glossary or DEFINITIONS (no orphan InfoTip)', () => {
    const named = [...overviewCode.matchAll(/\bterm(?:=|:\s*)["']([a-z_]+)["']/g)].map((m) => m[1])
    // The four headline numbers plus the Sources and run terms written out on the page.
    expect(new Set(named)).toEqual(
      new Set([
        'subscribers_signed_up',
        'subscribers_active',
        'app_accounts',
        'events_received',
        'live',
        'ok',
        'not_loaded',
        'rows_read',
        'kept',
        'merged',
        'rejected',
        'source',
        'sync',
      ]),
    )
    for (const key of named) expect(() => explain(key)).not.toThrow()
    // Terms the page passes through from data: each source's kind, each check kind and each quarantine reason.
    for (const s of SOURCES) expect(isGlossaryKey(s.kind)).toBe(true)
    for (const kind of CHECK_KINDS) expect(isGlossaryKey(kind)).toBe(true)
    for (const reason of QUARANTINE_REASONS) expect(isGlossaryKey(reason)).toBe(true)
    // The page reads glossary entries by key too (GLOSSARY.x); each must exist.
    for (const m of overviewCode.matchAll(/\bGLOSSARY\.([a-z_]+)/g)) expect(isGlossaryKey(m[1])).toBe(true)
  })

  it('explain() reads both homes and fails loud on an unknown key; the two homes share no key', () => {
    expect(explain('merged')).toEqual({ term: GLOSSARY.merged.term, text: GLOSSARY.merged.text })
    // A definition shows its plain heading, never its raw name.
    expect(explain('cold')).toEqual({ term: DEFINITION_LABEL.cold, text: DEFINITIONS.cold.doc })
    expect(explain('engagement_score')).toEqual({ term: 'Engagement', text: DEFINITIONS.engagement_score.doc })
    for (const key of Object.keys(DEFINITIONS) as (keyof typeof DEFINITIONS)[]) {
      expect(explain(key).term, key).toBe(DEFINITION_LABEL[key])
      expect(explain(key).term, key).not.toMatch(/_/)
    }
    expect(() => explain('quarantined')).toThrow(/neither a glossary term nor a DEFINITIONS entry/)
    const shared = Object.keys(GLOSSARY).filter((k) => Object.hasOwn(DEFINITIONS, k))
    expect(shared).toEqual([])
    for (const entry of Object.values(GLOSSARY)) {
      expect(entry.term.length).toBeGreaterThan(0)
      // One or two plain sentences.
      expect(entry.text.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2)
    }
  })

  it('the scan reads text beside an interpolation: each per-file fixture is flagged, a comment is not', () => {
    const { fixtures } = env.SCREEN_TEXTS
    expect(Object.keys(fixtures)).toEqual(Object.keys(SCAN_FIXTURES))
    // The AST splits "Read {n} files from …" into the runs either side of the interpolation.
    expect(fixtures.interpolated_file_count).toEqual(['Read ', ' files from beehiiv'])
    for (const key of Object.keys(SCAN_FIXTURES) as ScanFixture[]) {
      const offences = sourceTextOffences(fixtures[key])
      if (key === 'comment_only') expect(offences, key).toEqual([])
      else expect(offences.length, `${key}: ${SCAN_FIXTURES[key]}`).toBeGreaterThan(0)
    }
    expect(sourceTextOffences(fixtures.interpolated_file_count)).toEqual([
      '"beehiiv" in " files from beehiiv"',
      'file count in " files from beehiiv"',
    ])
    // " subscribers" is both the unit and, once trimmed, the bare source id.
    expect(sourceTextOffences(fixtures.interpolated_unit)).toEqual([
      '"subscribers" in " subscribers"',
      'source id subscribers as a literal',
    ])
  })

  it('the Overview spells no source name, id, file or unit: they come from the registry through the API', () => {
    const texts = env.SCREEN_TEXTS.overview
    expect(texts.length).toBeGreaterThan(50)
    // Runs beside an interpolation are in the scan (StatusChips' "Status of {name}").
    expect(texts).toContain('Status of ')
    expect(texts).toContain('View rejected rows')
    expect(sourceTextOffences(texts)).toEqual([])
    expect(overviewCode).not.toMatch(/\b(?:\d+|three) files?\b/i)
    // Per-file prose the Overview no longer shows.
    for (const gone of ['Loaded ', 'into one list', 'How the data was combined', 'rows in'])
      expect(overviewCode).not.toContain(gone)
    // Technical details read "Loads by: seed script" / "webhook", from one label home.
    expect(LOADS_BY_LABEL).toEqual({ seed: 'seed script', webhook: 'webhook' })
    expect(texts.filter((t) => t.trim().startsWith('Loads by:')).length).toBe(2)
    expect(overviewCode.match(/Loads by: \{LOADS_BY_LABEL\[source\.loads_by\]\}/g)?.length).toBe(2)
  })
})

// Last in the file: it sends webhooks, and the stored events stay for the rest of the file. The seed
// has no auto-band pair, so this is the only place an auto pair reaches GET /api/sources
// ("undecided review/auto pairs"). Inputs are T-DUP-2's (test/duplicates.test.ts header): real
// app_users.csv rows u_a6ac1f6c (line 113, mark.mitchell424@gmail.com) and u_b9e9a984 (line 432,
// mark.mitchell662@outlook.com) log in on one device, `d_` + the hex of the first user id, through
// the real signed POST /webhooks/app; event ids from eventIdPool(); times on TODAY.
describe('GET /api/sources checks count auto-band pairs too (T-SRC-3, 09 D-65)', () => {
  const MARK_A = { user: 'u_a6ac1f6c', email: 'mark.mitchell424@gmail.com' }
  const MARK_B = { user: 'u_b9e9a984', email: 'mark.mitchell662@outlook.com' }
  const SHARED_DEVICE = 'd_a6ac1f6c'

  it('a real shared-device login stitch adds one auto pair: 17 in both routes, 16 once it is reviewed', async () => {
    const before = await getDuplicates()
    expect(before.review.map((p) => p.band)).not.toContain('auto')
    expect(before.to_review).toBe(16)
    expect((await sources())[0]?.checks).toEqual(subscriberChecks(2, 16))

    const events = [
      { event: 'app_open', user_id: null, timestamp: `${TODAY}T09:00:00Z` },
      { event: 'login', user_id: MARK_A.user, timestamp: `${TODAY}T09:05:00Z` },
      { event: 'login', user_id: MARK_B.user, timestamp: `${TODAY}T09:10:00Z` },
    ]
    for (const e of events) {
      const body = {
        event_id: nextEventId(),
        event: e.event,
        user_id: e.user_id,
        device_id: SHARED_DEVICE,
        timestamp: e.timestamp,
      }
      const res = await sendWebhook(JSON.stringify(body))
      expect(res.status, await res.clone().text()).toBe(202)
    }

    const after = await getDuplicates()
    const auto = after.review.filter((p) => p.band === 'auto')
    expect(auto.map((p) => [p.a.email, p.b.email].sort())).toEqual([[MARK_A.email, MARK_B.email].sort()])
    expect(after.to_review).toBe(17)
    expect((await sources())[0]).toMatchObject({ status: 'needs_review', checks: subscriberChecks(2, 17) })

    const pair = auto[0]
    if (pair === undefined) throw new Error('no auto pair after the shared-device logins')
    await review(pair.pair_id)
    try {
      expect((await sources())[0]?.checks).toEqual(subscriberChecks(2, 16))
      expect((await getDuplicates()).to_review).toBe(16)
    } finally {
      await env.DB.prepare('DELETE FROM duplicate_reviews').run()
    }
    expect((await sources())[0]?.checks).toEqual(subscriberChecks(2, 17))
  })
})
