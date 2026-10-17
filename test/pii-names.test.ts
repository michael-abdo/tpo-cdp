import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import webCsv from '../data/web_events.csv?raw'
import { TOOL_SEEDS } from '../scripts/tool-seeds'
import { HOSTED_URL } from '../shared/config'
import { BRIEF_QUESTIONS } from '../src/insights/questions'
import { AuditWriteError, startTrace } from '../worker/assistant/audit/ai-audit'
import { buildModelRequest, type ModelTool } from '../worker/assistant/build-request'
import { enforceGate1, sanitizeQuestion } from '../worker/assistant/gates/gate1-input-sanitizer'
import { assertNoPII, findPII, KnownEmails, loadKnownEmails, PiiBlockedError, redactKnownNames } from '../worker/assistant/gates/pii-guard'
import { type ViewSchema, viewSchemas } from '../worker/assistant/schema-context'
import { renderSystemPrompt } from '../worker/assistant/system-prompt'
import type { ResultRow } from '../worker/assistant/tools/builtin-handlers'
import { formatToolOutput, frameToolResult } from '../worker/assistant/tools/format-results'
import { parseCsv } from '../worker/ingest/csv'
import { personalDataIssue } from '../worker/webhooks/exposed-properties'
import { seedDatabase } from './helpers/seed'
import { eventIdPool, sendWebhook } from './helpers/webhook'

// A subscriber's name typed in place of their email. The data has no name column, but each
// local part spells one: julia.evans230 is Julia Evans. Gate 1 masks that name to [name] in a
// question, and the outbound scanner reports it as known_name in a model request, a tool result,
// a model answer, a webhook story or link and an audit row. A single first name, or a name no
// stored email spells, stays as typed.
//
// Inputs, all real:
// - julia.evans230@gmail.com (subscribers.csv:373), joy.hall830@protonmail.com
//   (subscribers.csv:902) and daniel.hill389@gmail.com (app_users.csv:3).
// - Names no stored email spells: Maria Lopez, Bob Smith, and Evans Julia (the words reversed).
// - appuser12 (app_users.csv) spells only one word, so "appuser" is no name.
// - The clean set: every page path in web_events.csv, the brief's story slug and sample event,
//   the brief's three questions, the system prompt, every seeded tool description and real
//   100-row tool results read from v_profiles and v_web_events.

const JULIA = 'julia.evans230@gmail.com'
const BRIEF_EVENT = {
  event_id: 'evt_9f3a1c',
  event: 'read_story',
  user_id: 'u_2b6447a3',
  device_id: 'd_4b21e8',
  timestamp: '2026-09-28T14:22:05Z',
  properties: { story: 'supreme-court-ruling-explained' },
}

const nextEventId = eventIdPool()
let known: KnownEmails
let views: readonly ViewSchema[]

async function rows(sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results
}

/** A tool result as the executor guards it: the framed text the model reads plus the full rows. */
function toolResult(sourceRows: Record<string, unknown>[]): { content: string; rows: Record<string, unknown>[] } {
  const content = formatToolOutput({
    tool: 'query_sql',
    columns: Object.keys(sourceRows[0] ?? {}),
    // D1 rows hold only strings, numbers and nulls.
    rows: sourceRows as ResultRow[],
    total_rows: sourceRows.length,
    summary: { total_rows: sourceRows.length },
  })
  return { content, rows: sourceRows }
}

beforeAll(async () => {
  await seedDatabase()
  known = await loadKnownEmails(env.DB)
  views = await viewSchemas(env.DB)
})

describe('the names stored emails spell', () => {
  it('a name needs two words of two or more letters; digits are dropped and one word is never a name', () => {
    const set = new KnownEmails(['julia.evans230@gmail.com', 'appuser12@gmail.com', 'j.smith41@gmail.com', 'mary_ann-lee7@gmail.com'])
    expect(set.namesStartingWith('julia')).toEqual([['julia', 'evans']])
    expect(set.namesStartingWith('mary')).toEqual([['mary', 'ann', 'lee']])
    expect(set.namesStartingWith('appuser')).toBeUndefined()
    expect(set.namesStartingWith('smith')).toBeUndefined()
    expect(set.namesStartingWith('j')).toBeUndefined()
  })
})

describe('Gate 1 masks a typed subscriber name', () => {
  it('in any case, before a possessive, and every name in one question', async () => {
    const cases: Array<[string, string]> = [
      ['is Julia Evans an engaged subscriber?', 'is [name] an engaged subscriber?'],
      ['is JULIA EVANS engaged?', 'is [name] engaged?'],
      ['is julia evans engaged?', 'is [name] engaged?'],
      ["what is Julia Evans's last open?", "what is [name]'s last open?"],
      ['compare Julia Evans, Joy Hall and Daniel Hill by source', 'compare [name], [name] and [name] by source'],
      ['is Julia\nEvans engaged?', 'is [name] engaged?'],
    ]
    for (const [typed, masked] of cases) {
      const question = await enforceGate1(await startTrace(env.DB), typed)
      expect(question.text, typed).toBe(masked)
    }
  })

  it('keeps email and local-part redaction as before, and a local part typed with spaces is still [email]', async () => {
    const question = await enforceGate1(await startTrace(env.DB), `did ${JULIA}, julia evans 230 and Joy Hall open it?`)
    expect(question.text).toBe('did [email], [email] and [name] open it?')
    expect(question.emailsRedacted).toBe(2)
  })

  it('leaves a single first name, a name no stored email spells and a longer word as typed', async () => {
    for (const asked of [
      'is Julia engaged?',
      'how many readers named Joy signed up?',
      'is Maria Lopez a subscriber?',
      'is Bob Smith a subscriber?',
      'is Evans Julia a subscriber?',
      'did Julia Evansworth sign up?',
      'did Xjulia Evans sign up?',
      'is it Julia, Evans or Hall?',
    ]) {
      const question = await enforceGate1(await startTrace(env.DB), asked)
      expect(question.text, asked).toBe(asked)
    }
  })
})

describe('the scanner reports known_name', () => {
  it('in a model request, a tool result, a model answer and an audit row', async () => {
    const [profile] = await rows('SELECT * FROM v_profiles WHERE pkey = (SELECT pkey FROM profiles WHERE email_norm = ?)', JULIA)
    expect(profile).toBeDefined()
    const request = { messages: [{ role: 'user', content: 'is Julia Evans engaged?' }] }
    const planted = toolResult([{ ...profile, first_page: '/u/julia-evans' }])
    const answer = [{ type: 'text', text: 'The most engaged reader is JOY HALL.' }]
    expect(findPII(request, known)).toBe('known_name')
    expect(findPII(planted, known)).toBe('known_name')
    expect(findPII(frameToolResult('query_sql', 'daniel_hill'), known)).toBe('known_name')
    expect(findPII(answer, known)).toBe('known_name')
    expect(findPII(`${HOSTED_URL}/search?q=julia+evans`, known)).toBe('known_name')
    expect(() => assertNoPII(answer, known, 'model_output')).toThrow(PiiBlockedError)
    try {
      assertNoPII(answer, known, 'model_output')
    } catch (err) {
      expect((err as PiiBlockedError).check).toBe('known_name')
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const trace = await startTrace(env.DB)
    await expect(trace.write({ kind: 'model_request', status: 'success', request_json: request })).rejects.toThrow(AuditWriteError)
    vi.restoreAllMocks()
  })

  it('an earlier check still wins: a stored email is known_email and a local part is known_local_part', () => {
    expect(findPII(`Julia Evans (${JULIA})`, known)).toBe('known_email')
    expect(findPII({ text: 'julia evans\t230' }, known)).toBe('known_local_part')
  })

  it('a webhook story "julia-evans" or a link with the name is a 400 and nothing is stored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const [key, value] of [
      ['story', 'julia-evans'],
      ['story', 'readers-like-joy-hall'],
      ['link', `${HOSTED_URL}/readers/daniel-hill`],
    ] as const) {
      const eventId = nextEventId()
      const res = await sendWebhook(JSON.stringify({ ...BRIEF_EVENT, event_id: eventId, event: 'link_click', properties: { [key]: value } }))
      const body = await res.json()
      expect(res.status, value).toBe(400)
      expect(body, value).toEqual({ error: 'invalid_event', message: expect.any(String), details: [{ field: `properties.${key}`, issue: personalDataIssue(key) }] })
      expect(JSON.stringify(body)).not.toContain(value)
      expect(await rows('SELECT event_id FROM app_events WHERE event_id = ?', eventId)).toHaveLength(0)
    }
    warn.mockRestore()
  })

  it('a single first name, a name no stored email spells and a longer word are clean', () => {
    for (const text of ['Julia', 'julia-', 'Maria Lopez', 'bob-smith', 'Evans Julia', 'julia evansworth', 'Julia, Evans', 'julia/evans', 'appuser']) {
      expect(findPII(text, known), text).toBeNull()
    }
  })
})

describe('stays clean', () => {
  it('every real page path as a path, a URL, a slug and plain words, the brief\'s story slug and sample event', () => {
    const csv = parseCsv(webCsv)
    const pages = [...new Set(csv.rows.map((r) => r[csv.header.indexOf('page')]!.trim()))]
    expect(pages.length).toBeGreaterThan(10)
    const slug = BRIEF_EVENT.properties.story
    for (const text of [
      ...pages,
      ...pages.map((page) => `${HOSTED_URL}${page}`),
      ...pages.map((page) => page.slice(1).replaceAll('/', '-')),
      ...pages.map((page) => page.replace(/[/-]+/g, ' ').trim()),
      slug,
      slug.replaceAll('-', ' '),
    ]) {
      expect(findPII(text, known), text).toBeNull()
      expect(redactKnownNames(text, known), text).toEqual({ text, count: 0 })
    }
    // The sample event carries raw ids (raw_id), so only the name scan is asked here.
    const event = JSON.stringify(BRIEF_EVENT)
    expect(redactKnownNames(event, known)).toEqual({ text: event, count: 0 })
  })

  it('the brief\'s three questions through Gate 1 and in the whole model request, the system prompt and every seeded tool description', async () => {
    const tools: ModelTool[] = TOOL_SEEDS.map((seed) => ({ name: seed.name, description: seed.description, input_schema: seed.inputSchema as ModelTool['input_schema'] }))
    for (const asked of BRIEF_QUESTIONS) {
      const result = sanitizeQuestion(asked, known)
      if (!result.ok) throw new Error(`Gate 1 refused ${asked}`)
      expect(result.question.text, asked).toBe(asked)
      expect(findPII(buildModelRequest({ views, tools, question: result.question, rounds: [] }), known), asked).toBeNull()
    }
    const prompt = renderSystemPrompt(views)
    expect(redactKnownNames(prompt, known).count).toBe(0)
    for (const seed of TOOL_SEEDS) {
      expect(redactKnownNames(seed.description, known).count, seed.name).toBe(0)
      expect(findPII(seed.description, known), seed.name).toBeNull()
    }
  })

  it('real 100-row tool results from v_profiles and v_web_events', async () => {
    for (const sql of ['SELECT * FROM v_profiles ORDER BY pkey LIMIT 100', 'SELECT * FROM v_web_events ORDER BY event_ts LIMIT 100']) {
      const result = await rows(sql)
      expect(result, sql).toHaveLength(100)
      expect(findPII(toolResult(result), known), sql).toBeNull()
      const asText = result.map((row) => Object.values(row).join(' ')).join('\n')
      expect(redactKnownNames(asText, known).count, sql).toBe(0)
    }
  })
})
