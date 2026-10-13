/// <reference types="vite/client" />
import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { normalizeQueryFragment, QUERY_FRAGMENT_MIN_LENGTH } from '../shared/normalize'
import { pkeyForEmail, pkeyForUnknownUser } from '../shared/pseudonym'
import apiSource from '../src/api.ts?raw'
import lookupPageSource from '../src/pages/LookupPage.tsx?raw'
import {
  damerauLevenshtein,
  DID_YOU_MEAN_LIMIT,
  emailDistance,
  FUZZY_MAX_DISTANCE,
  FUZZY_MIN_LENGTH,
  nearestEmails,
  wantsSuggestions,
} from '../worker/lookup/fuzzy'
import { SEARCH_LIMIT } from '../worker/routes/lookup'
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
// - "ell", "hall", "joy.hall", "u_2b64", "2b6447": substrings of the real values above (09 D-47
//   removals). "2b6447" sits inside u_2b6447a3 without starting it, and no email contains it.
// - "JOY.HALL ", "  jo  ", "jo", "": "joy.hall" re-cased, padded or cut (09 D-47).
//   aaron.bell239@gmail.com (subscribers.csv:2483) contains "ell" without starting with it and
//   sorts before every "ell…" address, so plain alphabetical order would list it first.
// - "not-an-email": a real value of subscribers.csv:1750, quarantined (invalid_email), so no
//   profile holds it: the unknown fragment.
// - "hall%", "joy_hall", "hall\", "joy\.hall": real fragments with one LIKE metacharacter added
//   or swapped in for a "."; they test escaping, not data, and introduce no business value (09 D-47).
// - Fuzzy lookup (09 D-59, T-API-4), each a removal or swap within a real value (09 D-47):
//   "joy.hal830@protonmail.com" (one "l" removed from joy.hall830's address), "joyhall830" (the
//   "." removed), "joyhal830" (the "." and one "l" removed: distance 2 with a length gap of exactly
//   2; no row contains it), "joyh" (a 4-character cut of "joy.hall830" with its "." removed; no email
//   contains it), "appser17" (the "u" removed from appuser17@gmail.com, app_users.csv:6; within
//   distance 2 of 13 app-only addresses), "appuser1" (a cut of the same, contained in 11 of them),
//   "appus" and "appu" (5- and 4-character cuts), "yj" ("joy" with "o" removed and the rest swapped).
//   The expected lists were computed by a separate Python implementation over data/*.csv.
//   The shortest stored local part has 8 characters, so no fragment under 6 characters is within
//   distance 2 of any address: the 5-character gate is pinned on wantsSuggestions directly.
// - The stub: u_2b6447a (julia's id with its last character removed, as T-WH-6 uses), sent once
//   through the real webhook with the brief's sample device d_4b21e8 (09 D-11), in the last
//   describe because storage persists across this file's tests.

const JOY_HALL = ['joy.hall524@protonmail.com', 'joy.hall830@protonmail.com', 'joy.hall898@gmail.com']
const JULIA = 'julia.evans230@gmail.com'

interface Match {
  pkey: string
  email: string | null
  kind: string
  user_id: string | null
  status: string | null
}
interface Suggestion {
  pkey: string
  email: string
  kind: string
  distance: number
}
interface SearchBody {
  q: string
  matches: Match[]
  truncated: boolean
  did_you_mean: Suggestion[]
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
    // The "." stays: no dot stripping, like normalizeEmail (D-26).
    expect(normalizeQueryFragment('  JOY.HALL ')).toBe('joy.hall')
    // Not an address and still returned: a fragment is never validated.
    expect(normalizeQueryFragment('Joy.Hall830')).toBe('joy.hall830')
  })

  it('the route folds in code, never in SQL', () => {
    expect(lookupSource).toContain('normalizeQueryFragment(')
    expect(lookupSource).not.toMatch(/\bLOWER\s*\(/i)
  })

  it('the browser sends the raw input and never folds it (02 §Normalization)', () => {
    for (const [file, text] of [
      ['src/pages/LookupPage.tsx', lookupPageSource],
      ['src/api.ts', apiSource],
    ]) {
      expect(text, file).not.toMatch(/\.(trim|trimStart|trimEnd|toLowerCase|toLocaleLowerCase)\s*\(/)
    }
    expect(lookupPageSource).toContain('/api/lookup/search?q=${encodeURIComponent(fragment)}')
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
    expect(body).toEqual({ q: 'joy.hall', matches: expected, truncated: false, did_you_mean: [] })
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
      did_you_mean: [],
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
    // character), "hall\" would be a malformed escape, and "joy\.hall" would match the 3 joy.hall
    // profiles ("\." = a literal "."). "hall\" alone cannot tell: unescaped it also gives [].
    for (const q of ['hall%', 'joy_hall', 'hall\\', 'joy\\.hall']) {
      expect(await found(q), q).toEqual({ q, matches: [], truncated: false, did_you_mean: [] })
    }
  })

  it('user_id matches only from its start: 2b6447 (inside u_2b6447a3) → none', async () => {
    const inside = await env.DB.prepare("SELECT count(*) AS n FROM app_users WHERE instr(user_id, '2b6447') > 1")
      .first<number>('n')
    expect(inside).toBe(1)
    expect(await found('2b6447')).toEqual({ q: '2b6447', matches: [], truncated: false, did_you_mean: [] })
  })

  it('an unknown fragment → 200 with no matches, not 404', async () => {
    expect(await found('not-an-email')).toEqual({ q: 'not-an-email', matches: [], truncated: false, did_you_mean: [] })
  })

  it('no session → 401', async () => {
    const res = await search('joy.hall', {})
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized' })
  })
})

describe('fuzzy helper (worker/lookup/fuzzy.ts, 09 D-59)', () => {
  it('damerauLevenshtein counts insert, delete, substitute and swap as 1, unrestricted', () => {
    expect(damerauLevenshtein('joy.hall830', 'joy.hall830')).toBe(0)
    expect(damerauLevenshtein('joy.hal830', 'joy.hall830')).toBe(1)
    expect(damerauLevenshtein('joy.hall830', 'joy.hal830')).toBe(1)
    expect(damerauLevenshtein('jyo.hall830', 'joy.hall830')).toBe(1)
    expect(damerauLevenshtein('joy.hall524', 'joy.hall830')).toBe(3)
    expect(damerauLevenshtein('', 'joy')).toBe(3)
    // Swap "yj" to "jy", then insert "o" between: 2. The restricted (optimal string alignment)
    // variant cannot edit inside a swapped pair and says 3.
    expect(damerauLevenshtein('yj', 'joy')).toBe(2)
  })

  it('emailDistance takes the nearer of the whole address and its local part, null past 2', () => {
    expect(FUZZY_MAX_DISTANCE).toBe(2)
    expect(emailDistance('joy.hal830@protonmail.com', 'joy.hall830@protonmail.com')).toBe(1)
    expect(emailDistance('joyhall830', 'joy.hall830@protonmail.com')).toBe(1)
    // Two letters dropped: the lengths differ by exactly 2, so the length pre-check must keep it.
    expect(emailDistance('joyhal830', 'joy.hall830@protonmail.com')).toBe(2)
    expect(emailDistance('joy.hall830', 'joy.hall830@protonmail.com')).toBe(0)
    expect(emailDistance('joy.hall524', 'joy.hall830@protonmail.com')).toBeNull()
  })

  it('wantsSuggestions: only with no partial match and at least 5 characters', () => {
    expect(FUZZY_MIN_LENGTH).toBe(5)
    expect(wantsSuggestions('appus', 0)).toBe(true)
    expect(wantsSuggestions('appu', 0)).toBe(false)
    expect(wantsSuggestions('appuser1', 11)).toBe(false)
  })

  it('nearestEmails: nearest first, then code-unit order, at most 5', () => {
    expect(DID_YOU_MEAN_LIMIT).toBe(5)
    const rows = ['appuser7', 'appuser1', 'appuser13', 'appuser17', 'appuser12', 'appuser10', 'appuser11'].map(
      (local) => ({ email: `${local}@gmail.com` }),
    )
    // "appuser1@" sorts after "appuser10@".."appuser13@" ("@" > the digits), as ORDER BY
    // email_norm does; a locale comparison would put it second.
    expect(nearestEmails('appser17', rows)).toEqual([
      { email: 'appuser17@gmail.com', distance: 1 },
      { email: 'appuser10@gmail.com', distance: 2 },
      { email: 'appuser11@gmail.com', distance: 2 },
      { email: 'appuser12@gmail.com', distance: 2 },
      { email: 'appuser13@gmail.com', distance: 2 },
    ])
  })
})

describe('T-API-4 fuzzy lookup (did_you_mean)', () => {
  const suggestion = async (email: string, kind: string, distance: number): Promise<Suggestion> => ({
    pkey: await pkeyForEmail(piiKeySecret(), email),
    email,
    kind,
    distance,
  })

  it('joy.hal830@protonmail.com (one letter removed) → no matches, did_you_mean[0] = joy.hall830 at distance 1', async () => {
    const q = 'joy.hal830@protonmail.com'
    const body = await found(q)
    expect(body).toEqual({
      q,
      matches: [],
      truncated: false,
      did_you_mean: [await suggestion('joy.hall830@protonmail.com', 'subscriber', 1)],
    })
    expect(Object.keys(body.did_you_mean[0])).toEqual(['pkey', 'email', 'kind', 'distance'])
  })

  it('joyhall830 → joy.hall830 among did_you_mean, by its local part', async () => {
    const body = await found('joyhall830')
    expect(body.matches).toEqual([])
    expect(body.did_you_mean).toContainEqual(await suggestion('joy.hall830@protonmail.com', 'subscriber', 1))
  })

  it('joyhal830 (two letters dropped) → joy.hall830 among did_you_mean at distance 2', async () => {
    const body = await found('joyhal830')
    expect(body.matches).toEqual([])
    expect(body.did_you_mean).toContainEqual(await suggestion('joy.hall830@protonmail.com', 'subscriber', 2))
  })

  it('a 4-character miss → did_you_mean []', async () => {
    expect(await found('joyh')).toEqual({ q: 'joyh', matches: [], truncated: false, did_you_mean: [] })
    // The shortest stored local part has 8 characters, so no real fragment under 6 characters is
    // within 2 of anything and the data alone cannot show the length gate. Pin that the route
    // gates on wantsSuggestions (tested above), not on an empty match list alone.
    expect(lookupSource).toContain('if (wantsSuggestions(q, matches.length))')
  })

  it('a fragment with a partial match → did_you_mean [], though suggestions exist for it', async () => {
    const body = await found('appuser1')
    expect(body.matches).toHaveLength(11)
    expect(body.did_you_mean).toEqual([])
    const { results } = await env.DB.prepare(
      'SELECT email_norm AS email FROM profiles WHERE email_norm IS NOT NULL',
    ).all<{ email: string }>()
    expect(nearestEmails('appuser1', results)).toHaveLength(DID_YOU_MEAN_LIMIT)
  })

  it('at most 5: appser17 (sent re-cased and padded) has 13 addresses within distance 2 and returns the nearest 5', async () => {
    const { results } = await env.DB.prepare(
      'SELECT email_norm AS email FROM profiles WHERE email_norm IS NOT NULL',
    ).all<{ email: string }>()
    expect(results.filter((r) => emailDistance('appser17', r.email) !== null)).toHaveLength(13)
    const body = await found('APPSER17 ')
    expect(body).toEqual({
      q: 'appser17',
      matches: [],
      truncated: false,
      did_you_mean: [
        await suggestion('appuser17@gmail.com', 'app_only', 1),
        await suggestion('appuser10@gmail.com', 'app_only', 2),
        await suggestion('appuser11@gmail.com', 'app_only', 2),
        await suggestion('appuser12@gmail.com', 'app_only', 2),
        await suggestion('appuser13@gmail.com', 'app_only', 2),
      ],
    })
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
      did_you_mean: [],
    })
  })
})
