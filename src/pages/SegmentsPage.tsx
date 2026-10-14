// /segments (06 §/segments, R3): "Build a list to email". The brief's one-click preset, the filter
// form in plain words, Preview (POST /api/segments/preview), the count as a sentence, Export CSV
// (POST /api/segments/export.csv, run on the filters the shown result came from, so the file always
// matches the count on screen) and a short result table. Level 2 / Technical details (06 §UI
// principles 2–5): per-row Details, and the raw names and formulas of the filters' definitions
// from DEFINITIONS (02 §Derived "one runtime source") with the placeholders-only SQL shape. The
// filters' plain words live only beside each filter (09 D-72): no footer restates them. Status
// defaults to active; the response's hidden_unsubscribed is shown in words when it is above 0.
// The form sends what the inputs hold (02 §Normalization): labels below are display maps only.
// A segment answer or tile on /insights arrives as router state {filters} ("Open segment", 06
// §/insights): the form takes those filters and previews them once, so the count is the builder's.

import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { DEFINITIONS } from '../../shared/derive'
import { CANONICAL_SOURCES } from '../../shared/normalize'
import { SUBSCRIBER_STATUSES, type SubscriberStatus } from '../../worker/ingest/quarantine'
import { ApiError, downloadSegmentCsv, errorMessage, postJson } from '../api'
import {
  Announcer,
  Button,
  type Column,
  ErrorLine,
  Field,
  ICONS,
  Loading,
  PageHeader,
  ResponsiveTable,
  TechnicalDetails,
} from '../components'
import { humanDate } from '../format'
import { COLUMN_LABEL, sourceLabel, statusLabel } from '../labels'
import type { SegmentFilters, SegmentPreview, SegmentRow } from '../types'

/** Rows a preview asks for; the full segment is what Export CSV is for. */
const PREVIEW_LIMIT = 100
/** Rows shown before "Show all … in preview" (principle 2: the rest is one click away). */
const FIRST_ROWS = 10

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

/** The definitions behind the recency filter; only their raw names and formulas show, in Technical details. */
const FILTER_DEFINITIONS = [DEFINITIONS.days_since_open, DEFINITIONS.no_open_in_days]

/** The CSV's columns as the export writes them (04 §Segments). */
const CSV_COLUMNS = 'email, status, source, signup_date, last_open_date, engagement_score, has_app'

/** 04 filters as the form holds them; toFilters(toForm(f)) previews the same readers as f. */
function toForm(f: SegmentFilters): Form {
  return {
    status: f.status.length === 1 ? f.status[0] : 'all',
    sources: f.source ?? [],
    days: f.days_since_open_gte === undefined ? '' : String(f.days_since_open_gte),
    includeNeverOpened: f.days_since_open_gte !== undefined && f.include_never_opened,
    hasApp: f.has_app === null ? 'any' : f.has_app ? 'yes' : 'no',
  }
}

/** Router state set by "Open segment" on /insights. */
function openedFilters(state: unknown): SegmentFilters | null {
  if (typeof state !== 'object' || state === null || !('filters' in state)) return null
  return (state as { filters: SegmentFilters }).filters
}

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
  const cols: Column<SegmentRow>[] = [{ header: COLUMN_LABEL.email, cell: (r) => <span className="break-all">{r.email}</span> }]
  if (filters.status.length > 1) cols.push({ header: COLUMN_LABEL.status, cell: (r) => statusLabel(r.status) })
  if (filters.source?.length !== 1) cols.push({ header: COLUMN_LABEL.source, cell: (r) => sourceLabel(r.source) })
  cols.push(
    { header: COLUMN_LABEL.last_open_date, cell: (r) => (r.last_open_date === null ? 'Never opened' : humanDate(r.last_open_date)) },
    { header: COLUMN_LABEL.engagement_score, cell: (r) => `${fmt(r.engagement_score)} / 100`, numeric: true },
  )
  return cols
}

function RowDetails({ row }: { row: SegmentRow }) {
  return (
    <dl className="space-y-1">
      <Field label={COLUMN_LABEL.signup_date}>{humanDate(row.signup_date)}</Field>
      <Field label={COLUMN_LABEL.source}>{sourceLabel(row.source)}</Field>
      <Field label={COLUMN_LABEL.has_app}>{row.has_app ? 'Yes' : 'No'}</Field>
    </dl>
  )
}

export default function SegmentsPage() {
  const location = useLocation()
  const opened = openedFilters(location.state)
  const [form, setForm] = useState<Form>(() => (opened === null ? DEFAULT_FORM : toForm(opened)))
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

  // Filters opened from /insights preview once per navigation (location.key), StrictMode included.
  const previewedFor = useRef<string | null>(null)
  useEffect(() => {
    if (opened === null || previewedFor.current === location.key) return
    previewedFor.current = location.key
    void preview(toForm(opened))
  }, [opened, location.key])

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
      await downloadSegmentCsv(filters)
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

  const shownRows = ok === null ? 0 : showAll ? ok.data.rows.length : Math.min(FIRST_ROWS, ok.data.rows.length)

  let announcement = countSentence
  if (result?.status === 'loading') announcement = 'Counting matching readers…'
  if (exporting) announcement = 'Preparing download…'

  const labelClass = 'block text-sm font-medium text-gray-900'
  const hintClass = 'text-sm text-gray-600'
  const inputClass = 'block w-full min-h-9 rounded-lg border border-line-strong bg-surface px-2 py-1 text-sm text-ink'

  return (
    <div className="space-y-6">
      <PageHeader
        title="Build a list to email"
        purpose="Choose who to include, see how many readers match, then download the list."
        icon={ICONS.segments}
      />
      <Announcer message={announcement} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-accent-soft px-4 py-3 text-sm">
        <span className="text-gray-700">Not sure where to start?</span>
        <Button variant="quiet" icon={ICONS.next} onClick={applyPreset} className="justify-start text-left">
          Instagram readers who haven't opened in 30 days
        </Button>
      </div>

      <form onSubmit={submit} noValidate className="grid gap-5 rounded-xl border border-line bg-surface p-5 shadow-soft sm:grid-cols-2">
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
              className={`${inputClass.replace("w-full", "")} w-24`}
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
          <Button type="submit" variant={ok === null ? 'primary' : 'secondary'} icon={ICONS.preview} className="px-5">
            Preview
          </Button>
        </div>
      </form>

      {result?.status === 'loading' && <Loading label="Counting matching readers…" />}
      {result?.status === 'error' && (
        <ErrorLine
          message={result.message}
          next={result.invalidFilters ? "Check the “Haven't opened an email in at least” box." : undefined}
        />
      )}
      {ok !== null && (
        <section aria-labelledby="result-heading" className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 id="result-heading" className="font-display text-2xl font-semibold text-gray-900">
                {countSentence}
              </h2>
              {hidden > 0 && (
                <p className={hintClass}>{plural(hidden, 'unsubscribed reader', 'unsubscribed readers')} not shown.</p>
              )}
              {ok.data.count === 0 && (
                <p className={hintClass}>Try fewer days, more places they signed up, or “Either” for Uses the app.</p>
              )}
              {shownRows < ok.data.count && (
                <p className={hintClass}>
                  Showing the first {fmt(shownRows)}. Export CSV downloads the full list.
                </p>
              )}
            </div>
            {ok.data.count > 0 && (
              <Button variant="primary" icon={ICONS.export} onClick={() => void exportCsv(ok.filters)} disabled={exporting}>
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
                rows={ok.data.rows.slice(0, shownRows)}
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

      <div className="border-t border-gray-200 pt-4">
        <TechnicalDetails>
          <p className="font-medium">Definitions (shared/derive.ts)</p>
          {FILTER_DEFINITIONS.map((def) => (
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
      </div>
    </div>
  )
}
