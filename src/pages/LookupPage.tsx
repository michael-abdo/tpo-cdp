// /lookup (06 §/lookup, R2): one search box, then one profile in three columns: newsletter,
// website, app. The raw input goes to GET /api/lookup?q= unchanged; the server normalizes it
// (02 §Normalization). Absent sections render the labelled empty states from 06.

import { type FormEvent, useState } from 'react'
import { useSearchParams } from 'react-router'
import { isCold } from '../../shared/derive'
import { Empty, ErrorLine, Field, Loading, Section } from '../components'
import { dateOr, utc } from '../format'
import type { Lookup } from '../types'
import { useGet } from '../useGet'

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

export default function LookupPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q')
  const [input, setInput] = useState(q ?? '')
  const state = useGet<Lookup>(q === null || q.trim() === '' ? null : `/api/lookup?q=${encodeURIComponent(q)}`)

  function submit(e: FormEvent) {
    e.preventDefault()
    setParams(input.trim() === '' ? {} : { q: input })
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Lookup</h1>
      <form onSubmit={submit} className="flex gap-2">
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="email or u_…"
          aria-label="email or u_…"
          className="w-full max-w-md rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded bg-gray-900 px-4 py-2 text-sm text-white">
          Find
        </button>
      </form>
      {state === null && <Empty>Search by email or app user id to see one profile.</Empty>}
      {state?.status === 'loading' && <Loading />}
      {state?.status === 'error' && <ErrorLine message={state.message} />}
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
