// GET /api/sources (04 §GET /api/sources, 09 D-63, D-65; R1.1): every source in the registry
// (shared/sources.ts) with its last sync, status, checks, record count and run history, for
// Overview's Sources table (06 §Overview). Names, kinds, units and which checks a source has come
// only from the registry; numbers only from import_runs, quarantine, app_events and, for the
// possible_duplicates check, the D-62 scorer through worker/routes/duplicates.ts (the same count
// GET /api/duplicates calls to_review). Live queries on every request; nothing is cached
// (03 §No-restart). Session auth (mounted behind requireSession).

import { Hono } from 'hono'
import { TODAY } from '../../shared/config'
import { type CheckKind, SOURCES, type Source } from '../../shared/sources'
import type { AppEnv } from '../env'
import { duplicatesToReview } from './duplicates'

export interface SourceRun {
  id: number
  /** When the seed script ran, UTC `YYYY-MM-DDTHH:MM:SSZ` (02 §Time allow-list, 09 D-48). */
  ran_at: string
  rows_in: number
  rows_out: number
  merged: number
  /** Rows set aside (quarantined) by this run. */
  rejected: number
  /** Of those, rows a person can fix: every reason except blank_row (09 D-61). */
  needs_review: number
}

/** One check the registry declares for a source, with what it counts now (09 D-65). */
export interface SourceCheck {
  kind: CheckKind
  count: number
}

interface Common {
  id: Source['id']
  name: string
  unit: string
  /** The registry's record unit, singular (for a count of 1). */
  unit_one: string
  /** The registry entry's checks, in its order; [] when it declares none. */
  checks: SourceCheck[]
  records: number
}

export interface CsvSourceOut extends Common {
  kind: 'csv'
  loads_by: 'seed'
  /** needs_review when any check counts more than 0; not_loaded before the first seed. */
  status: 'ok' | 'needs_review' | 'not_loaded'
  last_sync: string | null
  /** Newest first. */
  runs: SourceRun[]
}

export interface WebhookSourceOut extends Common {
  kind: 'webhook'
  loads_by: 'webhook'
  status: 'live'
  /** Events whose event time falls on TODAY (02 §Time), not the wall-clock day. */
  today: number
  /** Latest received_at; null before the first event. */
  last_received: string | null
  runs: []
}

export type SourceOut = CsvSourceOut | WebhookSourceOut

interface RunRow {
  id: number
  file: string
  rows_in: number
  rows_out: number
  merged: number
  quarantined: number
  ran_at: string
}

/** Mounted at /api by worker/index.ts, behind requireSession. */
export const sourceRoutes = new Hono<AppEnv>()

sourceRoutes.get('/sources', async (c) => {
  const db = c.env.DB
  // One batch: D1 runs it as a single transaction, so the run, set-aside and event numbers come from
  // one snapshot. The possible_duplicates count is read after it, in its own queries (below).
  const [runs, rejects, events] = await db.batch([
    db.prepare('SELECT id, file, rows_in, rows_out, merged, quarantined, ran_at FROM import_runs ORDER BY id DESC'),
    db.prepare(
      `SELECT run_id, count(*) AS rejected, sum(reason <> 'blank_row') AS needs_review
         FROM quarantine GROUP BY run_id`,
    ),
    db
      .prepare(
        `SELECT count(*) AS records, coalesce(sum(substr(event_ts, 1, 10) = ?1), 0) AS today,
                max(received_at) AS last_received
           FROM app_events`,
      )
      .bind(TODAY),
  ])
  const byRun = new Map(
    (rejects.results as { run_id: number; rejected: number; needs_review: number }[]).map((r) => [r.run_id, r]),
  )
  const event = (events.results as { records: number; today: number; last_received: string | null }[])[0]
  if (event === undefined) throw new Error('sources: the app_events count query returned no row')

  const runsOf = (file: string): SourceRun[] =>
    (runs.results as RunRow[])
      .filter((r) => r.file === file)
      .map((r) => {
        const q = byRun.get(r.id) ?? { rejected: 0, needs_review: 0 }
        // The seed writes both tables; if they disagree, neither number can be shown (fail loud).
        if (q.rejected !== r.quarantined) {
          throw new Error(
            `sources: import_runs ${r.id} says ${r.quarantined} rows were set aside, quarantine holds ${q.rejected}`,
          )
        }
        return {
          id: r.id,
          ran_at: r.ran_at,
          rows_in: r.rows_in,
          rows_out: r.rows_out,
          merged: r.merged,
          rejected: r.quarantined,
          needs_review: q.needs_review,
        }
      })

  // Scored only when some source declares the check (the scorer reads every subscriber).
  const possibleDuplicates = SOURCES.some((s) => (s.checks as readonly CheckKind[]).includes('possible_duplicates'))
    ? await duplicatesToReview(db)
    : 0

  const sources: SourceOut[] = SOURCES.map((s): SourceOut => {
    const declared: readonly CheckKind[] = s.checks
    if (s.kind === 'webhook') {
      // A webhook has no sync to set rows aside and no status but live (04).
      if (declared.length > 0) throw new Error(`sources: webhook source ${s.id} declares checks`)
      return {
        id: s.id,
        name: s.name,
        kind: s.kind,
        unit: s.unit[1],
        unit_one: s.unit[0],
        loads_by: s.loads_by,
        status: 'live',
        checks: [],
        records: event.records,
        today: event.today,
        last_received: event.last_received,
        runs: [],
      }
    }
    const history = runsOf(s.id)
    const last = history[0]
    const fixable = last?.needs_review ?? 0
    // Rows a person can fix must reach a screen: a source without the check would show them as OK.
    if (fixable > 0 && !declared.includes('rows_to_fix')) {
      throw new Error(
        `sources: ${s.id}'s newest run set aside ${fixable} rows a person can fix, but its registry entry declares no rows_to_fix check`,
      )
    }
    const counts: Record<CheckKind, number> = { rows_to_fix: fixable, possible_duplicates: possibleDuplicates }
    const checks = declared.map((kind) => ({ kind, count: counts[kind] }))
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      unit: s.unit[1],
      unit_one: s.unit[0],
      loads_by: s.loads_by,
      status: last === undefined ? 'not_loaded' : checks.some((c) => c.count > 0) ? 'needs_review' : 'ok',
      checks,
      records: last?.rows_out ?? 0,
      last_sync: last?.ran_at ?? null,
      runs: history,
    }
  })
  return c.json({ sources })
})
