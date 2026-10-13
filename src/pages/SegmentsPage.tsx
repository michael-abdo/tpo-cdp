// /segments (06 §/segments, R3): "Build a list to email". The brief's one-click preset, the filter
// form in plain words, Preview (POST /api/segments/preview), the count as a sentence, Export CSV
// (POST /api/segments/export.csv, run on the filters the shown result came from, so the file always
// matches the count on screen) and a short result table. Level 2 / Technical details (06 §UI
// principles 2–5): per-row Details, "How these filters work" with the definitions from DEFINITIONS
// (02 §Derived "one runtime source"), raw names and the placeholders-only SQL shape. Status
// defaults to active; the response's hidden_unsubscribed is shown in words when it is above 0.
// The form sends what the inputs hold (02 §Normalization): labels below are display maps only.

import { type FormEvent, useState } from 'react'
import { DEFINITIONS } from '../../shared/derive'
import { CANONICAL_SOURCES } from '../../shared/normalize'
import { SUBSCRIBER_STATUSES, type SubscriberStatus } from '../../worker/ingest/quarantine'
import { ApiError, errorMessage, postJson, request } from '../api'
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
  TechnicalDetails,
} from '../components'
import type { SegmentFilters, SegmentPreview, SegmentRow } from '../types'

/** Rows a preview asks for; the full segment is what Export CSV is for. */
const PREVIEW_LIMIT = 100
/** Rows shown before "Show all … in preview" (principle 2: the rest is one click away). */
const FIRST_ROWS = 10

/** Display words for the stored values; the values sent to the API stay as they are. */
const SOURCE_LABEL: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  referral: 'Referral',
  google: 'Google',
  direct: 'Direct',
  podcast: 'Podcast',
  x: 'X',
}
const STATUS_LABEL: Record<string, string> = { active: 'Active', unsubscribed: 'Unsubscribed' }

const sourceLabel = (s: string | null) => (s === null ? 'Unknown' : (SOURCE_LABEL[s] ?? s))
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s

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

/** The footer definitions, each with a plain heading; the raw name shows only in Technical details. */
const FOOTER_DEFINITIONS = [
  { label: 'Days since last open', def: DEFINITIONS.days_since_open },
  { label: "Haven't opened in N days", def: DEFINITIONS.no_open_in_days },
  { label: 'Cold', def: DEFINITIONS.cold },
]

/** The CSV's columns as the export writes them (04 §Segments). */
const CSV_COLUMNS = 'email, status, source, signup_date, last_open_date, engagement_score, has_app'

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

/** An ok result keeps the filters it was computed for, so its notes and the export never describe an edited form. */
type Result =
  | { status: 'loading' }
  | { status: 'error'; message: string; invalidFilters: boolean }
  | { status: 'ok'; data: SegmentPreview; filters: SegmentFilters }

const fmt = (n: number) => n.toLocaleString('en-US')
const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`

/** The table's columns: a column whose every row would repeat the filter is left out (principle 5). */
function columnsFor(filters: SegmentFilters): Column<SegmentRow>[] {
  const cols: Column<SegmentRow>[] = [{ header: 'Email', cell: (r) => <span className="break-all">{r.email}</span> }]
  if (filters.status.length > 1) cols.push({ header: 'Status', cell: (r) => statusLabel(r.status) })
  if (filters.source?.length !== 1) cols.push({ header: 'Signed up from', cell: (r) => sourceLabel(r.source) })
  cols.push(
    { header: 'Last opened', cell: (r) => r.last_open_date ?? 'Never opened' },
    { header: 'Engagement', cell: (r) => `${fmt(r.engagement_score)} / 100`, numeric: true },
  )
  return cols
}

function RowDetails({ row }: { row: SegmentRow }) {
  return (
    <dl className="space-y-1">
      <Field label="Signed up">{row.signup_date}</Field>
      <Field label="Signed up from">{sourceLabel(row.source)}</Field>
      <Field label="Uses the app">{row.has_app ? 'Yes' : 'No'}</Field>
    </dl>
  )
}

export default function SegmentsPage() {
  const [form, setForm] = useState<Form>(DEFAULT_FORM)
  const [result, setResult] = useState<Result | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  async function preview(f: Form) {
    setResult({ status: 'loading' })
    setShowAll(false)
    setExportError(null)
    try {
      const filters = toFilters(f)
      const data = await postJson<SegmentPreview>('/api/segments/preview', { filters, limit: PREVIEW_LIMIT })
      setResult({ status: 'ok', data, filters })
    } catch (err) {
      setResult({
        status: 'error',
        message: errorMessage(err),
        invalidFilters: err instanceof ApiError && err.code === 'invalid_filters',
      })
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

  async function exportCsv(filters: SegmentFilters) {
    setExporting(true)
    setExportError(null)
    try {
      const res = await request('/api/segments/export.csv', { method: 'POST', body: { filters } })
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

  const daysBlank = form.days.trim() === ''
  const ok = result?.status === 'ok' ? result : null
  const hidden = ok !== null && !ok.filters.status.includes('unsubscribed') ? ok.data.hidden_unsubscribed : 0
  const countSentence = ok === null ? '' : ok.data.count === 0 ? 'No readers match' : `${plural(ok.data.count, 'reader matches', 'readers match')}`

  let announcement = countSentence
  if (result?.status === 'loading') announcement = 'Counting matching readers…'
  if (exporting) announcement = 'Preparing download…'

  const labelClass = 'block text-sm font-medium text-gray-900'
  const hintClass = 'text-sm text-gray-600'
  const inputClass = 'min-h-9 rounded border border-gray-300 bg-white px-2 py-1 text-sm'

  return (
    <div className="space-y-6">
      <PageHeader
        title="Build a list to email"
        purpose="Choose who to include, see how many readers match, then download the list."
      />
      <Announcer message={announcement} />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-gray-700">Not sure where to start? Try the brief's example:</span>
        <Button onClick={applyPreset}>haven't opened in 30 days (the brief's example)</Button>
      </div>

      <form onSubmit={submit} noValidate className="grid gap-5 rounded border border-gray-200 p-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="status" className={labelClass}>
            Status
          </label>
          <select
            id="status"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as Form['status'] })}
            className={inputClass}
          >
            {SUBSCRIBER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
            <option value="all">Everyone (including unsubscribed)</option>
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="has-app" className={labelClass}>
            Uses the app
          </label>
          <select
            id="has-app"
            value={form.hasApp}
            onChange={(e) => setForm({ ...form, hasApp: e.target.value as Form['hasApp'] })}
            className={inputClass}
          >
            <option value="any">Either</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>

        <fieldset className="space-y-1 sm:col-span-2" aria-describedby="sources-hint">
          <legend className={labelClass}>Where they signed up</legend>
          <p id="sources-hint" className={hintClass}>
            Leave all unchecked for any.
          </p>
          <div className="flex flex-wrap gap-x-4">
            {CANONICAL_SOURCES.map((s) => (
              <label key={s} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={form.sources.includes(s)}
                  onChange={() => toggleSource(s)}
                />
                {sourceLabel(s)}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="space-y-1 sm:col-span-2">
          <label htmlFor="days" className={labelClass}>
            Haven't opened an email in at least
          </label>
          <div className="flex items-center gap-2">
            <input
              id="days"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={form.days}
              onChange={(e) => setForm({ ...form, days: e.target.value })}
              aria-describedby="days-hint"
              className={`${inputClass} w-24`}
            />
            <span className="text-sm text-gray-700">days</span>
          </div>
          <p id="days-hint" className={hintClass}>
            Leave blank for anyone. Otherwise enter a whole number, 1 or more.
          </p>
          <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm has-disabled:cursor-not-allowed has-disabled:text-gray-500">
            <input
              type="checkbox"
              className="size-4"
              checked={form.includeNeverOpened}
              disabled={daysBlank}
              aria-describedby={daysBlank ? 'never-hint' : undefined}
              onChange={(e) => setForm({ ...form, includeNeverOpened: e.target.checked })}
            />
            Also include people who never opened
          </label>
          {daysBlank && (
            <p id="never-hint" className={hintClass}>
              Enter a number of days first.
            </p>
          )}
        </div>

        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" className="px-5">
            Preview
          </Button>
        </div>
      </form>

      {result === null && (
        <EmptyState>Choose who to include, then press Preview, or start from the brief's example above.</EmptyState>
      )}
      {result?.status === 'loading' && <Loading label="Counting matching readers…" />}
      {result?.status === 'error' && (
        <ErrorLine
          message={result.message}
          next={
            result.invalidFilters
              ? "Check the “Haven't opened an email in at least” box: enter a whole number, 1 or more, or leave it blank."
              : undefined
          }
        />
      )}
      {ok !== null && (
        <section aria-labelledby="result-heading" className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 id="result-heading" className="text-lg font-semibold text-gray-900">
                {countSentence}
              </h2>
              {hidden > 0 && (
                <p className={hintClass}>{plural(hidden, 'unsubscribed reader', 'unsubscribed readers')} not shown.</p>
              )}
              {ok.data.count === 0 && (
                <p className={hintClass}>Try fewer days, more places they signed up, or “Either” for Uses the app.</p>
              )}
              {ok.data.rows.length < ok.data.count && (
                <p className={hintClass}>
                  Showing {fmt(ok.data.rows.length)} of {fmt(ok.data.count)}. Export CSV downloads all {fmt(ok.data.count)}.
                </p>
              )}
            </div>
            {ok.data.count > 0 && (
              <Button onClick={() => void exportCsv(ok.filters)} disabled={exporting}>
                {exporting ? 'Preparing download…' : 'Export CSV'}
              </Button>
            )}
          </div>
          {exportError !== null && <ErrorLine message={exportError} next="Press Export CSV to try again." />}

          {ok.data.rows.length > 0 && (
            <>
              <ResponsiveTable
                caption="Matching readers"
                columns={columnsFor(ok.filters)}
                rows={showAll ? ok.data.rows : ok.data.rows.slice(0, FIRST_ROWS)}
                rowKey={(r) => r.email}
                details={(r) => <RowDetails row={r} />}
              />
              {!showAll && ok.data.rows.length > FIRST_ROWS && (
                <Button onClick={() => setShowAll(true)}>Show all {fmt(ok.data.rows.length)} in preview</Button>
              )}
            </>
          )}
        </section>
      )}

      <Disclosure label="How these filters work" className="border-t border-gray-200 pt-4">
        <dl className="space-y-2 text-sm">
          {FOOTER_DEFINITIONS.map(({ label, def }) => (
            <div key={def.name}>
              <dt className="font-medium text-gray-900">{label}</dt>
              <dd className="text-gray-700">{def.doc}</dd>
            </div>
          ))}
        </dl>
        <TechnicalDetails>
          <p className="font-medium">Definitions (shared/derive.ts)</p>
          {FOOTER_DEFINITIONS.map(({ def }) => (
            <p key={def.name}>
              <span className="font-mono">{def.name}</span>: <span className="font-mono">{def.formula}</span>
            </p>
          ))}
          <p>
            Preview shows at most {PREVIEW_LIMIT} rows. CSV columns: <span className="font-mono">{CSV_COLUMNS}</span>
          </p>
          {ok !== null && (
            <>
              <p className="pt-2 font-medium">SQL shape (placeholders only)</p>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono">{ok.data.sql_shape}</pre>
            </>
          )}
        </TechnicalDetails>
      </Disclosure>
    </div>
  )
}
