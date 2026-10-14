// GET /api/duplicates · POST /api/duplicates/:pair_id/review (04, 09 D-62; R1.3): the scored
// "Possible duplicates" review on Overview (06 §Overview). Scoring is worker/dedupe/score.ts; this
// file reads the rows it needs and stores a reviewer's verdict in duplicate_reviews.
// Nothing merges (D-13): the only table this file writes is duplicate_reviews, never profiles,
// subscribers or any event table. It returns emails, so it sits behind the session guard and is
// never an assistant tool (05).

import { Hono } from 'hono'
import { ApiError } from '../auth/middleware'
import type { AppEnv } from '../env'
import type { SubscriberStatus } from '../ingest/quarantine'
import {
  type DedupeReader,
  type DedupeResult,
  REVIEW_MIN_SCORE,
  type Reason,
  type ScoredPair,
  scoreDuplicates,
} from '../dedupe/score'

/** The rows GET returns at most (04). */
export const DUPLICATES_MAX_ROWS = 50

export const VERDICTS = ['same_person', 'different_people'] as const
export type Verdict = (typeof VERDICTS)[number]

export interface Decision {
  verdict: Verdict
  decided_at: string
}

/** One side of a pair as the UI shows it (04: email, signed up, source, status). */
export interface DuplicateReaderOut {
  email: string
  signup_date: string
  source: string | null
  status: SubscriberStatus
}

export interface DuplicatePairOut {
  pair_id: string
  a: DuplicateReaderOut
  b: DuplicateReaderOut
  score: number
  band: 'review' | 'auto'
  reasons: Reason[]
  suggestion: string
  decision: Decision | null
}

/** Every subscriber with its profile key, and every (device, subscriber) seen together in an identified app event. */
async function scoreAll(db: D1Database): Promise<DedupeResult> {
  const [readers, devices] = await db.batch<Record<string, unknown>>([
    db.prepare(
      `SELECT p.pkey AS pkey, s.email_norm AS email, s.signup_date AS signup_date, s.source AS source, s.status AS status
       FROM subscribers s JOIN profiles p ON p.email_norm = s.email_norm AND p.kind = 'subscriber'`,
    ),
    // Identified events only (the join on user_id drops anonymous ones); a stub user has no email
    // and so no subscriber profile, and drops out at the profiles join.
    db.prepare(
      `SELECT DISTINCT e.device_id AS device_id, p.pkey AS pkey
       FROM app_events e
       JOIN app_users u ON u.user_id = e.user_id
       JOIN profiles p ON p.email_norm = u.email_norm AND p.kind = 'subscriber'`,
    ),
  ])
  return scoreDuplicates(
    readers.results as unknown as DedupeReader[],
    devices.results as unknown as { device_id: string; pkey: string }[],
  )
}

async function decisions(db: D1Database): Promise<Map<string, Decision>> {
  const { results } = await db
    .prepare('SELECT pair_id, verdict, decided_at FROM duplicate_reviews')
    .all<{ pair_id: string; verdict: Verdict; decided_at: string }>()
  return new Map(results.map((r) => [r.pair_id, { verdict: r.verdict, decided_at: r.decided_at }]))
}

const readerOut = (r: DedupeReader): DuplicateReaderOut => ({
  email: r.email,
  signup_date: r.signup_date,
  source: r.source,
  status: r.status,
})

function pairOut(pair: ScoredPair, decision: Decision | null): DuplicatePairOut {
  if (pair.band === 'hidden') throw new Error('duplicates: a hidden pair was about to be returned')
  return {
    pair_id: pair.pair_id,
    a: readerOut(pair.a),
    b: readerOut(pair.b),
    score: pair.score,
    band: pair.band,
    reasons: pair.reasons,
    suggestion: pair.suggestion,
    decision,
  }
}

/** Mounted at /api by worker/index.ts, behind requireSession. */
export const duplicateRoutes = new Hono<AppEnv>()

duplicateRoutes.get('/duplicates', async (c) => {
  const [result, decided] = await Promise.all([scoreAll(c.env.DB), decisions(c.env.DB)])
  const shown = result.pairs.filter((p) => p.score >= REVIEW_MIN_SCORE)
  return c.json({
    candidates: result.candidates,
    // 06's "N to review": shown pairs (review or auto band) with no decision yet, over all of them, not just the first 50.
    to_review: shown.filter((p) => !decided.has(p.pair_id)).length,
    review: shown.slice(0, DUPLICATES_MAX_ROWS).map((p) => pairOut(p, decided.get(p.pair_id) ?? null)),
    hidden_below_review: result.pairs.length - shown.length,
    weights: result.weights,
    chance: result.chance,
  })
})

const VERDICT_MESSAGE = 'Send a JSON object with only "verdict": "same_person" or "different_people".'

function invalidVerdict(details: string[]): ApiError {
  console.warn(JSON.stringify({ at: 'duplicates', outcome: 'invalid_verdict', details }))
  return new ApiError(400, 'invalid_verdict', VERDICT_MESSAGE, details)
}

async function readVerdict(req: Request): Promise<Verdict> {
  let parseError: string | undefined
  const body: unknown = await req.json().catch((err: unknown) => {
    // The error's class name only: a JSON SyntaxError message quotes the body.
    parseError = err instanceof Error ? err.name : 'unknown'
    return undefined
  })
  if (parseError !== undefined) throw invalidVerdict([`body is not JSON: ${parseError}`])
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw invalidVerdict(['body is not a JSON object'])
  const unknown = Object.keys(body).filter((k) => k !== 'verdict')
  if (unknown.length > 0) throw invalidVerdict(unknown.map((k) => `unknown field: ${k}`))
  const verdict = (body as Record<string, unknown>).verdict
  if (typeof verdict !== 'string' || !(VERDICTS as readonly string[]).includes(verdict)) {
    throw invalidVerdict(['verdict must be "same_person" or "different_people"'])
  }
  return verdict as Verdict
}

duplicateRoutes.post('/duplicates/:pair_id/review', async (c) => {
  const verdict = await readVerdict(c.req.raw)
  const pairIdParam = c.req.param('pair_id')
  const pair = (await scoreAll(c.env.DB)).pairs.find((p) => p.pair_id === pairIdParam)
  if (pair === undefined) {
    console.warn(JSON.stringify({ at: 'duplicates', outcome: 'unknown_pair' }))
    throw new ApiError(
      404,
      'not_found',
      'No possible-duplicate pair has that id. Refresh the page to see the current list.',
    )
  }
  // Wall clock: when the reviewer pressed the button (01 §duplicate_reviews: decided_at, UTC). It is
  // on 02 §Time's wall-clock allow-list (`duplicate_reviews.decided_at`, 09 D-62); no date rule reads it.
  const decidedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await c.env.DB.prepare(
    `INSERT INTO duplicate_reviews (pair_id, pkey_a, pkey_b, verdict, score, decided_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (pair_id) DO UPDATE SET verdict = excluded.verdict, score = excluded.score, decided_at = excluded.decided_at`,
  )
    .bind(pair.pair_id, pair.a.pkey, pair.b.pkey, verdict, pair.score, decidedAt)
    .run()
  console.log(
    JSON.stringify({ at: 'duplicates', outcome: 'review_recorded', pair_id: pair.pair_id, verdict }),
  )
  return c.json({ pair_id: pair.pair_id, verdict, score: pair.score, decided_at: decidedAt })
})
