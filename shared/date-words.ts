// Calendar dates in plain words ("Aug 1–31, 2026"), never raw ISO strings, because the screens are
// for non-technical staff. One home for both the
// browser (src/format.ts and src/insights/windows.ts re-export these) and the Worker, which words a
// tile's time period into its "Explain this" question (worker/insights/board.ts). Pure: reads the
// digits as stored, so no time-zone shift and no clock.

import type { ResolvedWindow, RollingPreset } from './insight-window'

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const STORED_DATE = /^(\d{4})-(\d{2})-(\d{2})/

/**
 * A stored date or timestamp as plain words, `Sep 2, 2026`. Reads the
 * digits as stored, so no time-zone shift; any other shape is shown as-is and flagged.
 */
export function humanDate(date: string): string {
  const match = STORED_DATE.exec(date)
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined
  if (!match || month === undefined) return `${date} (unrecognized date)`
  return `${month} ${Number(match[3])}, ${match[1]}`
}

/**
 * A date range in words with the shared parts said once: `Aug 1–31, 2026`, `Aug 30 – Sep 28, 2026`,
 * `Dec 1, 2025 – Jan 31, 2026`; one day is `Sep 28, 2026`. Reads the digits as stored, like humanDate.
 */
export function humanRange(from: string, to: string): string {
  const a = STORED_DATE.exec(from)
  const b = STORED_DATE.exec(to)
  if (!a || !b || MONTHS[Number(a[2]) - 1] === undefined || MONTHS[Number(b[2]) - 1] === undefined) {
    return `${humanDate(from)} – ${humanDate(to)}`
  }
  if (from === to) return humanDate(from)
  const [aMonth, bMonth] = [MONTHS[Number(a[2]) - 1], MONTHS[Number(b[2]) - 1]]
  if (a[1] !== b[1]) return `${humanDate(from)} – ${humanDate(to)}`
  if (a[2] !== b[2]) return `${aMonth} ${Number(a[3])} – ${bMonth} ${Number(b[3])}, ${a[1]}`
  return `${aMonth} ${Number(a[3])}–${Number(b[3])}, ${a[1]}`
}

/** Every rolling preset of shared/insight-window.ts in words; the Record makes a new preset a type error here. */
export const PRESET_LABEL: Record<RollingPreset, string> = {
  last_month: 'Last month',
  last_30_days: 'Last 30 days',
  this_month: 'This month',
}

/** `Last month · Aug 1–31, 2026` for a rolling window, `Aug 1–31, 2026` for a fixed one. */
export function windowText(window: ResolvedWindow): string {
  const range = humanRange(window.from, window.to)
  if (window.kind === 'rolling') return `${PRESET_LABEL[window.preset]} · ${range}`
  return range
}
