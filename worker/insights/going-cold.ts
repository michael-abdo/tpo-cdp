// Readers at risk of going cold, the third /growth panel (GET /api/insights/going-cold). Per
// signup source: how many active subscribers meet `going_cold_risk`. The rule has one home,
// `goingColdRisk` in shared/derive.ts, and it is applied here to each subscriber's stored
// `last_open_date` and `cold_since`: SQL only reads the rows, it never restates the formula.
// Active only, like every list; the at-risk readers who are unsubscribed are
// counted in `hidden_unsubscribed` so the default is never silent. Every number carries an
// `explain` question for the "Explain this" link. Live query on every request; nothing
// is cached.

import { DEFINITIONS, type DefinitionKey, goingColdRisk } from '../../shared/derive'

/** The definitions the panel's numbers use, rendered from DEFINITIONS by the UI. */
export const GOING_COLD_DEFINITIONS: readonly DefinitionKey[] = ['going_cold_risk', 'cold_since']

export interface GoingColdCounts {
  /** Active subscribers in the group. */
  active: number
  /** Active subscribers who meet going_cold_risk. */
  at_risk: number
  /** at_risk / active, 4 decimals; null when the group has no active subscribers. */
  rate: number | null
  /** The assistant question these numbers answer. */
  explain: string
}

export interface GoingColdRow extends GoingColdCounts {
  /** Canonical source (shared/normalize.ts); null = no source recorded. */
  source: string | null
}

export interface GoingCold {
  total: GoingColdCounts
  /** Unsubscribed readers who meet going_cold_risk, left out of every count above but never silently. */
  hidden_unsubscribed: { count: number; explain: string }
  /** Most readers at risk first, then the larger source, then by name (no source last). */
  by_source: GoingColdRow[]
  definitions_used: readonly DefinitionKey[]
}

interface SubscriberRow {
  source: string | null
  status: string
  last_open_date: string | null
  cold_since: string
}

// kind = 'subscriber': app-only and stub profiles have no open or cold date to judge.
const ROWS_SQL = `SELECT source, status, last_open_date, cold_since FROM v_profiles WHERE kind = 'subscriber'`

/**
 * The rule in plain words, from its one runtime source: "Explain this" puts the question in the
 * Ask bar where staff read it, so it names the rule by what it means, never by its code name,
 * and the model still gets the exact rule.
 */
const RULE_WORDS = `at risk of going cold (${DEFINITIONS.going_cold_risk.doc.charAt(0).toLowerCase()}${DEFINITIONS.going_cold_risk.doc.slice(1).replace(/\.$/, '')})`

const QUESTION = (who: string) => `Of ${who}, how many are ${RULE_WORDS}, and what share is that?`

/** The question behind the panel's total. */
export const GOING_COLD_TOTAL_EXPLAIN = QUESTION('all active subscribers')

/** The question behind the hidden-unsubscribed count. */
export const GOING_COLD_HIDDEN_EXPLAIN = `How many subscribers who unsubscribed are ${RULE_WORDS}?`

/** The question behind one source's row. */
export function goingColdExplain(source: string | null): string {
  return QUESTION(
    source === null ? 'active subscribers with no acquisition source recorded' : `active subscribers whose acquisition source is "${source}"`,
  )
}

const rate = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 10000) / 10000)

function bySource(a: GoingColdRow, b: GoingColdRow): number {
  if (a.at_risk !== b.at_risk) return b.at_risk - a.at_risk
  if (a.active !== b.active) return b.active - a.active
  if (a.source === null || b.source === null) return a.source === null ? 1 : -1
  return a.source < b.source ? -1 : a.source > b.source ? 1 : 0
}

export async function goingCold(db: D1Database): Promise<GoingCold> {
  const { results } = await db.prepare(ROWS_SQL).all<SubscriberRow>()
  const groups = new Map<string | null, { active: number; at_risk: number }>()
  let hidden = 0
  for (const row of results) {
    if (row.status !== 'active' && row.status !== 'unsubscribed') {
      throw new Error(`going-cold: subscriber with status ${JSON.stringify(row.status)}`)
    }
    const atRisk = goingColdRisk(row.last_open_date, row.cold_since)
    if (row.status === 'unsubscribed') {
      if (atRisk) hidden++
      continue
    }
    const group = groups.get(row.source) ?? { active: 0, at_risk: 0 }
    group.active++
    if (atRisk) group.at_risk++
    groups.set(row.source, group)
  }
  const by_source = [...groups].map(([source, g]) => ({
    source,
    active: g.active,
    at_risk: g.at_risk,
    rate: rate(g.at_risk, g.active),
    explain: goingColdExplain(source),
  }))
  by_source.sort(bySource)
  const active = by_source.reduce((n, r) => n + r.active, 0)
  const atRisk = by_source.reduce((n, r) => n + r.at_risk, 0)
  return {
    total: { active, at_risk: atRisk, rate: rate(atRisk, active), explain: GOING_COLD_TOTAL_EXPLAIN },
    hidden_unsubscribed: { count: hidden, explain: GOING_COLD_HIDDEN_EXPLAIN },
    by_source,
    definitions_used: GOING_COLD_DEFINITIONS,
  }
}
