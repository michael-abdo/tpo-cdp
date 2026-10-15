// GET /api/overview: the headline numbers on Overview.
// Every number is a live query on each request: nothing is cached, so new data shows with no restart.

import { Hono } from 'hono'
import type { AppEnv } from '../env'

interface ImportRunRow {
  file: string
  rows_in: number
  rows_out: number
  merged: number
  quarantined: number
  ran_at: string
}

/** Mounted at /api by worker/index.ts, behind requireSession. */
export const overviewRoutes = new Hono<AppEnv>()

overviewRoutes.get('/overview', async (c) => {
  const db = c.env.DB
  // One batch: D1 runs it as a single transaction, so the numbers come from one snapshot.
  const [counts, runs, reasons] = await db.batch([
    db.prepare(
      `SELECT (SELECT count(*) FROM subscribers) AS subscribers,
              (SELECT count(*) FROM subscribers WHERE status = 'active') AS active,
              (SELECT count(*) FROM app_users) AS app_users,
              (SELECT count(*) FROM app_events) AS events_received`,
    ),
    db.prepare('SELECT file, rows_in, rows_out, merged, quarantined, ran_at FROM import_runs ORDER BY id'),
    db.prepare('SELECT reason, count(*) AS n FROM quarantine GROUP BY reason ORDER BY reason'),
  ])
  const total = (
    counts.results as { subscribers: number; active: number; app_users: number; events_received: number }[]
  )[0]
  if (total === undefined) throw new Error('overview: the count query returned no row')
  const quarantine_reasons: Record<string, number> = {}
  for (const row of reasons.results as { reason: string; n: number }[]) quarantine_reasons[row.reason] = row.n
  return c.json({
    subscribers: total.subscribers,
    active: total.active,
    app_users: total.app_users,
    events_received: total.events_received,
    import_runs: runs.results as ImportRunRow[],
    quarantine_reasons,
  })
})
