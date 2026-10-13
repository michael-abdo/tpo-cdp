// Visitor → subscriber funnel, the second /growth panel (04 §GET /api/insights/funnel,
// 06 §/growth; R6). Website visitors, and how many of them subscribed, by the page and by the
// campaign source (UTM) of their earliest visit (09 D-49), read from the PII-free v_funnel view,
// the same relation the assistant's `visitor_to_subscriber` metric reads, so "Explain this"
// reproduces these numbers. Anonymous visitors stay in the counts (02 §Linking 3, 09 D-15).
// The self-reported-vs-UTM panel is dropped (09 D-21). Live query on every request (03 §No-restart).

export interface FunnelCounts {
  visitors: number
  /** Visitors linked to a subscriber by a /subscribe email (02 §Linking 2). */
  subscribed: number
  /** subscribed / visitors, 4 decimals; null when there are no visitors. */
  rate: number | null
  /** The assistant question these numbers answer (09 D-39). */
  explain: string
}

export interface FunnelPageRow extends FunnelCounts {
  first_page: string
}

export interface FunnelUtmRow extends FunnelCounts {
  /** Canonical UTM of the earliest visit; null = that visit carried none (09 D-49). */
  first_utm_source: string | null
}

export interface Funnel {
  total: FunnelCounts
  /** Most visitors first, then by name. */
  by_first_page: FunnelPageRow[]
  /** Most visitors first, then by name. */
  by_first_utm: FunnelUtmRow[]
}

type Counts = Omit<FunnelCounts, 'explain'>

const COUNTS_SQL = `coalesce(sum(visitors), 0) AS visitors,
  coalesce(sum(subscribed), 0) AS subscribed,
  CASE WHEN coalesce(sum(visitors), 0) = 0 THEN NULL ELSE round(CAST(sum(subscribed) AS REAL) / sum(visitors), 4) END AS rate
FROM v_funnel`

const TOTAL_SQL = `SELECT ${COUNTS_SQL}`
const BY_PAGE_SQL = `SELECT first_page, ${COUNTS_SQL} GROUP BY first_page ORDER BY visitors DESC, first_page`
const BY_UTM_SQL = `SELECT first_utm_source, ${COUNTS_SQL} GROUP BY first_utm_source ORDER BY visitors DESC, first_utm_source`

const QUESTION = (who: string) =>
  `Of ${who}, how many subscribed to the newsletter, and what share is that?`

/** The question behind the panel's total. */
export const FUNNEL_TOTAL_EXPLAIN = QUESTION('all website visitors')

/** The question behind one first-page row. */
export function funnelPageExplain(page: string): string {
  return QUESTION(`website visitors whose first page was "${page}"`)
}

/** The question behind one first-UTM row. */
export function funnelUtmExplain(utm: string | null): string {
  return QUESTION(
    utm === null
      ? 'website visitors whose first visit carried no campaign source (UTM)'
      : `website visitors whose first visit came from the campaign source (UTM) "${utm}"`,
  )
}

export async function funnel(db: D1Database): Promise<Funnel> {
  // One batch: D1 runs it as one transaction, so the three answers come from one snapshot.
  const [total, pages, utms] = await db.batch([db.prepare(TOTAL_SQL), db.prepare(BY_PAGE_SQL), db.prepare(BY_UTM_SQL)])
  const totalRow = (total.results as Counts[])[0]
  if (totalRow === undefined) throw new Error('funnel: the total query returned no row')
  return {
    total: { ...totalRow, explain: FUNNEL_TOTAL_EXPLAIN },
    by_first_page: (pages.results as (Counts & { first_page: string })[]).map((r) => ({
      first_page: r.first_page,
      visitors: r.visitors,
      subscribed: r.subscribed,
      rate: r.rate,
      explain: funnelPageExplain(r.first_page),
    })),
    by_first_utm: (utms.results as (Counts & { first_utm_source: string | null })[]).map((r) => ({
      first_utm_source: r.first_utm_source,
      visitors: r.visitors,
      subscribed: r.subscribed,
      rate: r.rate,
      explain: funnelUtmExplain(r.first_utm_source),
    })),
  }
}
