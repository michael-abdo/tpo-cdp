import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'

// GET /api/overview (04 §/api/overview, 06 §Overview; R1.1, D-28). The test D1 holds the real
// seed of data/*.csv (test/helpers/seed.ts) and no webhook events; every expected number is
// from 02 §Counts.

let cookie: string

beforeAll(async () => {
  await seedDatabase()
  cookie = await loginCookie()
})

const overview = (headers: Record<string, string>) => SELF.fetch('http://cdp.test/api/overview', { headers })

describe('GET /api/overview', () => {
  it('returns exactly the 04 shape with the 02 §Counts numbers', async () => {
    const res = await overview({ cookie })
    expect(res.status).toBe(200)
    const body = await res.json<Record<string, unknown>>()
    expect(Object.keys(body)).toEqual([
      'subscribers',
      'active',
      'app_users',
      'events_received',
      'import_runs',
      'quarantine_reasons',
    ])
    const runs = body.import_runs as Record<string, unknown>[]
    expect(body).toEqual({
      subscribers: 2900,
      active: 2610,
      app_users: 930,
      events_received: 0,
      import_runs: [
        {
          file: 'subscribers',
          rows_in: 2995,
          rows_out: 2900,
          merged: 85,
          quarantined: 10,
          ran_at: runs[0]?.ran_at,
        },
        {
          file: 'web_events',
          rows_in: 10000,
          rows_out: 10000,
          merged: 0,
          quarantined: 0,
          ran_at: runs[1]?.ran_at,
        },
        {
          file: 'app_users',
          rows_in: 930,
          rows_out: 930,
          merged: 0,
          quarantined: 0,
          ran_at: runs[2]?.ran_at,
        },
      ],
      quarantine_reasons: { blank_row: 8, invalid_email: 2 },
    })
    for (const run of runs) {
      expect(Object.keys(run)).toEqual(['file', 'rows_in', 'rows_out', 'merged', 'quarantined', 'ran_at'])
      expect(run.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    }
  })

  it('import_runs.ran_at is returned as stored by the seed', async () => {
    const { ranAt } = await seedDatabase()
    const body = await (await overview({ cookie })).json<{ import_runs: { ran_at: string }[] }>()
    expect(body.import_runs.map((r) => r.ran_at)).toEqual([ranAt, ranAt, ranAt])
  })

  it('401 without a session cookie', async () => {
    const res = await overview({})
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Sign in to continue.' })
  })
})
