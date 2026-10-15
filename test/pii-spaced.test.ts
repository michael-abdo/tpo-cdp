import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import webCsv from '../data/web_events.csv?raw'
import { TOOL_SEEDS } from '../scripts/tool-seeds'
import { HOSTED_URL } from '../shared/config'
import { BRIEF_QUESTIONS } from '../src/insights/questions'
import { startTrace } from '../worker/assistant/audit/ai-audit'
import { buildModelRequest, type ModelTool } from '../worker/assistant/build-request'
import { enforceGate1 } from '../worker/assistant/gates/gate1-input-sanitizer'
import { assertNoPII, findPII, KnownEmails, loadKnownEmails, PiiBlockedError, redactKnownLocalParts } from '../worker/assistant/gates/pii-guard'
import { type ViewSchema, viewSchemas } from '../worker/assistant/schema-context'
import { renderSystemPrompt } from '../worker/assistant/system-prompt'
import type { ResultRow } from '../worker/assistant/tools/builtin-handlers'
import { formatToolOutput, frameToolResult } from '../worker/assistant/tools/format-results'
import { parseCsv } from '../worker/ingest/csv'
import { seedDatabase } from './helpers/seed'

// A known email's local part typed as words with spaces where its dots were ("julia evans 230",
// "Joy Hall830"): Gate 1 redacts it to [email] as it does the local part typed plainly, and the
// outbound scanner reports it as known_local_part in a model request, a tool result and a model
// answer. Ordinary prose, page paths, story slugs, the system prompt and real tool results with
// dates and numbers stay clean.
//
// Inputs, all real:
// - julia.evans230@gmail.com (subscribers.csv:373) and joy.hall830@protonmail.com
//   (subscribers.csv:902), the two people the other PII tests use, with only the dots changed to
//   spaces and the case changed.
// - The near misses change one digit or add one letter or digit to those values.
// - Every page path in web_events.csv, the brief's story slug, the brief's three questions and
//   ordinary questions a Growth teammate asks.
// - Tool results are rows read from the v_* views of the seeded database; a "planted" row puts a
//   spaced local part in place of one field of julia's own row.

const JULIA = 'julia.evans230@gmail.com'
const JULIA_LOCAL = 'julia.evans230'

/** Each spelling is a real local part with spaces in place of its dot or before its digits. */
const SPACED = [
  'julia evans230',
  'julia evans 230',
  'JULIA EVANS 230',
  'julia.evans 230',
  'Joy Hall830',
  'joy hall 830',
  'joy  hall 830',
  'joy hall\t830',
]

const QUESTIONS = [
  ...BRIEF_QUESTIONS,
  'show signups from 2026 08 29',
  'top 10 sources in 2026',
  'how did Julia Evans find us?',
  'how many readers opened in the last 30 days, and how many of them have the app?',
  'compare signups on 2026 09 28 with 2026 09 21 by source',
]

let known: KnownEmails
let views: readonly ViewSchema[]
let juliaPkey: string

async function rows(sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results
}

function realPages(): string[] {
  const csv = parseCsv(webCsv)
  return [...new Set(csv.rows.map((r) => r[csv.header.indexOf('page')]!.trim()))]
}

/** A tool result as the executor guards it: the framed text the model reads plus the full rows. */
function toolResult(sourceRows: Record<string, unknown>[]): { content: string; rows: Record<string, unknown>[] } {
  const columns = Object.keys(sourceRows[0] ?? {})
  const content = formatToolOutput({
    tool: 'query_sql',
    columns,
    // D1 rows hold only strings, numbers and nulls.
    rows: sourceRows as ResultRow[],
    total_rows: sourceRows.length,
    summary: { total_rows: sourceRows.length },
  })
  return { content, rows: sourceRows }
}

const TOOLS: ModelTool[] = TOOL_SEEDS.map((seed) => ({ name: seed.name, description: seed.description, input_schema: seed.inputSchema as ModelTool['input_schema'] }))

beforeAll(async () => {
  await seedDatabase()
  known = await loadKnownEmails(env.DB)
  views = await viewSchemas(env.DB)
  const pkey = await env.DB.prepare('SELECT pkey FROM profiles WHERE email_norm = ?').bind(JULIA).first<string>('pkey')
  if (pkey === null) throw new Error('no profile for julia')
  juliaPkey = pkey
})

describe('a known local part typed as words with spaces between them', () => {
  it('Gate 1 redacts every spaced form to [email], exactly as it does the local part typed plainly', async () => {
    const plain = await enforceGate1(await startTrace(env.DB), `how engaged is ${JULIA_LOCAL}?`)
    expect(plain.text).toBe('how engaged is [email]?')
    expect(plain.emailsRedacted).toBe(1)
    for (const typed of SPACED) {
      const question = await enforceGate1(await startTrace(env.DB), `how engaged is ${typed}?`)
      expect(question.text, typed).toBe(plain.text)
      expect(question.emailsRedacted, typed).toBe(plain.emailsRedacted)
    }
  })

  it('Gate 1 keeps everything around the words as typed, sentence punctuation included', async () => {
    const cases: Array<[string, string, number]> = [
      ['compare julia evans 230 and Joy Hall830 by source', 'compare [email] and [email] by source', 2],
      ['Joy Hall 830, then the rest', '[email], then the rest', 1],
      ['(julia evans230)', '([email])', 1],
      ['is it julia evans 230.', 'is it [email].', 1],
      ['how engaged is julia\nevans 230', 'how engaged is [email]', 1],
    ]
    for (const [typed, redacted, count] of cases) {
      const question = await enforceGate1(await startTrace(env.DB), typed)
      expect(question.text, typed).toBe(redacted)
      expect(question.emailsRedacted, typed).toBe(count)
    }
  })

  it('the scanner reports known_local_part in a model request, a tool result and a model answer', async () => {
    const [profile] = await rows('SELECT * FROM v_profiles WHERE pkey = ?', juliaPkey)
    for (const typed of SPACED) {
      const request = { messages: [{ role: 'user', content: `how engaged is ${typed}?` }] }
      const planted = toolResult([{ ...profile, first_page: typed }])
      const answer = [{ type: 'text', text: `The most engaged reader is ${typed}.` }]
      expect(findPII(request, known), typed).toBe('known_local_part')
      expect(findPII(planted, known), typed).toBe('known_local_part')
      expect(findPII(frameToolResult('query_sql', typed), known), typed).toBe('known_local_part')
      expect(findPII(answer, known), typed).toBe('known_local_part')
      expect(() => assertNoPII(answer, known, 'model_output'), typed).toThrow(PiiBlockedError)
    }
    // A real newline inside a string value is only whitespace to the per-value pass.
    expect(findPII({ text: 'julia\nevans 230' }, known)).toBe('known_local_part')
  })

  it('stays clean: near misses, which only a whole-word, letter-for-letter match could catch', () => {
    for (const text of [
      'how did Julia Evans find us?',
      'julia evans 2300',
      'julia evans 23',
      'julia evans2301',
      'xjulia evans230',
      'julia evans230x',
      'joy hall 831',
      'Joy Hall opened 830 newsletters',
    ]) {
      expect(findPII(text, known), text).toBeNull()
      expect(redactKnownLocalParts(text, known), text).toEqual({ text, count: 0 })
    }
  })

  it('stays clean: every real page path as a path, a URL, a slug and as plain words, and the brief\'s story slug', () => {
    const pages = realPages()
    expect(pages.length).toBeGreaterThan(10)
    const slug = 'supreme-court-ruling-explained'
    for (const text of [
      ...pages,
      ...pages.map((page) => `${HOSTED_URL}${page}`),
      ...pages.map((page) => page.slice(1).replaceAll('/', '-')),
      ...pages.map((page) => page.replace(/[/-]+/g, ' ').trim()),
      slug,
      slug.replaceAll('-', ' '),
    ]) {
      expect(findPII(text, known), text).toBeNull()
      expect(redactKnownLocalParts(text, known), text).toEqual({ text, count: 0 })
    }
  })

  it('stays clean: the brief\'s three questions and other ordinary questions, through Gate 1 and in the whole model request', async () => {
    for (const asked of QUESTIONS) {
      const question = await enforceGate1(await startTrace(env.DB), asked)
      expect(question.text, asked).toBe(asked)
      expect(question.emailsRedacted, asked).toBe(0)
      // The request holds the system prompt and every seeded tool definition too.
      expect(findPII(buildModelRequest({ views, tools: TOOLS, question, rounds: [] }), known), asked).toBeNull()
    }
    expect(findPII(renderSystemPrompt(views), known)).toBeNull()
  })

  it('stays clean: real tool results full of dates, numbers, sources and pages', async () => {
    for (const sql of [
      'SELECT * FROM v_profiles ORDER BY pkey LIMIT 100',
      'SELECT * FROM v_web_events ORDER BY event_ts LIMIT 100',
      'SELECT source, status, COUNT(*) AS subscribers FROM v_profiles GROUP BY source, status',
    ]) {
      const result = await rows(sql)
      expect(result.length, sql).toBeGreaterThan(0)
      expect(findPII(toolResult(result), known), sql).toBeNull()
      // The same rows as plain text, cells joined by spaces, so numbers and words sit side by side.
      const asText = result.map((row) => Object.values(row).join(' ')).join('\n')
      expect(findPII(asText, known), sql).toBeNull()
    }
  })
})
