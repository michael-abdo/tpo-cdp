// What /events says after each fetch and how often it fetches (06 §/events, §UI principles 7;
// 16 §If time remains item 2). Pure, so test/events-poll.test.ts runs it on real answers of
// GET /api/events/recent; src/pages/EventsPage.tsx is the only other reader.

import type { RecentEvent } from './types'

/** How often the list refreshes itself while the tab is visible (06 §/events, 16 §If time remains item 2). */
export const POLL_MS = 5_000

/** What started a fetch: the page opening, the 5-second poll, or the Refresh button. */
export type FetchKind = 'initial' | 'poll' | 'manual'

/**
 * The live-region text for a fetched list (06 §UI principles 7), or null to say nothing. `shown`
 * holds the event ids of the last list on screen; null before any list has loaded. Pure.
 */
export function eventsAnnouncement(shown: ReadonlySet<string> | null, events: readonly RecentEvent[], kind: FetchKind): string | null {
  const plural = (n: number) => (n === 1 ? 'event' : 'events')
  if (shown === null) return `${events.length} ${plural(events.length)} shown`
  const fresh = events.filter((e) => !shown.has(e.event_id)).length
  if (fresh > 0) return `${fresh} new ${plural(fresh)} at the top of the list`
  return kind === 'manual' ? 'No new events' : null
}
