// /segments (06 §/segments, R3; 09 D-69, 19-segments-spec §2 and §7): "Build a segment". Previous
// searches first (the last 5 filter objects this browser previewed, named by segmentLabel, with the
// brief's example always there and tagged), then the filter form in plain words: the basic filters
// and "More filters", grouped as the brief groups a subscriber (Newsletter info, Site visits, App
// activity). More filters starts open, so went cold, new subscribers and site visits (the brief's
// Growth questions) are one choice away; it still collapses (19 §7 note, 2026-10-14). A search run
// from Previous searches or "Open list" shows its count beside the list, with a link down to the
// result and Export CSV, and focus stays on the clicked item (19 §2). Preview (POST
// /api/segments/preview) shows the count as a sentence and the segment's name; Export CSV (POST
// /api/segments/export.csv) runs on the filters the server echoed for the shown result, so the
// file always matches the count on screen. Level 2 / Technical details (06 §UI principles 2–5):
// per-row Details, "How these filters work" with the definitions from DEFINITIONS (02 §Derived
// "one runtime source"), raw names and the placeholders-only SQL shape. Status defaults to active;
// the response's hidden_unsubscribed is shown in words when it is above 0. The form sends what
// the inputs hold (02 §Normalization): labels are display maps only, and the page choices come
// from GET /api/segments/options. A segment from Insights or an AI answer arrives as router state
// {filters} ("Open list", 06 §/insights): the form takes those filters and previews them once.
// Every 200 preview records the echoed filters in Previous searches (src/previous-searches.ts);
// a click on one re-runs it, so every count shown is live (03 §No-restart).

import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { APP_EVENTS, type AppEventName } from '../../shared/app-events'
import { TODAY } from '../../shared/config'
import { DEFINITIONS, type DefinitionKey, NEW_SUBSCRIBER_DAYS } from '../../shared/derive'
import { CANONICAL_SOURCES } from '../../shared/normalize'
import { SUBSCRIBER_STATUSES, type SubscriberStatus } from '../../worker/ingest/quarantine'
import { ApiError, downloadSegmentCsv, errorMessage, postJson } from '../api'
import {
  Announcer,
  Button,
  type Column,
  Disclosure,
  EmptyState,
  ErrorLine,
  Field,
  ICONS,
  Icon,
  InfoTip,
  Loading,
  PageHeader,
  ResponsiveTable,
  Tag,
  TechnicalDetails,
} from '../components'
import { humanDate } from '../format'
import { COLUMN_LABEL, DEFINITION_LABEL, EVENT_LABEL, monthLabel, segmentLabel, sourceLabel, statusLabel } from '../labels'
import { clearSearches, type PreviousSearch, readSearches, recordSearch, visibleSearches } from '../previous-searches'
import type { SegmentFilters, SegmentOptions, SegmentPreview, SegmentRow } from '../types'
import { useGet } from '../useGet'

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
  // More filters: blank = not set.
  signedUpDays: string
  /** '', 'any' or a `YYYY-MM` month. */
  wentCold: string
  engagementFrom: string
  engagementTo: string
  siteDays: string
  sitePage: string
  appDays: string
  appEvent: AppEventName | ''
}

const DEFAULT_FORM: Form = {
  status: 'active',
  sources: [],
  days: '',
  includeNeverOpened: false,
  hasApp: 'any',
  signedUpDays: '',
  wentCold: '',
  engagementFrom: '',
  engagementTo: '',
  siteDays: '',
  sitePage: '',
  appDays: '',
  appEvent: '',
}

/** The footer definitions, each under its plain heading (DEFINITION_LABEL); the raw name shows only in Technical details. */
const FOOTER_DEFINITIONS: readonly DefinitionKey[] = ['days_since_open', 'no_open_in_days', 'cold', 'went_cold_in', 'new_subscriber', 'engagement_score']

/** The CSV's columns as the export writes them (04 §Segments). */
const CSV_COLUMNS = 'email, status, source, signup_date, last_open_date, engagement_score, has_app'

const text = (n: number | undefined) => (n === undefined ? '' : String(n))

/** 04 filters as the form holds them; toFilters(toForm(f)) previews the same subscribers as f. */
function toForm(f: SegmentFilters): Form {
  return {
    status: f.status.length === 1 ? f.status[0] : 'all',
    sources: f.source ?? [],
    days: text(f.days_since_open_gte),
    includeNeverOpened: f.days_since_open_gte !== undefined && f.include_never_opened,
    hasApp: f.has_app === null || f.has_app === undefined ? 'any' : f.has_app ? 'yes' : 'no',
    signedUpDays: text(f.signed_up_within_days),
    wentCold: f.went_cold ?? '',
    engagementFrom: text(f.engagement_gte),
    engagementTo: text(f.engagement_lte),
    siteDays: text(f.site_visit_within_days),
    sitePage: f.site_visit_page ?? '',
    appDays: text(f.app_active_within_days),
    appEvent: f.app_event ?? '',
  }
}

/** Router state set by "Open list" on Insights or an AI answer. */
function openedFilters(state: unknown): SegmentFilters | null {
  if (typeof state !== 'object' || state === null || !('filters' in state)) return null
  return (state as { filters: SegmentFilters }).filters
}

/** A number box as sent: blank = absent; anything else is sent as typed, so the server's 400 shows. */
function num(value: string): number | undefined {
  const v = value.trim()
  return v === '' ? undefined : Number(v)
}

/** The 04 filters object; only set keys are sent, so an empty More filters adds nothing. */
function toFilters(form: Form): SegmentFilters {
  const days = num(form.days)
  const more: Partial<SegmentFilters> = {
    signed_up_within_days: num(form.signedUpDays),
    went_cold: form.wentCold === '' ? undefined : form.wentCold,
    engagement_gte: num(form.engagementFrom),
    engagement_lte: num(form.engagementTo),
    site_visit_within_days: num(form.siteDays),
    site_visit_page: form.sitePage === '' ? undefined : form.sitePage,
    app_active_within_days: num(form.appDays),
    app_event: form.appEvent === '' ? undefined : form.appEvent,
  }
  return {
    status: form.status === 'all' ? [...SUBSCRIBER_STATUSES] : [form.status],
    ...(form.sources.length === 0 ? {} : { source: form.sources }),
    ...(days === undefined ? {} : { days_since_open_gte: days }),
    include_never_opened: days !== undefined && form.includeNeverOpened,
    has_app: form.hasApp === 'any' ? null : form.hasApp === 'yes',
    ...Object.fromEntries(Object.entries(more).filter(([, v]) => v !== undefined)),
  }
}

/** How many of the five More filters are set: engagement, signed up, went cold, site visits, app activity. */
function moreFiltersOn(f: Form): number {
  return [
    f.engagementFrom.trim() !== '' || f.engagementTo.trim() !== '',
    f.signedUpDays.trim() !== '',
    f.wentCold !== '',
    f.siteDays.trim() !== '' || f.sitePage !== '',
    f.appDays.trim() !== '' || f.appEvent !== '',
  ].filter(Boolean).length
}

/** Went cold months built from TODAY: this month and the two before it (19-segments-spec §3). */
function coldMonthOptions(): { value: string; label: string }[] {
  const [y, m] = TODAY.split('-').map(Number)
  return [' (this month)', ' (last month)', ''].map((note, back) => {
    const value = new Date(Date.UTC(y, m - 1 - back, 1)).toISOString().slice(0, 7)
    return { value, label: `${monthLabel(value, 'short')}${note}` }
  })
}

/** An ok result keeps the filters the server echoed, so its notes and the export never describe an edited form. */
type Result =
  | { status: 'loading' }
  | { status: 'error'; message: string; invalidFilters: boolean }
  | { status: 'ok'; data: SegmentPreview; filters: SegmentFilters }

const fmt = (n: number) => n.toLocaleString('en-US')
const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`
/** The result heading and the Announcer's words for a count. */
const countSentence = (count: number) => (count === 0 ? 'No subscribers match' : plural(count, 'subscriber matches', 'subscribers match'))

/** Where the shown preview was started: the form's Preview button, a previous search, or "Open list". */
type Origin = 'form' | 'previous' | 'opened'

/** The id of the result heading and of the preview's error line, which SearchOutcome links to. */
const RESULT_HEADING_ID = 'result-heading'
const PREVIEW_ERROR_ID = 'preview-error'

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

/** The matching subscribers as a table (cards on phones), each row with its Details. */
const labelClass = 'block text-sm font-medium text-gray-900'
const groupClass = 'text-sm font-semibold text-ink'
const hintClass = 'text-sm text-gray-600'
const inputClass = 'block w-full min-h-9 rounded-lg border border-line-strong bg-surface px-2 py-1 text-sm text-ink'
const numberClass = 'block min-h-9 w-24 rounded-lg border border-line-strong bg-surface px-2 py-1 text-sm text-ink'

/**
 * The level-1 words under "Signed up in the last" (19 §3 row 2, "30 = new subscribers"; 06
 * §Vocabulary): the brief's "new subscribers" is a number of days here, so the page names it
 * without the InfoTip. The 30 is DEFINITIONS.new_subscriber's window (NEW_SUBSCRIBER_DAYS).
 */
export const NEW_SUBSCRIBERS_HINT = `${NEW_SUBSCRIBER_DAYS} days = new subscribers.`

/**
 * A "… in the last N days" number box. `tip` is an InfoTip beside its label; `hint` is a line of
 * level-1 words under the box, tied to the input by aria-describedby.
 */
export function DaysBox({
  id,
  label,
  value,
  onChange,
  tip,
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  tip?: ReactNode
  hint?: string
}) {
  const hintId = `${id}-hint`
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <label htmlFor={id} className={labelClass}>
          {label}
        </label>
        {tip}
      </div>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hint === undefined ? undefined : hintId}
          className={numberClass}
        />
        <span className="text-sm text-gray-700">days</span>
      </div>
      {hint !== undefined && (
        <p id={hintId} className={hintClass}>
          {hint}
        </p>
      )}
    </div>
  )
}

export function MatchingRows({ filters, rows }: { filters: SegmentFilters; rows: SegmentRow[] }) {
  return (
    <ResponsiveTable
      caption="Matching subscribers"
      columns={columnsFor(filters)}
      rows={rows}
      rowKey={(r) => r.email}
      details={(r) => <RowDetails row={r} />}
    />
  )
}

export function RowDetails({ row }: { row: SegmentRow }) {
  return (
    <dl className="space-y-1">
      <Field label={COLUMN_LABEL.signup_date}>{humanDate(row.signup_date)}</Field>
      <Field label={COLUMN_LABEL.source}>{sourceLabel(row.source)}</Field>
      <Field label="App account">{row.has_app ? 'Yes' : 'No'}</Field>
    </dl>
  )
}

/**
 * What a search started from Previous searches or "Open list" gave, shown beside the list: the
 * result sits below the form, often below the fold, and focus stays on the clicked item (19 §2),
 * so the count and the way to Export CSV must be visible where the click was. Not a live region:
 * the page's Announcer already reads the count. The link moves to the result heading, from which
 * Tab reaches Export CSV.
 */
export type Outcome = { status: 'loading' } | { status: 'ok'; count: number } | { status: 'error' }

export function SearchOutcome({ outcome }: { outcome: Outcome }) {
  const linkClass = 'font-medium text-accent-strong underline underline-offset-4 hover:text-accent'
  return (
    <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink" data-testid="search-outcome">
      {outcome.status === 'loading' && 'Counting matching subscribers…'}
      {outcome.status === 'ok' && (
        <>
          <span className="font-semibold">{countSentence(outcome.count)}.</span>{' '}
          <a href={`#${RESULT_HEADING_ID}`} className={linkClass}>
            {outcome.count === 0 ? 'See the result' : 'See them and export the CSV'}
          </a>
        </>
      )}
      {outcome.status === 'error' && (
        <>
          This search didn't run.{' '}
          <a href={`#${PREVIEW_ERROR_ID}`} className={linkClass}>
            See why
          </a>
        </>
      )}
    </p>
  )
}

/**
 * Previous searches (19-segments-spec §2): one button per search, named by segmentLabel, with the
 * brief's example tagged. Labels wrap, never truncate; nothing is hover-only.
 */
function PreviousSearches({
  rows,
  hasStored,
  outcome,
  onRun,
  onClear,
  buttonRef,
  headingRef,
}: {
  rows: PreviousSearch[]
  hasStored: boolean
  /** The outcome of the search last run from here or from "Open list"; null after a form Preview. */
  outcome: Outcome | null
  onRun: (row: PreviousSearch) => void
  onClear: () => void
  buttonRef: (key: string, el: HTMLButtonElement | null) => void
  headingRef: RefObject<HTMLHeadingElement | null>
}) {
  return (
    <section aria-labelledby="previous-heading" className="space-y-2 rounded-xl border border-line bg-surface p-4 shadow-soft sm:p-5">
      <div className="flex items-center gap-1.5">
        <Icon icon={ICONS.history} className="size-4 text-accent" />
        <h2 id="previous-heading" ref={headingRef} tabIndex={-1} className="font-semibold text-ink focus:outline-none">
          Previous searches
        </h2>
        <InfoTip term="previous_searches" />
      </div>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              ref={(el) => buttonRef(row.key, el)}
              onClick={() => onRun(row)}
              className="flex min-h-9 w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2"
            >
              <Icon icon={ICONS.next} className="mt-0.5 size-4 text-accent" />
              <span className="min-w-0">
                <span className="font-medium text-accent-strong">{segmentLabel(row.filters)}</span>
                {row.example && (
                  <span className="ml-2 inline-flex align-middle">
                    <Tag tone="neutral">
                      <span className="sr-only"> (</span>the brief's example<span className="sr-only">)</span>
                    </Tag>
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {outcome !== null && <SearchOutcome outcome={outcome} />}
      {hasStored && (
        <div className="flex justify-end">
          <Button variant="quiet" onClick={onClear}>
            Clear previous searches
          </Button>
        </div>
      )}
    </section>
  )
}

export default function SegmentsPage() {
  const location = useLocation()
  const opened = openedFilters(location.state)
  const [form, setForm] = useState<Form>(() => (opened === null ? DEFAULT_FORM : toForm(opened)))
  // Open from the start (19 §7 note): the brief's Growth filters sit here; the toggle still collapses it.
  const [moreOpen, setMoreOpen] = useState(true)
  const [result, setResult] = useState<Result | null>(null)
  const [origin, setOrigin] = useState<Origin>('form')
  const [showAll, setShowAll] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [stored, setStored] = useState<SegmentFilters[]>(() => readSearches())
  const [cleared, setCleared] = useState(false)
  const options = useGet<SegmentOptions>('/api/segments/options')

  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const focusKey = useRef<string | null>(null)
  const previousHeading = useRef<HTMLHeadingElement>(null)

  // After a click the search moves to the top (React moves its button); focus returns to it by key.
  useEffect(() => {
    const key = focusKey.current
    if (key === null) return
    focusKey.current = null
    buttons.current.get(key)?.focus()
  }, [stored])

  async function preview(filters: SegmentFilters, from: Origin) {
    setOrigin(from)
    setResult({ status: 'loading' })
    setShowAll(false)
    setExportError(null)
    setCleared(false)
    try {
      const data = await postJson<SegmentPreview>('/api/segments/preview', { filters, limit: PREVIEW_LIMIT })
      setResult({ status: 'ok', data, filters: data.filters })
      setStored(recordSearch(data.filters))
    } catch (err) {
      focusKey.current = null
      setResult({
        status: 'error',
        message: errorMessage(err),
        invalidFilters: err instanceof ApiError && err.code === 'invalid_filters',
      })
    }
  }

  /** Fills the form with filters (opening More filters when one is set) and previews them. */
  function load(filters: SegmentFilters, from: Origin) {
    const next = toForm(filters)
    setForm(next)
    if (moreFiltersOn(next) > 0) setMoreOpen(true)
    void preview(toFilters(next), from)
  }

  // Filters opened from Insights or an AI answer preview once per navigation (location.key), StrictMode included.
  const previewedFor = useRef<string | null>(null)
  useEffect(() => {
    if (opened === null || previewedFor.current === location.key) return
    previewedFor.current = location.key
    void preview(toFilters(toForm(opened)), 'opened')
  }, [opened, location.key])

  function submit(e: FormEvent) {
    e.preventDefault()
    void preview(toFilters(form), 'form')
  }

  function runPrevious(row: PreviousSearch) {
    focusKey.current = row.key
    load(row.filters, 'previous')
  }

  function clearPrevious() {
    clearSearches()
    setStored(readSearches())
    setCleared(true)
    previousHeading.current?.focus()
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
  const heading = ok === null ? '' : countSentence(ok.data.count)
  const outcome: Outcome | null =
    // Hidden after Clear: the list it sat under changed, and the result below still shows the count.
    result === null || origin === 'form' || cleared
      ? null
      : result.status === 'ok'
        ? { status: 'ok', count: result.data.count }
        : { status: result.status }
  const moreOn = moreFiltersOn(form)
  const shownRows = ok === null ? 0 : showAll ? ok.data.rows.length : Math.min(FIRST_ROWS, ok.data.rows.length)

  let announcement = heading
  // While loading, <Loading> is the one live region that says so; the Announcer stays quiet.
  if (result?.status === 'loading') announcement = ''
  if (exporting) announcement = 'Preparing download…'
  if (cleared) announcement = 'Previous searches cleared.'

  // A value loaded from a previous search or a pin stays choosable even when it is not in today's list.
  const pages = options?.status === 'ok' ? options.data.pages : []
  const pageChoices = form.sitePage === '' || pages.includes(form.sitePage) ? pages : [form.sitePage, ...pages]
  const monthChoices = coldMonthOptions()
  if (form.wentCold !== '' && form.wentCold !== 'any' && !monthChoices.some((c) => c.value === form.wentCold)) {
    monthChoices.push({ value: form.wentCold, label: monthLabel(form.wentCold, 'short') })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Build a segment"
        purpose="Choose who to include, see how many subscribers match, then export the CSV."
        icon={ICONS.segments}
      />
      <Announcer message={announcement} />

      <PreviousSearches
        rows={visibleSearches(stored)}
        hasStored={stored.length > 0}
        outcome={outcome}
        onRun={runPrevious}
        onClear={clearPrevious}
        headingRef={previousHeading}
        buttonRef={(key, el) => {
          if (el === null) buttons.current.delete(key)
          else buttons.current.set(key, el)
        }}
      />

      <form
        onSubmit={submit}
        noValidate
        aria-label="Filters"
        className="grid gap-5 rounded-xl border border-line bg-surface p-5 shadow-soft sm:grid-cols-2"
      >
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
            App account
          </label>
          <select
            id="has-app"
            value={form.hasApp}
            onChange={(e) => setForm({ ...form, hasApp: e.target.value as Form['hasApp'] })}
            className={inputClass}
          >
            <option value="any">Either</option>
            <option value="yes">Has an app account</option>
            <option value="no">No app account</option>
          </select>
        </div>

        <fieldset className="space-y-1 sm:col-span-2" aria-describedby="sources-hint">
          <legend className={labelClass}>Acquisition source</legend>
          <p id="sources-hint" className={hintClass}>
            Leave all unchecked for any.
          </p>
          <div className="flex flex-wrap gap-x-4">
            {CANONICAL_SOURCES.map((s) => (
              <label key={s} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" className="size-4" checked={form.sources.includes(s)} onChange={() => toggleSource(s)} />
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
              className={numberClass}
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

        <Disclosure
          label={moreOn === 0 ? 'More filters' : `More filters (${moreOn} on)`}
          open={moreOpen}
          onOpenChange={setMoreOpen}
          className="sm:col-span-2"
        >
          <div className="space-y-5 pt-1">
            <fieldset className="space-y-1">
              <legend className="flex items-center gap-1">
                <span className={groupClass}>Engagement</span>
                <InfoTip term="engagement_score" />
              </legend>
              <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
                <label htmlFor="engagement-from">from</label>
                <input
                  id="engagement-from"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  inputMode="numeric"
                  value={form.engagementFrom}
                  onChange={(e) => setForm({ ...form, engagementFrom: e.target.value })}
                  aria-describedby="engagement-hint"
                  className={numberClass}
                />
                <label htmlFor="engagement-to">to</label>
                <input
                  id="engagement-to"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  inputMode="numeric"
                  value={form.engagementTo}
                  onChange={(e) => setForm({ ...form, engagementTo: e.target.value })}
                  aria-describedby="engagement-hint"
                  className={numberClass}
                />
              </div>
              <p id="engagement-hint" className={hintClass}>
                0 to 100. Leave either blank for no limit.
              </p>
            </fieldset>

            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className={`${groupClass} mb-2`}>Newsletter info</legend>
              <DaysBox
                id="signed-up-days"
                label="Signed up in the last"
                value={form.signedUpDays}
                onChange={(v) => setForm({ ...form, signedUpDays: v })}
                tip={<InfoTip term="new_subscriber" />}
                hint={NEW_SUBSCRIBERS_HINT}
              />
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <label htmlFor="went-cold" className={labelClass}>
                    Went cold
                  </label>
                  <InfoTip term="cold" />
                </div>
                <select
                  id="went-cold"
                  value={form.wentCold}
                  onChange={(e) => setForm({ ...form, wentCold: e.target.value })}
                  className={inputClass}
                >
                  <option value="">Don't filter</option>
                  <option value="any">Any time (cold now)</option>
                  {monthChoices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>

            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className={`${groupClass} mb-2`}>Site visits</legend>
              <DaysBox id="site-days" label="Visited the site in the last" value={form.siteDays} onChange={(v) => setForm({ ...form, siteDays: v })} />
              <div className="space-y-1">
                <label htmlFor="site-page" className={labelClass}>
                  Page
                </label>
                <select
                  id="site-page"
                  value={form.sitePage}
                  onChange={(e) => setForm({ ...form, sitePage: e.target.value })}
                  aria-describedby={options?.status === 'error' ? 'site-page-error' : undefined}
                  className={inputClass}
                >
                  <option value="">Any page</option>
                  {pageChoices.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                {options?.status === 'loading' && <p className={hintClass}>Loading pages…</p>}
                {options?.status === 'error' && (
                  <ErrorLine id="site-page-error" message={options.message} next="Reload the page to try again." />
                )}
              </div>
            </fieldset>

            <fieldset className="grid gap-4 sm:grid-cols-2" aria-describedby="app-hint">
              <legend className={`${groupClass} mb-1`}>App activity</legend>
              <p id="app-hint" className={`${hintClass} sm:col-span-2`}>
                Comes from live app events, so it counts only what the app has sent.
              </p>
              <DaysBox id="app-days" label="Used the app in the last" value={form.appDays} onChange={(v) => setForm({ ...form, appDays: v })} />
              <div className="space-y-1">
                <label htmlFor="app-event" className={labelClass}>
                  Event
                </label>
                <select
                  id="app-event"
                  value={form.appEvent}
                  onChange={(e) => setForm({ ...form, appEvent: e.target.value as Form['appEvent'] })}
                  className={inputClass}
                >
                  <option value="">Any event</option>
                  {APP_EVENTS.map((e) => (
                    <option key={e} value={e}>
                      {e} ({EVENT_LABEL[e]})
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>
          </div>
        </Disclosure>

        <div className="sm:col-span-2">
          <Button type="submit" variant={ok === null ? 'primary' : 'secondary'} icon={ICONS.preview} className="w-full px-5 sm:w-auto">
            Preview
          </Button>
        </div>
      </form>

      {result === null && (
        <EmptyState icon={ICONS.segments}>Choose who to include, then press Preview, or start from a previous search above.</EmptyState>
      )}
      {result?.status === 'loading' && <Loading label="Counting matching subscribers…" />}
      {result?.status === 'error' && (
        <ErrorLine
          id={PREVIEW_ERROR_ID}
          message={result.message}
          next={
            result.invalidFilters
              ? 'Check the filters: days are whole numbers, 1 or more; engagement is 0 to 100, with “from” no higher than “to”.'
              : undefined
          }
        />
      )}
      {ok !== null && (
        <section aria-labelledby={RESULT_HEADING_ID} className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 id={RESULT_HEADING_ID} tabIndex={-1} className="scroll-mt-28 font-display text-2xl font-semibold text-gray-900 focus:outline-none">
                {heading}
              </h2>
              <p className="text-sm text-gray-800">{segmentLabel(ok.filters)}</p>
              {hidden > 0 && <p className={hintClass}>{plural(hidden, 'unsubscribed subscriber', 'unsubscribed subscribers')} not shown.</p>}
              {ok.data.count === 0 && <p className={hintClass}>Try fewer filters, fewer days or more acquisition sources.</p>}
              {shownRows < ok.data.count && (
                <p className={hintClass}>Showing the first {fmt(shownRows)}. Export CSV downloads all of them.</p>
              )}
            </div>
            {ok.data.count > 0 && (
              <Button
                variant="primary"
                icon={ICONS.export}
                onClick={() => void exportCsv(ok.filters)}
                disabled={exporting}
                className="w-full sm:w-auto"
              >
                {exporting ? 'Preparing download…' : 'Export CSV'}
              </Button>
            )}
          </div>
          {exportError !== null && <ErrorLine message={exportError} next="Press Export CSV to try again." />}

          {ok.data.rows.length > 0 && (
            <>
              <MatchingRows filters={ok.filters} rows={ok.data.rows.slice(0, shownRows)} />
              {!showAll && ok.data.rows.length > FIRST_ROWS && (
                <Button onClick={() => setShowAll(true)}>Show all {fmt(ok.data.rows.length)} in preview</Button>
              )}
            </>
          )}
        </section>
      )}

      <Disclosure label="How these filters work" className="border-t border-gray-200 pt-4">
        <dl className="space-y-2 text-sm">
          {FOOTER_DEFINITIONS.map((key) => (
            <div key={key}>
              <dt className="font-medium text-gray-900">{DEFINITION_LABEL[key]}</dt>
              <dd className="text-gray-700">{DEFINITIONS[key].doc}</dd>
            </div>
          ))}
        </dl>
        <TechnicalDetails>
          <p className="font-medium">Definitions (shared/derive.ts)</p>
          {FOOTER_DEFINITIONS.map((key) => (
            <p key={key}>
              <span className="font-mono">{DEFINITIONS[key].name}</span>: <span className="font-mono">{DEFINITIONS[key].formula}</span>
            </p>
          ))}
          <p>
            Preview shows at most {PREVIEW_LIMIT} rows. CSV columns: <span className="font-mono">{CSV_COLUMNS}</span>
          </p>
          {ok !== null && (
            <>
              <p className="pt-2 font-medium">Filters (as the server read them)</p>
              <pre className="overflow-x-auto font-mono break-all whitespace-pre-wrap">{JSON.stringify(ok.filters)}</pre>
              <p className="pt-2 font-medium">SQL shape (placeholders only)</p>
              <pre className="overflow-x-auto font-mono break-all whitespace-pre-wrap">{ok.data.sql_shape}</pre>
            </>
          )}
        </TechnicalDetails>
      </Disclosure>
    </div>
  )
}
