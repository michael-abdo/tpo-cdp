import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { TOOL_SEEDS, toolSeedInsert } from '../scripts/tool-seeds'
import { pinNext, SEGMENT_PIN_NOTE } from '../src/insights/pin-words'
import { CHECK_LABEL, COLUMN_LABEL, DEFINITION_LABEL, FILTER_LABEL } from '../src/labels'
import { discardSentence } from '../worker/assistant/respond'
import { viewSchemas } from '../worker/assistant/schema-context'
import { renderSystemPrompt } from '../worker/assistant/system-prompt'
import {
  BLOCKED_TILE_TITLE,
  INSIGHT_PANELS,
  NOT_PINNABLE_MESSAGE,
  NOT_PINNABLE_OTHER_MESSAGE,
  PIN_FAILED_MESSAGE,
  TILE_RUN_FAILED_MESSAGE,
} from '../worker/insights/board'
import { documentationIp, loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'
import { navArrayText, retiredIn } from './helpers/vocabulary'

// T-VOC-1 (08; 09 D-66, 06 §Vocabulary) for the Insights work: every word /insights, its board, its
// pin dialog and its server sentences can put on screen or hand to Ask is the brief's own. Scope:
// the files this work owns or changes (src/insights/, the Insights and audit pages, the nav, the
// labels, the CSV name, the board and panel sentences, the assistant's fallback sentence and system
// prompt). The pages it does not change (Look up, Segments, Overview, App events), the glossary and
// the README are the full T-VOC-1 scan's (test/vocabulary.test.ts on the main line, 09 D-66).
// Inputs: the real seeded board (data/*.csv, scripts/tool-seeds.ts) as GET /api/insights sends it,
// the server's own sentences, the label maps, and the source text of the page's components with
// comments removed (their JSX text and literals; test/ui/ renders them). No network.

function offences(where: string, texts: readonly string[]): string[] {
  return texts.flatMap((text) =>
    retiredIn(text).map((name) => `${where}: ${name} in "${text.trim().slice(0, 160)}"`),
  )
}

/** Source text without its comments (block comments, and // comments at a line start or after a space). */
function withoutComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
}

const SOURCES = import.meta.glob(
  [
    '../src/insights/*.{ts,tsx}',
    '../src/pages/InsightsPage.tsx',
    '../src/pages/AuditPage.tsx',
    '../src/App.tsx',
    '../src/nav.ts',
    '../src/api.ts',
    '../src/labels.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

let cookie: string

beforeAll(async () => {
  await seedDatabase()
  for (const seed of TOOL_SEEDS) {
    const { sql, params } = toolSeedInsert(seed)
    await env.DB.prepare(sql)
      .bind(...params)
      .run()
  }
  cookie = await loginCookie(documentationIp())
})

describe("T-VOC-1 for /insights: the brief's words (09 D-66, 06 §Vocabulary)", () => {
  it('the guard flags each retired term and lets the brief\'s question and "screen reader" through', () => {
    expect(retiredIn('Cold readers')).toEqual(['reader(s)'])
    expect(retiredIn('Find a reader')).toEqual(['reader(s)', 'Find a reader'])
    expect(retiredIn('Built a list of readers')).toEqual(['reader(s)', 'Build a list'])
    expect(retiredIn('How many app users have an email that is not on the newsletter list?')).toEqual([
      'Newsletter list',
      'App users',
    ])
    expect(retiredIn('build me a list of our most engaged readers')).toEqual([])
    expect(retiredIn('so screen readers hear each change')).toEqual([])
    expect(
      withoutComments(
        "// the reader presses Ask\nconst a = 'https://x' // a reader\n/* readers */ const b = 1",
      ),
    ).not.toMatch(/reader/)
  })

  it('no word of the source of the Insights page, its board, the audit page, the nav or the labels is retired', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(12)
    expect(
      Object.entries(SOURCES).flatMap(([path, code]) => offences(path, withoutComments(code).split('\n'))),
    ).toEqual([])
  })

  it("the board as the server sends it, and every question it hands to Ask, uses the brief's words", async () => {
    const res = await SELF.fetch('http://cdp.test/api/insights', { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = await res.text()
    const { tiles } = JSON.parse(body) as { tiles: Array<{ built_in: boolean; status: string }> }
    expect(tiles.filter((t) => t.built_in && t.status === 'ok')).toHaveLength(4)
    expect(offences('GET /api/insights', [body])).toEqual([])
    for (const panel of INSIGHT_PANELS) {
      const panelRes = await SELF.fetch(`http://cdp.test/api/insights/${panel}`, { headers: { cookie } })
      expect(panelRes.status).toBe(200)
      expect(offences(panel, [await panelRes.text()])).toEqual([])
    }
  })

  it("the server's sentences, the pin dialog's words and the system prompt use the brief's words", async () => {
    const sentences = [
      NOT_PINNABLE_MESSAGE,
      NOT_PINNABLE_OTHER_MESSAGE,
      PIN_FAILED_MESSAGE,
      TILE_RUN_FAILED_MESSAGE,
      BLOCKED_TILE_TITLE,
      SEGMENT_PIN_NOTE,
      ...['nothing_to_pin', 'not_found', 'invalid_pin', 'not_pinnable', 'internal_error'].map(
        (code) => pinNext(code) ?? '',
      ),
      discardSentence('segment', 177),
      discardSentence('segment', 1),
      discardSentence('table', null),
      discardSentence('answer', null),
      renderSystemPrompt(await viewSchemas(env.DB)),
    ]
    expect(discardSentence('segment', 177)).toBe('177 subscribers match.')
    expect(offences('server', sentences)).toEqual([])
  })

  it("every label a result or a filter shows is the brief's: no retired word, the 06 field names", () => {
    const labels = [
      ...Object.values(COLUMN_LABEL),
      ...Object.values(FILTER_LABEL),
      ...Object.values(CHECK_LABEL),
      ...Object.values(DEFINITION_LABEL),
    ]
    expect(offences('labels', labels)).toEqual([])
    // 06 §Vocabulary subscriber fields (email, signup date, status, acquisition source, last open date) and web field UTM source.
    expect({
      email: COLUMN_LABEL.email,
      signup_date: COLUMN_LABEL.signup_date,
      status: COLUMN_LABEL.status,
      source: COLUMN_LABEL.source,
      last_open_date: COLUMN_LABEL.last_open_date,
      utm_source: COLUMN_LABEL.utm_source,
      filter_source: FILTER_LABEL.source,
    }).toEqual({
      email: 'Email',
      signup_date: 'Signup date',
      status: 'Status',
      source: 'Acquisition source',
      last_open_date: 'Last open date',
      utm_source: 'UTM source',
      filter_source: 'Acquisition source',
    })
  })

  it('nav labels are the 06 words; "Insights" stays the operator\'s name for the page (09 D-64, 09 D-71)', () => {
    const nav = navArrayText(SOURCES['../src/nav.ts'])
    expect([...nav.matchAll(/label: '([^']+)'/g)].map((m) => m[1])).toEqual([
      'Overview',
      'Look up',
      'Segments',
      'Insights',
      'Techy',
      'App events',
      'AI audit log',
    ])
  })
})
