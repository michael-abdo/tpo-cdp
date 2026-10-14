// A tile's time period in words (06 §/insights: "Aug 1–31, 2026"), and the rolling presets a
// person can pick. The presets and how each resolves against TODAY live in shared/insight-window.ts
// (09 D-64); this file only names them and asks detectWindow which preset an answer's dates equal,
// the same rule the server uses when it stores a pin.

import { TODAY } from '../../shared/config'
import { detectWindow, type ResolvedWindow, ROLLING_PRESETS, type RollingPreset } from '../../shared/insight-window'
import { humanRange } from '../format'

/** Every preset of the shared list, in words; the Record makes a new preset a type error here. */
export const PRESET_LABEL: Record<RollingPreset, string> = {
  last_month: 'Last month',
  last_30_days: 'Last 30 days',
  this_month: 'This month',
}

export const PRESETS = ROLLING_PRESETS

/** The rolling preset whose dates today equal `from`–`to`, or null. */
export function matchingPreset(from: string, to: string): RollingPreset | null {
  const detected = detectWindow(from, to, TODAY)
  return 'rolling' in detected ? detected.rolling : null
}

/** `Last month · Aug 1–31, 2026` for a rolling window, `Aug 1–31, 2026` for a fixed one. */
export function windowText(window: ResolvedWindow): string {
  const range = humanRange(window.from, window.to)
  if (window.kind === 'rolling') return `${PRESET_LABEL[window.preset]} · ${range}`
  return range
}
