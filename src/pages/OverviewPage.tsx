// / Overview (06 §Overview, 09 D-63, D-65): where the data comes from, how each load went, and
// what needs a person. Every number is the API's; nothing is computed here.
// Level 1, top to bottom: four headline Metrics (GET /api/overview), each with an InfoTip; the
// Sources table (GET /api/sources) with its one-line header (the source count and the newest
// sync). Each source's Status cell is chips from its checks (09 D-65), problems first ("2 rows to
// fix", "16 possible duplicates"), else OK, Live or Not loaded yet, each with an InfoTip; a chip is
// a button that opens the row on its tab. One thing in one place (09 D-72): the chips are the one
// home of each check's count (no totals in the header), a row's cells the one home of the webhook's
// count and last sync, and a run's Rejected number the one home of its rejected total.
// Level 2: an open row is a tab set (WAI-ARIA tabs) — History (CSV: its runs, read · kept · merged
// · rejected, and "View rejected rows" → GET /api/quarantine?file=; webhook: events received),
// then one tab per check the source declares: Rows to fix (09 D-61, the rows as written and the
// fix) and Possible duplicates (09 D-62, each scored pair side by side with its score bar, reason
// chips, suggestion and two buttons that record a decision via GET/POST /api/duplicates; a decision
// re-reads GET /api/sources so the chip count follows). Nothing merges. Level 3: Technical details
// (raw ids, reason codes, CSV lines, UTC to the second, the m/u weights).
// Source names, kinds, units and checks come only from the API, which reads shared/sources.ts; term
// words and explanations only from shared/glossary.ts (or DEFINITIONS). No per-file sentence lives
// here (08 T-SRC-2 scans this file). Read-only: no edit or delete here (09 D-13).

import { Check, Copy, Smartphone, UserCheck, Users, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { TODAY } from '../../shared/config'
import { type CheckKind, DAILY_SYNC_SOURCE_IDS, LOADS_BY_LABEL } from '../../shared/sources'
import { countOf, GLOSSARY, type GlossaryKey } from '../../shared/glossary'
import { errorMessage, getJson, postJson } from '../api'
import {
  Announcer,
  Button,
  ComingSoonTag,
  EmptyState,
  ErrorLine,
  Field,
  GatedNote,
  ICONS,
  Icon,
  InfoTip,
  Loading,
  Metric,
  PageHeader,
  ResponsiveTable,
  Section,
  StatGrid,
  Tag,
  TechnicalDetails,
  type LucideIcon,
} from '../components'
import { useGated } from '../use-gated'
import { capitalized, humanDate, humanDateTime, utc } from '../format'
import { sourceLabel } from '../labels'
import { asWritten, csvName, needsReview, type QuarantinedRow, reviewGroups } from '../needs-review'
import type {
  CsvSource,
  DuplicateDecision,
  DuplicateReview,
  Duplicates,
  Overview,
  QuarantineList,
  SourceRun,
  Sources,
  WebhookSource,
} from '../types'
import { useGet } from '../useGet'

const TITLE = 'Overview'
const PURPOSE = 'Where the data comes from, how each load went, and what needs a person.'
/** The next step under a failed load, written once for the page, the sources and the duplicates (09 D-72). */
const RETRY = 'Refresh the page to try again.'

function n(value: number): string {
  return value.toLocaleString('en-US')
}

/** The four headline numbers (06 §Overview 1): the glossary names and explains each. */
const HEADLINE: { term: GlossaryKey; icon: LucideIcon; value: (o: Overview) => number }[] = [
  { term: 'subscribers_signed_up', icon: Users, value: (o) => o.subscribers },
  { term: 'subscribers_active', icon: UserCheck, value: (o) => o.active },
  { term: 'app_accounts', icon: Smartphone, value: (o) => o.app_users },
  { term: 'events_received', icon: ICONS.events, value: (o) => o.events_received },
]

type AnySource = Sources['sources'][number]

/** An open row's tabs: History, then one per check the source declares (09 D-65). */
type TabKey = 'history' | CheckKind

function tabsOf(source: AnySource): TabKey[] {
  return ['history', ...source.checks.map((c) => c.kind)]
}

/** "History" / "Rows to fix" / "Possible duplicates": a check's tab says its glossary words. */
function tabLabel(tab: TabKey): string {
  return tab === 'history' ? 'History' : capitalized(GLOSSARY[tab].many)
}

/** How each check's chip looks when it counts something (problems first, 06 §Overview 2). */
const CHECK_CHIP: Record<CheckKind, { icon: LucideIcon; tone: 'danger' | 'neutral' }> = {
  rows_to_fix: { icon: ICONS.warning, tone: 'danger' },
  possible_duplicates: { icon: Copy, tone: 'neutral' },
}

/** Newest last_sync over the CSV sources; null when nothing was loaded. */
function lastSync(sources: readonly AnySource[]): string | null {
  return sources.reduce<string | null>(
    (latest, s) => (s.kind === 'csv' && s.last_sync !== null && (latest === null || s.last_sync > latest) ? s.last_sync : latest),
    null,
  )
}

/**
 * A short run of facts separated by visible dots. The dots are aria-hidden (screen readers hear the
 * list items) but real text, so copied text reads "4 sources · last sync …" with no hidden words.
 */
function FactLine({ items, label }: { items: ReactNode[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-ink-muted">
      {items.map((item, i) => (
        <li key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden="true">· </span>}
          {item}
        </li>
      ))}
    </ul>
  )
}

/** One status chip and its InfoTip; the chip is a button that opens the row on `tab`. */
function Chip({
  term,
  tone,
  icon,
  onOpen,
  children,
}: {
  term: GlossaryKey
  tone: 'neutral' | 'accent' | 'success' | 'danger'
  icon: LucideIcon
  onOpen: () => void
  children: ReactNode
}) {
  return (
    <li className="inline-flex items-center gap-0.5">
      <Tag tone={tone} icon={icon} onClick={onOpen}>
        {children}
      </Tag>
      <InfoTip term={term} />
    </li>
  )
}

/** The Status cell (09 D-65): a chip per check that counts something, problems first; else OK / Live / Not loaded yet. */
function StatusChips({ source, onOpen }: { source: AnySource; onOpen: (tab: TabKey) => void }) {
  const problems = source.checks.filter((c) => c.count > 0)
  return (
    <ul aria-label={`Status of ${source.name}`} className="flex flex-wrap items-center gap-1">
      {source.kind === 'webhook' ? (
        <Chip term="live" tone="accent" icon={ICONS.live} onOpen={() => onOpen('history')}>
          {GLOSSARY.live.term}
        </Chip>
      ) : source.status === 'not_loaded' ? (
        <Chip term="not_loaded" tone="neutral" icon={ICONS.empty} onOpen={() => onOpen('history')}>
          {GLOSSARY.not_loaded.term}
        </Chip>
      ) : problems.length === 0 ? (
        <Chip term="ok" tone="success" icon={ICONS.success} onOpen={() => onOpen('history')}>
          {GLOSSARY.ok.term}
        </Chip>
      ) : (
        problems.map((c) => (
          <Chip key={c.kind} term={c.kind} {...CHECK_CHIP[c.kind]} onOpen={() => onOpen(c.kind)}>
            {countOf(c.kind, c.count)}
          </Chip>
        ))
      )}
    </ul>
  )
}

/** One label and number with its InfoTip, inside a run's <dl>. */
function RunFact({ term, value }: { term: GlossaryKey; value: number }) {
  return (
    <div>
      <dt className="flex items-center gap-0.5 text-xs text-ink-muted">
        {GLOSSARY[term].term}
        <InfoTip term={term} />
      </dt>
      <dd className="font-medium tabular-nums text-ink">{n(value)}</dd>
    </div>
  )
}

/** The fixable rows of a list, grouped by file and reason, each as written, with the fix (06, 09 D-61). */
function FixableGroups({ list }: { list: readonly QuarantinedRow[] }) {
  return reviewGroups(list).map((group) => (
    <div key={group.key} className="space-y-2">
      <p className="text-sm font-medium text-ink">{group.sentence}</p>
      {/* The table's name for screen readers; the sentence above is read once (09 D-72). */}
      <ResponsiveTable
        caption="The rows as written in the file"
        columns={group.columns.map((col) => ({
          header: col.label,
          cell: (row: QuarantinedRow) => (
            <span className="break-all whitespace-pre-wrap">{asWritten(row.fields[col.name])}</span>
          ),
        }))}
        rows={group.rows}
        rowKey={(row) => `${row.file}-${row.line_no}`}
      />
      <p className="flex items-start gap-2 text-sm text-ink-muted">
        <Icon icon={ICONS.next} className="mt-0.5 size-4" />
        <span>{group.fix}</span>
      </p>
    </div>
  ))
}

/** CSV line and reason code per row (level 3, principle 2). */
function RowLines({ list }: { list: readonly QuarantinedRow[] }) {
  return (
    <TechnicalDetails>
      <ul>
        {list.map((row) => (
          <li key={`${row.file}-${row.line_no}`}>
            {csvName(row.file)} line {row.line_no} · {row.reason}
          </li>
        ))}
      </ul>
    </TechnicalDetails>
  )
}

/**
 * A run's rejected rows (06 §Overview): the blank rows as a count with why they need nothing, and
 * the fixable rows as written. The total is the run's Rejected number above (09 D-72: said once).
 */
function RejectedRows({ sourceId, id }: { sourceId: string; id: string }) {
  const state = useGet<QuarantineList>(`/api/quarantine?file=${encodeURIComponent(sourceId)}`)
  if (state === null || state.status === 'loading') return <Loading label="Loading the rejected rows…" />
  if (state.status === 'error') return <ErrorLine message={state.message} next="Try again." />
  const list = state.data.rows
  const blank = list.filter((row) => row.reason === 'blank_row').length
  return (
    <div id={id} className="space-y-3 rounded-lg border border-line bg-surface p-3">
      {blank > 0 && (
        <p className="flex items-start gap-2 text-sm text-ink-muted">
          <Icon icon={ICONS.empty} className="mt-0.5 size-4" />
          <span>
            {countOf('blank_row', blank)}: {GLOSSARY.blank_row.text}
          </span>
        </p>
      )}
      <FixableGroups list={list} />
      <RowLines list={list} />
    </div>
  )
}

function RunCard({ source, run }: { source: CsvSource; run: SourceRun }) {
  const [open, setOpen] = useState(false)
  const panelId = `rejected-${source.id}-${run.id}`
  return (
    <li className="space-y-2 rounded-lg border border-line bg-surface-2 p-3">
      <p className="text-sm font-medium text-ink">{humanDateTime(run.ran_at)}</p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <RunFact term="rows_read" value={run.rows_in} />
        <RunFact term="kept" value={run.rows_out} />
        <RunFact term="merged" value={run.merged} />
        <RunFact term="rejected" value={run.rejected} />
      </dl>
      {run.rejected > 0 && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex min-h-6 items-center gap-1 rounded-md py-0.5 text-sm font-medium text-accent hover:text-accent-strong hover:underline hover:underline-offset-4"
        >
          <Icon icon={ICONS.preview} />
          {open ? 'Hide rejected rows' : 'View rejected rows'}
        </button>
      )}
      {open ? <RejectedRows sourceId={source.id} id={panelId} /> : <span id={panelId} hidden />}
    </li>
  )
}

/**
 * The gated load bar (09 D-80, 22-pages/overview.md §2a-2b): first child of a CSV source's
 * History tab, above the run cards. "Upload a new file" and "Run again" share one gate
 * (`csv_upload`, D-72: one chip, one note for the feature); "Automatic daily sync" is a second,
 * separate gate, shown only on the sources DAILY_SYNC_SOURCE_IDS names. Gated now: activating any
 * control only reveals its note and announces it — no file input exists, no switch moves, no
 * request goes out.
 */
export function LoadBar({ source }: { source: CsvSource }) {
  const upload = useGated('csv_upload')
  const sync = useGated('daily_sync')
  const showSync = DAILY_SYNC_SOURCE_IDS.includes(source.id)
  const muted =
    'inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-surface-2 px-3.5 py-1.5 text-sm font-medium text-ink-muted'
  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div role="group" aria-label={upload.feature.label} className="flex flex-wrap items-center gap-2">
          <button type="button" {...upload.bind} onClick={upload.activate} className={muted}>
            <Icon icon={ICONS.upload} />
            {upload.feature.controls![0]}
          </button>
          <button type="button" {...upload.bind} onClick={upload.activate} className={muted}>
            <Icon icon={ICONS.refresh} />
            {upload.feature.controls![1]}
          </button>
          <ComingSoonTag />
        </div>
        {showSync && (
          <div className="flex items-center gap-2 sm:ml-auto">
            <button type="button" role="switch" aria-checked="false" {...sync.bind} onClick={sync.activate} className={muted}>
              <Icon icon={ICONS.schedule} />
              {sync.feature.label}
            </button>
            <ComingSoonTag />
          </div>
        )}
      </div>
      <GatedNote id={upload.noteId} activated={upload.activated} text={upload.feature.note} />
      {showSync && <GatedNote id={sync.noteId} activated={sync.activated} text={sync.feature.note} />}
    </div>
  )
}

/** Level 2 for one source: a CSV's run history, or the webhook's events received (06 §Overview 2). */
function SourceHistory({ source }: { source: AnySource }) {
  if (source.kind === 'webhook') return <WebhookHistory source={source} />
  return (
    <div className="space-y-2">
      <LoadBar source={source} />
      {source.runs.length === 0 ? (
        <p className="text-sm text-ink-muted">No sync has run yet.</p>
      ) : (
        <ul aria-label={`${source.name}: syncs, newest first`} className="space-y-2">
          {source.runs.map((run) => (
            <RunCard key={run.id} source={source} run={run} />
          ))}
        </ul>
      )}
      <TechnicalDetails>
        <p>
          Loads by: {LOADS_BY_LABEL[source.loads_by]} · id: {source.id}
        </p>
        {source.runs.map((run) => (
          <p key={run.id}>
            import_runs.id {run.id} · ran_at {utc(run.ran_at)} · needs_review {run.needs_review}
          </p>
        ))}
      </TechnicalDetails>
    </div>
  )
}

/** The webhook's level 2: what its row does not say (09 D-72): the row holds the count and the last sync. */
function WebhookHistory({ source }: { source: WebhookSource }) {
  return (
    <div className="space-y-2">
      <dl>
        <div>
          <dt className="text-xs text-ink-muted">Dated today ({humanDate(TODAY)})</dt>
          <dd className="font-medium tabular-nums text-ink">{n(source.today)}</dd>
        </div>
      </dl>
      <p className="text-sm">
        <Link
          to="/events"
          className="inline-flex items-center gap-1.5 font-medium text-accent-strong underline underline-offset-4 hover:text-ink"
        >
          <Icon icon={ICONS.events} />
          See the latest {source.unit}
        </Link>
      </p>
      <TechnicalDetails>
        <p>
          Loads by: {LOADS_BY_LABEL[source.loads_by]} · id: {source.id} · endpoint: POST /webhooks/app
          {source.last_received !== null && <> · last received_at {utc(source.last_received)}</>}
        </p>
      </TechnicalDetails>
    </div>
  )
}

/** The rows a person can fix in one source's file, each as written, and what to do (09 D-61). */
function RowsToFix({ source }: { source: AnySource }) {
  const state = useGet<QuarantineList>(`/api/quarantine?file=${encodeURIComponent(source.id)}`)
  if (state === null || state.status === 'loading') return <Loading label="Loading the rows to fix…" />
  if (state.status === 'error') return <ErrorLine message={state.message} next="Try again." />
  const fixable = state.data.rows.filter((row) => needsReview(row.reason))
  if (fixable.length === 0) return <EmptyState icon={ICONS.success}>Nothing to fix.</EmptyState>
  return (
    <div className="space-y-3">
      <FixableGroups list={fixable} />
      <RowLines list={fixable} />
    </div>
  )
}

/**
 * An open row (level 2): the tabs History · Rows to fix · Possible duplicates, only those the
 * source has, as the WAI-ARIA tabs pattern (arrow keys, Home and End move and select; one tab in
 * the Tab order). Only the selected panel's content is mounted. `takeFocus` moves focus to the
 * selected tab once, after a status chip opened the row.
 */
function SourceTabs({
  source,
  tab,
  onSelect,
  takeFocus,
  onFocusTaken,
  onReviewed,
}: {
  source: AnySource
  tab: TabKey
  onSelect: (tab: TabKey) => void
  takeFocus: boolean
  onFocusTaken: () => void
  onReviewed: () => void
}) {
  const base = useId()
  const tabs = tabsOf(source)
  const selected = tabs.includes(tab) ? tab : 'history'
  const refs = useRef(new Map<TabKey, HTMLButtonElement>())

  useEffect(() => {
    if (!takeFocus) return
    refs.current.get(selected)?.focus()
    onFocusTaken()
  }, [takeFocus, selected, onFocusTaken])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = tabs.indexOf(selected)
    const next =
      e.key === 'ArrowRight'
        ? tabs[(i + 1) % tabs.length]
        : e.key === 'ArrowLeft'
          ? tabs[(i - 1 + tabs.length) % tabs.length]
          : e.key === 'Home'
            ? tabs[0]
            : e.key === 'End'
              ? tabs[tabs.length - 1]
              : undefined
    if (next === undefined) return
    e.preventDefault()
    onSelect(next)
    refs.current.get(next)?.focus()
  }

  return (
    <div className="space-y-3">
      <div
        role="tablist"
        aria-label={`${source.name}: details`}
        onKeyDown={onKeyDown}
        className="flex flex-wrap border-b border-line sm:gap-1"
      >
        {tabs.map((t) => {
          const isSelected = t === selected
          return (
            <button
              key={t}
              ref={(el) => {
                if (el === null) refs.current.delete(t)
                else refs.current.set(t, el)
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t}`}
              aria-selected={isSelected}
              aria-controls={`${base}-panel-${t}`}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelect(t)}
              className={`-mb-px inline-flex min-h-9 items-center border-b-2 px-2 py-1.5 text-sm whitespace-nowrap sm:px-3 font-medium transition-colors duration-150 motion-reduce:transition-none ${
                isSelected
                  ? 'border-accent text-accent-strong'
                  : 'border-transparent text-ink-muted hover:border-line-strong hover:text-ink'
              }`}
            >
              {tabLabel(t)}
            </button>
          )
        })}
      </div>
      {tabs.map((t) => (
        <div
          key={t}
          role="tabpanel"
          id={`${base}-panel-${t}`}
          aria-labelledby={`${base}-tab-${t}`}
          tabIndex={0}
          hidden={t !== selected}
          className="rounded-md"
        >
          {t !== selected ? null : t === 'history' ? (
            <SourceHistory source={source} />
          ) : t === 'rows_to_fix' ? (
            <RowsToFix source={source} />
          ) : (
            <PossibleDuplicates onReviewed={onReviewed} />
          )}
        </div>
      ))}
    </div>
  )
}

/** The Sources table (06 §Overview 2), rendered only from GET /api/sources. */
export function SourcesTable({
  sources,
  onReviewed,
  refreshError,
}: {
  sources: AnySource[]
  onReviewed: () => void
  refreshError: string | null
}) {
  // Open rows and the tab each shows; a chip opens its row on its own tab (09 D-65).
  const [openTabs, setOpenTabs] = useState<ReadonlyMap<string, TabKey>>(new Map())
  const [focusRow, setFocusRow] = useState<string | null>(null)
  const openKeys = useMemo(() => new Set(openTabs.keys()), [openTabs])
  const latest = lastSync(sources)

  function show(id: string, tab: TabKey | null) {
    setOpenTabs((prev) => {
      const next = new Map(prev)
      if (tab === null) next.delete(id)
      else next.set(id, tab)
      return next
    })
  }
  function openOn(id: string, tab: TabKey) {
    show(id, tab)
    setFocusRow(id)
  }
  const focusTaken = () => setFocusRow(null)

  return (
    <Section
      title="Sources"
      icon={ICONS.history}
      summary={
        <FactLine
          label="Sources summary"
          items={[
            <>
              {n(sources.length)} {sources.length === 1 ? 'source' : 'sources'}
              <InfoTip term="source" />
            </>,
            <>
              {latest === null ? 'no sync yet' : `last sync ${humanDate(latest)}`}
              <InfoTip term="sync" />
            </>,
          ]}
        />
      }
    >
      <ResponsiveTable
        caption="Sources"
        columns={[
          { header: 'Source', cell: (s: AnySource) => <span className="font-medium text-ink">{s.name}</span> },
          {
            header: 'Type',
            cell: (s: AnySource) => (
              <span className="inline-flex items-center gap-0.5">
                {GLOSSARY[s.kind].term}
                <InfoTip term={s.kind} />
              </span>
            ),
          },
          {
            header: 'Last sync',
            // A CSV's last sync is a date (one run a day at most); the webhook's is a date and
            // time, since an event can arrive seconds ago and a reader needs that to see it just
            // happened (R4.1, R4.10). humanDateTime rounds to the minute; the exact second is in
            // Technical details' last received_at (09 D-72: this cell is still the one home of the
            // fact, just shown at the precision each kind of sync needs).
            cell: (s: AnySource) => {
              const at = s.kind === 'csv' ? s.last_sync : s.last_received
              if (at === null) return 'None yet'
              return s.kind === 'webhook' ? humanDateTime(at) : humanDate(at)
            },
          },
          {
            header: 'Status',
            cell: (s: AnySource) => <StatusChips source={s} onOpen={(tab) => openOn(s.id, tab)} />,
          },
          {
            header: 'Records',
            numeric: true,
            cell: (s: AnySource) => (
              <>
                {n(s.records)} {s.records === 1 ? s.unit_one : s.unit}
              </>
            ),
          },
        ]}
        rows={sources}
        rowKey={(s) => s.id}
        open={openKeys}
        onOpenChange={(id, isOpen) => show(id, isOpen ? 'history' : null)}
        details={(s) => (
          <SourceTabs
            source={s}
            tab={openTabs.get(s.id) ?? 'history'}
            onSelect={(tab) => show(s.id, tab)}
            takeFocus={focusRow === s.id}
            onFocusTaken={focusTaken}
            onReviewed={onReviewed}
          />
        )}
      />
      {refreshError !== null && (
        <ErrorLine message={refreshError} next="The counts above may be out of date; refresh the page." />
      )}
    </Section>
  )
}

type DuplicatePair = Duplicates['review'][number]

const VERDICT_WORDS: Record<DuplicateDecision['verdict'], string> = {
  same_person: 'the same person',
  different_people: 'different people',
}

/** The 0–100 score as a bar plus its number in words; the bar is decoration (principle 7). */
function ScoreBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <div aria-hidden="true" className="h-2 w-32 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line">
        <div className="h-full rounded-full bg-accent" style={{ width: `${score}%` }} />
      </div>
      <span className="text-ink-muted">
        Score <span className="font-medium tabular-nums text-ink">{score}</span> of 100
      </span>
    </div>
  )
}

function DuplicateCard({
  pair,
  decision,
  saving,
  error,
  onDecide,
}: {
  pair: DuplicatePair
  decision: DuplicateDecision | null
  saving: boolean
  error: string | null
  onDecide: (verdict: DuplicateDecision['verdict']) => void
}) {
  return (
    <li className="space-y-3 rounded-xl border border-line bg-surface p-4 shadow-soft">
      <div className="grid gap-3 sm:grid-cols-2">
        {[pair.a, pair.b].map((person) => (
          <dl key={person.email} className="space-y-1 rounded-lg bg-surface-2 p-3">
            <Field label="Email">{person.email}</Field>
            <Field label="Signup date">{humanDate(person.signup_date)}</Field>
            <Field label="Acquisition source">{sourceLabel(person.source)}</Field>
          </dl>
        ))}
      </div>
      <ScoreBar score={pair.score} />
      <ul aria-label="Why this score" className="flex flex-wrap gap-1.5">
        {pair.reasons.map((reason) => (
          <li key={reason.field}>
            <Tag tone={reason.agrees ? 'accent' : 'neutral'} icon={reason.agrees ? Check : X}>
              <span className="sr-only">{reason.agrees ? 'Matches: ' : 'Differs: '}</span>
              {reason.label}
            </Tag>
          </li>
        ))}
      </ul>
      <p className="text-sm font-medium text-ink">{pair.suggestion}</p>
      <div role="group" aria-label="Your decision" className="flex flex-wrap items-center gap-2">
        <Button
          icon={Check}
          aria-pressed={decision?.verdict === 'same_person'}
          variant={decision?.verdict === 'same_person' ? 'primary' : 'secondary'}
          disabled={saving}
          onClick={() => onDecide('same_person')}
        >
          Same person
        </Button>
        <Button
          icon={X}
          aria-pressed={decision?.verdict === 'different_people'}
          variant={decision?.verdict === 'different_people' ? 'primary' : 'secondary'}
          disabled={saving}
          onClick={() => onDecide('different_people')}
        >
          Different people
        </Button>
        {saving && <Loading label="Saving…" />}
      </div>
      {decision !== null && (
        <p className="flex items-start gap-2 text-sm text-ink-muted">
          <Icon icon={ICONS.success} className="mt-0.5 size-4 text-success" />
          <span>
            Marked as {VERDICT_WORDS[decision.verdict]} on {humanDateTime(decision.decided_at)}. You can
            change it.
          </span>
        </p>
      )}
      {error !== null && <ErrorLine message={error} next="Try again." />}
    </li>
  )
}

/** Weights and the chance check, raw (level 3, principle 2). */
function DuplicateTechnicalDetails({ data, pairs }: { data: Duplicates; pairs: DuplicatePair[] }) {
  return (
    <TechnicalDetails>
      <p>
        candidates: {data.candidates} pairs of profiles sharing a name stem (email local part without trailing
        digits). score = round(100 × 2^W / (1 + 2^W)), W = sum of the field weights; agree weight log2(m/u),
        disagree weight log2((1−m)/(1−u)); u measured from the candidates, m assumed (09 D-62).
      </p>
      {data.weights === null ? (
        <p>No candidate pairs, so no weights.</p>
      ) : (
        <table className="w-auto text-left">
          <caption className="sr-only">Field weights, raw values</caption>
          <thead>
            <tr className="text-gray-600">
              {['field', 'm', 'u', 'agreeing', 'agree', 'disagree'].map((h) => (
                <th key={h} scope="col" className="py-1 pr-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.weights).map(([field, w]) => (
              <tr key={field}>
                <td className="py-0.5 pr-3">{field}</td>
                <td className="py-0.5 pr-3 text-right">{w.m}</td>
                <td className="py-0.5 pr-3 text-right">{w.u.toFixed(4)}</td>
                <td className="py-0.5 pr-3 text-right">{w.agreeing}</td>
                <td className="py-0.5 pr-3 text-right">{w.agree.toFixed(2)}</td>
                <td className="py-0.5 pr-3 text-right">{w.disagree.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        chance check: {data.chance.all_soft_agree} pairs agree on domain, signup_gap and source;{' '}
        {data.chance.expected_by_chance.toFixed(1)} expected if the fields were independent (candidates × the
        three agreement shares).
      </p>
      {pairs.length > 0 && (
        <ul>
          {pairs.map((p) => (
            <li key={p.pair_id}>
              {p.pair_id} · band {p.band} ·{' '}
              {p.reasons.map((r) => `${r.field} ${r.weight.toFixed(2)}`).join(', ')}
            </li>
          ))}
        </ul>
      )}
    </TechnicalDetails>
  )
}

/**
 * Scored possible duplicates for a person to judge (09 D-62); a decision is recorded, never merged.
 * After each one, `onReviewed` re-reads the sources so the chip's count follows (09 D-65).
 */
function PossibleDuplicates({ onReviewed }: { onReviewed: () => void }) {
  const state = useGet<Duplicates>('/api/duplicates')
  const [decided, setDecided] = useState<Readonly<Record<string, DuplicateDecision>>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ pairId: string; message: string } | null>(null)
  const [announcement, setAnnouncement] = useState('')

  if (state === null || state.status === 'loading')
    return <Loading label="Checking for possible duplicates…" />
  if (state.status === 'error')
    return <ErrorLine message={state.message} next={RETRY} />
  const data = state.data

  async function decide(pairId: string, verdict: DuplicateDecision['verdict']) {
    setSaving(pairId)
    setFailed(null)
    try {
      const stored = await postJson<DuplicateReview>(`/api/duplicates/${encodeURIComponent(pairId)}/review`, {
        verdict,
      })
      setDecided((prev) => ({
        ...prev,
        [pairId]: { verdict: stored.verdict, decided_at: stored.decided_at },
      }))
      setAnnouncement(`Recorded: ${VERDICT_WORDS[stored.verdict]}.`)
      onReviewed()
    } catch (err) {
      setFailed({ pairId, message: errorMessage(err) })
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="space-y-3">
      {data.review.length === 0 ? (
        <EmptyState>
          No likely duplicates — {n(data.candidates)} name matches checked, none share more than chance
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {data.review.map((pair) => (
            <DuplicateCard
              key={pair.pair_id}
              pair={pair}
              decision={decided[pair.pair_id] ?? pair.decision}
              saving={saving === pair.pair_id}
              error={failed?.pairId === pair.pair_id ? failed.message : null}
              onDecide={(verdict) => void decide(pair.pair_id, verdict)}
            />
          ))}
        </ul>
      )}
      <p className="text-sm text-ink-muted">
        Score {data.bands.auto_min} or more: very likely the same person. {data.bands.review_min}–
        {data.bands.auto_min - 1}: worth a look. Under {data.bands.review_min}: not shown ({n(data.hidden_below_review)}{' '}
        {data.hidden_below_review === 1 ? 'pair' : 'pairs'}). Nothing is deduped automatically — your answer is
        only recorded.
      </p>
      <DuplicateTechnicalDetails data={data} pairs={data.review} />
      <Announcer message={announcement} />
    </div>
  )
}

/**
 * The Sources table from GET /api/sources. A duplicate decision re-reads it in place (the table
 * stays mounted, so open rows and tabs stay open) and the chip and header counts follow.
 */
function SourcesSection() {
  const state = useGet<Sources>('/api/sources')
  const [fresh, setFresh] = useState<Sources | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  if (state === null || state.status === 'loading') return <Loading label="Loading the sources…" />
  if (state.status === 'error')
    return <ErrorLine message={state.message} next={RETRY} />

  function refresh() {
    getJson<Sources>('/api/sources').then(
      (data) => {
        setFresh(data)
        setRefreshError(null)
      },
      (err: unknown) => setRefreshError(errorMessage(err)),
    )
  }

  return <SourcesTable sources={(fresh ?? state.data).sources} onReviewed={refresh} refreshError={refreshError} />
}

/**
 * The gated "Settings for definitions" button (09 D-80, 22-pages/overview.md §2c): the Overview
 * header's unused action slot, so it renders in every state — loading, error, empty and the data
 * view alike, the one home of this entry (D-72's "settings has two homes" resolved: no nav item).
 */
export function SettingsButton() {
  const gated = useGated('definition_settings')
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          {...gated.bind}
          onClick={gated.activate}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-surface-2 px-3.5 py-1.5 text-sm font-medium text-ink-muted"
        >
          <Icon icon={ICONS.settings} />
          {gated.feature.label}
        </button>
        <ComingSoonTag />
      </div>
      <GatedNote id={gated.noteId} activated={gated.activated} text={gated.feature.note} />
    </div>
  )
}

export default function OverviewPage() {
  const state = useGet<Overview>('/api/overview')
  const header = <PageHeader title={TITLE} purpose={PURPOSE} icon={ICONS.overview} action={<SettingsButton />} />

  if (state === null || state.status === 'loading') {
    return (
      <>
        {header}
        <Loading label="Loading the numbers…" />
      </>
    )
  }
  if (state.status === 'error') {
    return (
      <>
        {header}
        <ErrorLine message={state.message} next={RETRY} />
      </>
    )
  }

  const o = state.data
  if (o.import_runs.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          action={
            <Button variant="primary" icon={ICONS.next} onClick={() => window.location.reload()}>
              Refresh
            </Button>
          }
        >
          <p className="font-medium text-gray-900">No data loaded yet.</p>
          <p>Ask whoever set up this tool to load the data files, then refresh this page.</p>
        </EmptyState>
        <TechnicalDetails>
          <p>
            Load command: <code className="font-mono">npm run db:seed:remote</code> (hosted) or{' '}
            <code className="font-mono">npm run db:seed:local</code> (local). No rows exist in{' '}
            <code className="font-mono">import_runs</code> yet.
          </p>
        </TechnicalDetails>
      </>
    )
  }

  return (
    <>
      {header}
      <StatGrid label="Headline numbers">
        {HEADLINE.map((h) => (
          <Metric key={h.term} value={h.value(o)} label={GLOSSARY[h.term].term} term={h.term} icon={h.icon} />
        ))}
      </StatGrid>

      <SourcesSection />

      <p className="text-sm">
        <Link
          to="/lookup"
          className="inline-flex items-center gap-1.5 font-medium text-accent-strong underline underline-offset-4 hover:text-ink"
        >
          <Icon icon={ICONS.lookup} />
          Next: look up anyone <span aria-hidden="true">→</span>
        </Link>
      </p>
    </>
  )
}
