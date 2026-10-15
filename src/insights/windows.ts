// The rolling presets a person can pick, and a tile's time period in words ("Aug 1–31, 2026").
// The presets and how each resolves against TODAY live in shared/insight-window.ts;
// their words live in shared/date-words.ts, which the Worker also uses for "Explain
// this". This file asks detectWindow which preset an answer's dates equal, the same rule the server
// uses when it stores a pin.

import { TODAY } from '../../shared/config'
import { detectWindow, ROLLING_PRESETS, type RollingPreset } from '../../shared/insight-window'
import { humanRange } from '../format'

export { PRESET_LABEL, windowText } from '../../shared/date-words'

/**
 * The dates a lookup sets itself (InsightTile.own_dates, AssistantResponse.pin_own_dates) in words:
 * one string for both the pin dialog and the tile footer, so they always name the same period.
 */
export function ownDatesText(dates: { from: string; to: string }): string {
  return `Set by this question · ${humanRange(dates.from, dates.to)}`
}

export const PRESETS = ROLLING_PRESETS

/** The rolling preset whose dates today equal `from`–`to`, or null. */
export function matchingPreset(from: string, to: string): RollingPreset | null {
  const detected = detectWindow(from, to, TODAY)
  return 'rolling' in detected ? detected.rolling : null
}
