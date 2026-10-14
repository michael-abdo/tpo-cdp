// /events (06 §/events; R4.10): the last 20 app events from GET /api/events/recent (04), newest
// first, fetched on load, then every 5 seconds while the tab is visible (16 §If time remains item
// 2): the poll stops when the tab is hidden (document.hidden) and fetches at once when it is shown
// again. "Refresh" fetches on demand. A poll never cuts across a fetch still running, and an answer
// older than the newest request is dropped. The live region (06 §UI principles 7) says how many
// events the first load shows, then only how many new ones arrived; a poll with nothing new says
// nothing, a Refresh with nothing new says so. A failed fetch keeps the last list on screen under
// the error, and the next poll tries again. Level 1 per event (06 §UI
// principles 2, 4, 5): when it arrived (received_at, shown only here), the event name as the brief
// writes it with a plain gloss in an InfoTip (06 §Vocabulary), and the profile it belongs to: the
// email, "anonymous device" when no identified event has named the device yet, or "Unknown app
// account (no email on file)" for a webhook-created user with no email (06 sketches
// "unknown user u_…"; principle 2 moves the u_ id to Technical details), plus a "Linked after login"
// tag (06's "stitched") when an anonymous event is attached through its device's login
// (attached_via login_stitch), explained once above the table; Level 2 (row Details): when it
// happened in the app; Technical details: device id, second-precise UTC times, raw ids and pk_
// keys (the event name is in the row already, 09 D-72). Events are sent from the terminal with
// `npm run webhook:send` (11 §Verify).

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { errorMessage, getJson } from '../api'
import {
  Announcer,
  Button,
  type Column,
  Disclosure,
  EmptyState,
  EventName,
  ErrorLine,
  Field,
  ICONS,
  Loading,
  PageHeader,
  ResponsiveTable,
  Tag,
  TechnicalDetails,
} from '../components'
import { humanDateTime, utc } from '../format'
import { eventsAnnouncement, type FetchKind, POLL_MS } from '../events-poll'
import type { RecentEvent, RecentEvents } from '../types'

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

function Profile({ e }: { e: RecentEvent }) {
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
        {e.email ?? 'Unknown app account (no email on file)'}
      </Link>
      {stitched(e) && <Tag tone="accent">Linked after login</Tag>}
    </span>
  )
}

function EventDetails({ e }: { e: RecentEvent }) {
  return (
    <div className="space-y-2">
      <dl className="space-y-1">
        <Field label="Happened in app">{humanDateTime(e.event_ts)}</Field>
      </dl>
      <TechnicalDetails>
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
    { header: 'Event', cell: (e) => <EventName event={e.event} /> },
    { header: 'Profile', cell: (e) => <Profile e={e} /> },
  ]
}

const POLL_SECONDS = POLL_MS / 1000
/** The next step under a failed fetch; how often the page tries is said once, under "How this list updates" (09 D-72). */
const KEEPS_TRYING = 'The page keeps trying on its own.'

/** The page's lists: the last good one (kept through a failed fetch) and the latest error. */
interface Shown {
  data: RecentEvents | null
  error: string | null
  /** Wall clock of the last good fetch, for "5 min ago". */
  at: number
}

export default function EventsPage() {
  const [shown, setShown] = useState<Shown | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // A counter rides along with the text so the same sentence twice in a row is still a change
  // the screen reader announces (Announcer: "change `message`").
  const [said, setSaid] = useState({ text: '', n: 0 })

  const alive = useRef(true)
  /** Sequence number of the newest request sent; any older answer is dropped. */
  const newest = useRef(0)
  /** True while the newest request has not answered. */
  const pending = useRef(false)
  /** Event ids of the last list on screen. */
  const shownIds = useRef<ReadonlySet<string> | null>(null)

  const say = useCallback((text: string) => setSaid((s) => ({ text, n: s.n + 1 })), [])

  const load = useCallback(
    async (kind: FetchKind) => {
      if (kind === 'poll' && pending.current) return
      const seq = ++newest.current
      pending.current = true
      let data: RecentEvents | null = null
      let error: string | null = null
      try {
        data = await getJson<RecentEvents>('/api/events/recent')
      } catch (err) {
        error = errorMessage(err)
      }
      if (!alive.current || seq !== newest.current) return
      pending.current = false
      setRefreshing(false)
      const at = Date.now()
      if (data !== null) {
        const text = eventsAnnouncement(shownIds.current, data.events, kind)
        shownIds.current = new Set(data.events.map((e) => e.event_id))
        setShown({ data, error: null, at })
        if (text !== null) say(text)
      } else {
        // ErrorLine is role="alert", so the error is announced without the live region.
        setShown((prev) => ({ data: prev?.data ?? null, error, at: prev?.at ?? at }))
      }
    },
    [say],
  )

  useEffect(() => {
    alive.current = true
    void load('initial')
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      if (timer === undefined) timer = setInterval(() => void load('poll'), POLL_MS)
    }
    const stop = () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else {
        void load('poll')
        start()
      }
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive.current = false
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  const refresh = () => {
    setRefreshing(true)
    say('Refreshing…')
    void load('manual')
  }

  const events = shown?.data?.events ?? null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recent app events"
        purpose="The last 20 events the app sent, newest first."
        icon={ICONS.events}
        action={
          <Button variant="primary" icon={ICONS.loading} onClick={refresh} disabled={shown === null || refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      <Disclosure label="How this list updates">
        <p className="text-sm text-gray-700">
          The list updates itself every {POLL_SECONDS} seconds while this tab is in view. These times are live, so they can be later than the date in the top bar.
        </p>
      </Disclosure>
      <Announcer message={said.n % 2 === 0 ? said.text : `${said.text}\u00a0`} />
      {shown === null ? (
        <Loading label="Loading the latest events…" />
      ) : (
        <>
          {shown.error !== null && (
            <ErrorLine
              message={shown.error}
              next={events === null ? KEEPS_TRYING : `The list below is from the last update. ${KEEPS_TRYING}`}
            />
          )}
          {events === null ? null : events.length === 0 ? (
            <EmptyState icon={ICONS.events}>
              No events yet — send one with <code className="font-mono">npm run webhook:send</code>
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {events.some(stitched) && (
                <Disclosure label="What does “Linked after login” mean?">
                  <p className="text-sm text-gray-700">
                    The event came in before the person logged in on that device. Once they logged in, we linked it to them.
                  </p>
                </Disclosure>
              )}
              <ResponsiveTable
                caption="Recent app events, newest first"
                columns={columns(shown.at)}
                rows={events}
                rowKey={(e) => e.event_id}
                details={(e) => <EventDetails e={e} />}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
