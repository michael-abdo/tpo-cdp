import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../shared/features'
import { SetAlertItem, TileActions } from '../../src/insights/board'
import { FollowUpField } from '../../src/insights/ask'
import { SendTheBoardButton } from '../../src/pages/InsightsPage'
import type { InsightTile } from '../../src/types'

// Insights' gated future features (09 D-80, 22-pages/insights.md): Schedules and digests (the
// board header's "Send the board" and a tile's "Set an alert", one shared flag) and Follow-up
// questions (the foot of the answer card).

const NUMBER_TILE: InsightTile = {
  id: 'tile-1',
  title: 'Went cold last month',
  prompt: 'how many went cold last month?',
  tool: 'aggregate',
  built_in: false,
  sort_order: 10,
  window: null,
  own_dates: null,
  chart: 'number',
  chart_override: null,
  result: { columns: ['value'], rows: [{ value: 46 }], summary: {} },
  segment: null,
  status: 'ok',
  error: null,
  error_details: null,
  ran_at: '2026-10-14T12:00:00.000Z',
  explain: 'how many went cold last month?',
  params: {},
  sql: null,
}

const BAR_TILE: InsightTile = { ...NUMBER_TILE, id: 'tile-2', chart: 'bar', result: { columns: ['source', 'count'], rows: [], summary: {} } }

function actionsHtml(tile: InsightTile): string {
  return renderToString(
    createElement(TileActions, { tile, above: null, below: null, onChanged: () => {}, onRemoved: () => {}, onExplain: () => {}, onClose: () => {} }),
  ).replaceAll('<!-- -->', '')
}

describe('Insights: Send the board (schedules_and_digests)', () => {
  it('renders aria-disabled="true", never disabled, with the note equal to shared/features.ts', () => {
    const html = renderToString(createElement(SendTheBoardButton)).replaceAll('<!-- -->', '')
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain(' disabled')
    expect(html).toContain(FEATURES.schedules_and_digests.note)
  })
})

describe('Insights: Set an alert (schedules_and_digests, single-number tiles only)', () => {
  it('shows on a "number" chart tile, with the same note as Send the board', () => {
    const html = actionsHtml(NUMBER_TILE)
    expect(html).toContain('Set an alert')
    expect(html).toContain(FEATURES.schedules_and_digests.note)
  })

  it('does not show on a "bar" chart tile (nothing a single alert line could cross)', () => {
    expect(actionsHtml(BAR_TILE)).not.toContain('Set an alert')
  })

  it('renders aria-disabled="true" and never the disabled attribute (Tailwind\'s "disabled:" variant classes aside)', () => {
    const html = renderToString(createElement(SetAlertItem)).replaceAll('<!-- -->', '')
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toMatch(/\sdisabled(="")?(?=[\s>])/)
  })
})

describe('Insights: Ask a follow-up (follow_up_questions)', () => {
  it('both the input and the Ask button are aria-disabled, never disabled, sharing one describedby', () => {
    const html = renderToString(createElement(FollowUpField)).replaceAll('<!-- -->', '')
    expect(html.match(/aria-disabled="true"/g)?.length).toBe(2)
    expect(html).not.toContain(' disabled')
    const ids = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(1)
    expect(html).toContain(FEATURES.follow_up_questions.note.replaceAll('"', '&quot;'))
  })

  it('the input is readOnly and there is no <form> wrapper, so Enter can never submit', () => {
    const html = renderToString(createElement(FollowUpField))
    expect(html).toMatch(/<input[^>]*readonly/i)
    expect(html).not.toContain('<form')
  })

  it('the Ask button carries a hidden " a follow-up" so it reads distinct from the main Ask button', () => {
    const html = renderToString(createElement(FollowUpField))
    expect(html).toContain('a follow-up</span>')
  })
})
