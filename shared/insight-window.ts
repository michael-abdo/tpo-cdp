/**
 * The window of a pinned insight tile (design 09 D-64; 01 §insights `params.window`; 04
 * §/api/insights board). A tile stores either a rolling preset, re-resolved against `today` on
 * every run, or a fixed pair of dates. `today` is always `TODAY` from shared/config.ts in the
 * Worker (02 §Time); it is a parameter so the functions stay pure and the UI can label a preset.
 *
 * The presets call 02 §Derived in shared/derive.ts, never a second formula:
 *   - last_month    lastMonth(today): the previous calendar month (09 D-10)
 *   - last_30_days  lastNDays(30, today): today − 30 .. today, the `new_subscriber` window
 *   - this_month    the first day of today's month .. today (no 02 §Derived row)
 * T-INS-5 checks both reused presets against derive.ts on several days, month ends included.
 * All ends are inclusive `YYYY-MM-DD` calendar dates.
 */
import { lastMonth, lastNDays } from './derive'

export const ROLLING_PRESETS = ['last_month', 'last_30_days', 'this_month'] as const
export type RollingPreset = (typeof ROLLING_PRESETS)[number]

/** As stored in `insights.params.window` and sent in `PATCH /api/insights/:id`. */
export type InsightWindow = { rolling: RollingPreset } | { fixed: [string, string] }

/** As returned on a tile: the stored window resolved to dates. */
export type ResolvedWindow =
  | { kind: 'rolling'; preset: RollingPreset; from: string; to: string }
  | { kind: 'fixed'; preset?: undefined; from: string; to: string }

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** True for a real `YYYY-MM-DD` calendar date (2026-02-30 is not). Pure. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = ISO_DATE.exec(value)
  if (match === null) return false
  const [, y, m, d] = match
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).toISOString().slice(0, 10) === value
}

function utcDate(y: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(y, monthIndex, day)).toISOString().slice(0, 10)
}

/** One preset's dates relative to `today`. Throws on a `today` that is not a calendar date. */
function presetDates(preset: RollingPreset, today: string): { from: string; to: string } {
  if (!isCalendarDate(today)) throw new Error(`insight-window: today must be a YYYY-MM-DD date, got ${JSON.stringify(today)}`)
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7)) - 1
  switch (preset) {
    case 'last_month':
      return lastMonth(today)
    case 'last_30_days':
      return lastNDays(30, today)
    case 'this_month':
      return { from: utcDate(y, m, 1), to: today }
  }
}

/** The dates a stored window covers on `today`. Throws on a malformed window (parse it first). Pure. */
export function resolveWindow(w: InsightWindow, today: string): ResolvedWindow {
  if ('rolling' in w) return { kind: 'rolling', preset: w.rolling, ...presetDates(w.rolling, today) }
  const [from, to] = w.fixed
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
    throw new Error(`insight-window: a fixed window needs two dates in order, got ${JSON.stringify(w.fixed)}`)
  }
  return { kind: 'fixed', from, to }
}

/**
 * The window to store for a tool input's `from`..`to` (09 D-64): the first preset that resolves
 * to exactly those dates on `today` is stored rolling, anything else fixed. Pure.
 */
export function detectWindow(from: string, to: string, today: string): InsightWindow {
  for (const preset of ROLLING_PRESETS) {
    const dates = presetDates(preset, today)
    if (dates.from === from && dates.to === to) return { rolling: preset }
  }
  return { fixed: [from, to] }
}

/** Problems with a window sent by a client or read from storage; empty when it is valid. Pure. */
export function windowProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['window must be {"rolling": "<preset>"} or {"fixed": ["YYYY-MM-DD", "YYYY-MM-DD"]}']
  }
  const keys = Object.keys(value)
  if (keys.length !== 1 || (keys[0] !== 'rolling' && keys[0] !== 'fixed')) {
    return ['window must have exactly one key, "rolling" or "fixed"']
  }
  const w = value as Record<string, unknown>
  if (keys[0] === 'rolling') {
    return (ROLLING_PRESETS as readonly unknown[]).includes(w.rolling) ? [] : [`window.rolling must be one of ${ROLLING_PRESETS.join(', ')}`]
  }
  const fixed = w.fixed
  if (!Array.isArray(fixed) || fixed.length !== 2 || !fixed.every(isCalendarDate)) {
    return ['window.fixed must be two YYYY-MM-DD calendar dates']
  }
  if (fixed[0] > fixed[1]) return ['window.fixed starts after it ends']
  return []
}
