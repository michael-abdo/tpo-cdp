import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../shared/features'
import { SetAlertItem, TileActions } from '../../src/insights/board'
import { FollowUpField } from '../../src/insights/ask'
import { SendTheBoardButton } from '../../src/pages/InsightsPage'
import type { InsightTile } from '../../src/types'
import {
  describedByResolvesTo,
  elementText,
  gatedControlTags,
  hasDisabledAttribute,
  showsComingSoonChip,
  wearsGatedLook,
} from '../helpers/gated-assertions'

// Insights' gated future features: Schedules and digests (the
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
  it('renders aria-disabled="true", never disabled, its label from shared/features.ts, with a describedby that resolves to the exact note', () => {
    const html = renderToString(createElement(SendTheBoardButton)).replaceAll('<!-- -->', '')
    expect(html).toContain('aria-disabled="true"')
    expect(hasDisabledAttribute(html)).toBe(false)
    expect(html).toContain(FEATURES.schedules_and_digests.controls![0])
    expect(describedByResolvesTo(html, FEATURES.schedules_and_digests.note)).toBe(true)
  })

  it('the button\'s own VISIBLE text equals shared/features.ts\'s controls[0] exactly', () => {
    const html = renderToString(createElement(SendTheBoardButton))
    expect(elementText(html, 'button')).toBe(FEATURES.schedules_and_digests.controls![0])
  })
})

describe('Insights: Set an alert (schedules_and_digests, single-number tiles only)', () => {
  it('shows on a "number" chart tile, its label from shared/features.ts, with the same note as Send the board', () => {
    const html = actionsHtml(NUMBER_TILE)
    expect(html).toContain(FEATURES.schedules_and_digests.controls![1])
    expect(describedByResolvesTo(html, FEATURES.schedules_and_digests.note)).toBe(true)
  })

  it('does not show on a "bar" chart tile (nothing a single alert line could cross)', () => {
    expect(actionsHtml(BAR_TILE)).not.toContain(FEATURES.schedules_and_digests.controls![1])
  })

  it('renders aria-disabled="true" and never the disabled attribute (Tailwind\'s "disabled:" variant classes aside)', () => {
    const html = renderToString(createElement(SetAlertItem)).replaceAll('<!-- -->', '')
    expect(html).toContain('aria-disabled="true"')
    expect(hasDisabledAttribute(html)).toBe(false)
  })

  it('the button\'s own VISIBLE text equals shared/features.ts\'s controls[1] exactly', () => {
    const html = renderToString(createElement(SetAlertItem))
    expect(elementText(html, 'button')).toBe(FEATURES.schedules_and_digests.controls![1])
  })
})

describe('Insights: Ask a follow-up (follow_up_questions)', () => {
  it('both the input and the Ask button are aria-disabled, never disabled, sharing one describedby that resolves to the exact note', () => {
    const html = renderToString(createElement(FollowUpField)).replaceAll('<!-- -->', '')
    expect(html.match(/aria-disabled="true"/g)?.length).toBe(2)
    expect(hasDisabledAttribute(html)).toBe(false)
    const ids = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(1)
    expect(describedByResolvesTo(html, FEATURES.follow_up_questions.note)).toBe(true)
    expect(html).toContain(FEATURES.follow_up_questions.controls![0])
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

  it("the field's label and the button's own VISIBLE text (the hidden suffix aside) equal shared/features.ts's controls[0]/controls[1] exactly", () => {
    const html = renderToString(createElement(FollowUpField))
    expect(elementText(html, 'label')).toBe(FEATURES.follow_up_questions.controls![0])
    expect(elementText(html, 'button')).toBe(FEATURES.follow_up_questions.controls![1])
  })
})

describe('Insights: no "Coming soon" chip; every gated control wears the shared greyed look', () => {
  const cases: [string, () => string][] = [
    ['Send the board', () => renderToString(createElement(SendTheBoardButton))],
    ['Set an alert (on its tile)', () => actionsHtml(NUMBER_TILE)],
    ['Ask a follow-up (input and button)', () => renderToString(createElement(FollowUpField))],
  ]
  for (const [name, render] of cases)
    it(name, () => {
      const html = render()
      expect(showsComingSoonChip(html)).toBe(false)
      for (const tag of gatedControlTags(html)) expect(wearsGatedLook(tag), tag).toBe(true)
    })
})
