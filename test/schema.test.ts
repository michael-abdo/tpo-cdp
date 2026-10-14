/// <reference types="vite/client" />
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { appAfterSignup, coldSince, engagementScore } from '../shared/derive'
import { normalizeEmail } from '../shared/normalize'
import { PII_COLUMNS } from '../shared/pii'
import readme from '../README.md?raw'
import { pkeyForEmail, visitorHash } from '../shared/pseudonym'

// Schema from migrations/ as applied by test/setup.ts: 01 §Tables, §PII-free views, §PII
// denylist; 09 D-46. T-PII-2 (08). The round-trip uses the real demo subject from 02 §Counts:
// subscribers.csv:902, app_users.csv:303 and her first web_events.csv row (line 5400).

const TABLES = [
  'profiles',
  'subscribers',
  'web_visitors',
  'web_events',
  'app_users',
  'app_events',
  'device_identity',
  'import_runs',
  'quarantine',
  'assistant_tools',
  'ai_audit',
]

const VIEW_COLUMNS: Record<string, string[]> = {
  v_profiles: [
    'pkey',
    'kind',
    'signup_date',
    'status',
    'source',
    'last_open_date',
    'cold_since',
    'engagement_score',
    'has_app',
    'app_created_at',
    'app_after_signup',
    'first_page',
    'first_utm_source',
  ],
  v_web_events: ['pkey', 'visitor_hash', 'page', 'event_ts', 'utm_source'],
  v_app_events: ['pkey', 'event', 'event_ts', 'story', 'link'],
  v_funnel: ['first_page', 'first_utm_source', 'visitors', 'subscribed'],
  v_source_app_conversion: ['source', 'subscribers', 'with_app_after_signup', 'rate'],
}

function secret(): string {
  const value = env.PII_KEY_SECRET
  if (!value) throw new Error('PII_KEY_SECRET missing from .dev.vars; the test cannot run')
  return value
}

async function columnsOf(relation: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${relation})`).all<{ name: string }>()
  return results.map((row) => row.name)
}

async function relationsOfType(type: 'table' | 'view'): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT name FROM sqlite_master WHERE type = ?')
    .bind(type)
    .all<{ name: string }>()
  return results.map((row) => row.name)
}

describe('schema (01 §Tables)', () => {
  it('every table in 01 exists, and there is no sessions table', async () => {
    const tables = await relationsOfType('table')
    for (const table of TABLES) expect(tables).toContain(table)
    expect(tables).not.toContain('sessions')
  })

  it('the views are exactly the five in 01 §PII-free views', async () => {
    expect((await relationsOfType('view')).sort()).toEqual(Object.keys(VIEW_COLUMNS).sort())
  })
})

describe('PII-free views (01 §PII-free views, §PII denylist)', () => {
  it('T-PII-2: no view exposes a PII_COLUMNS column', async () => {
    const pii = new Set<string>(PII_COLUMNS)
    for (const view of Object.keys(VIEW_COLUMNS)) {
      const leaked = (await columnsOf(view)).filter((column) => pii.has(column))
      expect(leaked, view).toEqual([])
    }
  })

  it('every view has exactly the columns 01 lists, in order', async () => {
    for (const [view, columns] of Object.entries(VIEW_COLUMNS)) {
      expect(await columnsOf(view), view).toEqual(columns)
    }
  })

  it('a real subscriber round-trips through v_profiles by pkey, with stored derived values', async () => {
    const emailRaw = 'joy.hall830@protonmail.com'
    const emailNorm = normalizeEmail(emailRaw)
    if (emailNorm === null) throw new Error('demo email failed normalization')
    const pkey = await pkeyForEmail(secret(), emailNorm)
    const signupDate = '2026-09-02'
    const lastOpenDate = '2026-09-22'
    const appCreatedAt = '2026-09-03'
    // Computed by the one runtime source (D-46), never in SQL. This test database holds no
    // app_events or web_events rows for her, so both activity counts are 0 here.
    const storedColdSince = coldSince(lastOpenDate, signupDate)
    const storedScore = engagementScore({
      last_open_date: lastOpenDate,
      app_events_last_30d: 0,
      site_visits_last_30d: 0,
    })

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO subscribers (email_norm, email_raw, signup_date, status, source, last_open_date, cold_since, merged_count)
         VALUES (?, ?, ?, 'active', 'instagram', ?, ?, 1)`,
      ).bind(emailNorm, emailRaw, signupDate, lastOpenDate, storedColdSince),
      env.DB.prepare(
        `INSERT INTO profiles (pkey, email_norm, kind, engagement_score, created_at) VALUES (?, ?, 'subscriber', ?, ?)`,
      ).bind(pkey, emailNorm, storedScore, signupDate),
      env.DB.prepare(
        `INSERT INTO app_users (user_id, email_norm, created_at, from_csv) VALUES ('u_ceed5f12', ?, ?, 1)`,
      ).bind(emailNorm, appCreatedAt),
      env.DB.prepare(
        `INSERT INTO web_visitors (visitor_id, visitor_hash, email_norm, first_seen_ts, first_page, first_utm_source)
         VALUES ('v_c9e136fd6d', ?, ?, '2026-09-02T16:19:04Z', '/', 'instagram')`,
      ).bind(await visitorHash(secret(), 'v_c9e136fd6d'), emailNorm),
    ])

    const { results } = await env.DB.prepare('SELECT * FROM v_profiles WHERE pkey = ?').bind(pkey).all()
    expect(results).toEqual([
      {
        pkey,
        kind: 'subscriber',
        signup_date: signupDate,
        status: 'active',
        source: 'instagram',
        last_open_date: lastOpenDate,
        cold_since: '2026-10-22',
        engagement_score: storedScore,
        has_app: 1,
        app_created_at: appCreatedAt,
        app_after_signup: appAfterSignup(appCreatedAt, signupDate) ? 1 : 0,
        first_page: '/',
        first_utm_source: 'instagram',
      },
    ])
    expect(results[0]?.app_after_signup).toBe(1)
    expect(storedColdSince).toBe('2026-10-22')
  })
})

// The migration sequence (README "the ten migrations"; 03 §Module layout). Two merged branches
// once each took the next number; this pins the order that applies on a fresh database (wrangler
// and test/setup.ts apply the files in name order) and that the README's count tells the same story.
describe('the migrations are one contiguous, ordered sequence', () => {
  const NAMES = [
    '0001_core',
    '0002_views',
    '0003_ai_audit_session',
    '0004_duplicate_reviews',
    '0005_ai_audit_client',
    '0006_insights',
    '0007_profiles_email_index',
    '0008_ai_audit_cache',
    '0009_tool_approval',
    '0010_drop_tool_approval',
  ]
  const files = Object.keys(import.meta.glob('../migrations/*.sql', { query: '?raw' }))
    .map((path) => /\/([^/]+)\.sql$/.exec(path)?.[1] ?? path)
    .sort()
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

  it('migrations/ holds exactly these files, in this order', () => {
    expect(files).toEqual(NAMES)
  })

  it('every number appears once, from 0001 with no gap', () => {
    const numbers = files.map((name) => Number(name.slice(0, 4)))
    expect(numbers).toEqual(files.map((_, i) => i + 1))
    expect(new Set(files.map((name) => name.slice(0, 4))).size).toBe(files.length)
  })

  it('the README says how many there are', () => {
    const said = /\bthe (\w+) migrations into the local D1\b/.exec(readme)?.[1]
    expect(said, 'README names the migration count ("the nine migrations")').toBeDefined()
    expect(WORDS.indexOf(said ?? ''), `README says "${said}"`).toBe(files.length)
  })
})

// 0010_drop_tool_approval.sql (09 D-77: the approval queue is gone). By the time this file runs the
// whole sequence has applied, so the column is already gone; the second test puts the 0009 shape
// back (the column and the rows the queue wrote), runs 0010's own statements, and checks that only
// a queued request is deleted (found by its flag, never by its name) before the column is dropped.
describe('migration 0010 deletes the queued requests, then drops assistant_tools.requested_from_trace', () => {
  async function insertTool(id: string, name: string, enabled: 0 | 1, requestedFrom: string | null): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO assistant_tools (id, name, description, input_schema, handler_type, execution_config, enabled, sort_order, requested_from_trace, created_at, updated_at)
       VALUES (?, ?, 'x', '{"type":"object"}', 'query', '{"sql":"select 1","param_mapping":{}}', ?, 1, ?, 'now', 'now')`,
    )
      .bind(id, name, enabled, requestedFrom)
      .run()
  }

  it('PRAGMA table_info(assistant_tools) no longer lists it', async () => {
    expect(await columnsOf('assistant_tools')).not.toContain('requested_from_trace')
  })

  it("deletes only a still-queued request (flagged and disabled), whatever it is named, then drops the column", async () => {
    await env.DB.prepare('ALTER TABLE assistant_tools ADD COLUMN requested_from_trace TEXT').run()
    await insertTool('t-queued', 'pending_0123456789abcdef0123456789abcdef', 0, 'trace-queued') // a request: deleted
    await insertTool('t-approved', 'sources_ranked', 1, 'trace-approved') // approved before D-77: kept
    await insertTool('t-lookalike', 'pending_lookalike', 0, null) // an ordinary disabled row: kept
    const migration = Object.values(
      import.meta.glob<string>('../migrations/0010_drop_tool_approval.sql', { query: '?raw', import: 'default', eager: true }),
    )[0]
    expect(migration, '0010 migration text loaded').toBeDefined()
    for (const statement of (migration ?? '').replace(/^--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) {
      await env.DB.prepare(statement).run()
    }
    const { results } = await env.DB.prepare("SELECT id FROM assistant_tools WHERE id LIKE 't-%' ORDER BY id").all<{ id: string }>()
    expect(results.map((r) => r.id)).toEqual(['t-approved', 't-lookalike'])
    expect(await columnsOf('assistant_tools')).not.toContain('requested_from_trace')
    await env.DB.prepare("DELETE FROM assistant_tools WHERE id LIKE 't-%'").run()
  })
})

// 0007_profiles_email_index.sql (19 §0 F3, §5.4; 09 D-69): without this index the three T-WH-10 /
// T-SEG-9 / T-SEG-11 queries still return the right rows, only slower, so a no-op migration would
// pass silently until vitest's timeout. Pin the index itself, not just its speed.
describe('migration 0007 creates the profiles(email_norm) index', () => {
  it('sqlite_master lists an index named profiles_email on profiles(email_norm)', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    )
      .bind('profiles_email')
      .all<{ name: string; tbl_name: string; sql: string }>()
    expect(results).toHaveLength(1)
    expect(results[0]?.tbl_name).toBe('profiles')
    expect(results[0]?.sql).toMatch(/\(email_norm\)/)
  })
})

// 0008_ai_audit_cache.sql (09 D-74; design 20 §3 R2): the two usage-meter columns R1's prompt
// caching is proven from. A no-op migration would pass every other test silently, so pin the
// columns themselves on ai_audit, nullable (rows written before this migration carry NULL).
describe('migration 0008 adds the cache usage meters to ai_audit', () => {
  it('ai_audit gains cache_read_tokens and cache_write_tokens, both nullable INTEGER', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(ai_audit)').all<{ name: string; type: string; notnull: number }>()
    for (const name of ['cache_read_tokens', 'cache_write_tokens']) {
      const column = results.find((c) => c.name === name)
      expect(column, name).toBeDefined()
      expect(column?.type).toBe('INTEGER')
      expect(column?.notnull).toBe(0)
    }
  })
})
