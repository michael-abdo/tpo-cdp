// The four events the app sends (04 §Webhook body and validation; R4.3, the brief). One home
// (CLAUDE.md, D-72): worker/webhooks/schema.ts re-exports this for the webhook schema and the
// "Send a test event" panel (09 D-73, worker/routes/events.ts, src/pages/EventsPage.tsx) imports
// it directly for its event picker, so no file writes a second copy of the four names.

export const APP_EVENTS = ['app_open', 'read_story', 'link_click', 'login'] as const

export type AppEventName = (typeof APP_EVENTS)[number]
