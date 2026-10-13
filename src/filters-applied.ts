// What "Ask a question" shows of the model's `filters_applied` (06 §/assistant footer, 09 D-58).
// The model writes `filters_applied` itself, and the server does not screen it (respond.ts screens
// only `text`), so the page runs the same D-58 check (shared/sql-sign.ts) over every key and every
// string in it, and over its JSON as shown in Technical details. Any sign hides the whole object,
// at both levels, and a sentence in words says why: rejection, not stripping, as for `text`.
// Otherwise each filter shows as a plain label and value (06 §UI principles 4), with the raw JSON
// for Technical details. Pure, so the test runs it on the shapes the page would render.

import { type SqlSign, sqlSign } from '../shared/sql-sign'
import { humanDate } from './format'
import { filterLabel, sourceLabel, statusLabel } from './labels'

export type FiltersAppliedView =
  | { status: 'shown'; fields: Array<{ key: string; label: string; value: string }>; raw: string }
  | { status: 'hidden'; sign: SqlSign; message: string }

/** The sentence shown in place of filters that carried a sign of SQL. */
export const FILTERS_HIDDEN_MESSAGE =
  "The AI's list of filters looked like database code, so it is not shown. The answer above is unchanged."

const fmt = (n: number) => n.toLocaleString('en-US')

/** A filter value in words: lists joined, true/false as Yes/No, null as Any; sources and statuses as on /segments. */
function filterValue(key: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => filterValue(key, v)).join(', ')
  if (value === null) return 'Any'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return key === 'days_since_open_gte' ? `${fmt(value)} days` : fmt(value)
  if (typeof value === 'string') {
    if (key === 'source') return sourceLabel(value)
    if (key === 'status') return statusLabel(value)
    if (key === 'window_from' || key === 'window_to') return humanDate(value)
    return value
  }
  return JSON.stringify(value)
}

/** Every object key and string inside `value`, in order, one per line. */
function writtenText(value: unknown, out: string[]): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) writtenText(item, out)
  else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.push(key)
      writtenText(inner, out)
    }
  }
  return out
}

export function filtersAppliedView(filters: Record<string, unknown>): FiltersAppliedView {
  const raw = JSON.stringify(filters)
  const sign = sqlSign(writtenText(filters, []).join('\n')) ?? sqlSign(raw)
  if (sign !== null) return { status: 'hidden', sign, message: FILTERS_HIDDEN_MESSAGE }
  return {
    status: 'shown',
    fields: Object.entries(filters).map(([key, value]) => ({ key, label: filterLabel(key), value: filterValue(key, value) })),
    raw,
  }
}
