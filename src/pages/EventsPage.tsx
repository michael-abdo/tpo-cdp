// /events (06 §/events; R4.10): the last 20 app events from GET /api/events/recent (04), newest
// first, fetched on load and again on "Refresh" (no polling). Each row shows received_at (only
// here), the event, the device and the profile the event resolves to at read time: its email,
// "anonymous device" when no identified event has named the device yet, or "unknown user u_…"
// for a webhook-created user with no email, plus a "stitched" tag when an anonymous event is
// attached through its device's login (attached_via login_stitch). Events are sent from the
// terminal with `npm run webhook:send` (scripts/send-webhook.ts, 11 §Verify).

import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { errorMessage, getJson } from '../api'
import { Empty, ErrorLine, Loading } from '../components'
import { utc } from '../format'
import type { RecentEvent, RecentEvents } from '../types'
import type { GetState } from '../useGet'

function Profile({ e }: { e: RecentEvent }) {
  if (e.user_id === null) return <span className="text-gray-500">anonymous device</span>
  const label = e.email ?? `unknown user ${e.user_id}`
  return (
    <>
      <Link to={`/lookup?q=${encodeURIComponent(e.email ?? e.user_id)}`} className="hover:underline">
        {label}
      </Link>
      {e.attached_via === 'login_stitch' && (
        <span className="ml-2 rounded bg-gray-200 px-1 text-[10px] uppercase">stitched</span>
      )}
      {e.pkey !== null && <span className="block font-mono text-xs text-gray-500">{e.pkey}</span>}
    </>
  )
}

/** A settled fetch: never 'loading', which is derived from the version instead. */
type Answer = Exclude<GetState<RecentEvents>, { status: 'loading' }>

export default function EventsPage() {
  // Each Refresh bumps the version; a settled answer is kept with the version it answers, so
  // the list stays on screen while a refresh is in flight and a stale answer never replaces it.
  const [version, setVersion] = useState(0)
  const [settled, setSettled] = useState<{ version: number; state: Answer } | null>(null)

  useEffect(() => {
    let current = true
    getJson<RecentEvents>('/api/events/recent').then(
      (data) => current && setSettled({ version, state: { status: 'ok', data } }),
      (err: unknown) =>
        current && setSettled({ version, state: { status: 'error', message: errorMessage(err) } }),
    )
    return () => {
      current = false
    }
  }, [version])

  const refreshing = settled !== null && settled.version !== version

  return (
    <>
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold">Recent app events</h1>
        <button
          type="button"
          onClick={() => setVersion((v) => v + 1)}
          disabled={settled === null || refreshing}
          className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {settled === null ? (
        <Loading />
      ) : settled.state.status === 'error' ? (
        <ErrorLine message={settled.state.message} />
      ) : settled.state.data.events.length === 0 ? (
        <Empty>
          No events yet — send one with <code>npm run webhook:send</code>
        </Empty>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-200 text-gray-500">
            <tr>
              <th className="py-2 pr-4 font-normal">Received (UTC)</th>
              <th className="py-2 pr-4 font-normal">Event</th>
              <th className="py-2 pr-4 font-normal">Device</th>
              <th className="py-2 font-normal">Profile</th>
            </tr>
          </thead>
          <tbody>
            {settled.state.data.events.map((e) => (
              <tr key={e.event_id} className="border-b border-gray-100 align-top">
                <td className="py-2 pr-4 whitespace-nowrap">{utc(e.received_at)}</td>
                <td className="py-2 pr-4">
                  <span className="font-mono">{e.event}</span>
                  <span className="block text-xs text-gray-500">event time {utc(e.event_ts)}</span>
                </td>
                <td className="py-2 pr-4 font-mono">{e.device_id}</td>
                <td className="py-2">
                  <Profile e={e} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
