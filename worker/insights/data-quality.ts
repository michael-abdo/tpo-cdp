// Data quality, the fourth /growth panel (GET /api/insights/data-quality, T-INS-3). Two parts:
//   - `import`: the seed's own record, read from `import_runs` and `quarantine`. The per-file
//     report lives on Overview, so the panel shows only the share set aside and points there
//     instead of repeating it. The two tables must agree on how
//     many rows were set aside; if they do not, the request fails loud rather than show either.
//   - `checks`: gaps in the records that did load, each counted over the PII-free views the
//     assistant reads (v_profiles, v_web_events), so its "Explain this" question reproduces the
//     number. The unexpected-value checks are the ones shared/normalize.ts promises: a
//     source outside the canonical set passes through and shows up here, never silently lost.
// Every status is counted (a data gap is a gap whoever it belongs to), so the subscriber
// questions ask the assistant to include unsubscribed ones (it leaves them out by default).
// Live query on every request; nothing is cached, so new data shows with no restart.

import { CANONICAL_SOURCES } from '../../shared/normalize'

export interface QuarantineGroup {
  file: string
  /** A quarantine reason (worker/ingest/quarantine.ts). */
  reason: string
  rows: number
}

export interface ImportQuality {
  /** Sums over every import_runs row. */
  rows_in: number
  rows_out: number
  merged: number
  quarantined: number
  /** quarantined / rows_in, 4 decimals; null when nothing was loaded. */
  rate: number | null
  /** quarantine rows by file, then reason. */
  by_file_reason: QuarantineGroup[]
}

/** The checks, in the order the panel lists them. */
export const DATA_QUALITY_CHECKS = [
  'subscribers_without_source',
  'subscribers_unexpected_source',
  'page_views_without_utm',
  'page_views_unexpected_utm',
  'app_users_not_on_list',
] as const

export type DataQualityCheckKey = (typeof DATA_QUALITY_CHECKS)[number]

export interface DataQualityCheck {
  key: DataQualityCheckKey
  /** Records with the gap. */
  count: number
  /** Records checked. */
  of: number
  /** count / of, 4 decimals; null when there is nothing to check. */
  rate: number | null
  /** The assistant question this number answers. */
  explain: string
}

export interface DataQuality {
  import: ImportQuality
  checks: DataQualityCheck[]
}

const CANONICAL_LIST = CANONICAL_SOURCES.join(', ')
const IN_CANONICAL = `(${CANONICAL_SOURCES.map(() => '?').join(', ')})`

const IMPORT_SQL = `SELECT coalesce(sum(rows_in), 0) AS rows_in, coalesce(sum(rows_out), 0) AS rows_out,
  coalesce(sum(merged), 0) AS merged, coalesce(sum(quarantined), 0) AS quarantined FROM import_runs`
const QUARANTINE_SQL = `SELECT file, reason, count(*) AS "rows" FROM quarantine GROUP BY file, reason ORDER BY file, reason`
// app_users_not_on_list's `of` (app_users_not_on_list's `explain`, below) is "all app accounts
// with an email", so the denominator stays email-scoped: migrations/0011 gives a
// kind = 'unknown_user_stub' row has_app = 1 by its user_id link, not an email, so it is excluded
// here the same way it is excluded from every other email-keyed v_profiles read (e.g.
// source-app.ts's WHERE kind = 'subscriber'). Without the kind filter, a stub inflates `of` by
// one per stub while `app_users WHERE email_norm IS NOT NULL` stays unchanged (test/webhook.test.ts
// T-WH-6 regression case).
const PROFILES_SQL = `SELECT
  coalesce(sum(kind = 'subscriber'), 0) AS subscribers,
  coalesce(sum(kind = 'subscriber' AND source IS NULL), 0) AS subscribers_without_source,
  coalesce(sum(kind = 'subscriber' AND source NOT IN ${IN_CANONICAL}), 0) AS subscribers_unexpected_source,
  coalesce(sum(has_app AND kind <> 'unknown_user_stub'), 0) AS app_users,
  coalesce(sum(kind = 'app_only'), 0) AS app_users_not_on_list
FROM v_profiles`
const WEB_SQL = `SELECT
  count(*) AS page_views,
  coalesce(sum(utm_source IS NULL), 0) AS page_views_without_utm,
  coalesce(sum(utm_source NOT IN ${IN_CANONICAL}), 0) AS page_views_unexpected_utm
FROM v_web_events`

/** The question behind each check's number. */
export const DATA_QUALITY_EXPLAIN: Record<DataQualityCheckKey, string> = {
  subscribers_without_source:
    'How many subscribers, including unsubscribed ones, have no acquisition source recorded, out of all subscribers?',
  subscribers_unexpected_source: `How many subscribers, including unsubscribed ones, have an acquisition source that is not one of ${CANONICAL_LIST}, out of all subscribers?`,
  page_views_without_utm: 'How many website visits carried no UTM source, out of all website visits?',
  page_views_unexpected_utm: `How many website visits carried a UTM source that is not one of ${CANONICAL_LIST}, out of all website visits?`,
  app_users_not_on_list:
    'How many app accounts have an email that does not belong to a newsletter subscriber, out of all app accounts with an email?',
}

const rate = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 10000) / 10000)

type ProfileCounts = Record<'subscribers' | 'subscribers_without_source' | 'subscribers_unexpected_source' | 'app_users' | 'app_users_not_on_list', number>
type WebCounts = Record<'page_views' | 'page_views_without_utm' | 'page_views_unexpected_utm', number>
type ImportCounts = Omit<ImportQuality, 'rate' | 'by_file_reason'>

export async function dataQuality(db: D1Database): Promise<DataQuality> {
  // One batch: D1 runs it as one transaction, so every number comes from one snapshot.
  const [imports, quarantine, profiles, web] = await db.batch([
    db.prepare(IMPORT_SQL),
    db.prepare(QUARANTINE_SQL),
    db.prepare(PROFILES_SQL).bind(...CANONICAL_SOURCES),
    db.prepare(WEB_SQL).bind(...CANONICAL_SOURCES),
  ])
  const run = (imports.results as ImportCounts[])[0]
  const p = (profiles.results as ProfileCounts[])[0]
  const w = (web.results as WebCounts[])[0]
  if (run === undefined || p === undefined || w === undefined) throw new Error('data-quality: a count query returned no row')
  const by_file_reason = quarantine.results as QuarantineGroup[]
  const quarantineRows = by_file_reason.reduce((n, g) => n + g.rows, 0)
  if (quarantineRows !== run.quarantined) {
    throw new Error(
      `data-quality: import_runs says ${run.quarantined} rows were quarantined but the quarantine table holds ${quarantineRows}`,
    )
  }
  const check = (key: DataQualityCheckKey, count: number, of: number): DataQualityCheck => ({
    key,
    count,
    of,
    rate: rate(count, of),
    explain: DATA_QUALITY_EXPLAIN[key],
  })
  return {
    import: { ...run, rate: rate(run.quarantined, run.rows_in), by_file_reason },
    checks: [
      check('subscribers_without_source', p.subscribers_without_source, p.subscribers),
      check('subscribers_unexpected_source', p.subscribers_unexpected_source, p.subscribers),
      check('page_views_without_utm', w.page_views_without_utm, w.page_views),
      check('page_views_unexpected_utm', w.page_views_unexpected_utm, w.page_views),
      check('app_users_not_on_list', p.app_users_not_on_list, p.app_users),
    ],
  }
}
