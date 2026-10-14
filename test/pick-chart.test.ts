import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { BAR_TOP_CATEGORIES, CHART_OVERRIDES, type ChartInput, pickChart } from '../shared/pick-chart'
import { BUILTIN_HANDLERS, type ToolOutput } from '../worker/assistant/tools/builtin-handlers'
import { seedDatabase } from './helpers/seed'

// T-INS-7 (08; 09 D-64): the pickChart rule table of 06 §/insights, row by row, and the override.
// Every input is a real result: the builder tools run over the seeded D1 (data/*.csv), or rows
// read from the PII-free views (09 D-47: no invented source, status or date). A rule that needs a
// shape no tool returns (a boolean cell, an empty column list) edits a copy of a real result.

const PRESET = { status: ['active'], source: ['instagram'], days_since_open_gte: 30, include_never_opened: true }

const run = (tool: 'aggregate' | 'segment', input: Record<string, unknown>): Promise<ToolOutput> => BUILTIN_HANDLERS[tool].run(env.DB, input)
const shape = (o: ToolOutput): ChartInput => ({ columns: o.columns, rows: o.rows, segment: o.segment ?? null })

beforeAll(async () => {
  await seedDatabase()
})

describe('T-INS-7: pickChart picks the chart from the result shape (06 §/insights)', () => {
  it('one number → number (went_cold_in August, 46 in 02 §Counts)', async () => {
    const result = await run('aggregate', { metric: 'went_cold', status: ['active'], source: ['instagram'], window_from: '2026-08-01', window_to: '2026-08-31' })
    expect(result.rows).toEqual([{ went_cold: 46 }])
    expect(pickChart(shape(result))).toBe('number')
    // The same row with its number gone is no longer a number.
    expect(pickChart({ columns: result.columns, rows: [{ went_cold: null }] })).toBe('table')
  })

  it('one row of several numbers is a table, not one number', async () => {
    const result = await run('aggregate', { metric: 'source_to_app' })
    expect(result.rows).toHaveLength(1)
    expect(result.columns.length).toBeGreaterThan(1)
    expect(pickChart(shape(result))).toBe('table')
  })

  it('time + numbers → line (subscribers by signup month)', async () => {
    const result = await run('aggregate', { metric: 'subscribers', group_by: 'signup_month', status: ['active', 'unsubscribed'] })
    expect(result.columns).toEqual(['signup_month', 'subscribers'])
    expect(result.rows.length).toBeGreaterThan(1)
    expect(pickChart(shape(result))).toBe('line')
    // Day dates are time too.
    const days = await env.DB.prepare('SELECT signup_date, count(*) AS subscribers FROM v_profiles WHERE signup_date IS NOT NULL GROUP BY 1 ORDER BY 1').all()
    expect(pickChart({ columns: ['signup_date', 'subscribers'], rows: days.results })).toBe('line')
  })

  it('category + numbers → bar, also with a null category (visitors with no campaign source)', async () => {
    const bySource = await run('aggregate', { metric: 'subscribers', group_by: 'source', status: ['active', 'unsubscribed'] })
    expect(pickChart(shape(bySource))).toBe('bar')
    const byUtm = await run('aggregate', { metric: 'visitor_to_subscriber', group_by: 'utm_source' })
    expect(byUtm.columns).toEqual(['utm_source', 'visitors', 'subscribed', 'rate'])
    expect(byUtm.rows.some((r) => r.utm_source === null)).toBe(true)
    expect(pickChart(shape(byUtm))).toBe('bar')
  })

  it(`more than ${BAR_TOP_CATEGORIES} categories is still a bar (top ${BAR_TOP_CATEGORIES} + "Other" is drawing, not picking)`, async () => {
    const { results } = await env.DB.prepare(
      "SELECT first_page || ' from ' || coalesce(first_utm_source, 'no campaign') AS entry, visitors FROM v_funnel ORDER BY visitors DESC",
    ).all()
    expect(results.length).toBeGreaterThan(BAR_TOP_CATEGORIES)
    expect(pickChart({ columns: ['entry', 'visitors'], rows: results })).toBe('bar')
  })

  it('0 rows or no columns → table', async () => {
    const empty = await run('aggregate', { metric: 'went_cold', status: ['active'], source: ['instagram'], group_by: 'source', window_from: '2026-07-01', window_to: '2026-07-01' })
    expect(empty.rows).toEqual([])
    expect(pickChart(shape(empty))).toBe('table')
    expect(pickChart({ columns: [], rows: [] })).toBe('table')
  })

  it('a segment result → segment, whatever its rows', async () => {
    const segment = await run('segment', PRESET)
    expect(segment.segment?.count).toBe(177) // 02 §Counts
    expect(pickChart(shape(segment))).toBe('segment')
    expect(pickChart({ columns: [], rows: [], segment: { count: segment.segment!.count } })).toBe('segment')
  })

  it('anything else → table: category + text, a boolean column, numbers with no label first', async () => {
    const segment = await run('segment', PRESET)
    // pkey, status, source, …: text after the first column.
    expect(pickChart({ columns: segment.columns, rows: segment.rows })).toBe('table')
    expect(pickChart({ columns: ['source', 'has_app'], rows: segment.rows.map((r) => ({ source: r.source, has_app: r.has_app })) })).toBe('table')
    const grouped = await run('aggregate', { metric: 'subscribers', group_by: 'source', status: ['active', 'unsubscribed'] })
    expect(pickChart({ columns: ['subscribers', 'source'], rows: grouped.rows })).toBe('table')
  })

  it('an override wins over every shape, including a segment', async () => {
    const number = await run('aggregate', { metric: 'went_cold', status: ['active'], source: ['instagram'], window_from: '2026-08-01', window_to: '2026-08-31' })
    const segment = await run('segment', PRESET)
    for (const override of CHART_OVERRIDES) {
      expect(pickChart(shape(number), override)).toBe(override)
      expect(pickChart(shape(segment), override)).toBe(override)
    }
    expect(pickChart(shape(number), null)).toBe('number')
  })
})
