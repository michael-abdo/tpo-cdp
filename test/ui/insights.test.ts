import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { type ChartKind, pickChart } from '../../shared/pick-chart'
import { AnswerCard } from '../../src/insights/ask'
import { BoardGrid, TileActions } from '../../src/insights/board'
import { InsightChart } from '../../src/insights/charts'
import type { ChartResult, ChartSegment } from '../../src/insights/shapes'
import type { AssistantResponse, InsightTile } from '../../src/types'

// /insights (06 §/insights, 09 D-64) rendered with React's server renderer, the way
// test/ui/assistant-result.test.ts renders the answer card: the answer card offers "Pin to board",
// a built-in tile's options have no Remove, and every chart kind carries its numbers as text.
// Every number is from 02 §Counts and every row is a real one (09 D-47):
//   - 46 = Instagram active went_cold_in(2026-08), the brief's first question, as the aggregate tool
//     returns it with no grouping (number) and grouped by cold_month (one point in time: line);
//   - the web_events UTM values (instagram 667, facebook 496, google 393, referral 256, podcast 108,
//     twitter 50) as a query_sql count of page views by utm_source over v_web_events (bar);
//   - the two demo subjects' newsletter fields (table);
//   - the brief's R3 preset, 177 readers (segment).
// The built-in tile is the seeded "Readers at risk of going cold" row (migrations/0005_insights.sql);
// its result is given no rows, since the board's numbers for it are not stated in 02 §Counts.

const BRIEF_Q1 = 'how many Instagram signups went cold last month?'
const AUGUST = { kind: 'rolling', preset: 'last_month', from: '2026-08-01', to: '2026-08-31' } as const

/** The rendered HTML, and its text with tags removed and entities decoded. */
function render(element: ReactElement): { html: string; text: string } {
  const html = renderToString(createElement(MemoryRouter, null, element))
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
  return { html, text }
}

/** The text inside the result's <table> (the chart's text alternative). */
function tableText(html: string): string {
  const match = /<table[^>]*>[\s\S]*<\/table>/.exec(html)
  expect(match, 'a chart renders its numbers as a <table>').not.toBeNull()
  return (match?.[0] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
}

const NUMBER: ChartResult = { columns: ['went_cold'], rows: [{ went_cold: 46 }] }
const LINE: ChartResult = { columns: ['cold_month', 'went_cold'], rows: [{ cold_month: '2026-08', went_cold: 46 }] }
const UTM: Array<[string, number]> = [
  ['instagram', 667],
  ['facebook', 496],
  ['google', 393],
  ['referral', 256],
  ['podcast', 108],
  ['twitter', 50],
]
const BAR: ChartResult = { columns: ['utm_source', 'page_views'], rows: UTM.map(([utm_source, page_views]) => ({ utm_source, page_views })) }
const TABLE: ChartResult = {
  columns: ['email', 'source', 'signup_date', 'last_open_date'],
  rows: [
    { email: 'joy.hall830@protonmail.com', source: 'instagram', signup_date: '2026-09-02', last_open_date: '2026-09-22' },
    { email: 'julia.evans230@gmail.com', source: 'instagram', signup_date: '2026-09-13', last_open_date: '2026-09-15' },
  ],
}
const PRESET: ChartSegment = {
  count: 177,
  filters: { status: ['active'], source: ['instagram'], days_since_open_gte: 30, include_never_opened: true, has_app: null },
}

function chart(kind: ChartKind, result: ChartResult, segment: ChartSegment | null = null) {
  // The inputs are the shapes pickChart gives these kinds (T-INS-7 pins the rule table itself).
  expect(pickChart({ ...result, segment }), kind).toBe(kind)
  return render(createElement(InsightChart, { kind, result, segment, caption: BRIEF_Q1 }))
}

describe('every chart kind renders with a text alternative (06 §UI principles 7, 09 D-64)', () => {
  it('number: the big number and its label are text', () => {
    const { text } = chart('number', NUMBER)
    expect(text).toContain('46')
    expect(text).toContain('Went cold')
  })

  it('bar: the drawing is hidden from screen readers; a table holds every category and number', () => {
    const { html } = chart('bar', BAR)
    expect(html).toMatch(/<div aria-hidden="true">[\s\S]*<svg/)
    const table = tableText(html)
    expect(table).toContain('Campaign source')
    for (const [utm, n] of UTM) {
      expect(table).toContain(utm === 'twitter' ? 'twitter' : utm.charAt(0).toUpperCase() + utm.slice(1))
      expect(table).toContain(n.toLocaleString('en-US'))
    }
    expect(html).toContain('Show the numbers')
  })

  it('line: the drawing is hidden from screen readers; a table holds every point in words', () => {
    const { html } = chart('line', LINE)
    expect(html).toMatch(/<div aria-hidden="true">[\s\S]*<svg/)
    const table = tableText(html)
    expect(table).toContain('Month they went cold')
    expect(table).toContain('Aug 2026')
    expect(table).toContain('46')
  })

  it('table: the rows are the text, with plain column names', () => {
    const { text } = chart('table', TABLE)
    expect(text).toContain('joy.hall830@protonmail.com')
    expect(text).toContain('julia.evans230@gmail.com')
    expect(text).toContain('Signed up')
    expect(text).toContain('Sep 2, 2026')
  })

  it('segment: the count and "Open list" are text; no row is drawn', () => {
    const { html, text } = chart('segment', { columns: [], rows: [] }, PRESET)
    expect(text).toContain('177 readers match')
    expect(text).toContain('Open list')
    expect(html).not.toContain('<table')
  })
})

describe('the answer card offers "Pin to board" (06 §/insights)', () => {
  it('the recorded answer to the brief\'s first question has the Pin button, which opens a dialog', () => {
    const data: AssistantResponse = {
      type: 'answer',
      text: '46 active Instagram signups went cold in August 2026.',
      table: null,
      segment: null,
      window: { from: '2026-08-01', to: '2026-08-31' },
      filters_applied: { status: ['active'], source: ['instagram'], window_from: '2026-08-01', window_to: '2026-08-31' },
      definitions_used: ['went_cold_in', 'last_month'],
      partial: false,
      audit_id: crypto.randomUUID(),
    }
    const { html, text } = render(createElement(AnswerCard, { data, question: BRIEF_Q1, onPinned: () => {} }))
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>[\s\S]*?Pin to board/)
    // The dialog's window choice: Aug 1–31 is last month on TODAY, so both kinds are offered.
    expect(text).toContain('Rolling: last month')
    expect(text).toContain('Fixed: Aug 1–31, 2026')
  })
})

const pinned: InsightTile = {
  id: crypto.randomUUID(),
  title: BRIEF_Q1,
  prompt: BRIEF_Q1,
  tool: 'aggregate',
  built_in: false,
  sort_order: 50,
  window: AUGUST,
  chart: 'number',
  chart_override: null,
  result: { ...NUMBER, summary: {} },
  segment: null,
  status: 'ok',
  error: null,
  ran_at: '2026-10-14T12:00:00.000Z',
  explain: BRIEF_Q1,
  params: { metric: 'went_cold', status: ['active'], source: ['instagram'], window: { rolling: 'last_month' } },
  sql: null,
}

const builtIn: InsightTile = {
  ...pinned,
  id: 'builtin-going-cold',
  title: 'Readers at risk of going cold',
  prompt: null,
  tool: 'insight_panel',
  built_in: true,
  sort_order: 30,
  window: null,
  chart: 'table',
  result: { columns: ['source', 'rate', 'at_risk', 'active'], rows: [], summary: { panel: 'going-cold' } },
  params: { panel: 'going-cold' },
}

function actions(tile: InsightTile) {
  return render(createElement(TileActions, { tile, above: null, below: null, onChanged: () => {}, onRemoved: () => {}, onExplain: () => {} }))
}

describe('tile options (06 §/insights tile menu)', () => {
  it('a built-in tile has no Remove; it can still be renamed, moved and explained', () => {
    const { text } = actions(builtIn)
    expect(text).not.toContain('Remove')
    expect(text).toContain('Rename')
    expect(text).toContain('Explain this')
    expect(text).toContain('Move down')
    expect(text).not.toContain('Change window')
  })

  it('a pinned tile with a window has Remove and Change window', () => {
    const { text } = actions(pinned)
    expect(text).toContain('Remove')
    expect(text).toContain('Change window')
  })

  it('a tile shows its window in words and "Updated just now"', () => {
    const { text } = render(createElement(BoardGrid, { tiles: [builtIn, pinned], onChanged: () => {}, onRemoved: () => {}, onExplain: () => {} }))
    expect(text).toContain('Last month · Aug 1–31, 2026')
    expect(text).toContain('Updated just now')
    expect(text).toContain('46')
    // sort_order 30 before 50.
    expect(text.indexOf('Readers at risk of going cold')).toBeLessThan(text.indexOf(BRIEF_Q1))
  })
})
