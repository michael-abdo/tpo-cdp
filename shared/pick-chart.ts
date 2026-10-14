/**
 * Which chart a result is drawn as (design 09 D-64; the rule table is 06 §/insights). Pure: it
 * reads only the result's shape, never a tool name or a title, so a tile, an Ask answer and a
 * test all pick the same chart for the same rows. The UI draws the kind with its own SVG
 * components (no chart library).
 *
 * The rules, first match wins:
 *   1. an override (the tile's `chart` column, 01 §insights) wins
 *   2. a segment result (`segment` present)                      → segment (count + "Open list")
 *   3. no rows or no columns                                     → table (its empty state)
 *   4. one row, one column, and that cell is a number            → number (one big number)
 *   5. first column is time, every other column is a number      → line
 *   6. first column is a category, every other column is a number → bar; the bar length is the
 *      first number column, sorted, top BAR_TOP_CATEGORIES + "Other" (06), however many rows
 *   7. anything else                                             → table
 *
 * Column kinds, read from every row: a number column holds only numbers or nulls and at least
 * one number; a time column holds only `YYYY-MM` or `YYYY-MM-DD` strings (the shapes the tools
 * group by: signup_month, cold_month, a date); a category column holds only strings or nulls.
 */

export type ChartKind = 'number' | 'bar' | 'line' | 'table' | 'segment'

/** The kinds a tile's chart override may name (01 §insights `chart`); segment comes only from the result. */
export const CHART_OVERRIDES = ['number', 'bar', 'line', 'table'] as const
export type ChartOverride = (typeof CHART_OVERRIDES)[number]

/** A bar chart shows this many categories, then one "Other" bar (06 §/insights). */
export const BAR_TOP_CATEGORIES = 20

export interface ChartInput {
  columns: string[]
  rows: Record<string, unknown>[]
  segment?: { count: number } | null
}

export type ColumnKind = 'number' | 'time' | 'category' | 'other'

/** A time cell: `YYYY-MM` or `YYYY-MM-DD`. */
export const TIME_VALUE = /^\d{4}-\d{2}(?:-\d{2})?$/

/** A column's kind read from every row (the rules above); the one home the UI's chart shapes reuse. */
export function columnKind(rows: readonly Record<string, unknown>[], column: string): ColumnKind {
  const values = rows.map((row) => row[column] ?? null)
  if (values.every((v) => v === null || typeof v === 'number') && values.some((v) => typeof v === 'number')) return 'number'
  if (values.every((v) => typeof v === 'string' && TIME_VALUE.test(v))) return 'time'
  if (values.every((v) => v === null || typeof v === 'string')) return 'category'
  return 'other'
}

export function pickChart(r: ChartInput, override?: ChartKind | null): ChartKind {
  if (override !== undefined && override !== null) return override
  if (r.segment !== undefined && r.segment !== null) return 'segment'
  if (r.rows.length === 0 || r.columns.length === 0) return 'table'
  const kinds = r.columns.map((c) => columnKind(r.rows, c))
  if (r.rows.length === 1 && kinds.length === 1 && kinds[0] === 'number') return 'number'
  const [first, ...rest] = kinds
  if (rest.length > 0 && rest.every((k) => k === 'number')) {
    if (first === 'time') return 'line'
    if (first === 'category') return 'bar'
  }
  return 'table'
}
