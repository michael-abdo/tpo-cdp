// /events (06 §/events; R4.10): the last 20 app events from GET /api/events/recent (04), newest
// first, fetched on load and again on "Refresh" (no polling). Level 1 per event (06 §UI
// principles 2, 4, 5): when it arrived (received_at, shown only here), what happened in words and
// who it belongs to: the email, "anonymous device" when no identified event has named the device
// yet, or "Unknown app user (no email on file)" for a webhook-created user with no email (06 sketches
// "unknown user u_…"; principle 2 moves the u_ id to Technical details), plus a "Linked after login"
// tag (06's "stitched") when an anonymous event is attached through its device's login
// (attached_via login_stitch). Level 2 (row Details): when it happened in the app and the link, in
// words; Technical details: device id, second-precise UTC times, raw names, ids and pk_ keys. Events are sent from the terminal with `npm run webhook:send` (11 §Verify).

import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { errorMessage, getJson } from '../api'
import {
  Announcer,
  Button,
  type Column,
  Disclosure,
  EmptyState,
  ErrorLine,
  Field,
  Loading,
  PageHeader,
  ResponsiveTable,
  Tag,
  TechnicalDetails,
} from '../components'
import { humanDateTime, utc } from '../format'
import type { RecentEvent, RecentEvents } from '../types'
import type { GetState } from '../useGet'

/** Plain words for the app's event names (worker/webhooks/schema.ts APP_EVENTS); others show as sent. */
const EVENT_LABEL: Record<string, string> = {
  app_open: 'Opened the app',
  read_story: 'Read a story',
  link_click: 'Clicked a link',
  login: 'Logged in',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const STORED_UTC = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/

/** `Sep 28, 10:02` (the header says UTC); any other shape falls back to the full utc() text. */
function shortUtc(ts: string): string {
  const m = STORED_UTC.exec(ts)
  if (!m) return utc(ts)
  return `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}, ${m[3]}`
}

/** "just now" / "5 min ago" / "3 h ago" / "2 days ago" from the wall-clock received_at; null if unparsable. */
function ago(ts: string, now: number): string | null {
  const t = Date.parse(ts)
  if (Number.isNaN(t)) return null
  const min = Math.floor((now - t) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  return `${d} ${d === 1 ? 'day' : 'days'} ago`
}

const stitched = (e: RecentEvent) => e.attached_via === 'login_stitch'

function Reader({ e }: { e: RecentEvent }) {
  if (e.user_id === null) {
    return (
      <span>
        Not logged in yet <span className="text-gray-600">(anonymous device)</span>
      </span>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <Link
        to={`/lookup?q=${encodeURIComponent(e.email ?? e.user_id)}`}
        className="inline-flex min-h-6 items-center break-all text-blue-700 underline underline-offset-2 hover:text-blue-900"
      >
        {e.email ?? 'Unknown app user (no email on file)'}
      </Link>
      {stitched(e) && <Tag>Linked after login</Tag>}
    </span>
  )
}

function EventDetails({ e }: { e: RecentEvent }) {
  return (
    <div className="space-y-2">
      <dl className="space-y-1">
        <Field label="Happened in app">{humanDateTime(e.event_ts)}</Field>
        {stitched(e) && <Field label="Linked by login">Yes, after this device logged in</Field>}
      </dl>
      <TechnicalDetails>
        <p>
          event: <span className="font-mono">{e.event}</span>
        </p>
        <p>
          device_id: <span className="font-mono break-all">{e.device_id}</span>
        </p>
        <p>
          event_ts: <span className="font-mono">{utc(e.event_ts)}</span>
        </p>
        <p>
          received_at: <span className="font-mono">{utc(e.received_at)}</span>
        </p>
        <p>
          event_id: <span className="font-mono break-all">{e.event_id}</span>
        </p>
        <p>
          attached_via: <span className="font-mono">{e.attached_via ?? 'none'}</span>
        </p>
        {e.user_id !== null && (
          <p>
            user_id: <span className="font-mono">{e.user_id}</span>
          </p>
        )}
        {e.pkey !== null && (
          <p>
            pkey: <span className="font-mono break-all">{e.pkey}</span>
          </p>
        )}
      </TechnicalDetails>
    </div>
  )
}

function columns(now: number): Column<RecentEvent>[] {
  return [
    {
      header: 'Arrived (UTC)',
      cell: (e) => {
        const rel = ago(e.received_at, now)
        return (
          <span className="whitespace-nowrap">
            {shortUtc(e.received_at)}
            {rel !== null && <span className="block text-gray-600">{rel}</span>}
          </span>
        )
      },
    },
    { header: 'What happened', cell: (e) => EVENT_LABEL[e.event] ?? e.event },
    { header: 'Reader', cell: (e) => <Reader e={e} /> },
  ]
}

/** A settled fetch: never 'loading', which is derived from the version instead. */
type Answer = Exclude<GetState<RecentEvents>, { status: 'loading' }>

export default function EventsPage() {
  // Each Refresh bumps the version; a settled answer is kept with the version it answers, so
  // the list stays on screen while a refresh is in flight and a stale answer never replaces it.
  const [version, setVersion] = useState(0)
  const [settled, setSettled] = useState<{ version: number; state: Answer; at: number } | null>(null)

  useEffect(() => {
    let current = true
    getJson<RecentEvents>('/api/events/recent').then(
      (data) => current && setSettled({ version, state: { status: 'ok', data }, at: Date.now() }),
      (err: unknown) =>
        current && setSettled({ version, state: { status: 'error', message: errorMessage(err) }, at: Date.now() }),
    )
    return () => {
      current = false
    }
  }, [version])

  const refreshing = settled !== null && settled.version !== version
  const events = settled?.state.status === 'ok' ? settled.state.data.events : null

  let announcement = ''
  if (refreshing) announcement = 'Refreshing…'
  else if (events !== null) announcement = `${events.length} ${events.length === 1 ? 'event' : 'events'} shown`

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recent app events"
        purpose="The last 20 events the app sent, newest first. These times are live, so they can be later than the date in the top bar. Press Refresh to see new ones."
        action={
          <Button variant="primary" onClick={() => setVersion((v) => v + 1)} disabled={settled === null || refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      <Announcer message={announcement} />
      {settled === null ? (
        <Loading label="Loading the latest events…" />
      ) : settled.state.status === 'error' ? (
        <ErrorLine message={settled.state.message} />
      ) : settled.state.data.events.length === 0 ? (
        <EmptyState>
          <p>
            No events yet — send one with <code className="font-mono">npm run webhook:send</code>
          </p>
          <p className="mt-1 text-gray-600">The app sends events here as readers use it. After one is sent, press Refresh.</p>
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {settled.state.data.events.some(stitched) && (
            <Disclosure label="What does “Linked after login” mean?">
              <p className="text-sm text-gray-700">
                The event came in before the person logged in on that device. Once they logged in, we linked it to them.
              </p>
            </Disclosure>
          )}
          <ResponsiveTable
            caption="Recent app events, newest first"
            columns={columns(settled.at)}
            rows={settled.state.data.events}
            rowKey={(e) => e.event_id}
            details={(e) => <EventDetails e={e} />}
          />
        </div>
      )}
    </div>
  )
}
