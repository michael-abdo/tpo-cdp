// How a result cell reads on /insights (06 §UI principles 4): the answer card's table, every chart's
// value labels and its text-alternative table use these, with the same display rules /segments uses
// for the same columns. One home: nothing on the page formats a cell another way.

import { humanDate, humanMonth } from '../format'
import { checkLabel, sourceLabel, statusLabel } from '../labels'
import type { AssistantCell } from '../types'

export const fmt = (n: number) => n.toLocaleString('en-US')

/** A rate column holds a share as a fraction (builtin-handlers.ts METRICS, worker/insights). */
export function isRateColumn(column: string): boolean {
  return column === 'rate' || column.endsWith('_rate')
}

export function percent(rate: number): string {
  return `${(rate * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
}

/** A table cell in words. */
export function cellText(column: string, value: AssistantCell): string {
  if (value === null) {
    if (column === 'last_open_date') return 'Never opened'
    if (column === 'source') return 'Unknown'
    if (column === 'utm_source' || column === 'first_utm_source') return 'No UTM source'
    if (column === 'first_page') return 'No tracked visit'
    if (isRateColumn(column)) return 'No data'
    return 'None'
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') {
    if (column === 'engagement_score') return `${fmt(value)} / 100`
    if (isRateColumn(column)) return percent(value)
    return fmt(value)
  }
  if (column === 'source' || column === 'utm_source' || column === 'first_utm_source') return sourceLabel(value)
  if (column === 'status') return statusLabel(value)
  if (column === 'check') return checkLabel(value)
  if (column === 'signup_date' || column === 'last_open_date') return humanDate(value)
  if (column.endsWith('_month')) return humanMonth(value)
  if (column === 'first_page' && value === '/') return 'Home page (/)'
  return value
}
