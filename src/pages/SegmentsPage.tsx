// /segments: "Build a segment". Previous
// searches first (the last 5 filter objects this browser previewed, named by segmentLabel, with the
// brief's example always there and tagged), then the filter form in plain words: the basic filters
// and "More filters", grouped as the brief groups a subscriber (Newsletter info, Site visits, App
// activity). More filters starts open, so went cold, new subscribers and site visits (the brief's
// Growth questions) are one choice away; it still collapses. A search run
// from Previous searches or "Open segment" shows its count beside the list, with a link down to the
// result and Export CSV, and focus stays on the clicked item. Preview (POST
// /api/segments/preview) shows the count as a sentence and the segment's name; Export CSV (POST
// /api/segments/export.csv) runs on the filters the server echoed for the shown result, so the
// file always matches the count on screen. Level 2 / Technical details (detail one click away,
// never on the first screen): per-row Details, "How these filters work" with the definitions from
// DEFINITIONS (their one runtime source), raw names and the placeholders-only SQL shape. Status defaults to active;
// the response's hidden_unsubscribed is shown in words when it is above 0. The form sends what
// the inputs hold (the server alone normalizes): labels are display maps only, and the page choices come
// from GET /api/segments/options. A segment from /insights (a tile or an AI answer) arrives as router state
// {filters} ("Open segment"): the form takes those filters and previews them once.
// Every 200 preview records the echoed filters in Previous searches (src/previous-searches.ts);
// a click on one re-runs it, so every count shown is live, never a stored copy.

import { type FormEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { APP_EVENTS } from '../../shared/app-events'
import { TODAY } from '../../shared/config'
import { DEFINITIONS, type DefinitionKey, NEW_SUBSCRIBER_DAYS } from '../../shared/derive'
import { GLOSSARY } from '../../shared/glossary'
import { CANONICAL_SOURCES } from '../../shared/normalize'
import { SEGMENT_COLUMNS, SEGMENT_SORT } from '../../shared/segment-filters'
import { SUBSCRIBER_STATUSES } from '../../worker/ingest/quarantine'
import { downloadSegmentCsv, errorMessage, postJson } from '../api'
import {
  Announcer,
  Button,
  ComingSoonTag,
  type Column,
  Disclosure,
  ErrorLine,
  Field,
  GatedNote,
  ICONS,
  Icon,
  InfoTip,
  Loading,
  PageHeader,
  ResponsiveTable,
  Tag,
  TechnicalDetails,
} from '../components'
import { useGated } from '../use-gated'
import { filtersAppliedView } from '../filters-applied'
import { humanDate } from '../format'
import { columnLabel, COLUMN_LABEL, DEFINITION_LABEL, monthLabel, segmentLabel, sourceLabel, statusLabel } from '../labels'
import { browserStore, clearSearches, type PreviousSearch, readSearches, visibleSearches } from '../previous-searches'
import { DEFAULT_FORM, FIELD_ID, FIELD_LABEL, fieldMessages, type Form, type FormField, moreFiltersOn, toFilters, toForm } from '../segment-form'
import { type PreviewResult, previewAndRecord } from '../segment-preview'
import type { SegmentFilters, SegmentOptions, SegmentPreview, SegmentRow } from '../types'
import { useGet } from '../useGet'

/** Rows a preview asks for; the full segment is what Export CSV is for. */
const PREVIEW_LIMIT = 100
/** Rows shown before "Show all … in preview" (the rest is one click away). */
const FIRST_ROWS = 10

/** The footer definitions; their raw names and formulas show in Technical details. */
const FOOTER_DEFINITIONS: readonly DefinitionKey[] = ['days_since_open', 'no_open_in_days', 'cold', 'went_cold_in', 'new_subscriber', 'engagement_score']

/**
 * The footer's plain list (level 2 "How these filters work"), each under its plain heading
 * (DEFINITION_LABEL). no_open_in_days and cold are left out: the level-1 hint beside the days
 * field already says them, once, and reconciles the brief's count with Cold (the brief's
 * "no open in N days" and `cold` are different rules, so their counts differ).
 */
const FOOTER_PLAIN = FOOTER_DEFINITIONS.filter((key) => key !== 'no_open_in_days' && key !== 'cold')

/** Router state set by "Open segment" on /insights (a tile or an AI answer). */
function openedFilters(state: unknown): SegmentFilters | null {
  if (typeof state !== 'object' || state === null || !('filters' in state)) return null
  return (state as { filters: SegmentFilters }).filters
}

/** Went cold months built from TODAY: this month and the two before it. */
function coldMonthOptions(): { value: string; label: string }[] {
  const [y, m] = TODAY.split('-').map(Number)
  return [' (this month)', ' (last month)', ''].map((note, back) => {
    const value = new Date(Date.UTC(y, m - 1 - back, 1)).toISOString().slice(0, 7)
    return { value, label: `${monthLabel(value, 'short')}${note}` }
  })
}

/** The shown preview: none yet, counting, or what previewAndRecord gave. */
type Result = { status: 'loading' } | PreviewResult

const fmt = (n: number) => n.toLocaleString('en-US')
const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`
/** The result heading and the Announcer's words for a count. */
const countSentence = (count: number) => (count === 0 ? 'No subscribers match' : plural(count, 'subscriber matches', 'subscribers match'))

/** Where the shown preview was started: the form's Preview button, a previous search, or "Open segment". */
type Origin = 'form' | 'previous' | 'opened'

/** The id of the result heading and of the preview's error line, which SearchOutcome links to. */
const RESULT_HEADING_ID = 'result-heading'
const PREVIEW_ERROR_ID = 'preview-error'

/** The table's columns: a column whose every row would repeat the filter is left out (no repeats). */
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
 * The level-1 words under "Signed up in the last" ("30 = new subscribers"): the brief's
 * "new subscribers" is a number of days here, so the page names it
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
  error,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  tip?: ReactNode
  hint?: string
  /** The server's problem with this box in plain words (src/segment-form.ts), shown under it. */
  error?: string
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
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy(hint === undefined ? undefined : hintId, error === undefined ? undefined : errorId(id))}
          className={numberClass}
        />
        <span className="text-sm text-gray-700">days</span>
      </div>
      {hint !== undefined && (
        <p id={hintId} className={hintClass}>
          {hint}
        </p>
      )}
      <FieldError id={id} message={error} />
    </div>
  )
}

/** The id of the problem line under input `id`. */
const errorId = (id: string) => `${id}-error`

/**
 * Five gated "More filters" (the page's coming-soon filters): each its
 * own flag under `group: 'more_filters'`, carrying no state (no Form field, no FILTER_KEYS entry),
 * so none can reach the filters object, Previous searches, Export CSV or the assistant's segment
 * tool. Placed after the working controls in the group they belong to (working controls keep
 * their place). Every control keeps its real shape — a date pair, a number box, a checkbox, a
 * select — with a fixed, empty/unchecked value; a click, Enter or Space only opens the shared
 * "Coming soon" pop-up. Enter never submits the form (`onKeyDown` calls `preventDefault`).
 */
export function GatedSignedUpBetween() {
  const gated = useGated('filter_signed_up_between')
  const from = useId()
  const to = useId()
  return (
    <fieldset className="space-y-1">
      {/* legend must be the fieldset's first child (not wrapped in a layout div) or the fieldset
          gets no accessible name; the chip sits inside it instead. */}
      <legend className={`${labelClass} flex items-center gap-1`}>
        {gated.feature.label}
        <ComingSoonTag />
      </legend>
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
        <label htmlFor={from}>from</label>
        <input
          id={from}
          type="date"
          readOnly
          value=""
          {...gated.bind}
          onClick={gated.activate}
          onKeyDown={gated.onKeyDown}
          onChange={gated.activate}
          className={inputClass}
        />
        <label htmlFor={to}>to</label>
        <input
          id={to}
          type="date"
          readOnly
          value=""
          {...gated.bind}
          onClick={gated.activate}
          onKeyDown={gated.onKeyDown}
          onChange={gated.activate}
          className={inputClass}
        />
      </div>
      <GatedNote id={gated.noteId} text={gated.feature.note} />
    </fieldset>
  )
}

export function GatedOpenedWithinDays() {
  const gated = useGated('filter_opened_within_days')
  const id = useId()
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <label htmlFor={id} className={labelClass}>
          {gated.feature.label}
        </label>
        <ComingSoonTag />
      </div>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          readOnly
          value=""
          {...gated.bind}
          onClick={gated.activate}
          onKeyDown={gated.onKeyDown}
          onChange={gated.activate}
          className={numberClass}
        />
        <span className="text-sm text-gray-700">days</span>
      </div>
      <GatedNote id={gated.noteId} text={gated.feature.note} />
    </div>
  )
}

export function GatedSiteVisitsAtLeast() {
  const gated = useGated('filter_site_visits_gte')
  const id = useId()
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <label htmlFor={id} className={labelClass}>
          {gated.feature.label}
        </label>
        <ComingSoonTag />
      </div>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          readOnly
          value=""
          {...gated.bind}
          onClick={gated.activate}
          onKeyDown={gated.onKeyDown}
          onChange={gated.activate}
          className={numberClass}
        />
        <span className="text-sm text-gray-700">times</span>
      </div>
      <GatedNote id={gated.noteId} text={gated.feature.note} />
    </div>
  )
}

export function GatedGoingColdRisk() {
  const gated = useGated('filter_going_cold_risk')
  return (
    <div className="space-y-1">
      <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={false}
          {...gated.bind}
          onClick={gated.activate}
          onKeyDown={gated.onKeyDown}
          onChange={gated.activate}
          className="size-4"
        />
        {gated.feature.label}
        <ComingSoonTag />
      </label>
      <GatedNote id={gated.noteId} text={gated.feature.note} />
    </div>
  )
}

export function GatedEmailDomain() {
  const gated = useGated('filter_email_domain')
  const id = useId()
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <label htmlFor={id} className={labelClass}>
          {gated.feature.label}
        </label>
        <ComingSoonTag />
      </div>
      <select
        id={id}
        value=""
        {...gated.bind}
        onClick={gated.activate}
        onKeyDown={gated.onKeyDown}
        onChange={gated.activate}
        className={inputClass}
      >
        <option value="">Any domain</option>
      </select>
      <GatedNote id={gated.noteId} text={gated.feature.note} />
    </div>
  )
}

/**
 * The gated "Send to beehiiv" button (coming soon): the result action row,
 * right after Export CSV, in the same group — secondary, never primary (Export CSV stays the
 * page's one primary action). Shown on the same condition as Export CSV (count > 0). Activation
 * only opens the shared "Coming soon" pop-up: no outward call, no confirm panel, no log.
 */
export function SendToBeehiiv() {
  const gated = useGated('send_to_beehiiv')
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          {...gated.bind}
          onClick={gated.activate}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-surface-2 px-3.5 py-1.5 text-sm font-medium text-ink-subtle"
        >
          <Icon icon={ICONS.send} />
          {gated.feature.label}
        </button>
        <ComingSoonTag />
      </div>
      <GatedNote id={gated.noteId} text={gated.feature.note} />
    </div>
  )
}

/** aria-describedby from the ids that are set; undefined when none is. */
function describedBy(...ids: (string | undefined)[]): string | undefined {
  const set = ids.filter((i): i is string => i !== undefined)
  return set.length === 0 ? undefined : set.join(' ')
}

/**
 * A rejected preview's problem with one box, in plain words, right under it: it names the field
 * and its limit as the server stated them. Not a live region: the
 * error line below the form is the alert and repeats every problem.
 */
export function FieldError({ id, message }: { id: string; message?: string }) {
  if (message === undefined) return null
  return (
    <p id={errorId(id)} className="flex items-start gap-1.5 text-sm text-danger">
      <Icon icon={ICONS.error} className="mt-0.5 size-4" />
      <span>{message}</span>
    </p>
  )
}

/**
 * The error line under the form for a rejected preview. With field-level problems it says the
 * search didn't run and lists each one in plain words; otherwise it shows the server's message.
 */
export function PreviewError({ result }: { result: Extract<PreviewResult, { status: 'error' }> }) {
  if (result.problems.length === 0) return <ErrorLine id={PREVIEW_ERROR_ID} message={result.message} />
  return <ErrorLine id={PREVIEW_ERROR_ID} message="This search didn't run." next={result.problems.map((p) => p.message).join(' ')} />
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
 * What the download has, beside Export CSV, so a teammate knows what they are downloading before
 * they download it: every piece reads the one
 * home the export itself uses, so this can never describe a different file than the one that
 * downloads. SEGMENT_COLUMNS and SEGMENT_SORT (shared/segment-filters.ts) are the same arrays
 * compileSegment reads to build the export's SELECT and ORDER BY; `filters` is the
 * canonical object the server echoed for this result (POST /api/segments/preview's `filters`),
 * read through the one filters-in-words renderer (src/filters-applied.ts) the Ask bar's answer
 * card already uses. One thing in one place: the row count repeats only as a number, in words the count sentence
 * and segmentLabel do not already use, naming the one new fact — whether unsubscribed subscribers
 * are part of the file.
 */
export function ExportFileDetails({ filters, count }: { filters: SegmentFilters; count: number }) {
  const active = filters.status.includes('active')
  const unsubscribed = filters.status.includes('unsubscribed')
  const rows = plural(count, 'row', 'rows')
  const note =
    active && unsubscribed
      ? `${rows}, including unsubscribed subscribers.`
      : unsubscribed
        ? `${rows}, all unsubscribed.`
        : `${rows}. Unsubscribed subscribers are not included.`
  // SegmentFilters is a closed, already-validated shape (shared/segment-filters.ts); filtersAppliedView
  // takes the looser Record<string, unknown> its other caller (an AI-authored filters_applied) needs.
  const applied = filtersAppliedView(filters as unknown as Record<string, unknown>)
  return (
    <div className="space-y-1">
      <p className={hintClass}>{note}</p>
      <Disclosure label="What's in the file">
        <div className="space-y-2 text-sm text-gray-700">
          <p>Columns, in file order: {SEGMENT_COLUMNS.map(columnLabel).join(', ')}.</p>
          <p>Sorted by {SEGMENT_SORT.map((key) => (key.column === 'pkey' ? key.words : `${columnLabel(key.column)}, ${key.words}`)).join('; ')}.</p>
          {applied.status === 'shown' ? (
            <div>
              <p>Filters applied:</p>
              <dl className="space-y-1">
                {applied.fields.map((f) => (
                  <Field key={f.key} label={f.label}>
                    {f.value}
                  </Field>
                ))}
              </dl>
            </div>
          ) : (
            <p>{applied.message}</p>
          )}
        </div>
        <TechnicalDetails>
          <p className="font-medium">Raw column headers, export order</p>
          <p className="font-mono">{SEGMENT_COLUMNS.join(', ')}</p>
        </TechnicalDetails>
      </Disclosure>
    </div>
  )
}

/**
 * What a search started from Previous searches or "Open segment" gave, shown beside the list: the
 * result sits below the form, often below the fold, and focus stays on the clicked item,
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
          {/* The error line below says it didn't run and why; this only points there. */}
          <a href={`#${PREVIEW_ERROR_ID}`} className={linkClass}>
            Didn't run: see why
          </a>
        </>
      )}
    </p>
  )
}

/**
 * Previous searches: one button per search, named by segmentLabel, with the
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
  /** The outcome of the search last run from here or from "Open segment"; null after a form Preview. */
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
  // Open from the start: the brief's Growth filters sit here; the toggle still collapses it.
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
    const { result: next, stored: after } = await previewAndRecord(
      { filters, limit: PREVIEW_LIMIT },
      (body) => postJson<SegmentPreview>('/api/segments/preview', body),
      browserStore(),
    )
    if (next.status === 'error') focusKey.current = null
    setResult(next)
    if (after !== null) setStored(after)
  }

  /** Fills the form with filters (opening More filters when one is set) and previews them. */
  function load(filters: SegmentFilters, from: Origin) {
    const next = toForm(filters)
    setForm(next)
    if (moreFiltersOn(next) > 0) setMoreOpen(true)
    void preview(toFilters(next), from)
  }

  // Filters opened from /insights (a tile or an AI answer) preview once per navigation (location.key), StrictMode included.
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
  const fieldError: Partial<Record<FormField, string>> = result?.status === 'error' ? fieldMessages(result.problems) : {}
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
          <label htmlFor={FIELD_ID.status} className={labelClass}>
            {FIELD_LABEL.status}
          </label>
          <select
            id={FIELD_ID.status}
            aria-invalid={fieldError.status === undefined ? undefined : true}
            aria-describedby={fieldError.status === undefined ? undefined : errorId(FIELD_ID.status)}
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
          <FieldError id={FIELD_ID.status} message={fieldError.status} />
        </div>

        <div className="space-y-1">
          <label htmlFor={FIELD_ID.hasApp} className={labelClass}>
            {FIELD_LABEL.hasApp}
          </label>
          <select
            id={FIELD_ID.hasApp}
            aria-invalid={fieldError.hasApp === undefined ? undefined : true}
            aria-describedby={fieldError.hasApp === undefined ? undefined : errorId(FIELD_ID.hasApp)}
            value={form.hasApp}
            onChange={(e) => setForm({ ...form, hasApp: e.target.value as Form['hasApp'] })}
            className={inputClass}
          >
            <option value="any">Either</option>
            <option value="yes">Has an app account</option>
            <option value="no">No app account</option>
          </select>
          <FieldError id={FIELD_ID.hasApp} message={fieldError.hasApp} />
        </div>

        <fieldset
          className="space-y-1 sm:col-span-2"
          aria-describedby={describedBy('sources-hint', fieldError.sources === undefined ? undefined : errorId(FIELD_ID.sources))}
        >
          <legend className={labelClass}>{FIELD_LABEL.sources}</legend>
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
          <FieldError id={FIELD_ID.sources} message={fieldError.sources} />
        </fieldset>

        <div className="space-y-1 sm:col-span-2">
          <label htmlFor={FIELD_ID.days} className={labelClass}>
            {FIELD_LABEL.days}
          </label>
          <div className="flex items-center gap-2">
            <input
              id={FIELD_ID.days}
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={form.days}
              onChange={(e) => setForm({ ...form, days: e.target.value })}
              aria-invalid={fieldError.days === undefined ? undefined : true}
              aria-describedby={describedBy('days-hint', fieldError.days === undefined ? undefined : errorId(FIELD_ID.days))}
              className={numberClass}
            />
            <span className="text-sm text-gray-700">days</span>
          </div>
          <p id="days-hint" className={hintClass}>
            Leave blank for anyone. Otherwise enter a whole number, 1 or more.
          </p>
          <FieldError id={FIELD_ID.days} message={fieldError.days} />
          <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm has-disabled:cursor-not-allowed has-disabled:text-gray-500">
            <input
              type="checkbox"
              className="size-4"
              checked={form.includeNeverOpened}
              disabled={daysBlank}
              aria-describedby={daysBlank ? 'never-hint' : 'never-opened-meaning'}
              onChange={(e) => setForm({ ...form, includeNeverOpened: e.target.checked })}
            />
            {FIELD_LABEL.includeNeverOpened}
          </label>
          <FieldError id={FIELD_ID.includeNeverOpened} message={fieldError.includeNeverOpened} />
          {daysBlank ? (
            <p id="never-hint" className={hintClass}>
              Enter a number of days first.
            </p>
          ) : (
            <p id="never-opened-meaning" className={hintClass}>
              {DEFINITIONS.no_open_in_days.plain} {DEFINITIONS.cold.plain}
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
                <label htmlFor={FIELD_ID.engagementFrom}>from</label>
                <input
                  id={FIELD_ID.engagementFrom}
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  inputMode="numeric"
                  value={form.engagementFrom}
                  onChange={(e) => setForm({ ...form, engagementFrom: e.target.value })}
                  aria-invalid={fieldError.engagementFrom === undefined ? undefined : true}
                  aria-describedby={describedBy('engagement-hint', fieldError.engagementFrom === undefined ? undefined : errorId(FIELD_ID.engagementFrom))}
                  className={numberClass}
                />
                <label htmlFor={FIELD_ID.engagementTo}>to</label>
                <input
                  id={FIELD_ID.engagementTo}
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  inputMode="numeric"
                  value={form.engagementTo}
                  onChange={(e) => setForm({ ...form, engagementTo: e.target.value })}
                  aria-invalid={fieldError.engagementTo === undefined ? undefined : true}
                  aria-describedby={describedBy('engagement-hint', fieldError.engagementTo === undefined ? undefined : errorId(FIELD_ID.engagementTo))}
                  className={numberClass}
                />
              </div>
              <p id="engagement-hint" className={hintClass}>
                0 to 100. Leave either blank for no limit.
              </p>
              <FieldError id={FIELD_ID.engagementFrom} message={fieldError.engagementFrom} />
              <FieldError id={FIELD_ID.engagementTo} message={fieldError.engagementTo} />
            </fieldset>

            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className={`${groupClass} mb-2`}>Newsletter info</legend>
              <DaysBox
                id={FIELD_ID.signedUpDays}
                label={FIELD_LABEL.signedUpDays}
                value={form.signedUpDays}
                error={fieldError.signedUpDays}
                onChange={(v) => setForm({ ...form, signedUpDays: v })}
                tip={<InfoTip term="new_subscriber" />}
                hint={NEW_SUBSCRIBERS_HINT}
              />
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <label htmlFor={FIELD_ID.wentCold} className={labelClass}>
                    {FIELD_LABEL.wentCold}
                  </label>
                  <InfoTip term="cold" />
                </div>
                <select
                  id={FIELD_ID.wentCold}
                  value={form.wentCold}
                  aria-invalid={fieldError.wentCold === undefined ? undefined : true}
                  aria-describedby={fieldError.wentCold === undefined ? undefined : errorId(FIELD_ID.wentCold)}
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
                <FieldError id={FIELD_ID.wentCold} message={fieldError.wentCold} />
              </div>
              <GatedSignedUpBetween />
              <GatedGoingColdRisk />
              <GatedOpenedWithinDays />
              <GatedEmailDomain />
            </fieldset>

            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className={`${groupClass} mb-2`}>Site visits</legend>
              <DaysBox
                id={FIELD_ID.siteDays}
                label={FIELD_LABEL.siteDays}
                value={form.siteDays}
                error={fieldError.siteDays}
                onChange={(v) => setForm({ ...form, siteDays: v })}
              />
              <div className="space-y-1">
                <label htmlFor={FIELD_ID.sitePage} className={labelClass}>
                  {FIELD_LABEL.sitePage}
                </label>
                <select
                  id={FIELD_ID.sitePage}
                  value={form.sitePage}
                  onChange={(e) => setForm({ ...form, sitePage: e.target.value })}
                  aria-invalid={fieldError.sitePage === undefined ? undefined : true}
                  aria-describedby={describedBy(
                    options?.status === 'error' ? 'site-page-options-error' : undefined,
                    fieldError.sitePage === undefined ? undefined : errorId(FIELD_ID.sitePage),
                  )}
                  className={inputClass}
                >
                  <option value="">Any page</option>
                  {pageChoices.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <FieldError id={FIELD_ID.sitePage} message={fieldError.sitePage} />
                {options?.status === 'loading' && <p className={hintClass}>Loading pages…</p>}
                {options?.status === 'error' && (
                  <ErrorLine id="site-page-options-error" message={options.message} next="Reload the page to try again." />
                )}
              </div>
              <GatedSiteVisitsAtLeast />
            </fieldset>

            <fieldset className="grid gap-4 sm:grid-cols-2" aria-describedby="app-hint">
              <legend className={`${groupClass} mb-1`}>App activity</legend>
              <p id="app-hint" className={`${hintClass} sm:col-span-2`}>
                Comes from live app events, so it counts only what the app has sent.
              </p>
              <DaysBox
                id={FIELD_ID.appDays}
                label={FIELD_LABEL.appDays}
                value={form.appDays}
                error={fieldError.appDays}
                onChange={(v) => setForm({ ...form, appDays: v })}
              />
              <div className="space-y-1">
                <label htmlFor={FIELD_ID.appEvent} className={labelClass}>
                  {FIELD_LABEL.appEvent}
                </label>
                <select
                  id={FIELD_ID.appEvent}
                  aria-invalid={fieldError.appEvent === undefined ? undefined : true}
                  aria-describedby={fieldError.appEvent === undefined ? undefined : errorId(FIELD_ID.appEvent)}
                  value={form.appEvent}
                  onChange={(e) => setForm({ ...form, appEvent: e.target.value as Form['appEvent'] })}
                  className={inputClass}
                >
                  <option value="">Any event</option>
                  {APP_EVENTS.map((e) => (
                    <option key={e} value={e}>
                      {e}: {GLOSSARY[e].text}
                    </option>
                  ))}
                </select>
                <FieldError id={FIELD_ID.appEvent} message={fieldError.appEvent} />
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
      {result?.status === 'loading' && <Loading label="Counting matching subscribers…" />}
      {result?.status === 'error' && <PreviewError result={result} />}
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
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-start">
                <Button
                  variant="primary"
                  icon={ICONS.export}
                  onClick={() => void exportCsv(ok.filters)}
                  disabled={exporting}
                  className="w-full sm:w-auto"
                >
                  {exporting ? 'Preparing download…' : 'Export CSV'}
                </Button>
                <SendToBeehiiv />
              </div>
            )}
          </div>
          {ok.data.count > 0 && <ExportFileDetails filters={ok.filters} count={ok.data.count} />}
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
          {FOOTER_PLAIN.map((key) => (
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
          <p>Preview shows at most {PREVIEW_LIMIT} rows. Export CSV's own columns are in "What's in the file", above.</p>
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
