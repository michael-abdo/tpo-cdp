/**
 * The four events the app sends (R4.3); the CHECK on app_events.event in 0001_core.sql matches.
 * The one home of the list, kept free of imports so the browser bundle can read it without the
 * webhook validator (worker/webhooks/schema.ts re-exports it; shared/segment-filters.ts uses it
 * for the `app_event` filter, 09 D-69; the "Send a test event" panel picks from it, 09 D-73).
 */
export const APP_EVENTS = ['app_open', 'read_story', 'link_click', 'login'] as const

export type AppEventName = (typeof APP_EVENTS)[number]
