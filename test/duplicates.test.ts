import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { TODAY } from '../shared/config'
import { pkeyForEmail } from '../shared/pseudonym'
import type { Duplicates, DuplicateReview } from '../src/types'
import {
  AUTO_MIN_SCORE,
  bandOf,
  candidatePairs,
  type DedupeReader,
  M_PROBABILITIES,
  nameStem,
  pairId,
  REVIEW_MIN_SCORE,
  SCORED_FIELDS,
  scoreDuplicates,
  scoreFromWeight,
  suggestionFor,
} from '../worker/dedupe/score'
import { loginCookie } from './helpers/auth'
import { piiKeySecret, seedDatabase } from './helpers/seed'
import { eventIdPool, sendWebhook } from './helpers/webhook'

// The scored possible-duplicates review: T-DUP-1..3.
// The test D1 holds the real seed of data/*.csv (test/helpers/seed.ts). Expected numbers are the
// seed's: 1,704 candidate pairs over 788 stems (1,977 emails);
// agreement rates 0.347 (domain), 0.147 (signup within 7 days), 0.195 (source); 16 pairs agree on
// all three, ≈ 17 expected by chance; 0 hard links; joy.hall → 3 emails, 3 pairs, none in review.
// Inputs and where they come from:
// - the hard link (T-DUP-2, last describe, since it sends webhooks and storage persists across this
//   file): real app_users.csv rows u_a6ac1f6c (line 113, mark.mitchell424@gmail.com,
//   subscribers.csv:842) and u_b9e9a984 (line 432, mark.mitchell662@outlook.com,
//   subscribers.csv:1406), a candidate pair that agrees on no soft field. Both log in on one device,
//   `d_` + the hex of the first user id (the convention of test/webhook.test.ts), through the real
//   signed POST /webhooks/app (brief-shaped payloads from real ids); event ids from
//   eventIdPool(); times 09:00/09:05/09:10 on TODAY (demo events default to TODAY).
// - the 404 pair id: the two demo subjects joy.hall830 and julia.evans230,
//   real profiles whose name stems differ, so they are no candidate pair.
// - bad verdicts are removals or a JSON shape change, never invented business data.

const JOY_HALL = ['joy.hall524@protonmail.com', 'joy.hall830@protonmail.com', 'joy.hall898@gmail.com']
const MARK_A = { user: 'u_a6ac1f6c', email: 'mark.mitchell424@gmail.com' }
const MARK_B = { user: 'u_b9e9a984', email: 'mark.mitchell662@outlook.com' }
const SHARED_DEVICE = 'd_a6ac1f6c'

let cookie: string
let readers: DedupeReader[]

beforeAll(async () => {
  await seedDatabase()
  cookie = await loginCookie()
  const { results } = await env.DB.prepare(
    `SELECT p.pkey AS pkey, s.email_norm AS email, s.signup_date, s.source, s.status
     FROM subscribers s JOIN profiles p ON p.email_norm = s.email_norm AND p.kind = 'subscriber'`,
  ).all<DedupeReader>()
  readers = results
})

const getDuplicates = (headers: Record<string, string> = { cookie }) =>
  SELF.fetch('http://cdp.test/api/duplicates', { headers })

const postReview = (pair: string, body: string, headers: Record<string, string> = { cookie }) =>
  SELF.fetch(`http://cdp.test/api/duplicates/${pair}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })

async function duplicates(): Promise<Duplicates> {
  const res = await getDuplicates()
  expect(res.status).toBe(200)
  return res.json<Duplicates>()
}

/** This test's own reading of the three soft fields (independent of score.ts's agreement code). */
function softAgreement(a: DedupeReader, b: DedupeReader) {
  const days = Math.abs(Date.parse(a.signup_date) - Date.parse(b.signup_date)) / 86_400_000
  return {
    domain: a.email.split('@')[1] === b.email.split('@')[1],
    signup_gap: days <= 7,
    source: a.source !== null && a.source === b.source,
  }
}

const allThree = (a: DedupeReader, b: DedupeReader) => Object.values(softAgreement(a, b)).every(Boolean)
const emailsOf = (p: { a: { email: string }; b: { email: string } }) =>
  [p.a.email, p.b.email].sort().join(' + ')

describe('T-DUP-1: candidates and bands on the seed', () => {
  it('1,704 candidate pairs over 788 name stems, covering 1,977 emails', () => {
    const pairs = candidatePairs(readers)
    expect(readers).toHaveLength(2900)
    expect(pairs).toHaveLength(1704)
    const emails = new Set(pairs.flatMap(([a, b]) => [a.email, b.email]))
    expect(emails.size).toBe(1977)
    expect(new Set([...emails].map((e) => nameStem(e))).size).toBe(788)
    for (const [a, b] of pairs) {
      expect(nameStem(a.email)).toBe(nameStem(b.email))
      expect(a.pkey < b.pkey).toBe(true)
    }
  })

  it('the stem is the local part before its trailing digits', () => {
    expect(nameStem('joy.hall830@protonmail.com')).toBe('joy.hall')
    expect(nameStem('david.murphy86@gmail.com')).toBe(nameStem('david.murphy868@gmail.com'))
  })

  it('GET /api/duplicates: 1,704 checked, exactly the 16 three-way pairs to review, none auto, the rest hidden', async () => {
    const body = await duplicates()
    expect(Object.keys(body)).toEqual([
      'candidates',
      'to_review',
      'review',
      'hidden_below_review',
      'bands',
      'weights',
      'chance',
    ])
    expect(body.candidates).toBe(1704)
    const threeWay = candidatePairs(readers).filter(([a, b]) => allThree(a, b))
    expect(threeWay).toHaveLength(16)
    expect(body.review.map(emailsOf).sort()).toEqual(threeWay.map(([a, b]) => emailsOf({ a, b })).sort())
    expect(body.to_review).toBe(16)
    expect(body.hidden_below_review).toBe(1688)
    // The footer's band edges come from here, the scorer's own constants.
    expect(body.bands).toEqual({ auto_min: AUTO_MIN_SCORE, review_min: REVIEW_MIN_SCORE })
    expect(body.bands).toEqual({ auto_min: 90, review_min: 50 })
    for (const pair of body.review) {
      expect(pair.band).toBe('review')
      // The 16 three-way pairs each score 76 (review band 50–89).
      expect(pair.score).toBe(76)
      expect(pair.decision).toBeNull()
      expect(Object.keys(pair)).toEqual([
        'pair_id',
        'a',
        'b',
        'score',
        'band',
        'reasons',
        'suggestion',
        'decision',
      ])
      expect(Object.keys(pair.a)).toEqual(['email', 'signup_date', 'source', 'status'])
      expect(pair.reasons.map((r) => r.field)).toEqual([...SCORED_FIELDS])
      expect(pair.reasons.map((r) => r.agrees)).toEqual([true, true, true, false])
      // The review band's suggestion is just the verdict; the reasons above already name what matches.
      expect(pair.suggestion).toBe('Could be the same person')
      expect(pair.pair_id).toBe(await pairId(...(await pkeysOf(pair))))
    }
    // The chance check: 16 observed, ≈ 17 expected.
    expect(body.chance.all_soft_agree).toBe(16)
    expect(Math.round(body.chance.expected_by_chance)).toBe(17)
  })

  it("joy.hall's 3 pairs all score below the review band", async () => {
    const result = await scoreDuplicates(readers, [])
    const joy = result.pairs.filter((p) => JOY_HALL.includes(p.a.email) && JOY_HALL.includes(p.b.email))
    expect(joy).toHaveLength(3)
    for (const pair of joy) {
      expect(pair.score).toBeLessThan(50)
      expect(pair.band).toBe('hidden')
    }
    // joy.hall830 + joy.hall524 share domain and source but signed up more than 7 days apart.
    const close = joy.find(
      (p) => p.a.email.endsWith('@protonmail.com') && p.b.email.endsWith('@protonmail.com'),
    )
    expect(close?.reasons.filter((r) => r.agrees).map((r) => r.field)).toEqual(['domain', 'source'])
    expect(close?.suggestion).toBe('Probably different people')
    const body = await duplicates()
    expect(body.review.some((p) => JOY_HALL.includes(p.a.email) || JOY_HALL.includes(p.b.email))).toBe(false)
  })

  it('no pair reaches the auto band on the seed', async () => {
    const result = await scoreDuplicates(readers, [])
    expect(Math.max(...result.pairs.map((p) => p.score))).toBeLessThan(90)
    expect(result.pairs.filter((p) => p.band === 'auto')).toEqual([])
  })
})

async function pkeysOf(pair: { a: { email: string }; b: { email: string } }): Promise<[string, string]> {
  return [await pkeyForEmail(piiKeySecret(), pair.a.email), await pkeyForEmail(piiKeySecret(), pair.b.email)]
}

describe('T-DUP-2: Fellegi–Sunter weights and ranking', () => {
  it('weights equal log2(m/u) and log2((1−m)/(1−u)), u measured from the seed', async () => {
    const pairs = candidatePairs(readers)
    const n = pairs.length
    const counts = { domain: 0, signup_gap: 0, source: 0 }
    for (const [a, b] of pairs) {
      const agree = softAgreement(a, b)
      for (const field of Object.keys(counts) as (keyof typeof counts)[]) if (agree[field]) counts[field]++
    }
    // The seed's agreement rates: 0.347 × 0.147 × 0.195.
    expect(counts.domain / n).toBeCloseTo(0.347, 3)
    expect(counts.signup_gap / n).toBeCloseTo(0.147, 3)
    expect(counts.source / n).toBeCloseTo(0.195, 3)
    const { weights } = await duplicates()
    if (weights === null) throw new Error('weights missing on the seed')
    const expectedU = {
      domain: counts.domain / n,
      signup_gap: counts.signup_gap / n,
      source: counts.source / n,
      shared_device: 0.5 / n, // 0 hard links: counted as half a pair (score.ts UNSEEN_AGREEMENT_PAIRS)
    }
    for (const field of SCORED_FIELDS) {
      const m = M_PROBABILITIES[field]
      const u = expectedU[field]
      expect(weights[field].m, field).toBe(m)
      expect(weights[field].u, field).toBeCloseTo(u, 12)
      expect(weights[field].agree, field).toBeCloseTo(Math.log2(m / u), 12)
      expect(weights[field].disagree, field).toBeCloseTo(Math.log2((1 - m) / (1 - u)), 12)
    }
    expect(weights.shared_device.agreeing).toBe(0)
    // The m values docs/notes.md documents, pinned as literals so they cannot drift unseen.
    expect(M_PROBABILITIES).toEqual({ domain: 0.8, signup_gap: 0.5, source: 0.8, shared_device: 0.9 })
    // The device disagree weight, and the 16 three-way pairs would score 97 without it.
    expect(weights.shared_device.disagree).toBeCloseTo(-3.32, 2)
    expect(scoreFromWeight(weights.domain.agree + weights.signup_gap.agree + weights.source.agree)).toBe(97)
  })

  it("a pair's score is the logistic of its summed weights, and each reason carries its own weight", async () => {
    const result = await scoreDuplicates(readers, [])
    if (result.weights === null) throw new Error('weights missing on the seed')
    for (const pair of result.pairs) {
      let sum = 0
      for (const reason of pair.reasons) {
        const w = result.weights[reason.field]
        expect(reason.weight).toBe(reason.agrees ? w.agree : w.disagree)
        sum += reason.weight
      }
      expect(pair.weight).toBeCloseTo(sum, 12)
      expect(pair.score).toBe(Math.round((100 * 2 ** sum) / (1 + 2 ** sum)))
      expect(pair.band).toBe(bandOf(pair.score))
    }
    expect(scoreFromWeight(0)).toBe(50)
    expect(scoreFromWeight(Math.log2(9))).toBe(90)
  })

  it('the 16 three-way-agreeing pairs rank above every pair agreeing on fewer fields', async () => {
    const result = await scoreDuplicates(readers, [])
    const top = result.pairs.slice(0, 16)
    const rest = result.pairs.slice(16)
    expect(top.every((p) => allThree(p.a, p.b))).toBe(true)
    expect(rest.some((p) => allThree(p.a, p.b))).toBe(false)
    expect(Math.min(...top.map((p) => p.score))).toBeGreaterThan(Math.max(...rest.map((p) => p.score)))
  })

  it('review and auto bands say just the verdict; "only the name matches" is reserved for the no-other-match (hidden) case', () => {
    const none = { domain: false, signup_gap: false, source: false, shared_device: false }
    expect(suggestionFor('hidden', none)).toBe('Probably different people — only the name matches')
    expect(suggestionFor('review', none)).toBe('Could be the same person')
    expect(suggestionFor('hidden', { ...none, source: true })).toBe('Probably different people')
    expect(suggestionFor('review', { ...none, source: true })).toBe('Could be the same person')
    expect(suggestionFor('auto', { ...none, shared_device: true })).toBe('Very likely the same person')
    // What else matches is never repeated in the sentence: the chips are its one home.
    for (const band of ['hidden', 'review', 'auto'] as const)
      expect(suggestionFor(band, { domain: true, signup_gap: true, source: true, shared_device: true })).not.toMatch(/domain|signup|source|device/)
  })

  it('the band edges: auto ≥ 90, review 50–89, hidden < 50', () => {
    expect(AUTO_MIN_SCORE).toBe(90)
    expect(REVIEW_MIN_SCORE).toBe(50)
    expect(bandOf(100)).toBe('auto')
    expect(bandOf(90)).toBe('auto')
    expect(bandOf(89)).toBe('review')
    expect(bandOf(50)).toBe('review')
    expect(bandOf(49)).toBe('hidden')
    expect(bandOf(0)).toBe('hidden')
  })

  it('a pair id does not depend on the order of its two pkeys', async () => {
    const [x, y] = await pkeysOf({ a: { email: JOY_HALL[0] }, b: { email: JOY_HALL[1] } })
    expect(x).not.toBe(y)
    expect(await pairId(x, y)).toBe(await pairId(y, x))
    expect(await pairId(x, y)).toMatch(/^dp_[0-9a-f]{16}$/)
  })
})

/** Every table's rows except duplicate_reviews, for "a review changes nothing else". */
async function snapshotOtherTables(): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('duplicate_reviews', 'd1_migrations')
     AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`,
  ).all<{ name: string }>()
  const out: Record<string, string> = {}
  for (const { name } of results) {
    const rows = await env.DB.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()
    out[name] = JSON.stringify(rows.results)
  }
  return out
}

describe('T-DUP-3: recording a verdict', () => {
  it('POST stores, then replaces, a verdict; GET shows it; nothing else changes', async () => {
    const before = await snapshotOtherTables()
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining(['profiles', 'subscribers', 'app_events', 'app_users', 'web_events']),
    )
    const first = await duplicates()
    const pair = first.review[0]

    const res = await postReview(pair.pair_id, JSON.stringify({ verdict: 'same_person' }))
    expect(res.status).toBe(200)
    const stored = await res.json<DuplicateReview>()
    expect(Object.keys(stored)).toEqual(['pair_id', 'verdict', 'score', 'decided_at'])
    expect(stored).toMatchObject({ pair_id: pair.pair_id, verdict: 'same_person', score: pair.score })
    expect(stored.decided_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

    const after = await duplicates()
    expect(after.review.find((p) => p.pair_id === pair.pair_id)?.decision).toEqual({
      verdict: 'same_person',
      decided_at: stored.decided_at,
    })
    expect(after.to_review).toBe(first.to_review - 1)

    const again = await postReview(pair.pair_id, JSON.stringify({ verdict: 'different_people' }))
    expect(again.status).toBe(200)
    expect((await duplicates()).review.find((p) => p.pair_id === pair.pair_id)?.decision?.verdict).toBe(
      'different_people',
    )
    const { results } = await env.DB.prepare(
      'SELECT pair_id, pkey_a, pkey_b, verdict, score FROM duplicate_reviews',
    ).all()
    const [lo, hi] = (await pkeysOf(pair)).sort()
    expect(results).toEqual([
      { pair_id: pair.pair_id, pkey_a: lo, pkey_b: hi, verdict: 'different_people', score: pair.score },
    ])

    expect(await snapshotOtherTables()).toEqual(before)
  })

  it('a bad verdict is 400 invalid_verdict', async () => {
    const { review } = await duplicates()
    const id = review[0].pair_id
    for (const body of [
      '{"verdict":"same"}',
      '{}',
      '{"verdict":"same_person","score":1}',
      'same_person',
      '["same_person"]',
    ]) {
      const res = await postReview(id, body)
      expect(res.status, body).toBe(400)
      expect((await res.json<{ error: string }>()).error).toBe('invalid_verdict')
    }
  })

  it('an unknown pair is 404', async () => {
    const id = await pairId(
      await pkeyForEmail(piiKeySecret(), 'joy.hall830@protonmail.com'),
      await pkeyForEmail(piiKeySecret(), 'julia.evans230@gmail.com'),
    )
    const res = await postReview(id, JSON.stringify({ verdict: 'different_people' }))
    expect(res.status).toBe(404)
    expect((await res.json<{ error: string }>()).error).toBe('not_found')
  })

  it('no session → 401 on GET and POST', async () => {
    expect((await getDuplicates({})).status).toBe(401)
    const { review } = await duplicates()
    expect((await postReview(review[0].pair_id, JSON.stringify({ verdict: 'same_person' }), {})).status).toBe(
      401,
    )
  })
})

describe('T-DUP-2: a shared device from a real signed login stitch is a hard link', () => {
  it('both readers logging in on one device puts their pair in the auto band, first', async () => {
    const before = await duplicates()
    expect(before.review.some((p) => emailsOf(p) === [MARK_A.email, MARK_B.email].sort().join(' + '))).toBe(
      false,
    )
    const nextId = eventIdPool()
    const events = [
      {
        event_id: nextId(),
        event: 'app_open',
        user_id: null,
        device_id: SHARED_DEVICE,
        timestamp: `${TODAY}T09:00:00Z`,
      },
      {
        event_id: nextId(),
        event: 'login',
        user_id: MARK_A.user,
        device_id: SHARED_DEVICE,
        timestamp: `${TODAY}T09:05:00Z`,
      },
      {
        event_id: nextId(),
        event: 'login',
        user_id: MARK_B.user,
        device_id: SHARED_DEVICE,
        timestamp: `${TODAY}T09:10:00Z`,
      },
    ]
    for (const event of events) {
      const res = await sendWebhook(JSON.stringify(event))
      expect(res.status, await res.clone().text()).toBe(202)
    }

    const body = await duplicates()
    const top = body.review[0]
    expect(emailsOf(top)).toBe([MARK_A.email, MARK_B.email].sort().join(' + '))
    expect(top.band).toBe('auto')
    expect(top.score).toBeGreaterThanOrEqual(90)
    expect(top.reasons.map((r) => [r.field, r.agrees])).toEqual([
      ['domain', false],
      ['signup_gap', false],
      ['source', false],
      ['shared_device', true],
    ])
    expect(top.reasons[3].label).toBe('same device in the app')
    expect(top.suggestion).toBe('Very likely the same person')
    expect(body.weights?.shared_device.agreeing).toBe(1)
    expect(body.weights?.shared_device.u).toBeCloseTo(1 / 1704, 12)
    expect(body.to_review).toBe(before.to_review + 1)
  })
})
