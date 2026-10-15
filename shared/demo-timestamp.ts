// The one home for `demoTimestamp`: TODAY (shared/config.ts) at the current wall-clock UTC time
// of day, as `YYYY-MM-DDTHH:MM:SSZ`. Demo events are dated TODAY like every business date; the
// time of day keeps successive demo events in send order. The real "now" would date a demo event
// after TODAY, outside every "last N days" window, so it could never move a score. Both demo
// senders call this: `scripts/send-webhook.ts` (`npm run webhook:send`) and
// `POST /api/events/test` (worker/routes/events.ts). Neither writes a second copy.

import { TODAY } from './config'

export function demoTimestamp(): string {
  return `${TODAY}T${new Date().toISOString().slice(11, 19)}Z`
}
