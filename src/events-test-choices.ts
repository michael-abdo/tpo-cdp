// What the "Send a test event" panel offers and sends, kept pure so
// test/ui/events-test-panel.test.ts can pin it without rendering (src/events-test-panel.tsx is
// the only other caller; the component file exports only the component). The panel can send an
// anonymous event (no user) and can reuse the last test event's device, which is how an operator
// shows the login stitch: anonymous events on one device, then a login on that device, after
// which Look up lists the earlier events as that account's.

import { APP_EVENTS, type AppEventName } from '../shared/app-events'
import type { RecentEvent } from './types'

/** The account picker's first choice: an event with no user, as an app sends before a login. */
export const ANONYMOUS_CHOICE = 'Anonymous (no user)'

/** Who the next test event is from: nobody yet (nothing picked), no user, or one real app account. */
export type TestEventSender = null | { kind: 'anonymous' } | { kind: 'account'; user_id: string }

/** The body POST /api/events/test takes for a new event or for "Send again". */
export type TestEventRequest =
  | { user_id: string | null; event: AppEventName; same_device_as?: string }
  | { resend: string }

/** The events offered for a sender: every APP_EVENT, except login with no user (a login needs one). */
export function eventChoices(sender: TestEventSender): readonly AppEventName[] {
  return sender?.kind === 'anonymous' ? APP_EVENTS.filter((name) => name !== 'login') : APP_EVENTS
}

/** The body for a new event; null while no sender is picked. `sameDeviceAs` reuses that test event's device. */
export function newEventRequest(
  sender: TestEventSender,
  event: AppEventName,
  sameDeviceAs: string | null,
): TestEventRequest | null {
  if (sender === null) return null
  return {
    user_id: sender.kind === 'anonymous' ? null : sender.user_id,
    event,
    ...(sameDeviceAs === null ? {} : { same_device_as: sameDeviceAs }),
  }
}

/** After a login, where Look up shows that account and the device's earlier events as its own. */
export function lookupAfterLogin(event: RecentEvent): { href: string; label: string } | null {
  if (event.event !== 'login' || event.user_id === null) return null
  return { href: `/lookup?q=${encodeURIComponent(event.user_id)}`, label: event.email ?? event.user_id }
}
