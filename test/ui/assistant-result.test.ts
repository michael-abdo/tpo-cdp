import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { FILTERS_HIDDEN_MESSAGE } from '../../src/filters-applied'
import { Result } from '../../src/pages/AssistantPage'
import type { AssistantResponse } from '../../src/types'

// The AI assistant page (06 §/assistant, 09 D-58): the answer block as the page renders it. The model
// writes filters_applied and the server passes it through unscreened (test/audit.test.ts), so this
// renders the page's own Result with React's server renderer and reads every character it would
// show, at both levels and in Technical details (<details> content is in the HTML even when closed).
// The response is the recorded answer to the brief's first question (46 = Instagram active
// went_cold_in 2026-08, 02 §Counts), as the server returns it; filters_applied is the model's
// output, test input like D-54's transport payloads. The SQL is the shape T-AI-5 discards from text.

const REAL = { status: ['active'], source: ['instagram'], window_from: '2026-08-01', window_to: '2026-08-31' }
const SQL = 'SELECT email_norm FROM subscribers'

function answer(filtersApplied: Record<string, unknown>): AssistantResponse {
  return {
    type: 'answer',
    text: '46 active Instagram signups went cold in August 2026.',
    table: null,
    segment: null,
    window: { from: '2026-08-01', to: '2026-08-31' },
    filters_applied: filtersApplied,
    definitions_used: ['went_cold_in', 'last_month'],
    partial: false,
    audit_id: crypto.randomUUID(),
  }
}

/** The rendered HTML, and its text with tags removed and entities decoded. */
function render(data: AssistantResponse): { html: string; text: string } {
  const html = renderToString(createElement(MemoryRouter, null, createElement(Result, { data })))
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
  return { html, text }
}

describe("/assistant renders the model's filters_applied only through the D-58 screen", () => {
  it('clean filters show in words under "How this answer was worked out" and as raw JSON in Technical details', () => {
    const { text } = render(answer(REAL))
    expect(text).toContain('Acquisition source')
    expect(text).toContain('Instagram')
    expect(text).toContain(JSON.stringify(REAL))
    expect(text).not.toContain(FILTERS_HIDDEN_MESSAGE)
  })

  const shapes: Array<[string, Record<string, unknown>]> = [
    ['a SELECT … FROM in a value', { ...REAL, query: SQL }],
    ['SQL as a key', { ...REAL, [SQL]: true }],
    ['SQL in a nested array', { ...REAL, steps: [['first', SQL]] }],
    ['a ```sql fence in a value', { ...REAL, note: '```sql\nSELECT email_norm FROM subscribers\n```' }],
  ]
  for (const [name, filters] of shapes) {
    it(`${name}: no model-written SQL reaches the page; the sentence in words stands in`, () => {
      const data = answer(filters)
      const { html, text } = render(data)
      for (const out of [html, text]) {
        expect(out, name).not.toContain('email_norm')
        expect(out, name).not.toContain('SELECT')
      }
      expect(text, name).not.toMatch(/\bselect\b/i)
      // Hidden whole: not even the clean filters beside the SQL are shown.
      expect(text, name).not.toContain('Acquisition source')
      expect(text, name).not.toContain('"window_from"')
      expect(text, name).toContain(FILTERS_HIDDEN_MESSAGE)
      // The rest of the answer still shows.
      expect(text, name).toContain(data.text)
    })
  }

  it('the known false positive (README Known gaps): the word select before the window_* keys hides the block', () => {
    const { text } = render(answer({ note: 'select readers', ...REAL }))
    expect(text).toContain(FILTERS_HIDDEN_MESSAGE)
    expect(text).not.toContain('Acquisition source')
  })

  it('hidden filters with no time period and no definitions still give the sentence, not "names no … filters"', () => {
    const data: AssistantResponse = { ...answer({ query: SQL }), window: null, definitions_used: [] }
    const { html, text } = render(data)
    expect(html).not.toContain('email_norm')
    expect(text).toContain(FILTERS_HIDDEN_MESSAGE)
    expect(text).not.toContain('The answer names no time period, filters or definitions.')
  })
})
