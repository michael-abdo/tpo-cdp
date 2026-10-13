// /segments (06 §/segments, R3): the filter form, Preview (POST /api/segments/preview), Export CSV
// (POST /api/segments/export.csv, downloaded from the response), the brief's one-click preset,
// the result table, the placeholders-only SQL shape and a footer rendered from DEFINITIONS
// (02 §Derived "one runtime source"). Status defaults to active and the response's
// hidden_unsubscribed is shown as "+N unsubscribed hidden" (02 §Defaults).

import { type FormEvent, useState } from 'react'
import { DEFINITIONS } from '../../shared/derive'
import { CANONICAL_SOURCES } from '../../shared/normalize'
import { SUBSCRIBER_STATUSES, type SubscriberStatus } from '../../worker/ingest/quarantine'
import { errorMessage, postJson, request } from '../api'
import { Empty, ErrorLine, Loading } from '../components'
import { dateOr } from '../format'
import type { SegmentFilters, SegmentPreview } from '../types'

/** Rows a preview asks for; the full segment is what Export CSV is for. */
const PREVIEW_LIMIT = 100

/** The form's state: strings and flags as the inputs hold them, turned into 04 filters on submit. */
interface Form {
  /** One status, or 'all' for every status. */
  status: SubscriberStatus | 'all'
  sources: string[]
  /** Blank = no recency filter. */
  days: string
  includeNeverOpened: boolean
  hasApp: 'any' | 'yes' | 'no'
}

const DEFAULT_FORM: Form = { status: 'active', sources: [], days: '', includeNeverOpened: false, hasApp: 'any' }

/** The brief's R3 example (02 §Counts): Instagram, active, no open in 30 days including never-opened. */
const BRIEF_PRESET: Form = { status: 'active', sources: ['instagram'], days: '30', includeNeverOpened: true, hasApp: 'any' }

const FOOTER_DEFINITIONS = [DEFINITIONS.days_since_open, DEFINITIONS.no_open_in_days, DEFINITIONS.cold]

/** The 04 filters object; a days value the server would reject is still sent, so its 400 message shows. */
function toFilters(form: Form): SegmentFilters {
  const days = form.days.trim()
  return {
    status: form.status === 'all' ? [...SUBSCRIBER_STATUSES] : [form.status],
    ...(form.sources.length === 0 ? {} : { source: form.sources }),
    ...(days === '' ? {} : { days_since_open_gte: Number(days) }),
    include_never_opened: days !== '' && form.includeNeverOpened,
    has_app: form.hasApp === 'any' ? null : form.hasApp === 'yes',
  }
}

/** An ok result keeps the filters it was computed for, so the hidden count never describes an edited form. */
type Result =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: SegmentPreview; filters: SegmentFilters }

export default function SegmentsPage() {
  const [form, setForm] = useState<Form>(DEFAULT_FORM)
  const [result, setResult] = useState<Result | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  async function preview(f: Form) {
    setResult({ status: 'loading' })
    try {
      const filters = toFilters(f)
      const data = await postJson<SegmentPreview>('/api/segments/preview', { filters, limit: PREVIEW_LIMIT })
      setResult({ status: 'ok', data, filters })
    } catch (err) {
      setResult({ status: 'error', message: errorMessage(err) })
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    void preview(form)
  }

  function applyPreset() {
    setForm(BRIEF_PRESET)
    void preview(BRIEF_PRESET)
  }

  async function exportCsv() {
    setExporting(true)
    setExportError(null)
    try {
      const res = await request('/api/segments/export.csv', { method: 'POST', body: { filters: toFilters(form) } })
      const url = URL.createObjectURL(await res.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = 'segment.csv'
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setExportError(errorMessage(err))
    } finally {
      setExporting(false)
    }
  }

  function toggleSource(source: string) {
    setForm((f) => ({
      ...f,
      sources: f.sources.includes(source) ? f.sources.filter((s) => s !== source) : [...f.sources, source],
    }))
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Segments</h1>
      <button
        type="button"
        onClick={applyPreset}
        className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50"
      >
        haven't opened in 30 days (the brief's example)
      </button>

      <form onSubmit={submit} className="space-y-3 rounded border border-gray-200 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="status">Status</label>
          <select
            id="status"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as Form['status'] })}
            className="rounded border border-gray-300 px-2 py-1"
          >
            {SUBSCRIBER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value="all">all statuses</option>
          </select>
          {result?.status === 'ok' && !result.filters.status.includes('unsubscribed') && (
            <span className="text-gray-500">(+{result.data.hidden_unsubscribed} unsubscribed hidden)</span>
          )}
        </div>

        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="mb-1">Source (none checked = any source)</legend>
          {CANONICAL_SOURCES.map((s) => (
            <label key={s} className="flex items-center gap-1">
              <input type="checkbox" checked={form.sources.includes(s)} onChange={() => toggleSource(s)} />
              {s}
            </label>
          ))}
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="days">Days since last open ≥</label>
          <input
            id="days"
            type="number"
            min={1}
            step={1}
            value={form.days}
            onChange={(e) => setForm({ ...form, days: e.target.value })}
            placeholder="any"
            className="w-20 rounded border border-gray-300 px-2 py-1"
          />
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={form.includeNeverOpened}
              disabled={form.days.trim() === ''}
              onChange={(e) => setForm({ ...form, includeNeverOpened: e.target.checked })}
            />
            include never opened
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="has-app">Has app</label>
          <select
            id="has-app"
            value={form.hasApp}
            onChange={(e) => setForm({ ...form, hasApp: e.target.value as Form['hasApp'] })}
            className="rounded border border-gray-300 px-2 py-1"
          >
            <option value="any">any</option>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </div>

        <div className="flex gap-2">
          <button type="submit" className="rounded bg-gray-900 px-4 py-1.5 text-white">
            Preview
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting}
            className="rounded border border-gray-300 px-4 py-1.5 disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
        {exportError !== null && <ErrorLine message={exportError} />}
      </form>

      {result === null && <Empty>Set the filters and press Preview, or use the preset above.</Empty>}
      {result?.status === 'loading' && <Loading />}
      {result?.status === 'error' && <ErrorLine message={result.message} />}
      {result?.status === 'ok' && (
        <section className="space-y-3">
          <h2 className="font-semibold">
            Result: {result.data.count.toLocaleString('en-US')} subscribers
            {result.data.rows.length < result.data.count && (
              <span className="font-normal text-gray-500"> (showing the first {result.data.rows.length})</span>
            )}
          </h2>
          {result.data.rows.length === 0 ? (
            <Empty>No subscribers match these filters.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-gray-200 text-gray-500">
                  <tr>
                    <th className="py-1 pr-4">email</th>
                    <th className="py-1 pr-4">status</th>
                    <th className="py-1 pr-4">source</th>
                    <th className="py-1 pr-4">signup</th>
                    <th className="py-1 pr-4">last open</th>
                    <th className="py-1 pr-4">score</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.rows.map((row) => (
                    <tr key={row.email} className="border-b border-gray-100">
                      <td className="py-1 pr-4">{row.email}</td>
                      <td className="py-1 pr-4">{row.status}</td>
                      <td className="py-1 pr-4">{row.source ?? 'none'}</td>
                      <td className="py-1 pr-4">{row.signup_date}</td>
                      <td className="py-1 pr-4">{dateOr(row.last_open_date, 'never')}</td>
                      <td className="py-1 pr-4">{row.engagement_score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-gray-600">SQL shape (placeholders only)</summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-xs">
              {result.data.sql_shape}
            </pre>
          </details>
        </section>
      )}

      <footer className="space-y-1 border-t border-gray-200 pt-3 text-xs text-gray-600">
        {FOOTER_DEFINITIONS.map((d) => (
          <p key={d.name}>
            <span className="font-mono">{d.name}</span>: {d.doc}
          </p>
        ))}
      </footer>
    </>
  )
}
