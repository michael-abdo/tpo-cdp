/**
 * Scored possible duplicates (design 09 D-62; 02 §Dedupe "Fuzzy duplicates"; R1.3, A3).
 *
 * Pure: readers in, scored pairs out. No I/O, no clock. worker/routes/duplicates.ts reads the rows
 * and the decisions; nothing here (or there) merges or writes a profile, subscriber or event (D-13).
 *
 * Method (Fellegi–Sunter, as Splink, Amperity and dedupe.io do; D-62):
 * 1. Candidates: every pair of subscribers whose normalized emails share a name stem, the local
 *    part with its trailing digits removed (`joy.hall830@…` → `joy.hall`). Profiles merge only on
 *    the exact normalized email (02 §Dedupe); this only finds pairs for a person to look at.
 * 2. Per field, does the pair agree? Email domain; signup dates at most 7 days apart; the same
 *    signup source; one app device seen with both readers' app accounts (the hard link).
 * 3. Weights: agree → log2(m/u), disagree → log2((1−m)/(1−u)). u = the share of candidate pairs
 *    that agree, measured from the data on every call; m = an assumption (`M_PROBABILITIES`).
 * 4. W = the sum of the four weights; score = 100 × 2^W / (1 + 2^W), rounded. W = 0 (evidence for
 *    and against balance) is 50; W = log2 9 (9 : 1 for one person) is 90.
 * 5. Bands: ≥ 90 auto (the band where a merge would be automatic; nothing merges here), 50–89
 *    review, < 50 hidden.
 */
import type { SubscriberStatus } from '../ingest/quarantine'

/** One subscriber as the scorer sees it. `email` is `email_norm` (02 §Normalization). */
export interface DedupeReader {
  pkey: string
  email: string
  signup_date: string
  source: string | null
  status: SubscriberStatus
}

/** The four scored fields, in the order reasons are listed. The name stem is the blocking key, not scored. */
export const SCORED_FIELDS = ['domain', 'signup_gap', 'source', 'shared_device'] as const
export type ScoredField = (typeof SCORED_FIELDS)[number]

/** The three fields that come from subscribers.csv (the hard link comes from app events). */
export const SOFT_FIELDS = ['domain', 'signup_gap', 'source'] as const satisfies readonly ScoredField[]

/** Signup dates this many days apart or fewer count as agreeing (D-62). */
export const SIGNUP_GAP_MAX_DAYS = 7

/**
 * m = P(field agrees | the two emails belong to one person). No labelled pairs exist to measure it,
 * so it is a documented assumption (09 D-62: "m-probabilities a documented assumption"):
 * - domain 0.8: a person opening a second address mostly stays with their mail provider;
 * - signup_gap 0.5: about half of repeat signups come within a week of the first (a campaign
 *   seen twice), the rest any time later;
 * - source 0.8: the same person is mostly reached again through the same channel;
 * - shared_device 0.9: one person mostly reads on one phone, so both accounts would show on it.
 */
export const M_PROBABILITIES: Readonly<Record<ScoredField, number>> = {
  domain: 0.8,
  signup_gap: 0.5,
  source: 0.8,
  shared_device: 0.9,
}

/**
 * A field no candidate pair agrees on would get u = 0 and an infinite agree weight; it is counted as
 * half an agreeing pair instead (u = 0.5 / n), so the weight stays finite and still reflects "never
 * seen". Likewise a field every pair agrees on counts half a pair short (u = (n − 0.5) / n). On the
 * seed this applies only to shared_device (02: 0 hard links); every other u is the plain share.
 */
export const UNSEEN_AGREEMENT_PAIRS = 0.5

/** Score bands (D-62). */
export const AUTO_MIN_SCORE = 90
export const REVIEW_MIN_SCORE = 50
export type Band = 'auto' | 'review' | 'hidden'

export interface FieldWeight {
  m: number
  u: number
  /** Candidate pairs that agree on this field. */
  agreeing: number
  /** log2(m/u) */
  agree: number
  /** log2((1−m)/(1−u)) */
  disagree: number
}

export interface Reason {
  field: ScoredField
  agrees: boolean
  /** The weight this pair received for the field (agree or disagree weight). */
  weight: number
  /** Plain words for the reason chip (06 §Overview), e.g. "signed up 2 days apart". */
  label: string
}

export interface ScoredPair {
  pair_id: string
  /** pkey order: a.pkey < b.pkey. */
  a: DedupeReader
  b: DedupeReader
  /** Sum of the four weights. */
  weight: number
  score: number
  band: Band
  reasons: Reason[]
  suggestion: string
}

export interface DedupeResult {
  /** Candidate pairs (name stem shared). */
  candidates: number
  /** Every candidate, highest weight first (ties by pair_id). */
  pairs: ScoredPair[]
  /** null when there are no candidates (nothing to measure u from). */
  weights: Record<ScoredField, FieldWeight> | null
  /** The chance check of D-62: pairs agreeing on all three soft fields, observed vs expected if fields were independent. */
  chance: { all_soft_agree: number; expected_by_chance: number }
}

const TRAILING_DIGITS = /\d+$/

/** `first.last` before the digits: the local part of a normalized email with trailing digits removed; null when nothing is left. */
export function nameStem(email: string): string | null {
  const at = email.lastIndexOf('@')
  const local = at < 0 ? email : email.slice(0, at)
  const stem = local.replace(TRAILING_DIGITS, '')
  return stem === '' ? null : stem
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1)
}

const DAY_MS = 86_400_000

/** Whole days between two stored `YYYY-MM-DD` dates; throws on any other shape (fail loud). */
export function daysApart(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`)
  const tb = Date.parse(`${b}T00:00:00Z`)
  if (Number.isNaN(ta) || Number.isNaN(tb)) throw new Error('dedupe: a signup_date is not YYYY-MM-DD')
  return Math.round(Math.abs(ta - tb) / DAY_MS)
}

/** Every pair of readers sharing a name stem, each ordered so `a.pkey < b.pkey`. */
export function candidatePairs(readers: readonly DedupeReader[]): [DedupeReader, DedupeReader][] {
  const byStem = new Map<string, DedupeReader[]>()
  for (const reader of readers) {
    const stem = nameStem(reader.email)
    if (stem === null) continue
    const group = byStem.get(stem)
    if (group === undefined) byStem.set(stem, [reader])
    else group.push(reader)
  }
  const pairs: [DedupeReader, DedupeReader][] = []
  for (const group of byStem.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [x, y] = [group[i], group[j]]
        if (x.pkey === y.pkey) throw new Error('dedupe: two subscribers share one pkey')
        pairs.push(x.pkey < y.pkey ? [x, y] : [y, x])
      }
    }
  }
  return pairs
}

/** Order-independent key for a pair of pkeys (used for the shared-device set). */
function pairKey(p: string, q: string): string {
  return p < q ? `${p}|${q}` : `${q}|${p}`
}

/**
 * Pairs of pkeys that share a first-party id, from (device_id, pkey) rows. A web visitor and an
 * app user each carry one email by schema (web_visitors.email_norm, app_users' primary key), so
 * after ingest the only id two different subscriber emails can share is an app device that sent
 * identified events for both readers' app accounts (01 §Identity resolution).
 */
export function sharedDevicePairs(rows: readonly { device_id: string; pkey: string }[]): Set<string> {
  const byDevice = new Map<string, Set<string>>()
  for (const row of rows) {
    const set = byDevice.get(row.device_id)
    if (set === undefined) byDevice.set(row.device_id, new Set([row.pkey]))
    else set.add(row.pkey)
  }
  const shared = new Set<string>()
  for (const pkeys of byDevice.values()) {
    const list = [...pkeys]
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) shared.add(pairKey(list[i], list[j]))
    }
  }
  return shared
}

type Agreement = Record<ScoredField, boolean>

function agreementOf(a: DedupeReader, b: DedupeReader, gap: number, shared: Set<string>): Agreement {
  return {
    domain: domainOf(a.email) === domainOf(b.email),
    signup_gap: gap <= SIGNUP_GAP_MAX_DAYS,
    // An unknown (blank) source agrees with nothing: there is no evidence either way (none in the data).
    source: a.source !== null && a.source === b.source,
    shared_device: shared.has(pairKey(a.pkey, b.pkey)),
  }
}

/** u measured from the candidates and the assumed m, as Fellegi–Sunter log2 weights; null when there are no candidates to measure. */
export function fieldWeights(
  candidates: number,
  agreeing: Readonly<Record<ScoredField, number>>,
): Record<ScoredField, FieldWeight> | null {
  if (candidates === 0) return null
  const out = {} as Record<ScoredField, FieldWeight>
  for (const field of SCORED_FIELDS) {
    const m = M_PROBABILITIES[field]
    const count = agreeing[field]
    if (count < 0 || count > candidates)
      throw new Error(`dedupe: ${field} agreement count is outside 0..${candidates}`)
    const clamped = Math.min(Math.max(count, UNSEEN_AGREEMENT_PAIRS), candidates - UNSEEN_AGREEMENT_PAIRS)
    const u = clamped / candidates
    out[field] = { m, u, agreeing: count, agree: Math.log2(m / u), disagree: Math.log2((1 - m) / (1 - u)) }
  }
  return out
}

/** 100 × 2^W / (1 + 2^W), rounded: the share for "one person" if, before any field, both were equally likely. */
export function scoreFromWeight(weight: number): number {
  return Math.round(100 / (1 + 2 ** -weight))
}

export function bandOf(score: number): Band {
  if (score >= AUTO_MIN_SCORE) return 'auto'
  if (score >= REVIEW_MIN_SCORE) return 'review'
  return 'hidden'
}

function gapLabel(gap: number): string {
  if (gap === 0) return 'signed up the same day'
  return `signed up ${gap.toLocaleString('en-US')} ${gap === 1 ? 'day' : 'days'} apart`
}

/** Plain words for one reason chip (06 §Overview), in the brief's field names (06 §Vocabulary). */
export function reasonLabel(field: ScoredField, agrees: boolean, gap: number): string {
  switch (field) {
    case 'domain':
      return agrees ? 'same email domain' : 'different email domain'
    case 'signup_gap':
      return gapLabel(gap)
    case 'source':
      return agrees ? 'same acquisition source' : 'different acquisition source'
    case 'shared_device':
      return agrees ? 'same device in the app' : 'no shared device'
  }
}

function leadFor(band: Band): string {
  if (band === 'hidden') return 'Probably different people'
  return band === 'auto' ? 'Very likely the same person' : 'Could be the same person'
}

/**
 * The one-line plain suggestion (06 §Overview); the default is "Probably different people — only the
 * name matches". It is the verdict only: the reason chips beside it already say which fields match
 * (09 D-72, one thing in one place), so the sentence names only the name, which has no chip, and
 * only when nothing else matches.
 */
export function suggestionFor(band: Band, agreement: Agreement): string {
  const lead = leadFor(band)
  if (SCORED_FIELDS.some((f) => agreement[f])) return lead
  return band === 'hidden' ? `${lead} — only the name matches` : `${lead} — the name matches`
}

/** `dp_` + the first 16 hex characters of SHA-256 over the two pkeys in sorted order. */
export async function pairId(pkeyA: string, pkeyB: string): Promise<string> {
  const [lo, hi] = pkeyA < pkeyB ? [pkeyA, pkeyB] : [pkeyB, pkeyA]
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${lo}|${hi}`)),
  )
  let hex = ''
  for (const byte of digest.subarray(0, 8)) hex += byte.toString(16).padStart(2, '0')
  return `dp_${hex}`
}

/**
 * Scores every candidate pair. `devices` are the (device_id, pkey) rows of identified app events
 * whose app account belongs to a subscriber (worker/routes/duplicates.ts reads them).
 */
export async function scoreDuplicates(
  readers: readonly DedupeReader[],
  devices: readonly { device_id: string; pkey: string }[],
): Promise<DedupeResult> {
  const shared = sharedDevicePairs(devices)
  const raw = candidatePairs(readers).map(([a, b]) => {
    const gap = daysApart(a.signup_date, b.signup_date)
    return { a, b, gap, agreement: agreementOf(a, b, gap, shared) }
  })
  const agreeing = Object.fromEntries(
    SCORED_FIELDS.map((f) => [f, raw.filter((p) => p.agreement[f]).length]),
  ) as Record<ScoredField, number>
  const weights = fieldWeights(raw.length, agreeing)
  if (weights === null) {
    return { candidates: 0, pairs: [], weights: null, chance: { all_soft_agree: 0, expected_by_chance: 0 } }
  }

  const pairs = await Promise.all(
    raw.map(async ({ a, b, gap, agreement }): Promise<ScoredPair> => {
      const reasons = SCORED_FIELDS.map((field) => {
        const agrees = agreement[field]
        return {
          field,
          agrees,
          weight: agrees ? weights[field].agree : weights[field].disagree,
          label: reasonLabel(field, agrees, gap),
        }
      })
      const weight = reasons.reduce((sum, r) => sum + r.weight, 0)
      const score = scoreFromWeight(weight)
      const band = bandOf(score)
      return {
        pair_id: await pairId(a.pkey, b.pkey),
        a,
        b,
        weight,
        score,
        band,
        reasons,
        suggestion: suggestionFor(band, agreement),
      }
    }),
  )
  pairs.sort((x, y) => y.weight - x.weight || (x.pair_id < y.pair_id ? -1 : x.pair_id > y.pair_id ? 1 : 0))

  const allSoft = raw.filter((p) => SOFT_FIELDS.every((f) => p.agreement[f])).length
  const expected = SOFT_FIELDS.reduce((product, f) => product * (agreeing[f] / raw.length), raw.length)
  return {
    candidates: raw.length,
    pairs,
    weights,
    chance: { all_soft_agree: allSoft, expected_by_chance: expected },
  }
}
