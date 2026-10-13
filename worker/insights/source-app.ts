// Source → app conversion, the first /growth panel (04 §GET /api/insights/source-app-conversion,
// 06 §/growth; R6). Per signup source: how many subscribers created an app account AFTER their
// newsletter signup (02 §Linking 6, 09 D-15). An app created before signup, or on the signup day,
// is not a conversion: the rule is `app_after_signup` (02 §Derived), stored in v_profiles, the
// same column the assistant's `source_to_app` metric sums, so "Explain this" reproduces these
// numbers. Every status is counted: the panel describes the whole list, so each `explain`
// question asks the assistant to include unsubscribed readers (its default is active only,
// 02 §Defaults). Live query on every request; nothing is cached (03 §No-restart).

import type { DefinitionKey } from '../../shared/derive'

/** The definitions the panel's numbers use, rendered from DEFINITIONS by the UI (02 §Derived). */
export const SOURCE_APP_DEFINITIONS: readonly DefinitionKey[] = ['app_after_signup', 'has_app']

export interface SourceAppCounts {
  subscribers: number
  /** Subscribers with any app account, whatever its date. */
  with_app: number
  /** Subscribers whose app account was created after the signup day (the conversions). */
  with_app_after_signup: number
  /** with_app_after_signup / subscribers, 4 decimals; null when there are no subscribers. */
  rate: number | null
  /** The assistant question these numbers answer (09 D-39). */
  explain: string
}

export interface SourceAppRow extends SourceAppCounts {
  /** Canonical source (02 §Normalization); null = no source recorded. */
  source: string | null
}

export interface SourceAppConversion {
  total: SourceAppCounts
  /** Highest conversion rate first, then the larger source, then by name. */
  by_source: SourceAppRow[]
  definitions_used: readonly DefinitionKey[]
}

type Counts = Omit<SourceAppCounts, 'explain'>

// kind = 'subscriber' keeps app-only and stub profiles out: they have no signup to come after.
const COUNTS_SQL = `count(*) AS subscribers,
  coalesce(sum(has_app), 0) AS with_app,
  coalesce(sum(app_after_signup), 0) AS with_app_after_signup,
  CASE WHEN count(*) = 0 THEN NULL ELSE round(CAST(sum(app_after_signup) AS REAL) / count(*), 4) END AS rate
FROM v_profiles WHERE kind = 'subscriber'`

const TOTAL_SQL = `SELECT ${COUNTS_SQL}`
const BY_SOURCE_SQL = `SELECT source, ${COUNTS_SQL} GROUP BY source ORDER BY rate DESC, subscribers DESC, source`

const QUESTION = (who: string) =>
  `Of ${who}, including unsubscribed readers, how many created an app account after the day they signed up for the newsletter, and what share is that?`

/** The question behind the panel's total. */
export const SOURCE_APP_TOTAL_EXPLAIN = QUESTION('all subscribers')

/** The question behind one source's row. */
export function sourceAppExplain(source: string | null): string {
  return QUESTION(source === null ? 'subscribers with no signup source recorded' : `subscribers whose signup source is "${source}"`)
}

export async function sourceAppConversion(db: D1Database): Promise<SourceAppConversion> {
  // One batch: D1 runs it as one transaction, so the total and the rows come from one snapshot.
  const [total, rows] = await db.batch([db.prepare(TOTAL_SQL), db.prepare(BY_SOURCE_SQL)])
  const totalRow = (total.results as Counts[])[0]
  if (totalRow === undefined) throw new Error('source-app: the total query returned no row')
  return {
    total: { ...totalRow, explain: SOURCE_APP_TOTAL_EXPLAIN },
    by_source: (rows.results as (Counts & { source: string | null })[]).map((r) => ({
      source: r.source,
      subscribers: r.subscribers,
      with_app: r.with_app,
      with_app_after_signup: r.with_app_after_signup,
      rate: r.rate,
      explain: sourceAppExplain(r.source),
    })),
    definitions_used: SOURCE_APP_DEFINITIONS,
  }
}
