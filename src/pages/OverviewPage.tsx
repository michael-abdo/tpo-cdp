// / Overview (06 §Overview): four stat tiles and the import report, all from GET /api/overview
// (04). Every number is the API's; nothing is computed here.

import { Empty, ErrorLine, Loading, Section } from '../components'
import type { Overview } from '../types'
import { useGet } from '../useGet'

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-2xl font-semibold">{value.toLocaleString('en-US')}</div>
      <div className="text-sm text-gray-500">{label}</div>
    </div>
  )
}

export default function OverviewPage() {
  const state = useGet<Overview>('/api/overview')
  if (state === null || state.status === 'loading') return <Loading />
  if (state.status === 'error') return <ErrorLine message={state.message} />
  const o = state.data
  const reasons = Object.entries(o.quarantine_reasons)

  return (
    <>
      <h1 className="text-xl font-semibold">Overview</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Tile label="Subscribers" value={o.subscribers} />
        <Tile label="Active" value={o.active} />
        <Tile label="App users" value={o.app_users} />
        <Tile label="Events received since launch" value={o.events_received} />
      </div>
      <Section title="Import report">
        {o.import_runs.length === 0 ? (
          <Empty>No import has run yet. The seed step loads the three CSV files.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {o.import_runs.map((run) => (
              <li key={`${run.file}-${run.ran_at}`}>
                <span className="font-mono">{run.file}</span>: {run.rows_in.toLocaleString('en-US')} rows in →{' '}
                {run.rows_out.toLocaleString('en-US')} {run.file} · {run.merged.toLocaleString('en-US')} merged ·{' '}
                {run.quarantined.toLocaleString('en-US')} quarantined
              </li>
            ))}
          </ul>
        )}
        <h3 className="pt-2 text-sm font-semibold">Quarantine reasons</h3>
        {reasons.length === 0 ? (
          <Empty>No rows were quarantined.</Empty>
        ) : (
          <ul className="text-sm">
            {reasons.map(([reason, n]) => (
              <li key={reason}>
                <span className="font-mono">{reason}</span>: {n.toLocaleString('en-US')}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}
