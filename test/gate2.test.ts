import { env } from 'cloudflare:test'
import type Anthropic from '@anthropic-ai/sdk'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { TOOL_SEEDS, toolSeedInsert } from '../scripts/tool-seeds'
import { EMAIL_REGEX, PII_COLUMNS, RAW_ID_REGEX } from '../shared/pii'
import { startTrace } from '../worker/assistant/audit/ai-audit'
import { MODEL } from '../worker/assistant/build-request'
import { authorizeToolCall, DATE_COLUMN, validateSqlAgainstViews } from '../worker/assistant/gates/gate2-tool-authorizer'
import { GateDenied, readOnlySelect, sanitizeSqlError, SQL_ROW_LIMIT } from '../worker/assistant/gates/gate3-readonly-sql'
import type { MessagesTransport } from '../worker/assistant/loop'
import { type ViewSchema, viewSchemas } from '../worker/assistant/schema-context'
import { executeToolCall } from '../worker/assistant/tools/tool-executor'
import { loadTools } from '../worker/assistant/tools/tool-loader'
import { requireJson, requireSession } from '../worker/auth/middleware'
import type { AppEnv } from '../worker/env'
import { onError } from '../worker/index'
import { assistantRoutes } from '../worker/routes/assistant'
import { traceOutcome } from '../worker/routes/audit'
import { loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'

// T-GATE-2 and T-AI-2.
//
// Inputs: the seeded D1 (data/*.csv via test/helpers/seed.ts) and the assistant_tools rows from
// scripts/tool-seeds.ts. The SQL strings are what a model could write: view and column names from
// the PII-free views, the probes the gates must refuse (table names from migrations/0001_core.sql),
// and filter values that occur in data/*.csv (status, source, page "/"). Expected numbers are the
// seed's: 2,610 active / 290 unsubscribed subscribers; the demo subject joy.hall830 (first page
// "/", first UTM "instagram"). No test calls the network: the one route test passes a
// transport defined here that returns Messages-API-shaped turns written in this file.

const JOY = 'joy.hall830@protonmail.com'
const PKEY = /^pk_[0-9a-f]{16}$/

let views: readonly ViewSchema[]

beforeAll(async () => {
  await seedDatabase()
  for (const seed of TOOL_SEEDS) {
    const { sql, params } = toolSeedInsert(seed)
    await env.DB.prepare(sql).bind(...params).run()
  }
  views = await viewSchemas(env.DB)
})

/** The problems a gate raised, or null when it let the SQL through. */
function denial(run: () => unknown): GateDenied | null {
  try {
    run()
    return null
  } catch (err) {
    if (err instanceof GateDenied) return err
    throw err
  }
}

const gate2 = (sql: string) => denial(() => validateSqlAgainstViews(sql, views))
const gate3 = (sql: string) => denial(() => readOnlySelect(sql))

async function auditRows(traceId: string) {
  return (
    await env.DB.prepare('SELECT kind, status, tool_name, sql, row_count, error FROM ai_audit WHERE trace_id = ? ORDER BY created_at, rowid')
      .bind(traceId)
      .all<{ kind: string; status: string; tool_name: string | null; sql: string | null; row_count: number | null; error: string | null }>()
  ).results
}

async function runTool(name: string, input: unknown, db: D1Database = env.DB) {
  const trace = await startTrace(env.DB)
  const executed = await executeToolCall({ db, trace, tools: await loadTools(env.DB) }, { id: `toolu_${name}`, name, input })
  return { executed, rows: await auditRows(trace.traceId) }
}

/** env.DB, recording every SQL text the tool prepares. */
function recordingDb(): { db: D1Database; prepared: string[] } {
  const prepared: string[] = []
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (query: string) => {
          prepared.push(query)
          return target.prepare(query)
        }
      }
      const value: unknown = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { db, prepared }
}

/**
 * Hidden-table probes that a v_* alias or a column alias used to carry past the relation check:
 * an alias named WINDOW ended the FROM list early, and `IN <name>` reads a table in SQLite.
 */
const ALIAS_PROBES: Array<[string, RegExp]> = [
  ['SELECT count(*) AS n FROM v_source_app_conversion AS window JOIN subscribers ON 1 = 1', /^subscribers is not one of the views/],
  ['SELECT count(*) AS n FROM v_source_app_conversion window JOIN subscribers ON 1 = 1', /^subscribers is not one of the views/],
  ['SELECT count(*) AS n, 1 AS app_users FROM v_funnel AS window JOIN app_users ON 1 = 1', /^app_users is not one of the views/],
  ['SELECT count(*) AS n, 1 AS app_users FROM v_funnel AS window, app_users', /^app_users is not one of the views/],
  ['SELECT request_json AS request_json, 1 AS ai_audit FROM v_profiles AS window JOIN ai_audit ON 1 = 1', /^ai_audit is not one of the views/],
  ["SELECT count(*) AS n FROM v_profiles profiles WHERE (pkey, pkey, 'subscriber', engagement_score, signup_date) IN profiles", /^IN must be followed by "\("/],
  ['SELECT count(*) AS n FROM v_profiles app_users WHERE (app_users.pkey, 1, 2, 3) IN app_users', /^IN must be followed by "\("/],
  ['SELECT count(*) AS n FROM v_web_events web_visitors WHERE (1, 2, 3, 4, 5, 6, 7) IN web_visitors', /^IN must be followed by "\("/],
  ['SELECT count(*) AS n FROM v_profiles quarantine WHERE (1, 2, 3, 4, 5, 6) NOT IN quarantine', /^IN must be followed by "\("/],
  ['SELECT count(*) AS profiles FROM v_profiles WHERE pkey IN profiles', /^IN must be followed by "\("/],
  ["SELECT count(*) AS n FROM v_profiles WHERE pkey IN 'subscribers'", /^IN must be followed by "\("/],
  ['SELECT count(*) AS n FROM v_profiles WHERE pkey IN main.subscribers', /^IN must be followed by "\("/],
]

describe('T-GATE-2 Gate 2: validateSqlAgainstViews', () => {
  it('reads the v_* allowlist from PRAGMA: exactly the PII-free views, none with a PII column', () => {
    expect(views.map((v) => v.name)).toEqual(['v_app_events', 'v_funnel', 'v_profiles', 'v_source_app_conversion', 'v_web_events'])
    for (const v of views) for (const c of v.columns) expect(PII_COLUMNS).not.toContain(c.name)
  })

  it('FROM v_profiles is allowed; FROM subscribers is denied', () => {
    expect(validateSqlAgainstViews("SELECT count(*) AS n FROM v_profiles WHERE status = 'active'", views)).toEqual({ views: ['v_profiles'] })
    const denied = gate2('SELECT count(*) AS n FROM subscribers')
    expect(denied?.gate).toBe('gate2')
    expect(denied?.problems).toEqual([expect.stringMatching(/^subscribers is not one of the views; only these views may be read: v_app_events, /)])
  })

  it('joins, aliases, subqueries and window functions over views pass', () => {
    const ok = [
      "SELECT e.page, count(*) AS views FROM v_web_events e JOIN v_profiles p ON p.pkey = e.pkey WHERE p.source = 'instagram' GROUP BY e.page ORDER BY views DESC",
      "SELECT source, rate FROM v_source_app_conversion ORDER BY rate DESC",
      "SELECT pkey FROM v_profiles WHERE pkey IN (SELECT pkey FROM v_app_events) AND status = 'active'",
      "SELECT first_page, sum(visitors) AS v FROM (SELECT first_page, visitors FROM v_funnel) AS f GROUP BY first_page",
      "SELECT pkey, row_number() OVER (PARTITION BY source ORDER BY engagement_score DESC) AS r FROM v_profiles WHERE signup_date BETWEEN '2026-08-01' AND '2026-08-31'",
      "SELECT v_profiles.pkey, CAST(engagement_score AS INTEGER) AS score FROM v_profiles, v_funnel WHERE v_profiles.first_page = v_funnel.first_page",
    ]
    for (const sql of ok) expect(gate2(sql), sql).toBeNull()
  })

  it('a table hidden anywhere is denied: comma join, subquery, JOIN, quoted name, schema prefix, table function, sqlite_master', () => {
    const probes: Array<[string, RegExp]> = [
      ['SELECT v_profiles.pkey FROM v_profiles, profiles', /^profiles is not one of the views/],
      ['SELECT pkey FROM v_profiles WHERE pkey IN (SELECT pkey FROM profiles)', /^profiles is not one of the views/],
      ['SELECT p.pkey FROM v_profiles p JOIN app_users a ON a.created_at = p.app_created_at', /^app_users is not one of the views/],
      ['SELECT pkey FROM "subscribers"', /^quoted names \("…\) are not allowed/],
      ['SELECT pkey FROM [subscribers]', /^quoted names \(\[…\) are not allowed/],
      ['SELECT pkey FROM main.v_profiles', /^main\.v_profiles: name a view directly/],
      ["SELECT name FROM pragma_table_info('subscribers')", /^pragma_table_info\(\) is not a view/],
      ['SELECT sql FROM sqlite_master', /^sqlite_master is not one of the views/],
      // SQLite reads a parenthesized table as a relation: the name inside must not hide under the alias.
      ['SELECT count(*) AS subscribers FROM (subscribers)', /^a parenthesized table or join is not allowed after FROM/],
      ['SELECT * FROM (subscribers) subscribers', /^a parenthesized table or join is not allowed after FROM/],
      ['SELECT p.pkey FROM v_profiles p JOIN (app_users) app_users ON 1 = 1', /^a parenthesized table or join is not allowed after JOIN/],
      ['SELECT * FROM (ai_audit) ai_audit', /^a parenthesized table or join is not allowed after FROM/],
      ['SELECT p.pkey FROM v_profiles p, (assistant_tools) assistant_tools', /^a parenthesized table or join is not allowed after a comma in FROM/],
      ['SELECT * FROM (v_profiles JOIN subscribers ON 1 = 1) x', /^a parenthesized table or join is not allowed after FROM/],
      // SQLite also takes a string as a table name after FROM or JOIN.
      ["SELECT * FROM 'subscribers'", /^after FROM, write a view name plainly or \(SELECT …\), not a string or quoted name/],
      ["SELECT p.pkey FROM v_profiles p JOIN 'app_users' u ON 1 = 1", /^after JOIN, write a view name plainly or \(SELECT …\)/],
      // The allowlist is the views' exact names, not a v_ prefix.
      ['SELECT pkey FROM v_profiles_raw', /^v_profiles_raw is not one of the views/],
      // An alias or IN form must not carry a table past the check.
      ...ALIAS_PROBES,
    ]
    for (const [sql, problem] of probes) {
      const denied = gate2(sql)
      expect(denied, sql).not.toBeNull()
      expect(denied!.problems.some((p) => problem.test(p)), `${sql} → ${denied!.problems.join(' | ')}`).toBe(true)
    }
  })

  it('an unknown column is denied, checked per view; a PII column is named as personal data', () => {
    expect(gate2('SELECT engagement FROM v_profiles')?.problems).toEqual([
      'unknown column engagement: not a column of v_profiles',
    ])
    expect(gate2('SELECT p.page FROM v_profiles p')?.problems).toEqual(['unknown column p.page: v_profiles has no column page'])
    expect(gate2('SELECT x.pkey FROM v_profiles p')?.problems).toEqual(['x is not a view or alias read by this query'])
    for (const column of PII_COLUMNS) {
      expect(gate2(`SELECT ${column} FROM v_profiles`)?.problems).toEqual([`${column} is personal data; no view exposes it`])
    }
  })

  it('write and statement keywords, other functions and the wall clock are denied', () => {
    expect(gate2("DELETE FROM v_profiles WHERE status = 'unsubscribed'")?.problems).toContain('DELETE is not allowed: only a read-only SELECT over the views')
    expect(gate2("UPDATE v_profiles SET status = 'active'")?.problems).toContain('UPDATE is not allowed: only a read-only SELECT over the views')
    expect(gate2('WITH s AS (SELECT pkey FROM v_profiles) SELECT pkey FROM s')?.problems).toContain(
      'WITH is not allowed: only a read-only SELECT over the views',
    )
    expect(gate2('PRAGMA table_info(subscribers)')?.problems).toContain('PRAGMA is not allowed: only a read-only SELECT over the views')
    expect(gate2('SELECT source, count(*) OVER w AS n FROM v_profiles WINDOW w AS (PARTITION BY source)')?.problems).toContain(
      'WINDOW is not allowed: only a read-only SELECT over the views',
    )
    expect(gate2('SELECT load_extension(pkey) AS x FROM v_profiles')?.problems).toEqual(['the function load_extension() is not allowed'])
    expect(gate2("SELECT count(*) AS n FROM v_profiles WHERE last_open_date < date('now', '-30 days')")?.problems).toEqual([
      "the wall clock ('now') is not allowed; use TODAY from the system prompt as a date literal",
    ])
    expect(gate2('SELECT count(*) AS n FROM v_profiles WHERE signup_date > CURRENT_DATE')?.problems).toEqual([
      'CURRENT_DATE is the wall clock and is not allowed; use TODAY from the system prompt as a date literal',
    ])
  })

  it('the wall clock through a date function is denied: no time value, a computed one, a free-text column, a renamed column', () => {
    // SQLite evaluates each of these with the machine's clock, not TODAY.
    const probes: Array<[string, RegExp]> = [
      ['SELECT count(*) AS n FROM v_profiles WHERE signup_date > date()', /^date\(\) without a time value reads the wall clock/],
      ["SELECT strftime('%Y-%m-%d') AS d FROM v_profiles", /^strftime\(\) without a time value reads the wall clock/],
      ['SELECT julianday() AS d FROM v_profiles', /^julianday\(\) without a time value reads the wall clock/],
      ["SELECT date('n'||'ow') AS d FROM v_profiles", /^the time value of date\(\) must be a single date literal or date column, not an expression/],
      ["SELECT datetime(lower('NOW')) AS d FROM v_profiles", /^the time value of datetime\(\) must be a single date literal or date column/],
      ["SELECT count(*) AS n FROM v_profiles WHERE signup_date > date(signup_date, date())", /^date\(\) without a time value/],
      ["SELECT date('instagram') AS d FROM v_profiles", /^the time value of date\(\) must be a date literal 'YYYY-MM-DD'/],
      // A webhook can store any text in page; only stored date columns are time values.
      ['SELECT date(page) AS d FROM v_web_events', /^page is not a stored date column of a view this query reads/],
      // A name can be given to any expression, with or without AS, or through a compound subquery.
      ["SELECT * FROM (SELECT 'n'||'ow' signup_date FROM v_profiles) WHERE date(signup_date) > '2026-08-01'", /^signup_date is not a stored date column/],
      ["SELECT 'n'||'ow' AS signup_date FROM v_profiles ORDER BY date(signup_date)", /^signup_date is not a stored date column/],
      ["SELECT * FROM (SELECT signup_date FROM v_profiles UNION ALL SELECT page FROM v_web_events) WHERE date(signup_date) > '2026-08-01'", /^date\(\) over a column cannot be combined with UNION/],
      ['SELECT date(x.signup_date) AS d FROM (SELECT signup_date FROM v_profiles) x', /^x\.signup_date: date\(\) must read its date column from a view/],
    ]
    for (const [sql, problem] of probes) {
      const denied = gate2(sql)
      expect(denied, sql).not.toBeNull()
      expect(denied!.problems.some((p) => problem.test(p)), `${sql} → ${denied!.problems.join(' | ')}`).toBe(true)
    }
    const ok = [
      "SELECT count(*) AS n FROM v_profiles WHERE status = 'active' AND julianday('2026-09-28') - julianday(last_open_date) >= 30",
      "SELECT strftime('%Y-%m', p.signup_date) AS month, count(*) AS n FROM v_profiles p GROUP BY month",
      "SELECT date(event_ts) AS day, count(*) AS views FROM v_web_events WHERE event_ts >= '2026-08-01' GROUP BY day",
      "SELECT pkey FROM v_profiles WHERE date(signup_date, '+7 days') < '2026-09-28T00:00:00Z'",
    ]
    for (const sql of ok) expect(gate2(sql), sql).toBeNull()
  })

  it('the date columns a date function may read hold only ISO dates in the seeded data', async () => {
    const dateColumns = views.flatMap((v) => v.columns.filter((c) => DATE_COLUMN.test(c.name)).map((c) => `${v.name}.${c.name}`))
    expect(dateColumns).toEqual([
      'v_app_events.event_ts',
      'v_profiles.signup_date',
      'v_profiles.last_open_date',
      'v_profiles.cold_since',
      'v_profiles.app_created_at',
      'v_web_events.event_ts',
    ])
    for (const qualified of dateColumns) {
      const [view, column] = qualified.split('.')
      const counts = await env.DB.prepare(
        `SELECT count(${column}) AS filled, sum(${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*') AS iso FROM ${view}`,
      ).first<{ filled: number; iso: number | null }>()
      // app events arrive only through the webhook (no events CSV), which stores event_ts normalized.
      if (view !== 'v_app_events') expect(counts!.filled, qualified).toBeGreaterThan(0)
      expect(counts!.iso ?? 0, qualified).toBe(counts!.filled)
    }
  })
})

describe('T-GATE-2 Gate 3: the read-only floor', () => {
  it('LIMIT 100 is appended when absent; a larger LIMIT is capped; a smaller one and OFFSET are kept', () => {
    expect(SQL_ROW_LIMIT).toBe(100)
    expect(readOnlySelect('SELECT pkey FROM v_profiles ORDER BY signup_date')).toEqual({
      sql: 'SELECT pkey FROM v_profiles ORDER BY signup_date LIMIT 100',
      limit: 100,
    })
    expect(readOnlySelect('SELECT pkey FROM v_profiles LIMIT 500')).toEqual({ sql: 'SELECT pkey FROM v_profiles LIMIT 100', limit: 100 })
    expect(readOnlySelect('SELECT pkey FROM v_profiles LIMIT 5')).toEqual({ sql: 'SELECT pkey FROM v_profiles LIMIT 5', limit: 5 })
    expect(readOnlySelect('SELECT pkey FROM v_profiles limit 900 offset 20').sql).toBe('SELECT pkey FROM v_profiles LIMIT 100 OFFSET 20')
    expect(readOnlySelect('SELECT pkey FROM v_profiles LIMIT 20, 900').sql).toBe('SELECT pkey FROM v_profiles LIMIT 100 OFFSET 20')
    // A LIMIT inside a subquery is not the statement's limit.
    expect(readOnlySelect('SELECT pkey FROM v_profiles WHERE pkey IN (SELECT pkey FROM v_app_events LIMIT 5)').sql).toBe(
      'SELECT pkey FROM v_profiles WHERE pkey IN (SELECT pkey FROM v_app_events LIMIT 5) LIMIT 100',
    )
  })

  it('a LIMIT that is not a whole number is refused (LIMIT -1 means no limit in SQLite)', () => {
    for (const sql of ['SELECT pkey FROM v_profiles LIMIT -1', 'SELECT pkey FROM v_profiles LIMIT 2.5', 'SELECT pkey FROM v_profiles LIMIT (SELECT 1000)']) {
      expect(gate3(sql)?.problems, sql).toEqual([expect.stringMatching(/^LIMIT must be a whole number up to 100/)])
    }
  })

  it('DELETE, ;-chained, a trailing ;, PRAGMA, ATTACH, WITH and comments are rejected', () => {
    expect(gate3("DELETE FROM subscribers WHERE status = 'unsubscribed'")?.problems).toContain('the query must start with SELECT')
    expect(gate3('SELECT pkey FROM v_profiles; DELETE FROM subscribers')?.problems).toContain('one statement only: ";" is not allowed outside a string')
    expect(gate3('SELECT pkey FROM v_profiles;')?.problems).toContain('one statement only: ";" is not allowed outside a string')
    expect(gate3('PRAGMA table_info(subscribers)')?.problems).toEqual(['the query must start with SELECT', 'PRAGMA is not allowed'])
    expect(gate3("ATTACH DATABASE 'cdp' AS other")?.problems).toEqual(['the query must start with SELECT', 'ATTACH is not allowed'])
    expect(gate3('WITH s AS (SELECT pkey FROM v_profiles) SELECT pkey FROM s')?.problems).toEqual(['the query must start with SELECT', 'WITH is not allowed'])
    expect(gate3('SELECT pkey FROM (WITH s AS (SELECT pkey FROM v_profiles) SELECT pkey FROM s)')?.problems).toEqual(['WITH is not allowed'])
    // A trailing comment would swallow the appended LIMIT.
    expect(gate3('SELECT pkey FROM v_profiles --')?.problems).toEqual(['comments are not allowed'])
    expect(gate3('SELECT pkey /* x */ FROM v_profiles')?.problems).toEqual(['comments are not allowed'])
  })

  it('";", "--" and keywords inside a string are text, not syntax', () => {
    expect(gate3("SELECT ';' AS separator, '-- PRAGMA WITH' AS words")).toBeNull()
    expect(gate3("SELECT 'it''s; fine' AS quoted")).toBeNull()
  })

  it('unreadable SQL and parameter markers the caller does not bind are refused', () => {
    expect(gate3("SELECT 'open FROM v_profiles")?.problems).toEqual(['a string is not closed'])
    expect(gate3('SELECT (pkey FROM v_profiles')?.problems).toEqual(['a "(" is not closed'])
    expect(gate3('SELECT pkey FROM v_profiles WHERE source = ?')?.problems).toEqual(['the query has 1 "?" marker(s) but 0 value(s) are bound'])
    expect(readOnlySelect('SELECT pkey FROM v_profiles WHERE source = ?', 1).sql).toBe('SELECT pkey FROM v_profiles WHERE source = ? LIMIT 100')
    expect(gate3('SELECT pkey FROM v_profiles WHERE source = :source')?.problems).toEqual(['the character ":" is not allowed outside a string'])
  })

  it('a database error reaches the model sanitized: first line, no D1 or SQLite codes', () => {
    expect(sanitizeSqlError(new Error('D1_ERROR: near "LIMIT": syntax error at offset 40: SQLITE_ERROR\n    at stack line'))).toBe(
      'near "LIMIT": syntax error at offset 40',
    )
    expect(sanitizeSqlError(new Error(''))).toBe('the database refused the query')
  })
})

describe('T-GATE-2 every tool call goes through Gate 2: authorizeToolCall', () => {
  it('an unknown tool is denied; input failing input_schema is denied; valid input passes', async () => {
    const tools = await loadTools(env.DB)
    expect(tools.definitions.map((d) => d.name)).toEqual(['segment', 'aggregate', 'query_sql', 'pages_new_subscribers_hit_first', 'describe_schema'])
    expect(authorizeToolCall(tools, { name: 'drop_everything', input: {} })).toEqual({ allowed: false, reason: 'unknown_tool' })
    const cases: Array<[string, unknown, string[]]> = [
      ['segment', { status: 'active' }, ['input.status must be array']],
      ['segment', { status: ['active', 'instagram'] }, ['input.status[1] must be one of "active", "unsubscribed"']],
      ['segment', { days_since_open_gte: 0 }, ['input.days_since_open_gte must be at least 1']],
      ['segment', { days_since_open_gte: 30.5 }, ['input.days_since_open_gte must be integer']],
      ['segment', { status: [] }, ['input.status must have at least 1 item(s)']],
      ['segment', { pages_viewed: ['/'] }, ['input has unknown property "pages_viewed"']],
      ['aggregate', { group_by: 'source' }, ['input.metric is required']],
      ['query_sql', { sql: 'SELECT pkey FROM v_profiles' }, ['input.explanation is required']],
      ['query_sql', { sql: 42, explanation: 'count' }, ['input.sql must be string']],
      ['query_sql', [], ['input must be object']],
    ]
    for (const [name, input, problems] of cases) {
      expect(authorizeToolCall(tools, { name, input }), JSON.stringify(input)).toMatchObject({ allowed: false, reason: 'input_schema', problems })
    }
    const ok = { status: ['active'], source: ['instagram'], has_app: null }
    expect(authorizeToolCall(tools, { name: 'segment', input: ok })).toMatchObject({ allowed: true, input: ok })
  })

  it('the executor refuses schema-failing input before the handler runs: an error result and a blocked gate2 row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { executed, rows } = await runTool('segment', { status: 'active' })
    expect(executed.output).toBeNull()
    expect(executed.result.is_error).toBe(true)
    expect(String(executed.result.content)).toContain('input_schema: input.status must be array')
    expect(rows).toEqual([
      { kind: 'blocked', status: 'blocked', tool_name: 'segment', sql: null, row_count: null, error: 'gate2_denied: input_schema: input.status must be array' },
    ])
  })
})

describe('query_sql through Gates 2 and 3', () => {
  it('runs a real query once, with LIMIT forced, and audits the SQL that ran', async () => {
    const sql = 'SELECT status, count(*) AS subscribers FROM v_profiles WHERE status IS NOT NULL GROUP BY status ORDER BY status'
    const { executed, rows } = await runTool('query_sql', { sql, explanation: 'subscribers by status' })
    expect(executed.result.is_error).toBeUndefined()
    expect(executed.output).toMatchObject({
      tool: 'query_sql',
      columns: ['status', 'subscribers'],
      rows: [
        { status: 'active', subscribers: 2610 },
        { status: 'unsubscribed', subscribers: 290 },
      ],
      total_rows: 2,
      summary: { explanation: 'subscribers by status', rows: 2, row_limit: 100, may_have_more_rows: false },
      sql: `${sql} LIMIT 100`,
    })
    expect(String(executed.result.content)).toContain('| active | 2610 |')
    expect(rows).toEqual([{ kind: 'tool_call', status: 'success', tool_name: 'query_sql', sql: `${sql} LIMIT 100`, row_count: 2, error: null }])
  })

  it('FROM subscribers → an error result to the model and a blocked gate2 row with the SQL as sent; nothing runs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sql = 'SELECT email_norm, status FROM subscribers'
    const { executed, rows } = await runTool('query_sql', { sql, explanation: 'emails' })
    expect(executed.output).toBeNull()
    expect(executed.result.is_error).toBe(true)
    expect(String(executed.result.content)).toContain('subscribers is not one of the views')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'blocked', status: 'blocked', tool_name: 'query_sql', sql, row_count: null })
    expect(rows[0].error).toMatch(/^gate2_denied: /)
    expect(rows[0].error).toContain('subscribers is not one of the views')
    expect(rows[0].error).toContain('email_norm is personal data; no view exposes it')
    expect(rows[0].error).toContain('unknown column status: the query reads no view')
  })

  it('a chained statement that passes Gate 2 is stopped by Gate 3', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sql = "SELECT pkey FROM v_profiles WHERE status = 'active'; SELECT pkey FROM v_profiles"
    const { executed, rows } = await runTool('query_sql', { sql, explanation: 'two statements' })
    expect(executed.result.is_error).toBe(true)
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'blocked', tool_name: 'query_sql', sql, error: 'gate3_denied: one statement only: ";" is not allowed outside a string' }),
    ])
  })

  it('a query the database refuses goes back once, sanitized, as a query_failed tool_call error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sql = 'SELECT source, count(*) AS n FROM v_profiles GROUP BY'
    const { db, prepared } = recordingDb()
    const { executed, rows } = await runTool('query_sql', { sql, explanation: 'broken group by' }, db)
    // One attempt: the query is prepared once and not retried.
    expect(prepared.filter((q) => q.startsWith(sql))).toEqual([`${sql} LIMIT 100`])
    expect(executed.output).toBeNull()
    expect(executed.result.is_error).toBe(true)
    const content = String(executed.result.content)
    expect(content).toContain('the query failed: ')
    expect(content).not.toMatch(/D1_ERROR|SQLITE_ERROR|\n\s+at /)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'tool_call', status: 'error', tool_name: 'query_sql', sql: `${sql} LIMIT 100` })
    expect(rows[0].error).toMatch(/^query_failed: the query failed: /)
  })

  it('a query that matches nothing returns its columns and no rows', async () => {
    const sql = "SELECT pkey, source FROM v_profiles WHERE status = 'active' AND status = 'unsubscribed'"
    const { executed } = await runTool('query_sql', { sql, explanation: 'nobody' })
    expect(executed.output).toMatchObject({ columns: ['pkey', 'source'], rows: [], total_rows: 0, summary: { may_have_more_rows: false } })
    expect(String(executed.result.content)).toContain('No rows.')
  })

  it('a hidden table in parentheses, behind an alias or after IN, or the wall clock in a date function is refused before D1, with a blocked gate2 row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probes = [
      'SELECT count(*) AS subscribers FROM (subscribers)',
      'SELECT * FROM (subscribers) subscribers',
      'SELECT p.pkey FROM v_profiles p JOIN (app_users) app_users ON 1 = 1',
      'SELECT * FROM (ai_audit) ai_audit',
      "SELECT * FROM 'subscribers'",
      "SELECT count(*) AS n FROM v_profiles WHERE status = 'active' AND last_open_date < date()",
      ...ALIAS_PROBES.map(([sql]) => sql),
    ]
    for (const sql of probes) {
      const { db, prepared } = recordingDb()
      const { executed, rows } = await runTool('query_sql', { sql, explanation: 'probe' }, db)
      // Nothing ran: the probe was never prepared (the views' PRAGMA columns are cached by schema-context.ts).
      expect(prepared.filter((q) => q.startsWith(sql)), sql).toEqual([])
      expect(executed.output, sql).toBeNull()
      expect(executed.result.is_error, sql).toBe(true)
      expect(rows, sql).toEqual([expect.objectContaining({ kind: 'blocked', status: 'blocked', tool_name: 'query_sql', sql, row_count: null })])
      expect(rows[0].error?.startsWith('gate2_denied: '), `${sql} → ${rows[0].error}`).toBe(true)
    }
  })

  it('two columns with one name are refused rather than silently merged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { executed } = await runTool('query_sql', { sql: 'SELECT p.pkey, w.pkey FROM v_profiles p JOIN v_web_events w ON w.pkey = p.pkey', explanation: 'keys' })
    expect(String(executed.result.content)).toContain('two result columns are named pkey; give each column its own name with AS')
  })
})

describe('T-AI-2 query_sql results contain pk_ keys only', () => {
  it('subjects come back as pk_ keys: the demo subject by her key, visitors and readers by theirs; no email or raw id in any cell', async () => {
    const joy = await env.DB.prepare('SELECT pkey FROM profiles WHERE email_norm = ?').bind(JOY).first<string>('pkey')
    if (joy === null) throw new Error('no profile for the demo subject (02 §Counts)')
    const emails = new Set(
      (await env.DB.prepare('SELECT email_norm FROM profiles WHERE email_norm IS NOT NULL').all<{ email_norm: string }>()).results.map((r) => r.email_norm),
    )
    const queries = [
      { sql: `SELECT pkey, source, first_page, first_utm_source FROM v_profiles WHERE pkey = '${joy}'`, keys: ['pkey'] },
      { sql: "SELECT pkey, visitor_hash, page, event_ts FROM v_web_events WHERE page = '/' ORDER BY event_ts", keys: ['visitor_hash'] },
      { sql: 'SELECT pkey, page, utm_source FROM v_web_events WHERE pkey IS NOT NULL ORDER BY event_ts DESC', keys: ['pkey'] },
      { sql: "SELECT pkey, signup_date, engagement_score FROM v_profiles WHERE status = 'active' AND source = 'instagram' ORDER BY engagement_score DESC", keys: ['pkey'] },
    ]
    const outputs = []
    for (const { sql, keys } of queries) {
      const { executed } = await runTool('query_sql', { sql, explanation: 'who' })
      const output = executed.output
      if (output === null) throw new Error(`query_sql did not run: ${String(executed.result.content)}`)
      expect(output.rows.length, sql).toBeGreaterThan(0)
      expect(output.rows.length, sql).toBeLessThanOrEqual(SQL_ROW_LIMIT)
      for (const row of output.rows) {
        for (const key of keys) expect(row[key], `${sql} ${key}`).toMatch(PKEY)
        if (row.pkey !== null) expect(row.pkey).toMatch(PKEY)
        for (const cell of Object.values(row)) {
          if (typeof cell !== 'string') continue
          expect(EMAIL_REGEX.test(cell), cell).toBe(false)
          expect(RAW_ID_REGEX.test(cell), cell).toBe(false)
          expect(emails.has(cell)).toBe(false)
        }
      }
      outputs.push(output)
    }
    expect(outputs[0].rows).toEqual([{ pkey: joy, source: 'instagram', first_page: '/', first_utm_source: 'instagram' }])
    expect(outputs[1].rows).toHaveLength(100) // more than 100 "/" views: the forced LIMIT holds
    expect(outputs[3].summary).toMatchObject({ row_limit: 100 })
  })

  it('every identifying column is out of reach: each PII column, by name or through a table, is denied before D1', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probes = [
      'SELECT email_norm FROM v_profiles',
      'SELECT user_id, device_id FROM v_app_events',
      'SELECT visitor_id FROM v_web_events',
      'SELECT pkey, email_norm FROM profiles',
      'SELECT raw_row FROM quarantine',
      'SELECT u.email_raw FROM v_profiles p JOIN app_users u ON u.created_at = p.app_created_at',
    ]
    for (const sql of probes) {
      const { executed, rows } = await runTool('query_sql', { sql, explanation: 'identities' })
      expect(executed.output, sql).toBeNull()
      expect(rows, sql).toHaveLength(1)
      expect(rows[0].kind, sql).toBe('blocked')
      expect(rows[0].error?.startsWith('gate2_denied: '), sql).toBe(true)
    }
  })
})

// ── the whole request (POST /api/assistant) ─────────────────────────────────────────────────

let calls = 0

function message(content: Anthropic.ContentBlock[], stop_reason: Anthropic.StopReason): Anthropic.Message {
  calls += 1
  return {
    id: `msg_gate2_${calls}`,
    type: 'message',
    role: 'assistant',
    model: MODEL,
    container: null,
    diagnostics: null,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
    },
  }
}

describe('Gate 2/3 inside the request: a refusal goes back to the model and the request goes on', () => {
  it('query_sql over subscribers is refused, the model corrects it, the answer is 200 and the audit says so', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const corrected = "SELECT status, count(*) AS subscribers FROM v_profiles WHERE status = 'active' GROUP BY status"
    const turns: Array<() => Anthropic.Message> = [
      () =>
        message(
          [{ type: 'tool_use', id: 'toolu_q1', name: 'query_sql', input: { sql: 'SELECT count(*) AS n FROM subscribers', explanation: 'count' }, caller: { type: 'direct' } }],
          'tool_use',
        ),
      () => message([{ type: 'tool_use', id: 'toolu_q2', name: 'query_sql', input: { sql: corrected, explanation: 'count' }, caller: { type: 'direct' } }], 'tool_use'),
      () =>
        message(
          [{ type: 'text', text: 'There are 2610 active subscribers.', citations: null }],
          'end_turn',
        ),
    ]
    const requests: Anthropic.MessageCreateParamsNonStreaming[] = []
    const transport: MessagesTransport = async (request) => {
      requests.push(structuredClone(request))
      const next = turns[requests.length - 1]
      if (next === undefined) throw new Error(`no scripted turn for call ${requests.length}`)
      return next()
    }
    const app = new Hono<AppEnv>()
    app.use('/api/*', requireJson, requireSession)
    app.route('/api', assistantRoutes(() => transport))
    app.onError(onError)
    const res = await app.request(
      '/api/assistant',
      { method: 'POST', headers: { cookie: await loginCookie(), 'content-type': 'application/json' }, body: JSON.stringify({ question: 'how many active subscribers do we have?' }) },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json<{ text: string; table: { rows: unknown[] } | null; audit_id: string }>()
    expect(body.text).toContain('2610')

    const refusal = requests[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    expect(refusal[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_q1', is_error: true })
    expect(String(refusal[0].content)).toContain('subscribers is not one of the views')

    const rows = await auditRows(body.audit_id)
    expect(rows.map((r) => `${r.kind}/${r.status}/${r.tool_name ?? '-'}`)).toEqual([
      'model_request/success/-',
      'blocked/blocked/query_sql',
      'model_request/success/-',
      'tool_call/success/query_sql',
      'model_request/success/-',
    ])
    expect(rows[1].error).toMatch(/^gate2_denied: subscribers is not one of the views/)
    expect(rows[3].sql).toBe(`${corrected} LIMIT 100`)
    // The refusal is a step the loop goes on from, as an unknown tool is (worker/routes/audit.ts).
    expect(traceOutcome({ last_kind: 'blocked', last_status: 'blocked', last_error: rows[1].error, board_run: 0 })).toBe('unfinished')
  })
})
