// /lookup (06 §/lookup, R2): one search box, then one profile in three columns: newsletter,
// website, app. The raw input goes to GET /api/lookup?q= unchanged; the server normalizes it
// (02 §Normalization). Absent sections render the labelled empty states from 06.
// Partial lookup (06 §/lookup, 09 D-52): after QUERY_FRAGMENT_MIN_LENGTH typed characters the
// box lists GET /api/lookup/search suggestions (debounced); Find goes to the exact lookup and
// falls back to the suggestions on 404. The raw input is sent; the server folds it.

import { type FormEvent, type KeyboardEvent, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { isCold } from '../../shared/derive'
import { QUERY_FRAGMENT_MIN_LENGTH } from '../../shared/normalize'
import { ApiError, errorMessage, getJson } from '../api'
import { Empty, ErrorLine, Field, Loading, Section } from '../components'
import { dateOr, utc } from '../format'
import type { Lookup, LookupSearch } from '../types'
import { type GetState, useGet } from '../useGet'

/** Wait after the last keystroke before asking for suggestions (06: ~250 ms). */
const SUGGEST_DEBOUNCE_MS = 250
const NO_MATCH = 'No profile matches — try part of the email'
const LISTBOX_ID = 'lookup-suggestions'

const KIND_LABEL: Record<Lookup['profile']['kind'], string> = {
  subscriber: 'Subscriber',
  app_only: 'App-only user',
  unknown_user_stub: 'Unknown app user (created from webhook)',
}

function ScoreBar({ score }: { score: number }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm" title="engagement_score, 0–100">
      <span className="inline-block h-2 w-24 overflow-hidden rounded bg-gray-200">
        <span className="block h-full bg-gray-700" style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </span>
      score {score}
    </span>
  )
}

function Header({ data }: { data: Lookup }) {
  const { profile, newsletter } = data
  return (
    <div className="space-y-1 rounded border border-gray-200 p-4">
      <div className="flex flex-wrap items-center gap-4">
        <span className="font-semibold">{profile.email ?? 'No email on record'}</span>
        <span className="font-mono text-xs text-gray-500">{profile.pkey}</span>
        <ScoreBar score={profile.engagement_score} />
      </div>
      <div className="text-sm text-gray-700">
        {KIND_LABEL[profile.kind]}
        {newsletter !== null &&
          ` · ${newsletter.status} · ${newsletter.source ?? 'no source'} · signed up ${newsletter.signup_date}`}
      </div>
      <div className="text-sm text-gray-700">
        {newsletter !== null && `Last open ${dateOr(newsletter.last_open_date, 'never')} · `}
        {profile.cold_since !== null &&
          `${isCold(profile.cold_since) ? 'cold since' : 'cold on'} ${profile.cold_since} · `}
        App: {profile.has_app ? 'yes' : 'no'}
        {profile.has_app && newsletter !== null && (profile.app_after_signup ? ' (after signup)' : ' (not after signup)')}
      </div>
    </div>
  )
}

function Newsletter({ data }: { data: Lookup['newsletter'] }) {
  if (data === null) return <Empty>No newsletter record</Empty>
  return (
    <dl className="space-y-1">
      <Field label="Signup">{data.signup_date}</Field>
      <Field label="Status">{data.status}</Field>
      <Field label="Source">{data.source ?? 'none recorded'}</Field>
      <Field label="Last open">{dateOr(data.last_open_date, 'never opened')}</Field>
      <Field label="Merged rows">{data.merged_count}</Field>
    </dl>
  )
}

function Website({ data }: { data: Lookup['web'] }) {
  if (data === null) return <Empty>No website history</Empty>
  const before = data.events.filter((e) => e.pre_signup).length
  return (
    <div className="space-y-2">
      <dl className="space-y-1">
        <Field label="Visitor">{data.visitor_id}</Field>
        <Field label="First page">{data.first_page}</Field>
        <Field label="First UTM">{data.first_utm_source ?? 'none'}</Field>
        <Field label="Views">
          {data.events.length}, {before} before signup (shaded)
        </Field>
      </dl>
      {data.events.length === 0 ? (
        <Empty>No page views recorded</Empty>
      ) : (
        <ol className="space-y-1 text-xs">
          {data.events.map((e, i) => (
            <li key={`${e.event_ts}-${i}`} className={`rounded px-2 py-1 ${e.pre_signup ? 'bg-gray-100' : ''}`}>
              <span className="font-mono">{e.page}</span>
              <span className="block text-gray-500">
                {utc(e.event_ts)}
                {e.utm_source !== null && ` · utm ${e.utm_source}`}
                {e.pre_signup && ' · before signup'}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function AppActivity({ data }: { data: Lookup['app'] }) {
  if (data === null) return <Empty>No app account</Empty>
  return (
    <div className="space-y-2">
      <dl className="space-y-1">
        <Field label="User">{data.user_id}</Field>
        <Field label="Since">{data.created_at}</Field>
        <Field label="Origin">{data.from_csv ? 'app_users.csv' : 'created from webhook'}</Field>
        <Field label="Devices">{data.devices.length === 0 ? 'No devices seen' : data.devices.join(', ')}</Field>
      </dl>
      {data.events.length === 0 ? (
        <Empty>No app events yet</Empty>
      ) : (
        <ol className="space-y-1 text-xs">
          {data.events.map((e, i) => (
            <li key={`${e.event_ts}-${i}`} className="rounded px-2 py-1">
              <span className="font-mono">{e.event}</span>
              {e.attached_via === 'login_stitch' && (
                <span className="ml-2 rounded bg-gray-200 px-1 text-[10px] uppercase">stitched</span>
              )}
              <span className="block text-gray-500">{utc(e.event_ts)}</span>
              {e.properties !== null && (
                <span className="block break-all font-mono text-gray-500">{JSON.stringify(e.properties)}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

type Match = LookupSearch['matches'][number]

/** The exact lookup's answer; a 404 is kept apart because it opens the suggestion fallback. */
type ExactState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'not_found'; message: string }
  | { status: 'ok'; data: Lookup }

/** `value`, once it has stopped changing for `ms`. */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** What the exact lookup takes for a picked suggestion: the email, or the u_… of an email-less stub. */
function lookupKey(match: Match): string {
  const key = match.email ?? match.user_id
  if (key === null) throw new Error(`lookup: suggestion ${match.pkey} has neither an email nor a user id`)
  return key
}

/** Server-side minimum, checked here only to avoid asking for an answer that is always 400. */
function searchable(raw: string): boolean {
  return raw.trim().length >= QUERY_FRAGMENT_MIN_LENGTH
}

function Suggestions({
  state,
  active,
  onPick,
}: {
  state: GetState<LookupSearch> | null
  active: number
  onPick: (match: Match) => void
}) {
  if (state === null) return null
  if (state.status === 'loading') return <Loading />
  if (state.status === 'error') return <ErrorLine message={state.message} />
  const { matches, truncated } = state.data
  if (matches.length === 0) return <Empty>{NO_MATCH}</Empty>
  return (
    <ul id={LISTBOX_ID} role="listbox" className="max-w-md divide-y divide-gray-100 rounded border border-gray-200 text-sm">
      {matches.map((m, i) => (
        <li
          key={m.pkey}
          id={`${LISTBOX_ID}-${i}`}
          role="option"
          aria-selected={i === active}
          // mousedown, not click: the input keeps focus, so the list is not closed first.
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(m)
          }}
          className={`flex cursor-pointer flex-wrap gap-x-3 px-3 py-2 ${i === active ? 'bg-gray-100' : ''}`}
        >
          <span className="font-medium">{m.email ?? m.user_id}</span>
          <span className="text-gray-500">{KIND_LABEL[m.kind]}</span>
          {m.status !== null && <span className="text-gray-500">{m.status}</span>}
        </li>
      ))}
      {truncated && <li className="px-3 py-2 text-gray-500">+ more — keep typing</li>}
    </ul>
  )
}

export default function LookupPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q')
  const [input, setInput] = useState(q ?? '')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const fragment = useDebounced(input, SUGGEST_DEBOUNCE_MS)
  const suggestions = useGet<LookupSearch>(
    open && searchable(fragment) ? `/api/lookup/search?q=${encodeURIComponent(fragment)}` : null,
  )
  const matches = suggestions?.status === 'ok' ? suggestions.data.matches : []

  const [exact, setExact] = useState<{ q: string; state: ExactState } | null>(null)
  useEffect(() => {
    if (q === null || q.trim() === '') return
    let current = true
    getJson<Lookup>(`/api/lookup?q=${encodeURIComponent(q)}`).then(
      (data) => current && setExact({ q, state: { status: 'ok', data } }),
      (err: unknown) => {
        if (!current) return
        if (err instanceof ApiError && err.status === 404) {
          setExact({ q, state: { status: 'not_found', message: err.message } })
          setOpen(true) // 06: on 404 Find falls back to the suggestion list
        } else {
          setExact({ q, state: { status: 'error', message: errorMessage(err) } })
        }
      },
    )
    return () => {
      current = false
    }
  }, [q])
  const state: ExactState | null =
    q === null || q.trim() === '' ? null : exact === null || exact.q !== q ? { status: 'loading' } : exact.state

  function pick(match: Match) {
    const key = lookupKey(match)
    setInput(key)
    setOpen(false)
    setActive(-1)
    setParams({ q: key })
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setActive(-1)
    // Find again on the same unmatched q re-opens its fallback list; otherwise the list closes.
    setOpen(input === q && state?.status === 'not_found')
    setParams(input.trim() === '' ? {} : { q: input })
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!searchable(input)) return
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => Math.max(-1, Math.min(matches.length - 1, i + step)))
    } else if (e.key === 'Enter' && open && active >= 0 && active < matches.length) {
      e.preventDefault()
      pick(matches[active])
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      setOpen(false)
      setActive(-1)
    }
  }

  // The fallback after a 404 is the list itself; with the list closed (Esc) the 404 message stays.
  const listShown = open && searchable(fragment)
  return (
    <>
      <h1 className="text-xl font-semibold">Lookup</h1>
      <form onSubmit={submit} className="flex gap-2">
        <input
          type="search"
          role="combobox"
          aria-expanded={listShown}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={listShown && active >= 0 ? `${LISTBOX_ID}-${active}` : undefined}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
          placeholder="email or u_…"
          aria-label="email or u_…"
          className="w-full max-w-md rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded bg-gray-900 px-4 py-2 text-sm text-white">
          Find
        </button>
      </form>
      {listShown && <Suggestions state={suggestions} active={active} onPick={pick} />}
      {state === null && !listShown && <Empty>Search by email or app user id, or type part of one.</Empty>}
      {state?.status === 'loading' && <Loading />}
      {state?.status === 'error' && <ErrorLine message={state.message} />}
      {state?.status === 'not_found' && !listShown && (
        <Empty>{searchable(q ?? '') ? state.message : NO_MATCH}</Empty>
      )}
      {state?.status === 'ok' && (
        <div className="space-y-4">
          <Header data={state.data} />
          <p className="text-xs text-gray-500">All timestamps are UTC.</p>
          <div className="grid gap-4 md:grid-cols-3">
            <Section title="Newsletter">
              <Newsletter data={state.data.newsletter} />
            </Section>
            <Section title="Website">
              <Website data={state.data.web} />
            </Section>
            <Section title="App">
              <AppActivity data={state.data.app} />
            </Section>
          </div>
        </div>
      )}
    </>
  )
}
