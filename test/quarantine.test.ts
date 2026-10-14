/// <reference types="vite/client" />
import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import appCsv from '../data/app_users.csv?raw'
import subscribersCsv from '../data/subscribers.csv?raw'
import webCsv from '../data/web_events.csv?raw'
import { needsReview, reviewGroups } from '../src/needs-review'
import type { Overview, QuarantineList } from '../src/types'
import { QUARANTINE_REASONS } from '../worker/ingest/quarantine'
import { FILE_HEADERS, quarantineFields } from '../worker/routes/quarantine'
import { loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'

// GET /api/quarantine?reason=&file= (04 §/api/quarantine, 09 D-61, D-63) and the Overview "Needs review"
// section's pure logic (src/needs-review.ts, 06 §Overview). T-OVR-1: the test D1 holds the real seed of
// data/*.csv; the counts (8 blank rows, the 2 invalid emails `not-an-email` and `@gmail.com`) are
// 02 §Counts, the line numbers 1750 and 1788 are 08 T-OVR-1's.

let cookie: string

beforeAll(async () => {
  await seedDatabase()
  cookie = await loginCookie()
})

const quarantine = (query: string, headers: Record<string, string> = { cookie }) =>
  SELF.fetch(`http://cdp.test/api/quarantine${query}`, { headers })

/** Line `lineNo` (1-based, header = 1) of the real subscribers.csv, as written. */
const subscriberLine = (lineNo: number) => subscribersCsv.split(/\r?\n/)[lineNo - 1]

describe('GET /api/quarantine (T-OVR-1)', () => {
  it('reason=invalid_email → exactly the 2 invalid emails, fields as written, status active', async () => {
    const res = await quarantine('?reason=invalid_email')
    expect(res.status).toBe(200)
    const body = await res.json<QuarantineList>()
    expect(body).toEqual({
      rows: [
        {
          file: 'subscribers',
          line_no: 1750,
          reason: 'invalid_email',
          fields: {
            email: 'not-an-email',
            signup_date: '2026-08-14',
            status: 'active',
            acquisition_source: 'Instagram',
            last_open_date: '',
          },
        },
        {
          file: 'subscribers',
          line_no: 1788,
          reason: 'invalid_email',
          fields: {
            email: '@gmail.com',
            signup_date: '2026-09-02',
            status: 'active',
            acquisition_source: 'Google',
            last_open_date: '',
          },
        },
      ],
    })
    // The fields are the file's own text at that line, in the file's column order.
    for (const row of body.rows) expect(Object.values(row.fields).join(',')).toBe(subscriberLine(row.line_no))
  })

  it('no reason → all 10 set-aside rows (8 blank_row + 2 invalid_email), in file line order', async () => {
    const res = await quarantine('')
    expect(res.status).toBe(200)
    const { rows } = await res.json<QuarantineList>()
    expect(rows).toHaveLength(10)
    expect(rows.filter((r) => r.reason === 'blank_row')).toHaveLength(8)
    expect(rows.filter((r) => r.reason === 'invalid_email').map((r) => r.line_no)).toEqual([1750, 1788])
    expect(new Set(rows.map((r) => r.file))).toEqual(new Set(['subscribers']))
    const lines = rows.map((r) => r.line_no)
    expect(lines).toEqual([...lines].sort((a, b) => a - b))
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(['file', 'line_no', 'reason', 'fields'])
      expect(Object.keys(row.fields)).toEqual(FILE_HEADERS.subscribers)
      expect(Object.values(row.fields).join(',')).toBe(subscriberLine(row.line_no))
      if (row.reason === 'blank_row') expect(Object.values(row.fields).every((v) => v === '')).toBe(true)
    }
  })

  it('each reason code filters to its own rows; the seed has no missing_field or bad_date rows', async () => {
    const counts: Record<string, number> = {}
    for (const reason of QUARANTINE_REASONS) {
      const res = await quarantine(`?reason=${reason}`)
      expect(res.status).toBe(200)
      const { rows } = await res.json<QuarantineList>()
      expect(rows.every((r) => r.reason === reason)).toBe(true)
      counts[reason] = rows.length
    }
    expect(counts).toEqual({ blank_row: 8, invalid_email: 2, missing_field: 0, bad_date: 0 })
  })

  it('an unknown or empty reason → 400 invalid_reason, without echoing the input', async () => {
    for (const query of ['?reason=merged', '?reason=', '?reason=INVALID_EMAIL']) {
      const res = await quarantine(query)
      expect(res.status).toBe(400)
      const body = await res.json<{ error: string; message: string }>()
      expect(body).toEqual({
        error: 'invalid_reason',
        message: 'reason must be one of blank_row, invalid_email, missing_field, bad_date, or left out.',
      })
    }
  })

  it('401 without a session cookie', async () => {
    const res = await quarantine('?reason=invalid_email', {})
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Sign in to continue.' })
  })
})

describe('GET /api/quarantine?file= (09 D-63: each run’s "View rejected rows")', () => {
  it('file=subscribers → the same 10 rows as no filter; the other sources set nothing aside', async () => {
    const all = await (await quarantine('')).json<QuarantineList>()
    const res = await quarantine('?file=subscribers')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(all)
    for (const file of ['web_events', 'app_users', 'app_events']) {
      const other = await quarantine(`?file=${file}`)
      expect(other.status).toBe(200)
      expect(await other.json()).toEqual({ rows: [] })
    }
  })

  it('file and reason combine: subscribers + invalid_email → lines 1750 and 1788; web_events + invalid_email → none', async () => {
    const both = await (await quarantine('?file=subscribers&reason=invalid_email')).json<QuarantineList>()
    expect(both.rows.map((r) => [r.file, r.line_no, r.reason])).toEqual([
      ['subscribers', 1750, 'invalid_email'],
      ['subscribers', 1788, 'invalid_email'],
    ])
    const other = await (await quarantine('?reason=invalid_email&file=web_events')).json<QuarantineList>()
    expect(other).toEqual({ rows: [] })
  })

  it('a file outside the registry → 400 invalid_file, without echoing the input', async () => {
    for (const query of ['?file=subscribers.csv', '?file=', '?file=SUBSCRIBERS', '?file=quarantine']) {
      const res = await quarantine(query)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: 'invalid_file',
        message: 'file must be one of subscribers, web_events, app_users, app_events, or left out.',
      })
    }
  })

  it('401 without a session cookie', async () => {
    const res = await quarantine('?file=subscribers', {})
    expect(res.status).toBe(401)
  })
})

describe('quarantineFields', () => {
  it("each file's header is the first line of the real CSV, in the file's order", () => {
    const firstLine = (csv: string) => csv.split(/\r?\n/)[0]
    expect(FILE_HEADERS.subscribers.join(',')).toBe(firstLine(subscribersCsv))
    expect(FILE_HEADERS.web_events.join(',')).toBe(firstLine(webCsv))
    expect(FILE_HEADERS.app_users.join(',')).toBe(firstLine(appCsv))
  })

  it('fails loud on a stored row whose field count is not the header’s (09 D-47: a real row, last field removed)', () => {
    const shortened = subscriberLine(1750).split(',').slice(0, -1).join(',')
    expect(() => quarantineFields('subscribers', shortened)).toThrow(/4 fields, header has 5/)
  })
})

describe('Needs review section (src/needs-review.ts) on the real answers', () => {
  it('shows only when Overview reports a reason other than blank_row', async () => {
    const overview = await (
      await SELF.fetch('http://cdp.test/api/overview', { headers: { cookie } })
    ).json<Overview>()
    const shown = Object.keys(overview.quarantine_reasons).filter(needsReview)
    expect(shown).toEqual(['invalid_email'])
    expect(needsReview('blank_row')).toBe(false)
  })

  it('one group: the plain sentence, the 2 rows as written, and the fix; blank rows left out', async () => {
    const { rows } = await (await quarantine('')).json<QuarantineList>()
    const groups = reviewGroups(rows)
    expect(groups).toHaveLength(1)
    const [group] = groups
    expect(group.sentence).toBe("2 subscribers couldn't be added — their email isn't valid.")
    expect(group.fix).toBe('Correct the email in subscribers.csv, then re-run the seed.')
    expect(group.columns.map((c) => c.label)).toEqual(['Email', 'Signed up', 'Status', 'Source'])
    expect(group.rows.map((r) => [r.line_no, ...group.columns.map((c) => r.fields[c.name])])).toEqual([
      [1750, 'not-an-email', '2026-08-14', 'active', 'Instagram'],
      [1788, '@gmail.com', '2026-09-02', 'active', 'Google'],
    ])
  })

  it('no group when only blank rows were set aside', async () => {
    const { rows } = await (await quarantine('?reason=blank_row')).json<QuarantineList>()
    expect(rows).toHaveLength(8)
    expect(reviewGroups(rows)).toEqual([])
  })
})
