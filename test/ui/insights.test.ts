/// <reference types="vite/client" />
import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import webCsv from '../../data/web_events.csv?raw'
import { BAR_TOP_CATEGORIES, type ChartKind, pickChart } from '../../shared/pick-chart'
import { AnswerCard } from '../../src/insights/ask'
import { pinBody, pinNext } from '../../src/insights/pin-words'
import { BoardGrid, TileActions } from '../../src/insights/board'
import { cellText } from '../../src/insights/cells'
import { ownDatesText } from '../../src/insights/windows'
import { InsightChart } from '../../src/insights/charts'
import type { ChartResult, ChartSegment } from '../../src/insights/shapes'
import type { AssistantResponse, InsightTile } from '../../src/types'
import { parseCsv } from '../../worker/ingest/csv'
import { NOT_PINNABLE_MESSAGE, NOT_PINNABLE_SHAPE_MESSAGE } from '../../shared/insight-messages'

// /insights rendered with React's server renderer, the way
// test/ui/assistant-result.test.ts renders the answer card: the answer card offers "Pin to board",
// a built-in tile's options have no Remove, and every chart kind carries its numbers as text.
// Every number is the seed's and every row is a real one:
//   - 46 = Instagram active went_cold_in(2026-08), the brief's first question, as the aggregate tool
//     returns it with no grouping (number) and grouped by cold_month (one point in time: line);
//   - the web_events UTM values (instagram 667, facebook 496, google 393, referral 256, podcast 108,
//     twitter 50) as a query_sql count of page views by utm_source over v_web_events (bar);
//   - page views by page and campaign source over data/web_events.csv, counted here from the real
//     rows (104 pairs: more than BAR_TOP_CATEGORIES, so the "Other" bar is drawn);
//   - the two demo subjects' newsletter fields, without their emails (table);
//   - the brief's R3 preset, 177 subscribers (segment).
// The built-in tile is the seeded "Subscribers at risk of going cold" row (migrations/0006_insights.sql);
// its result is given no rows, since this test does not pin the board's numbers for it.

const BRIEF_Q1 = 'how many Instagram signups went cold last month?'
const AUGUST = { kind: 'rolling', preset: 'last_month', from: '2026-08-01', to: '2026-08-31' } as const

/** The rendered HTML, and its text with tags removed and entities decoded. */
function render(element: ReactElement): { html: string; text: string } {
  const html = renderToString(createElement(MemoryRouter, null, element))
  const text = html
    .replace(/<!-- -->/g, '') // React's marker between adjacent text nodes, not a break in the text
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
// The table shape a tool returns for subjects never carries an email (the scanner refuses it):
// the demo subjects' newsletter fields, keyed by nothing that names them.
const TABLE: ChartResult = {
  columns: ['source', 'signup_date', 'last_open_date', 'status'],
  rows: [
    { source: 'instagram', signup_date: '2026-09-02', last_open_date: '2026-09-22', status: 'active' },
    { source: 'instagram', signup_date: '2026-09-13', last_open_date: '2026-09-15', status: 'active' },
  ],
}

/** Page views by `page from <utm_source>` over the real web_events.csv rows. */
function pageViewsByEntry(): ChartResult {
  const { header, rows } = parseCsv(webCsv)
  const page = header.indexOf('page')
  const utm = header.indexOf('utm_source')
  const counts = new Map<string, number>()
  for (const r of rows) {
    const entry = `${r[page]} from ${r[utm] === '' ? 'no campaign' : r[utm]}`
    counts.set(entry, (counts.get(entry) ?? 0) + 1)
  }
  return { columns: ['entry', 'page_views'], rows: [...counts].map(([entry, page_views]) => ({ entry, page_views })) }
}

/** The labels of the drawn bars, in drawing order (the aria-hidden chart, not the numbers table). */
function drawnLabels(html: string): string[] {
  const drawing = /<ol[^>]*data-bars=""[^>]*>([\s\S]*?)<\/ol>/.exec(html)
  expect(drawing, 'a bar chart draws an <ol> of bars').not.toBeNull()
  return [...(drawing?.[1] ?? '').matchAll(/data-bar-label="">([^<]*)</g)].map((m) => m[1].replace(/&amp;/g, '&'))
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

describe('every chart kind renders with a text alternative', () => {
  it('number: the big number and its label are text', () => {
    const { text } = chart('number', NUMBER)
    expect(text).toContain('46')
    expect(text).toContain('Went cold')
  })

  it('bar: the drawing is hidden from screen readers; a table holds every category and number', () => {
    const { html } = chart('bar', BAR)
    expect(html).toMatch(/<div aria-hidden="true">[\s\S]*<svg/)
    const table = tableText(html)
    expect(table).toContain('UTM source')
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
    expect(text).toContain('Instagram')
    expect(text).toContain('Signup date')
    expect(text).toContain('Sep 2, 2026')
  })

  it('segment: the count, its filters in words and "Open segment" are text; no row is drawn', () => {
    const { html, text } = chart('segment', { columns: [], rows: [] }, PRESET)
    expect(text).toContain('177 subscribers match')
    // The filters in the words of src/filters-applied.ts (one home); has_app null ("any") is not listed.
    expect(text).toContain("Status: Active · Acquisition source: Instagram · Haven't opened an email in at least: 30 days · Also includes people who never opened: Yes")
    expect(text).not.toContain('Uses the app')
    expect(text).toContain('Open segment')
    expect(text).not.toMatch(/reader|Open list/i)
    expect(html).not.toContain('<table')
  })
})

describe('bars are sorted largest first, top 20 + "Other"', () => {
  it('rows in any order are drawn largest first; the numbers table keeps the rows as returned', () => {
    // The real UTM counts, smallest first: the order a GROUP BY without ORDER BY may return.
    const ascending: ChartResult = { columns: BAR.columns, rows: [...BAR.rows].reverse() }
    const { html } = chart('bar', ascending)
    expect(drawnLabels(html)).toEqual(['Instagram', 'Facebook', 'Google', 'Referral', 'Podcast', 'twitter'])
    const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? ''
    expect(body.indexOf('>twitter<')).toBeGreaterThan(-1)
    expect(body.indexOf('>twitter<')).toBeLessThan(body.indexOf('>Instagram<'))
  })

  it(`more than ${BAR_TOP_CATEGORIES} categories: ${BAR_TOP_CATEGORIES} bars, then one "Other (N more)" bar with their sum`, () => {
    const result = pageViewsByEntry()
    expect(result.rows.length).toBeGreaterThan(BAR_TOP_CATEGORIES)
    const { html } = chart('bar', result)
    const labels = drawnLabels(html)
    // Largest first; equal counts in label order, as the chart breaks ties.
    const sorted = [...result.rows].sort((a, b) => (b.page_views as number) - (a.page_views as number) || String(a.entry).localeCompare(String(b.entry)))
    const rest = sorted.slice(BAR_TOP_CATEGORIES)
    expect(labels).toHaveLength(BAR_TOP_CATEGORIES + 1)
    expect(labels.slice(0, BAR_TOP_CATEGORIES)).toEqual(sorted.slice(0, BAR_TOP_CATEGORIES).map((r) => cellText('entry', r.entry)))
    expect(labels[BAR_TOP_CATEGORIES]).toBe(`Other (${rest.length.toLocaleString('en-US')} more)`)
    const otherSum = rest.reduce((sum, r) => sum + (r.page_views as number), 0)
    expect(html).toContain(`>${otherSum.toLocaleString('en-US')}<`)
  })

  it('a zero row draws no bar and is counted under the chart; it stays in the numbers table', () => {
    // The real UTM counts with a sixth row edited to 0 (an edited copy of a real result).
    const withZero: ChartResult = { columns: BAR.columns, rows: BAR.rows.map((r) => (r.utm_source === 'twitter' ? { ...r, page_views: 0 } : r)) }
    const { html, text } = chart('bar', withZero)
    expect(drawnLabels(html)).not.toContain('twitter')
    expect(text).toContain('Not drawn: 1 at 0.')
    expect(tableText(html)).toContain('twitter')
  })
})

describe('the answer card offers "Pin to board"', () => {
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
      pin_window: { from: '2026-08-01', to: '2026-08-31' },
      pin_own_dates: null,
      pin_refusal: null,
    }
    const { html, text } = render(createElement(AnswerCard, { data, question: BRIEF_Q1, onPinned: () => {} }))
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>[\s\S]*?Pin to board/)
    // The dialog's window choice: Aug 1–31 is last month on TODAY, so both kinds are offered.
    expect(text).toContain('Rolling: last month')
    expect(text).toContain('Fixed: Aug 1–31, 2026')
  })

  it('a segment answer names no dates in the dialog, even when the model’s answer gave a window', () => {
    // The recorded segment answer to "build me a list of our most engaged readers": the model named
    // a 30-day window in its answer, but the segment's filters carry no dates, so the server reports
    // pin_window and pin_own_dates null and its tile says "As of".
    const data: AssistantResponse = {
      type: 'segment',
      text: 'Here are your most engaged active readers.',
      table: null,
      segment: { count: 177, filters: PRESET.filters },
      window: { from: '2026-08-29', to: '2026-09-28' },
      filters_applied: { status: ['active'] },
      definitions_used: ['engagement_score'],
      partial: false,
      audit_id: crypto.randomUUID(),
      pin_window: null,
      pin_own_dates: null,
      pin_refusal: null,
    }
    const { html, text } = render(createElement(AnswerCard, { data, question: 'build me a list of our most engaged readers', onPinned: () => {} }))
    // The dialog says what the tile keeps of a segment, and what it does not.
    expect(text).toContain('The tile keeps how many subscribers match these filters and a link to the segment. It does not keep their order or names.')
    expect(html).not.toContain('type="radio"')
    expect(html).not.toContain('<fieldset')
    expect(text).not.toContain('Time period:')
    expect(text).not.toContain('Set by this question')
  })

  it('a lookup that sets its own dates: the dialog and the tile footer name the same dates in the same words', () => {
    // The recorded answer to "which pages do new subscribers hit first?" (the query row;
    // new_subscriber = TODAY − 30 .. TODAY); the dialog is what is under test, so the table is left out.
    const dates = { from: '2026-08-29', to: '2026-09-28' }
    const data: AssistantResponse = {
      type: 'answer',
      text: 'Most new subscribers first landed on the home page.',
      table: null,
      segment: null,
      window: dates,
      filters_applied: {},
      definitions_used: ['new_subscriber'],
      partial: false,
      audit_id: crypto.randomUUID(),
      pin_window: null,
      pin_own_dates: dates,
      pin_refusal: null,
    }
    const words = ownDatesText(dates)
    expect(words).toBe('Set by this question · Aug 29 – Sep 28, 2026')
    const dialog = render(createElement(AnswerCard, { data, question: 'which pages do new subscribers hit first?', onPinned: () => {} }))
    expect(dialog.html).not.toContain('type="radio"')
    expect(dialog.text).toContain(`Time period: ${words}`)
    const tile: InsightTile = { ...pinned, tool: 'pages_new_subscribers_hit_first', window: null, own_dates: dates, chart: 'bar', result: { ...BAR, summary: {} }, params: {} }
    const footer = render(createElement(BoardGrid, { tiles: [tile], onChanged: () => {}, onRemoved: () => {}, onExplain: () => {} }))
    expect(footer.text).toContain(words)
    expect(footer.text).not.toContain('As of')
  })

  it('a stale answer (the Ask bar holds another question) says so in words, with no lowered opacity', () => {
    const data: AssistantResponse = {
      type: 'answer',
      text: '46 active Instagram signups went cold in August 2026.',
      table: null,
      segment: null,
      window: { from: '2026-08-01', to: '2026-08-31' },
      filters_applied: {},
      definitions_used: ['went_cold_in'],
      partial: false,
      audit_id: crypto.randomUUID(),
      pin_window: { from: '2026-08-01', to: '2026-08-31' },
      pin_own_dates: null,
      pin_refusal: null,
    }
    const { html, text } = render(createElement(AnswerCard, { data, question: BRIEF_Q1, onPinned: () => {}, stale: true }))
    const section = /<section[^>]*>/.exec(html)?.[0] ?? ''
    expect(section).toContain('data-stale')
    // The card's own classes: no opacity, which lowered every text and control under 4.5:1 (axe).
    expect(section).not.toContain('opacity')
    expect(text).toContain('Earlier question')
    expect(text).toContain(`This answer is for your earlier question: “${BRIEF_Q1}”.`)
    const fresh = render(createElement(AnswerCard, { data, question: BRIEF_Q1, onPinned: () => {} }))
    expect(/<section[^>]*>/.exec(fresh.html)?.[0]).not.toContain('data-stale')
  })
})

describe('answers and tiles that cannot be pinned or run say so in plain words', () => {
  it('an answer from free-form SQL has no Pin button; the card says why in the not-pinnable sentence', () => {
    // The server's sentence (one home, shared/insight-messages.ts), as POST /api/assistant returns it.
    const sentence = NOT_PINNABLE_MESSAGE
    const data: AssistantResponse = {
      type: 'answer',
      text: '46 active Instagram signups went cold in Aug 1–31, 2026.',
      table: null,
      segment: null,
      window: { from: '2026-08-01', to: '2026-08-31' },
      filters_applied: {},
      definitions_used: ['went_cold_in'],
      partial: false,
      audit_id: crypto.randomUUID(),
      pin_window: null,
      pin_own_dates: null,
      pin_refusal: sentence,
    }
    const { html, text } = render(createElement(AnswerCard, { data, question: BRIEF_Q1, onPinned: () => {} }))
    expect(text).toContain(sentence)
    // The gated "Ask a follow-up" controls open the "Coming soon" pop-up (aria-disabled); no other dialog opener.
    expect(html).not.toMatch(/<button(?![^>]*aria-disabled)[^>]*aria-haspopup="dialog"/)
    expect(html).not.toContain('<dialog')
    expect(text).not.toContain('Pin to board')
    expect(text).not.toContain('Request approval')
  })

  it('a query_sql answer that fails the pin grammar has no Pin button; the card says why, with no approval-queue wording', () => {
    const data: AssistantResponse = {
      type: 'answer',
      text: 'Here is the table you asked for.',
      table: { columns: ['source', 'n'], rows: [{ source: 'instagram', n: 10 }] },
      segment: null,
      window: null,
      filters_applied: {},
      definitions_used: [],
      partial: false,
      audit_id: crypto.randomUUID(),
      pin_window: null,
      pin_own_dates: null,
      pin_refusal: NOT_PINNABLE_SHAPE_MESSAGE,
    }
    const { html, text } = render(createElement(AnswerCard, { data, question: BRIEF_Q1, onPinned: () => {} }))
    // The gated "Ask a follow-up" controls open the "Coming soon" pop-up (aria-disabled); no other dialog opener.
    expect(html).not.toMatch(/<button(?![^>]*aria-disabled)[^>]*aria-haspopup="dialog"/)
    expect(text).not.toContain('Pin to board')
    expect(text).not.toContain('Request approval')
    expect(text).not.toContain('approval')
    expect(text).not.toContain('sent')
    expect(text).toContain(NOT_PINNABLE_SHAPE_MESSAGE)
  })

  it('a pin error has a next step for invalid_pin, not_pinnable and internal_error', () => {
    for (const code of ['invalid_pin', 'not_pinnable', 'internal_error', 'nothing_to_pin', 'not_found']) {
      expect(pinNext(code), code).toMatch(/\S/)
      expect(pinNext(code), code).not.toMatch(/reader/i)
    }
    expect(pinNext('blocked_pii')).toBeUndefined()
  })

  it('a tile whose query failed shows the plain sentence at level 1; the raw text only in Technical details', () => {
    const failed: InsightTile = {
      ...pinned,
      tool: 'pages_new_subscribers_hit_first',
      window: null,
      status: 'error',
      result: null,
      error: 'This tile could not run right now. Press Refresh to try again.',
      error_details: 'integer overflow',
      params: {},
    }
    const level1 = render(createElement(BoardGrid, { tiles: [failed], onChanged: () => {}, onRemoved: () => {}, onExplain: () => {} }))
    expect(level1.text).toContain('This tile could not run right now. Press Refresh to try again.')
    // Said once: the sentence carries its own next step.
    expect(level1.text.split('Press Refresh to try again.')).toHaveLength(2)
    expect(level1.text).not.toContain('integer overflow')
    const options = actions(failed)
    expect(options.text).toMatch(/Technical details.*Why it did not run: integer overflow/)
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
  own_dates: null,
  chart: 'number',
  chart_override: null,
  result: { ...NUMBER, summary: {} },
  segment: null,
  status: 'ok',
  error: null,
  error_details: null,
  ran_at: '2026-10-14T12:00:00.000Z',
  explain: BRIEF_Q1,
  params: { metric: 'went_cold', status: ['active'], source: ['instagram'], window: { rolling: 'last_month' } },
  sql: null,
}

const builtIn: InsightTile = {
  ...pinned,
  id: 'builtin-going-cold',
  title: 'Subscribers at risk of going cold',
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
  return render(createElement(TileActions, { tile, above: null, below: null, onChanged: () => {}, onRemoved: () => {}, onExplain: () => {}, onClose: () => {} }))
}

describe('tile options (the tile menu)', () => {
  it('a built-in tile has no Remove; it can still be renamed, moved and explained', () => {
    const { text } = actions(builtIn)
    expect(text).not.toContain('Remove')
    expect(text).toContain('Rename')
    expect(text).toContain('Explain this')
    expect(text).toContain('Move down')
    expect(text).not.toContain('Change time period')
  })

  it('a pinned tile with a window has Remove and Change time period', () => {
    const { text } = actions(pinned)
    expect(text).toContain('Remove')
    expect(text).toContain('Change time period')
  })

  it('the time period form names the dates each preset covers today', () => {
    const { text } = render(
      createElement(TileActions, { tile: pinned, above: null, below: null, onChanged: () => {}, onRemoved: () => {}, onExplain: () => {}, onClose: () => {}, initialMode: 'window' }),
    )
    expect(text).toContain('Rolling: last month (Aug 1–31, 2026)')
    // "Last N days" = TODAY − 30 .. TODAY.
    expect(text).toContain('Rolling: last 30 days (Aug 29 – Sep 28, 2026)')
    expect(text).toContain('Rolling: this month (Sep 1–28, 2026)')
    expect(text).toContain('A rolling period moves with today')
    // The tile shows last month and its title says so: no hint.
    expect(text).not.toContain('use Rename')
  })

  it('the time period form offers Rename when the title names another period than the one picked', () => {
    const moved: InsightTile = { ...pinned, window: { kind: 'rolling', preset: 'last_30_days', from: '2026-08-29', to: '2026-09-28' } }
    const { text } = render(
      createElement(TileActions, { tile: moved, above: null, below: null, onChanged: () => {}, onRemoved: () => {}, onExplain: () => {}, onClose: () => {}, initialMode: 'window' }),
    )
    expect(text).toContain('The title says “last month”. After saving, use Rename so it matches the new period.')
  })

  it('a tile shows its window in words as a button that changes it, and "Updated just now"', () => {
    const { html, text } = render(createElement(BoardGrid, { tiles: [builtIn, pinned], onChanged: () => {}, onRemoved: () => {}, onExplain: () => {} }))
    expect(text).toContain('Last month · Aug 1–31, 2026')
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?Last month · Aug 1–31, 2026[\s\S]*?change time period for /)
    // A tile with no period says when it is as of.
    expect(text).toContain('As of Sep 28, 2026')
    expect(text).toContain('Updated just now')
    expect(text).toContain('46')
    // sort_order 30 before 50.
    expect(text.indexOf('Subscribers at risk of going cold')).toBeLessThan(text.indexOf(BRIEF_Q1))
  })
})

describe('an empty first page reads in words', () => {
  // julia.evans230@gmail.com has no web history, so a first-page grouping holds
  // her in the null bucket; the bar label and its table must say why, not "None".
  it('a null first_page is "No tracked visit"; "/" is the home page', () => {
    expect(cellText('first_page', null)).toBe('No tracked visit')
    expect(cellText('first_page', '/')).toBe('Home page (/)')
  })
})

describe('the pin dialog sends the trace id, and the title only when the person changed it', () => {
  const ID = 'a3c1d2e4-5b6f-4a7b-8c9d-0e1f2a3b4c5d'

  it('an unchanged title is left to the server: the body holds only audit_id', () => {
    expect(pinBody(ID, BRIEF_Q1, BRIEF_Q1)).toEqual({ audit_id: ID })
    expect('title' in pinBody(ID, BRIEF_Q1, BRIEF_Q1)).toBe(false)
  })

  it('an edited title is sent with the trace id', () => {
    expect(pinBody(ID, 'Cold Instagram signups', BRIEF_Q1)).toEqual({ audit_id: ID, title: 'Cold Instagram signups' })
  })
})
