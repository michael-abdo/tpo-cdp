// / Overview (06 §Overview, 09 D-63): where reader data comes from, how each load went, and what
// needs a person. Every number is the API's; nothing is computed here but sums for the header line.
// Level 1, top to bottom: four headline Metrics (GET /api/overview), each with an InfoTip; the
// Sources table (GET /api/sources) with its one-line header. Level 2: each source's history (CSV:
// its runs, read · kept · merged · rejected, and "View rejected rows" → GET /api/quarantine?file=;
// webhook: events received), then "Needs review" (09 D-61) and "Possible duplicates" (09 D-62),
// collapsed. Level 3: Technical details (raw ids, reason codes, CSV lines, UTC to the second).
// Source names, kinds and units come only from the API, which reads shared/sources.ts; term words
// and explanations only from shared/glossary.ts (or DEFINITIONS). No per-file sentence lives here
// (08 T-SRC-2 scans this file). Read-only: no edit or delete here (09 D-13).
// "Possible duplicates" (09 D-62): each scored pair side by side with its score bar, reason chips,
// one-line suggestion and two buttons that record a decision (GET/POST /api/duplicates). Nothing
// merges; the m/u weights sit in Technical details. Scores, reasons and suggestions are the API's.

import { Check, Smartphone, UserCheck, Users, UsersRound, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { TODAY } from '../../shared/config'
import { LOADS_BY_LABEL } from '../../shared/sources'
import { countOf, GLOSSARY, type GlossaryKey } from '../../shared/glossary'
import { errorMessage, postJson } from '../api'
import {
  Announcer,
  Button,
  Disclosure,
  EmptyState,
  ErrorLine,
  Field,
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
import { humanDate, humanDateTime, utc } from '../format'
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
import { AUTO_MIN_SCORE, REVIEW_MIN_SCORE } from '../../worker/dedupe/score'

const TITLE = 'Overview'
const PURPOSE = 'Where reader data comes from, how each load went, and what needs a person.'

function n(value: number): string {
  return value.toLocaleString('en-US')
}

/** "1 row" / "2 rows". */
const rowCount = (count: number) => `${n(count)} ${count === 1 ? 'row' : 'rows'}`

/** The four headline numbers (06 §Overview 1): the glossary names and explains each. */
const HEADLINE: { term: GlossaryKey; icon: LucideIcon; value: (o: Overview) => number }[] = [
  { term: 'readers_signed_up', icon: Users, value: (o) => o.subscribers },
  { term: 'readers_subscribed', icon: UserCheck, value: (o) => o.active },
  { term: 'app_accounts', icon: Smartphone, value: (o) => o.app_users },
  { term: 'events_received', icon: ICONS.events, value: (o) => o.events_received },
]

type AnySource = Sources['sources'][number]

/** Rows a person can fix in each CSV source's latest run (09 D-61): the Sources header and "Needs review" count. */
function toReview(sources: readonly AnySource[]): number {
  return sources.reduce((t, s) => t + (s.kind === 'csv' ? (s.runs[0]?.needs_review ?? 0) : 0), 0)
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

function StatusTag({ source }: { source: AnySource }) {
  if (source.kind === 'webhook') {
    return (
      <span className="inline-flex items-center gap-0.5">
        <Tag tone="accent" icon={ICONS.live}>
          {GLOSSARY.live.term}
        </Tag>
        <InfoTip term="live" />
      </span>
    )
  }
  if (source.status === 'not_loaded') return <Tag icon={ICONS.empty}>Not loaded yet</Tag>
  if (source.status === 'ok') {
    return (
      <Tag tone="success" icon={ICONS.success}>
        OK
      </Tag>
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      <Tag icon={ICONS.warning}>{n(source.runs[0]?.needs_review ?? 0)} to review</Tag>
      <InfoTip term="needs_review" />
    </span>
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
      <ResponsiveTable
        caption={group.sentence}
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

/** A run's rejected rows (06 §Overview): the count per reason in glossary words, fixable rows as written. */
function RejectedRows({ sourceId, id }: { sourceId: string; id: string }) {
  const state = useGet<QuarantineList>(`/api/quarantine?file=${encodeURIComponent(sourceId)}`)
  if (state === null || state.status === 'loading') return <Loading label="Loading the rejected rows…" />
  if (state.status === 'error') return <ErrorLine message={state.message} next="Try again." />
  const list = state.data.rows
  const perReason = new Map<QuarantinedRow['reason'], number>()
  for (const row of list) perReason.set(row.reason, (perReason.get(row.reason) ?? 0) + 1)
  const blank = perReason.get('blank_row') ?? 0
  return (
    <div id={id} className="space-y-3 rounded-lg border border-line bg-surface p-3">
      <p className="text-sm text-ink">
        {rowCount(list.length)}: {[...perReason].map(([reason, count]) => countOf(reason, count)).join(', ')}.
      </p>
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

/** Level 2 for one source: a CSV's run history, or the webhook's events received (06 §Overview 2). */
function SourceHistory({ source }: { source: AnySource }) {
  if (source.kind === 'webhook') return <WebhookHistory source={source} />
  return (
    <div className="space-y-2">
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
          Loads by: {LOADS_BY_LABEL[source.loads_by]} · id: {source.id} · loads_by: {source.loads_by}
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

function WebhookHistory({ source }: { source: WebhookSource }) {
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-muted">Received</dt>
          <dd className="font-medium tabular-nums text-ink">{n(source.records)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Dated today ({humanDate(TODAY)})</dt>
          <dd className="font-medium tabular-nums text-ink">{n(source.today)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Last received</dt>
          <dd className="font-medium text-ink">
            {source.last_received === null ? 'None yet' : humanDateTime(source.last_received)}
          </dd>
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
          Loads by: {LOADS_BY_LABEL[source.loads_by]} · id: {source.id} · loads_by: {source.loads_by} · endpoint: POST /webhooks/app
          {source.last_received !== null && <> · last received_at {utc(source.last_received)}</>}
        </p>
      </TechnicalDetails>
    </div>
  )
}

/** The Sources table (06 §Overview 2), rendered only from GET /api/sources. */
function SourcesTable({ sources }: { sources: AnySource[] }) {
  const latest = lastSync(sources)
  const review = toReview(sources)
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
            review === 0 ? 'nothing to review' : `${rowCount(review)} ${review === 1 ? 'needs' : 'need'} review`,
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
            cell: (s: AnySource) => {
              const at = s.kind === 'csv' ? s.last_sync : s.last_received
              return at === null ? 'None yet' : humanDate(at)
            },
          },
          { header: 'Status', cell: (s: AnySource) => <StatusTag source={s} /> },
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
        details={(s) => <SourceHistory source={s} />}
        detailsLabel="History"
      />
    </Section>
  )
}

/** The set-aside rows a person can fix, each as written in its file, and what to do (09 D-61). */
function NeedsReview({ count }: { count: number }) {
  const state = useGet<QuarantineList>('/api/quarantine')
  return (
    <Disclosure
      label={
        <span className="inline-flex items-center gap-1.5">
          <Icon icon={ICONS.warning} />
          Needs review — {rowCount(count)}
        </span>
      }
    >
      {state === null || state.status === 'loading' ? (
        <Loading label="Loading the rows to review…" />
      ) : state.status === 'error' ? (
        <ErrorLine message={state.message} next="Refresh the page to try again." />
      ) : (
        <>
          <FixableGroups list={state.data.rows} />
          <RowLines list={state.data.rows.filter((row) => needsReview(row.reason))} />
        </>
      )}
    </Disclosure>
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
        {[pair.a, pair.b].map((reader) => (
          <dl key={reader.email} className="space-y-1 rounded-lg bg-surface-2 p-3">
            <Field label="Email">{reader.email}</Field>
            <Field label="Signed up">{humanDate(reader.signup_date)}</Field>
            <Field label="Source">{sourceLabel(reader.source)}</Field>
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
        candidates: {data.candidates} reader pairs sharing a name stem (email local part without trailing
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

/** Scored possible duplicates for a person to judge (09 D-62); a decision is recorded, never merged. */
function PossibleDuplicates() {
  const state = useGet<Duplicates>('/api/duplicates')
  const [decided, setDecided] = useState<Readonly<Record<string, DuplicateDecision>>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ pairId: string; message: string } | null>(null)
  const [announcement, setAnnouncement] = useState('')

  if (state === null || state.status === 'loading')
    return <Loading label="Checking for possible duplicates…" />
  if (state.status === 'error')
    return <ErrorLine message={state.message} next="Refresh the page to try again." />
  const data = state.data
  const newlyDecided = data.review.filter(
    (p) => p.decision === null && decided[p.pair_id] !== undefined,
  ).length
  const toReview = data.to_review - newlyDecided

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
    } catch (err) {
      setFailed({ pairId, message: errorMessage(err) })
    } finally {
      setSaving(null)
    }
  }

  return (
    <Disclosure
      label={
        <span className="inline-flex items-center gap-1.5">
          <Icon icon={UsersRound} />
          Possible duplicates — {n(toReview)} to review
        </span>
      }
    >
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
        Score {AUTO_MIN_SCORE} or more: very likely the same person. {REVIEW_MIN_SCORE}–{AUTO_MIN_SCORE - 1}:
        worth a look. Under {REVIEW_MIN_SCORE}: not shown ({n(data.hidden_below_review)}{' '}
        {data.hidden_below_review === 1 ? 'pair' : 'pairs'}). Nothing is merged automatically — your answer is
        only recorded.
      </p>
      <DuplicateTechnicalDetails data={data} pairs={data.review} />
      <Announcer message={announcement} />
    </Disclosure>
  )
}

/** Sources, then the two collapsed review sections under the table (06 §Overview 2–3). */
function SourcesAndReview() {
  const state = useGet<Sources>('/api/sources')
  if (state === null || state.status === 'loading') return <Loading label="Loading the sources…" />
  if (state.status === 'error')
    return <ErrorLine message={state.message} next="Refresh the page to try again." />
  const review = toReview(state.data.sources)
  return (
    <>
      <SourcesTable sources={state.data.sources} />
      <div className="space-y-3">
        {review > 0 && <NeedsReview count={review} />}
        <PossibleDuplicates />
      </div>
    </>
  )
}

export default function OverviewPage() {
  const state = useGet<Overview>('/api/overview')
  const header = <PageHeader title={TITLE} purpose={PURPOSE} icon={ICONS.overview} />

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
        <ErrorLine message={state.message} next="Refresh the page to try again." />
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

      <SourcesAndReview />

      <p className="text-sm">
        <Link
          to="/lookup"
          className="inline-flex items-center gap-1.5 font-medium text-accent-strong underline underline-offset-4 hover:text-ink"
        >
          <Icon icon={ICONS.lookup} />
          Next: find a reader <span aria-hidden="true">→</span>
        </Link>
      </p>
    </>
  )
}
