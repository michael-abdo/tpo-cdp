// / Overview (06 §Overview): four stat tiles and the import report, all from GET /api/overview
// (04). Every number is the API's; nothing is computed here.
// Disclosure (06 §UI principles 2): level 1 = the four headline numbers and one sentence;
// level 2 = "How the data was combined" (rows in → kept · merged · set aside, reasons in words);
// level 3 = Technical details (raw file names, reason codes, run times in UTC).
// "Needs review" (09 D-61) is level 1 when a set-aside row can be fixed: one sentence, each row as
// written (GET /api/quarantine) and the fix; CSV line numbers and reason codes sit in Technical
// details. Read-only: no edit or delete here (09 D-13).
// "Possible duplicates" (09 D-62) is level 2, collapsed: "Possible duplicates — N to review", each
// scored pair side by side with its score bar, reason chips, one-line suggestion and two buttons
// that record a decision (GET/POST /api/duplicates). Nothing merges; the m/u weights sit in
// Technical details. Scores, reasons and suggestions are the API's; nothing is scored here.

import { Check, Smartphone, UserCheck, Users, UsersRound, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
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
  Loading,
  PageHeader,
  ResponsiveTable,
  Section,
  StatGrid,
  StatTile,
  Tag,
  TechnicalDetails,
} from '../components'
import { humanDate, humanDateTime, utc } from '../format'
import { sourceLabel } from '../labels'
import { asWritten, csvName, needsReview, reviewGroups } from '../needs-review'
import type { DuplicateDecision, DuplicateReview, Duplicates, Overview, QuarantineList } from '../types'
import { useGet } from '../useGet'
import { AUTO_MIN_SCORE, REVIEW_MIN_SCORE } from '../../worker/dedupe/score'

const TITLE = 'Overview'
const PURPOSE = 'The newsletter list, website visits and app users, combined into one profile per reader.'

/** Plain names for the three source files (principle 4); an unknown file shows its own name. */
const FILES: Record<string, { name: string; unit: string }> = {
  subscribers: { name: 'Newsletter list', unit: 'subscribers' },
  web_events: { name: 'Website visits', unit: 'page views' },
  app_users: { name: 'App users', unit: 'app users' },
}

/** Plain words for the quarantine reasons (worker/ingest/quarantine.ts): [one, many]. */
const REASONS: Record<string, [string, string]> = {
  blank_row: ['blank row', 'blank rows'],
  invalid_email: ['invalid email', 'invalid emails'],
  missing_field: ['row missing a required field', 'rows missing a required field'],
  bad_date: ['row with an unreadable date', 'rows with an unreadable date'],
}

function n(value: number): string {
  return value.toLocaleString('en-US')
}

function reasonText(code: string, count: number): string {
  const words = REASONS[code] ?? [code.replaceAll('_', ' '), code.replaceAll('_', ' ')]
  return `${n(count)} ${count === 1 ? words[0] : words[1]}`
}

function ImportLine({ run }: { run: Overview['import_runs'][number] }) {
  const file = FILES[run.file] ?? { name: run.file, unit: 'records' }
  return (
    <li>
      <span className="font-medium">{file.name}:</span> {n(run.rows_in)} rows in{' '}
      <span aria-hidden="true">→</span>
      <span className="sr-only">became</span> {n(run.rows_out)} {file.unit}
      {run.merged > 0 && (
        <>
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
          {n(run.merged)} duplicates merged
        </>
      )}
      {run.quarantined > 0 && (
        <>
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
          {n(run.quarantined)} set aside
        </>
      )}
    </li>
  )
}

/** The set-aside rows a person can fix, each as written in its file, and what to do about them. */
function NeedsReview() {
  const state = useGet<QuarantineList>('/api/quarantine')
  if (state === null || state.status === 'loading') return <Loading label="Loading the rows to review…" />
  if (state.status === 'error')
    return <ErrorLine message={state.message} next="Refresh the page to try again." />
  const groups = reviewGroups(state.data.rows)
  if (groups.length === 0) return null
  return (
    <Section title="Needs review" icon={ICONS.error}>
      {groups.map((group) => (
        <div key={group.key} className="space-y-2">
          <p className="text-sm font-medium text-ink">{group.sentence}</p>
          <ResponsiveTable
            caption={group.sentence}
            columns={group.columns.map((col) => ({
              header: col.label,
              cell: (row: QuarantineList['rows'][number]) => (
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
      ))}
      <TechnicalDetails>
        <ul>
          {groups.flatMap((group) =>
            group.rows.map((row) => (
              <li key={`${row.file}-${row.line_no}`}>
                {csvName(row.file)} line {row.line_no} · {row.reason}
              </li>
            )),
          )}
        </ul>
      </TechnicalDetails>
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
        candidates: {data.candidates} subscriber pairs sharing a name stem (email local part without trailing
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

const plainCount = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`

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
          <p>Ask whoever set up this tool to load the three files, then refresh this page.</p>
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

  const reasons = Object.entries(o.quarantine_reasons)

  return (
    <>
      {header}
      <StatGrid label="Headline numbers">
        <StatTile label="Readers who signed up" icon={Users} value={o.subscribers} />
        <StatTile label="Readers still subscribed" icon={UserCheck} value={o.active} />
        <StatTile label="App users" icon={Smartphone} value={o.app_users} />
        <StatTile
          label="Events received since launch"
          icon={ICONS.events}
          value={o.events_received}
          note={
            o.events_received === 0 ? (
              <Link
                to="/events"
                className="text-accent-strong underline underline-offset-2 hover:text-blue-900"
              >
                None yet — see App events
              </Link>
            ) : undefined
          }
        />
      </StatGrid>

      <p className="flex items-start gap-2 text-sm text-ink-muted">
        <Icon icon={ICONS.success} className="mt-0.5 size-4 text-success" />
        <span>
          Loaded {plainCount(o.import_runs.length, 'file', 'files')} into one list:{' '}
          {plainCount(
            o.import_runs.reduce((t, r) => t + r.merged, 0),
            'duplicate',
            'duplicates',
          )}{' '}
          merged,{' '}
          {plainCount(
            o.import_runs.reduce((t, r) => t + r.quarantined, 0),
            'row',
            'rows',
          )}{' '}
          set aside.
        </span>
      </p>
      <Disclosure label="How the data was combined">
        <ul className="space-y-1 text-sm text-gray-800">
          {o.import_runs.map((run) => (
            <ImportLine key={`${run.file}-${run.ran_at}`} run={run} />
          ))}
        </ul>
        <p className="text-sm text-gray-700">
          {reasons.length === 0
            ? 'No rows were set aside — every row loaded.'
            : `Set aside: ${reasons.map(([code, count]) => reasonText(code, count)).join(', ')}. These rows are kept for review, not counted.`}
        </p>
        <TechnicalDetails>
          <table className="w-auto text-left">
            <caption className="sr-only">Import runs, raw values</caption>
            <thead>
              <tr className="text-gray-600">
                <th scope="col" className="py-1 pr-3 font-medium">
                  file
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  rows_in
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  rows_out
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  merged
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  quarantined
                </th>
                <th scope="col" className="hidden py-1 font-medium sm:table-cell">
                  ran_at
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {o.import_runs.map((run) => (
                <tr key={`${run.file}-${run.ran_at}`}>
                  <td className="py-0.5 pr-3">{run.file}</td>
                  <td className="py-0.5 pr-3 text-right">{run.rows_in}</td>
                  <td className="py-0.5 pr-3 text-right">{run.rows_out}</td>
                  <td className="py-0.5 pr-3 text-right">{run.merged}</td>
                  <td className="py-0.5 pr-3 text-right">{run.quarantined}</td>
                  <td className="hidden py-0.5 sm:table-cell">{utc(run.ran_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sm:hidden">
            Ran at: {o.import_runs.map((run) => `${run.file} ${utc(run.ran_at)}`).join('; ')}
          </p>
          {reasons.length > 0 && (
            <p>
              quarantine_reasons:{' '}
              <span className="font-mono">
                {reasons.map(([code, count]) => `${code} ${count}`).join(', ')}
              </span>
            </p>
          )}
        </TechnicalDetails>
      </Disclosure>

      {reasons.some(([code]) => needsReview(code)) && <NeedsReview />}

      <PossibleDuplicates />

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
