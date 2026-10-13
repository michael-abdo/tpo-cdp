/// <reference types="vite/client" />
import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { normalizeQueryFragment, QUERY_FRAGMENT_MIN_LENGTH } from '../shared/normalize'
import { pkeyForEmail, pkeyForUnknownUser } from '../shared/pseudonym'
import lookupSource from '../worker/routes/lookup.ts?raw'
import { loginCookie } from './helpers/auth'
import { piiKeySecret, seedDatabase } from './helpers/seed'
import { eventIdPool, sendWebhook } from './helpers/webhook'

// GET /api/lookup/search (04 §/api/lookup/search, 06 §/lookup Partial lookup, 09 D-52), T-API-3
// (08). The test D1 holds the real seed of data/*.csv. Numbers are the 02 §Counts partial
// lookup fixtures; the 20-row cap is 04's. Inputs and where they come from:
// - joy.hall524 (subscribers.csv:2250), joy.hall830 (subscribers.csv:902, app user u_ceed5f12 at
//   app_users.csv:303), joy.hall898 (subscribers.csv:1392): the 3 `joy.hall` profiles.
// - julia.evans230@gmail.com: subscribers.csv:373, app_users.csv:2 (u_2b6447a3, the PDF's sample).
// - "ell", "hall", "joy.hall", "u_2b64": substrings of the real values above (09 D-47 removals).
//   aaron.bell239@gmail.com (subscribers.csv:2483) contains "ell" without starting with it and
//   sorts before every "ell…" address, so plain alphabetical order would list it first.
// - "not-an-email": a real value of subscribers.csv:1750, quarantined (invalid_email), so no
//   profile holds it: the unknown fragment.
// - "hall%", "joy_hall", "hall\": real fragments with one LIKE metacharacter added or swapped in
//   for a "."; they test escaping, not data, and introduce no business value (09 D-47).
// - The stub: u_2b6447a (julia's id with its last character removed, as T-WH-6 uses), sent once
//   through the real webhook with the brief's sample device d_4b21e8 (09 D-11), in the last
//   describe because storage persists across this file's tests.

const JOY_HALL = ['joy.hall524@protonmail.com', 'joy.hall830@protonmail.com', 'joy.hall898@gmail.com']
const JULIA = 'julia.evans230@gmail.com'
const SEARCH_LIMIT = 20

interface Match {
  pkey: string
  email: string | null
  kind: string
  user_id: string | null
  status: string | null
}
interface SearchBody {
  q: string
  matches: Match[]
  truncated: boolean
}

let cookie: string

beforeAll(async () => {
  await seedDatabase()
  cookie = await loginCookie()
})

function search(q: string, headers: Record<string, string> = { cookie }): Promise<Response> {
  return SELF.fetch(`http://cdp.test/api/lookup/search?${new URLSearchParams({ q })}`, { headers })
}

async function found(q: string): Promise<SearchBody> {
  const res = await search(q)
  expect(res.status, q).toBe(200)
  return res.json<SearchBody>()
}

describe('normalizeQueryFragment (02 §Normalization)', () => {
  it('trims and lowercases, and nothing else', () => {
    expect(normalizeQueryFragment('  JOY.HALL ')).toBe('joy.hall')
    // Not an address and still returned: a fragment is never validated.
    expect(normalizeQueryFragment('Joy.Hall830')).toBe('joy.hall830')
    // No plus or dot stripping, like normalizeEmail (D-26).
    expect(normalizeQueryFragment('Joy.Hall+830')).toBe('joy.hall+830')
  })

  it('the route folds in code, never in SQL', () => {
    expect(lookupSource).toContain('normalizeQueryFragment(')
    expect(lookupSource).not.toMatch(/\bLOWER\s*\(/i)
  })
})

describe('T-API-3 partial lookup', () => {
  it('joy.hall → exactly the 3 profiles, alphabetical within the prefix group', async () => {
    const body = await found('joy.hall')
    const expected = await Promise.all(
      JOY_HALL.map(async (email) => ({
        pkey: await pkeyForEmail(piiKeySecret(), email),
        email,
        kind: 'subscriber',
        user_id: email === 'joy.hall830@protonmail.com' ? 'u_ceed5f12' : null,
        status: 'active',
      })),
    )
    expect(body).toEqual({ q: 'joy.hall', matches: expected, truncated: false })
  })

  it('email prefix matches come before other contains-matches', async () => {
    // The contains-only address that alphabetical order would list first is a real profile.
    const bell = await env.DB.prepare('SELECT count(*) AS n FROM profiles WHERE email_norm = ?')
      .bind('aaron.bell239@gmail.com')
      .first<number>('n')
    expect(bell).toBe(1)
    const body = await found('ell')
    expect(body.matches).toHaveLength(SEARCH_LIMIT)
    expect(body.truncated).toBe(true)
    const emails = body.matches.map((m) => m.email)
    expect(emails.every((e) => e !== null && e.startsWith('ell'))).toBe(true)
    expect(emails).not.toContain('aaron.bell239@gmail.com')
    expect(emails).toEqual([...emails].sort())
  })

  it('hall → 20 rows and truncated, every row containing the fragment, in order', async () => {
    const body = await found('hall')
    expect(body.q).toBe('hall')
    expect(body.matches).toHaveLength(SEARCH_LIMIT)
    expect(body.truncated).toBe(true)
    const emails = body.matches.map((m) => m.email)
    expect(emails.every((e) => e !== null && e.includes('hall'))).toBe(true)
    expect(emails).toEqual([...emails].sort())
    // 02 §Counts: 52 profiles contain "hall"; the first 20 alphabetically are returned.
    const { results } = await env.DB.prepare(
      "SELECT email_norm FROM profiles WHERE email_norm LIKE '%hall%' ORDER BY email_norm",
    ).all<{ email_norm: string }>()
    expect(results).toHaveLength(52)
    expect(emails).toEqual(results.slice(0, SEARCH_LIMIT).map((r) => r.email_norm))
  })

  it('u_2b64 → julia.evans230 by her app user id', async () => {
    expect(await found('u_2b64')).toEqual({
      q: 'u_2b64',
      matches: [
        {
          pkey: await pkeyForEmail(piiKeySecret(), JULIA),
          email: JULIA,
          kind: 'subscriber',
          user_id: 'u_2b6447a3',
          status: 'active',
        },
      ],
      truncated: false,
    })
  })

  it('"JOY.HALL " (case and whitespace) answers exactly like joy.hall', async () => {
    expect(await found('JOY.HALL ')).toEqual(await found('joy.hall'))
  })

  it('fewer than 3 characters after normalization → 400 query_too_short', async () => {
    expect(QUERY_FRAGMENT_MIN_LENGTH).toBe(3)
    for (const q of ['jo', '  jo  ', '']) {
      const res = await search(q)
      expect(res.status, JSON.stringify(q)).toBe(400)
      const body = await res.json<Record<string, unknown>>()
      expect(body).toEqual({ error: 'query_too_short', message: 'Type at least 3 characters to search.' })
    }
  })

  it('%, _ and \\ match literally', async () => {
    // Unescaped, "hall%" would match all 52, "joy_hall" the 3 joy.hall profiles ("_" = any one
    // character), and "hall\" would be a malformed escape.
    for (const q of ['hall%', 'joy_hall', 'hall\\']) {
      expect(await found(q), q).toEqual({ q, matches: [], truncated: false })
    }
  })

  it('an unknown fragment → 200 with no matches, not 404', async () => {
    expect(await found('not-an-email')).toEqual({ q: 'not-an-email', matches: [], truncated: false })
  })

  it('no session → 401', async () => {
    const res = await search('joy.hall', {})
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized' })
  })
})

describe('T-API-3 stub users are matched by user_id', () => {
  it('a webhook-created user appears with its stub pkey, null email and null status', async () => {
    const stub = 'u_2b6447a'
    const nextEventId = eventIdPool()
    const res = await sendWebhook(
      JSON.stringify({
        event_id: nextEventId(),
        event: 'read_story',
        user_id: stub,
        device_id: 'd_4b21e8',
        timestamp: '2026-09-28T14:22:05Z',
      }),
    )
    expect(res.status).toBe(202)
    // user_id order: the stub's id is a prefix of julia's, so it sorts first.
    expect(await found('u_2b6447a')).toEqual({
      q: 'u_2b6447a',
      matches: [
        {
          pkey: await pkeyForUnknownUser(piiKeySecret(), stub),
          email: null,
          kind: 'unknown_user_stub',
          user_id: stub,
          status: null,
        },
        {
          pkey: await pkeyForEmail(piiKeySecret(), JULIA),
          email: JULIA,
          kind: 'subscriber',
          user_id: 'u_2b6447a3',
          status: 'active',
        },
      ],
      truncated: false,
    })
  })
})
