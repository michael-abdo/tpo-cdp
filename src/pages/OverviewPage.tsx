// / Overview (06 §Overview): four stat tiles and the import report, all from GET /api/overview
// (04). Every number is the API's; nothing is computed here.
// Disclosure (06 §UI principles 2): level 1 = the four headline numbers and one sentence;
// level 2 = "How the data was combined" (rows in → kept · merged · set aside, reasons in words);
// level 3 = Technical details (raw file names, reason codes, run times in UTC).

import { Link } from 'react-router'
import {
  Button,
  Disclosure,
  EmptyState,
  ErrorLine,
  Loading,
  PageHeader,
  StatGrid,
  StatTile,
  TechnicalDetails,
} from '../components'
import { utc } from '../format'
import type { Overview } from '../types'
import { useGet } from '../useGet'

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
      <span className="font-medium">{file.name}:</span> {n(run.rows_in)} rows in <span aria-hidden="true">→</span>
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

const plainCount = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`

export default function OverviewPage() {
  const state = useGet<Overview>('/api/overview')
  const header = <PageHeader title={TITLE} purpose={PURPOSE} />

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
            <Button variant="primary" onClick={() => window.location.reload()}>
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
        <StatTile label="Readers on the newsletter list" value={o.subscribers} />
        <StatTile label="Readers still subscribed" value={o.active} />
        <StatTile label="App users" value={o.app_users} />
        <StatTile
          label="Events received since launch"
          value={o.events_received}
          note={
            o.events_received === 0 ? (
              <Link to="/events" className="text-blue-700 underline underline-offset-2 hover:text-blue-900">
                None yet — see App events
              </Link>
            ) : undefined
          }
        />
      </StatGrid>

      <p className="text-sm text-gray-700">
        Loaded {plainCount(o.import_runs.length, 'file', 'files')} into one list:{' '}
        {plainCount(o.import_runs.reduce((t, r) => t + r.merged, 0), 'duplicate', 'duplicates')} merged,{' '}
        {plainCount(o.import_runs.reduce((t, r) => t + r.quarantined, 0), 'row', 'rows')} set aside.
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
                <th scope="col" className="py-1 pr-3 font-medium">file</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">rows_in</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">rows_out</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">merged</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">quarantined</th>
                <th scope="col" className="hidden py-1 font-medium sm:table-cell">ran_at</th>
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
              <span className="font-mono">{reasons.map(([code, count]) => `${code} ${count}`).join(', ')}</span>
            </p>
          )}
        </TechnicalDetails>
      </Disclosure>

      <p className="text-sm">
        <Link to="/lookup" className="font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900">
          Next: find a reader <span aria-hidden="true">→</span>
        </Link>
      </p>
    </>
  )
}
