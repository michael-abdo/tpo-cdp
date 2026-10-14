// The one home (CLAUDE.md, D-72) for `demoTimestamp`: TODAY (shared/config.ts) at the current
// wall-clock UTC time of day, as `YYYY-MM-DDTHH:MM:SSZ`. 02 §Time: "demo events default to
// TODAY" (04 §POST /api/events/test); the time of day keeps successive demo events in send
// order without ever dating an event after TODAY (09 D-01, amended 2026-10-14 — "now" was a spec
// slip that would date a demo event after TODAY, so it could never move a score). Both demo
// senders call this: `scripts/send-webhook.ts` (`npm run webhook:send`) and
// `POST /api/events/test` (worker/routes/events.ts, 09 D-73). Neither writes a second copy.

import { TODAY } from './config'

export function demoTimestamp(): string {
  return `${TODAY}T${new Date().toISOString().slice(11, 19)}Z`
}
