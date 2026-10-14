import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HOSTED_URL } from '../shared/config'
import { LOCAL_PART_MIN_CHARS } from '../shared/pii'
import { startTrace } from '../worker/assistant/audit/ai-audit'
import { enforceGate1 } from '../worker/assistant/gates/gate1-input-sanitizer'
import type { SegmentRow } from '../worker/segments/compile'
import { segmentCsv } from '../worker/segments/export'
import { loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'
import { eventIdPool, nowSeconds, sendWebhook } from './helpers/webhook'

// T-HARD-1..3, 5..7 (08; 09 D-70 items 1, 2, 3, 5, 6, 7): the fixes for findings of the practice
// self-audit. The test D1 holds the real seed of data/*.csv (test/helpers/seed.ts); no network
// (09 D-54). Every 02 §Counts number these tests touch stays as 02 states it.
// Inputs and where they come from:
// - T-HARD-1: joy.hall830 and julia.evans230 are the local parts of the demo subjects
//   joy.hall830@protonmail.com (subscribers.csv:902) and julia.evans230@gmail.com
//   (subscribers.csv:373); the loop reads every local part from the seeded profiles. The
//   near-misses are removals from a real local part (joy.hall83, oy.hall830; 09 D-47) and a real
//   local part joined to the label of its own domain (joy.hall830.protonmail), which is one token
//   that is not a local part.
// - Webhook bodies (T-HARD-2) are brief-shaped with real ids (09 D-11): event ids from
//   eventIdPool() (`evt_` + a real visitor_id's hex), user u_ceed5f12 (app_users.csv:303,
//   joy.hall830) on device `d_` + her id's hex, the brief's event time. Accepted values: the
//   brief's story slug and LINK, the hosted app's URL (shared/config.ts HOSTED_URL) with a real
//   page path. Refused values are real data put in the wrong place (a page path, an address, the
//   address behind https://) or minimal edits of the accepted ones (09 D-47): upper-cased, cut to
//   nothing, repeated past 120 characters, wrapped in an array, the scheme removed.
// - T-HARD-3: users u_f1cad5ce (app_users.csv:15, eli.clark874@icloud.com) and u_38e852b0
//   (app_users.csv:11, sarah.edwards657@gmail.com) on eli's device `d_f1cad5ce`; event times are
//   taken from the wall clock (the bound is relative to it, 09 D-70 #3), as T-WH-7 does.
// - T-HARD-5: segment rows are real rows of the seeded export. The `@` cell is the real
//   subscribers.csv:1788 address `@gmail.com` (quarantined by the seed, so it is put back into a
//   real row's email by hand); `=`, `+` and `-` are the other D-70 #5 formula characters put in
//   front of a real address, as injection probes (not business data), one also followed by a
//   comma and the row's real source to show the RFC 4180 quoting is kept.

afterEach(() => {
  vi.restoreAllMocks()
})

beforeAll(async () => {
  await seedDatabase()
})

async function column<T>(sql: string, name: string, ...binds: unknown[]): Promise<T[]> {
  const { results } = await env.DB.prepare(sql).bind(...binds).all<Record<string, T>>()
  return results.map((row) => row[name])
}

async function auditCount(traceId: string): Promise<number> {
  const n = await env.DB.prepare('SELECT count(*) AS n FROM ai_audit WHERE trace_id = ?').bind(traceId).first<number>('n')
  if (n === null) throw new Error('count returned no row')
  return n
}

describe('T-HARD-1: Gate 1 redacts a known email local part typed on its own (09 D-70 #1)', () => {
  it('a demo subject typed as joy.hall830 reaches the model as [email], counted like an email, no audit row', async () => {
    const trace = await startTrace(env.DB)
    const question = await enforceGate1(trace, 'is joy.hall830 engaged?')
    expect(question.text).toBe('is [email] engaged?')
    expect(question.emailsRedacted).toBe(1)
    // As for an email in the text (T-GATE-1): redaction continues the request and writes no row.
    expect(await auditCount(trace.traceId)).toBe(0)
  })

  it('every known local part of the seed is redacted as a whole token', async () => {
    const emails = await column<string>('SELECT DISTINCT email_norm FROM profiles WHERE email_norm IS NOT NULL', 'email_norm')
    expect(emails).toHaveLength(2930) // 02 §Counts: 2,900 subscribers + 30 app-only accounts
    const trace = await startTrace(env.DB)
    for (const email of emails) {
      const local = email.slice(0, email.indexOf('@'))
      expect(local.length).toBeGreaterThanOrEqual(LOCAL_PART_MIN_CHARS)
      const question = await enforceGate1(trace, `how engaged is ${local}?`)
      expect(question.text, 'a known local part survived Gate 1').toBe('how engaged is [email]?')
    }
  })

  it('folds case, keeps sentence punctuation, and redacts addresses and local parts together', async () => {
    const trace = await startTrace(env.DB)
    expect((await enforceGate1(trace, 'did JOY.HALL830. open anything?')).text).toBe('did [email]. open anything?')
    expect((await enforceGate1(trace, "what is joy.hall830's first page?")).text).toBe("what is [email]'s first page?")
    const both = await enforceGate1(trace, 'compare joy.hall830@protonmail.com with julia.evans230')
    expect(both.text).toBe('compare [email] with [email]')
    expect(both.emailsRedacted).toBe(2)
  })

  it('a token that only contains or nearly matches a local part is left as typed', async () => {
    const known = await column<string>('SELECT email_norm FROM profiles WHERE email_norm IS NOT NULL', 'email_norm')
    const locals = new Set(known.map((e) => e.slice(0, e.indexOf('@'))))
    const trace = await startTrace(env.DB)
    for (const token of ['joy.hall83', 'oy.hall830', 'joy.hall830.protonmail']) {
      expect(locals.has(token)).toBe(false)
      const question = await enforceGate1(trace, `how engaged is ${token}?`)
      expect(question.text).toBe(`how engaged is ${token}?`)
      expect(question.emailsRedacted).toBe(0)
    }
    expect(LOCAL_PART_MIN_CHARS).toBe(6) // 09 D-70 #1
  })
})

type Body = Record<string, unknown>

const nextEventId = eventIdPool()
const JOY_USER = 'u_ceed5f12'
const JOY_DEVICE = 'd_ceed5f12'
const BRIEF_TS = '2026-09-28T14:22:05Z'
const SLUG = 'supreme-court-ruling-explained'
const LINK = `${HOSTED_URL}/news/supreme-court-ruling-explained`

/** A brief-shaped read_story event by joy.hall830's app account with a fresh event id. */
function joyEvent(fields: Body): Body {
  return { event_id: nextEventId(), event: 'read_story', user_id: JOY_USER, device_id: JOY_DEVICE, timestamp: BRIEF_TS, ...fields }
}

async function post(body: Body): Promise<{ status: number; text: string }> {
  const res = await sendWebhook(JSON.stringify(body))
  return { status: res.status, text: await res.text() }
}

async function storedCount(eventId: unknown): Promise<number> {
  const n = await env.DB.prepare('SELECT count(*) AS n FROM app_events WHERE event_id = ?').bind(eventId).first<number>('n')
  if (n === null) throw new Error('count returned no row')
  return n
}

describe('T-HARD-2: webhook story and link must be slugs; other strings never reach v_app_events (09 D-70 #2)', () => {
  it('stores a slug story and an http(s) link, and v_app_events shows them', async () => {
    const body = joyEvent({ properties: { story: SLUG, link: LINK } })
    expect((await post(body)).status).toBe(202)
    const rows = await env.DB.prepare(
      `SELECT v.story, v.link FROM v_app_events v WHERE v.story = ? AND v.link = ?`,
    ).bind(SLUG, LINK).all()
    expect(rows.results).toHaveLength(1)
  })

  const refusals: [field: 'story' | 'link', value: unknown][] = [
    ['story', '/news/church-attendance-study'],
    ['story', 'joy.hall830@protonmail.com'],
    ['story', SLUG.toUpperCase()],
    ['story', ''],
    ['story', Array(5).fill(SLUG).join('-').slice(0, 121)],
    ['story', [SLUG]],
    ['link', '/news/supreme-court-ruling-explained'],
    ['link', LINK.replace(/^https:\/\//, '')],
    ['link', 'https://julia.evans230@gmail.com'],
    ['link', SLUG],
  ]

  it.each(refusals)('refuses properties.%s = %j with 400 invalid_event naming the field, never the value', async (field, value) => {
    const logged: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
    const body = joyEvent({ properties: { story: SLUG, link: LINK, [field]: value } })
    const { status, text } = await post(body)
    expect(status).toBe(400)
    const json = JSON.parse(text) as { error: string; details: { field: string; issue: string }[] }
    expect(json.error).toBe('invalid_event')
    expect(json.details).toEqual([{ field: `properties.${field}`, issue: expect.any(String) }])
    if (typeof value === 'string' && value !== '') {
      expect(text).not.toContain(value)
      expect(logged.join('\n')).not.toContain(value)
    }
    expect(await storedCount(body.event_id)).toBe(0)
  })

  it('stores any other string property but no v_app_events cell holds it', async () => {
    const address = 'joy.hall830@protonmail.com'
    const body = joyEvent({ properties: { story: SLUG, page: address, utm: { source: address } } })
    expect((await post(body)).status).toBe(202)
    const raw = await env.DB.prepare('SELECT properties FROM app_events WHERE event_id = ?').bind(body.event_id).first<string>('properties')
    expect(JSON.parse(raw!)).toEqual(body.properties)
    const { results } = await env.DB.prepare('SELECT * FROM v_app_events').all()
    expect(results.length).toBeGreaterThan(0)
    expect(JSON.stringify(results)).not.toContain(address)
  })
})

const HOUR_MS = 3_600_000
/** An ISO event time `offsetMs` after the wall clock. */
const fromNow = (offsetMs: number) => new Date(nowSeconds() * 1000 + offsetMs).toISOString()

async function scoreOf(email: string): Promise<number> {
  const score = await env.DB.prepare('SELECT engagement_score FROM profiles WHERE email_norm = ?').bind(email).first<number>('engagement_score')
  if (score === null) throw new Error('no profile for a real app user')
  return score
}

function deviceOwner(deviceId: string) {
  return env.DB.prepare('SELECT user_id, last_seen_ts FROM device_identity WHERE device_id = ?').bind(deviceId).first<{ user_id: string; last_seen_ts: string }>()
}

describe('T-HARD-3: an event time more than 24 h after the server clock is refused (09 D-70 #3)', () => {
  const ELI = { user_id: 'u_f1cad5ce', email: 'eli.clark874@icloud.com' }
  const SARAH = 'u_38e852b0'
  const DEVICE = 'd_f1cad5ce'

  it('a login 24 h + 1 min ahead is 400 on timestamp, stores nothing and cannot pin the device', async () => {
    const login = { event_id: nextEventId(), event: 'login', user_id: ELI.user_id, device_id: DEVICE, timestamp: fromNow(-HOUR_MS) }
    expect((await post(login)).status).toBe(202)
    const owner = await deviceOwner(DEVICE)
    expect(owner?.user_id).toBe(ELI.user_id)

    const future = { event_id: nextEventId(), event: 'login', user_id: SARAH, device_id: DEVICE, timestamp: fromNow(24 * HOUR_MS + 60_000) }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { status, text } = await post(future)
    expect(status).toBe(400)
    const json = JSON.parse(text) as { error: string; details: { field: string; issue: string }[] }
    expect(json.error).toBe('invalid_event')
    expect(json.details).toEqual([{ field: 'timestamp', issue: 'timestamp must be at most 24 hours after the server clock' }])
    expect(text).not.toContain(String(future.timestamp).slice(0, 19))
    expect(await storedCount(future.event_id)).toBe(0)
    expect(await deviceOwner(DEVICE)).toEqual(owner)
  })

  it('an event 23 h ahead, after TODAY, is stored and counts toward the score (09 D-01)', async () => {
    const before = await scoreOf(ELI.email)
    const ahead = { event_id: nextEventId(), event: 'app_open', user_id: ELI.user_id, device_id: DEVICE, timestamp: fromNow(23 * HOUR_MS) }
    expect((await post(ahead)).status).toBe(202)
    expect(await storedCount(ahead.event_id)).toBe(1)
    // One more app event in the last 30 days adds 2.5 points before rounding (02 §Derived).
    const after = await scoreOf(ELI.email)
    expect(after - before).toBeGreaterThanOrEqual(2)
    expect(after - before).toBeLessThanOrEqual(3)
  })
})

const CRLF = '\r\n'

/** POST /api/segments/<path> with a session from `ip` (a documentation address by default). */
async function segmentsPost(path: string, body: unknown, cookie: string, ip?: string): Promise<Response> {
  return SELF.fetch(`http://cdp.test/api/segments/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, ...(ip === undefined ? {} : { 'cf-connecting-ip': ip }) },
    body: JSON.stringify(body),
  })
}

describe('T-HARD-5: the segment CSV export neutralizes formula cells (09 D-70 #5)', () => {
  it('the real export of all 2,900 subscribers is unchanged: no cell starts with = + - @ or gets a quote', async () => {
    const res = await segmentsPost('export.csv', { filters: { status: ['active', 'unsubscribed'] } }, await loginCookie())
    expect(res.status).toBe(200)
    const text = await res.text()
    const records = text.slice(0, -2).split(CRLF)
    expect(records).toHaveLength(1 + 2900) // header + 02 §Counts subscribers
    expect(text).not.toContain("'")
    expect(text).not.toContain('"')
  })

  it("prefixes ' to a cell starting with = + - or @ and keeps RFC 4180 quoting", async () => {
    const preview = await segmentsPost('preview', { filters: { status: ['active'], source: ['google'] }, limit: 1 }, await loginCookie())
    const [real] = (await preview.json<{ rows: SegmentRow[] }>()).rows
    expect(real.source).toBe('google')
    const rows: SegmentRow[] = [
      { ...real, email: '@gmail.com' },
      { ...real, email: `=${real.email}` },
      { ...real, email: `+${real.email}` },
      { ...real, email: `-${real.email}` },
      { ...real, email: `=${real.email},${real.source}` },
    ]
    const records = segmentCsv(rows).slice(0, -2).split(CRLF).slice(1)
    const rest = segmentCsv([real]).slice(0, -2).split(CRLF)[1].slice(real.email.length)
    expect(records).toEqual([
      `'@gmail.com${rest}`,
      `'=${real.email}${rest}`,
      `'+${real.email}${rest}`,
      `'-${real.email}${rest}`,
      `"'=${real.email},${real.source}"${rest}`,
    ])
  })
})
