// The shapes the charts of /insights draw, read from a result's columns the way
// shared/pick-chart.ts reads them: the first column is the category or the time, the first number
// column after it is the value. pickChart chooses the kind; these say whether a result has what a
// kind needs (so "Change chart" offers only kinds that can draw) and pull out what is drawn.

import { BAR_TOP_CATEGORIES, type ChartKind, columnKind } from '../../shared/pick-chart'
import type { AssistantCell, SegmentFilters } from '../types'
import { cellText, isRateColumn } from './cells'

export interface ChartResult {
  columns: string[]
  rows: Record<string, AssistantCell>[]
}

export interface ChartSegment {
  count: number
  filters: SegmentFilters
}

/** Table rows shown before "Show all …" (principle 2: the rest is one click away). */
export const FIRST_ROWS = 10

// ── shapes ───────────────────────────────────────────────────────────────────────────────
// Column kinds are pickChart's own (shared/pick-chart.ts columnKind): one home for the rules.

export function cell(row: Record<string, AssistantCell>, column: string): AssistantCell {
  return row[column] ?? null
}

/** Columns holding only numbers (or no value), with at least one number. */
function numericColumns(r: ChartResult): string[] {
  return r.columns.filter((c) => columnKind(r.rows, c) === 'number')
}

/** The first column when it holds only `YYYY-MM` or `YYYY-MM-DD` text (pickChart's time column). */
function timeColumn(r: ChartResult): string | null {
  const [first] = r.columns
  if (first === undefined || r.rows.length === 0) return null
  return columnKind(r.rows, first) === 'time' ? first : null
}

/** The first column when it is text: what the bars are labelled by (pickChart's category; a time column can label bars too). */
function categoryColumn(r: ChartResult): string | null {
  const [first] = r.columns
  if (first === undefined) return null
  const kind = columnKind(r.rows, first)
  return kind === 'category' || kind === 'time' ? first : null
}

export interface NumberShape {
  column: string
  value: number
  others: { column: string; value: AssistantCell }[]
}

/** One row with a number: the first number is the headline, the row's other values sit under it. */
export function numberShape(r: ChartResult): NumberShape | null {
  if (r.rows.length !== 1) return null
  const [column] = numericColumns(r)
  const row = r.rows[0]
  const value = column === undefined ? null : cell(row, column)
  if (column === undefined || typeof value !== 'number') return null
  return { column, value, others: r.columns.filter((c) => c !== column).map((c) => ({ column: c, value: cell(row, c) })) }
}

export interface BarShape {
  category: string
  value: string
  bars: { key: string; label: string; value: number }[]
  /** Categories past BAR_TOP_CATEGORIES; `value` is their sum, or null for a rate (a sum of shares means nothing). */
  other: { count: number; value: number | null } | null
  /**
   * Rows with no bar to draw: a value of 0 or no value. They stay in the numbers table; the chart
   * says how many, so nothing is left out without saying why.
   */
  undrawn: { zero: number; missing: number }
  /** Rates share a 0–100% scale; counts run to the largest bar. */
  max: number
}

/**
 * A category first and a number: bars sorted largest first, top BAR_TOP_CATEGORIES, the rest as
 * "Other". A zero or missing value draws no bar, so it is counted in `undrawn` instead.
 */
export function barShape(r: ChartResult): BarShape | null {
  const category = categoryColumn(r)
  const value = numericColumns(r).find((c) => c !== category)
  if (category === null || value === undefined || r.rows.length === 0) return null
  const all = r.rows.map((row, i) => ({ key: `${i}`, label: cellText(category, cell(row, category)), value: cell(row, value) }))
  const drawn = all
    .filter((b): b is { key: string; label: string; value: number } => typeof b.value === 'number' && b.value !== 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
  const undrawn = { zero: all.filter((b) => b.value === 0).length, missing: all.filter((b) => typeof b.value !== 'number').length }
  const rate = isRateColumn(value)
  const rest = drawn.slice(BAR_TOP_CATEGORIES)
  const other = rest.length === 0 ? null : { count: rest.length, value: rate ? null : rest.reduce((sum, b) => sum + b.value, 0) }
  const bars = drawn.slice(0, BAR_TOP_CATEGORIES)
  const max = rate ? 1 : Math.max(0, ...bars.map((b) => b.value), other?.value ?? 0)
  return { category, value, bars, other, undrawn, max }
}

export interface LineShape {
  time: string
  value: string
  points: { x: string; y: number }[]
}

/** A time and a number: points in time order. */
export function lineShape(r: ChartResult): LineShape | null {
  const time = timeColumn(r)
  const value = numericColumns(r).find((c) => c !== time)
  if (time === null || value === undefined) return null
  const points = r.rows
    .map((row) => ({ x: cell(row, time), y: cell(row, value) }))
    .filter((p): p is { x: string; y: number } => typeof p.x === 'string' && typeof p.y === 'number')
    .sort((a, b) => a.x.localeCompare(b.x))
  if (points.length === 0) return null
  return { time, value, points }
}

/** Whether a result can be drawn as `kind`; a table always can, a segment needs its count. */
export function chartFits(kind: ChartKind, r: ChartResult, segment: ChartSegment | null): boolean {
  switch (kind) {
    case 'number':
      return numberShape(r) !== null
    case 'bar':
      return barShape(r) !== null
    case 'line':
      return lineShape(r) !== null
    case 'table':
      return true
    case 'segment':
      return segment !== null
  }
}

/** Chart kinds in words, for "Change chart" and Technical details. */
export const CHART_LABEL: Record<ChartKind, string> = {
  number: 'Big number',
  bar: 'Bar chart',
  line: 'Line chart',
  table: 'Table',
  segment: 'Segment size',
}
