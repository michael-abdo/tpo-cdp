/// <reference types="vite/client" />
import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import appCsv from '../data/app_users.csv?raw'
import subscribersCsv from '../data/subscribers.csv?raw'
import webCsv from '../data/web_events.csv?raw'
import { needsReview, reviewGroups, type QuarantinedRow } from '../src/needs-review'
import type { Overview, QuarantineList } from '../src/types'
import { QUARANTINE_REASONS } from '../worker/ingest/quarantine'
import { FILE_HEADERS, quarantineFields } from '../worker/routes/quarantine'
import { loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'

// GET /api/quarantine?reason=&file= and the pure logic of the
// Overview's "Rows to fix" tab (src/needs-review.ts). T-OVR-1: the test D1
// holds the real seed of data/*.csv; the counts (8 blank rows, the 2 invalid emails `not-an-email` and `@gmail.com`) are
// the seed's, the line numbers 1750 and 1788 are T-OVR-1's.

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

  it('each reason code filters to its own rows; the seed has none of the other reasons', async () => {
    const counts: Record<string, number> = {}
    for (const reason of QUARANTINE_REASONS) {
      const res = await quarantine(`?reason=${reason}`)
      expect(res.status).toBe(200)
      const { rows } = await res.json<QuarantineList>()
      expect(rows.every((r) => r.reason === reason)).toBe(true)
      counts[reason] = rows.length
    }
    expect(counts).toEqual({
      blank_row: 8,
      invalid_email: 2,
      missing_field: 0,
      bad_date: 0,
      unknown_status: 0,
      misplaced_email: 0,
      conflicting_email: 0,
      duplicate_user_id: 0,
    })
  })

  it('an unknown or empty reason → 400 invalid_reason, without echoing the input', async () => {
    for (const query of ['?reason=merged', '?reason=', '?reason=INVALID_EMAIL']) {
      const res = await quarantine(query)
      expect(res.status).toBe(400)
      const body = await res.json<{ error: string; message: string }>()
      expect(body).toEqual({
        error: 'invalid_reason',
        message:
          'reason must be one of blank_row, invalid_email, missing_field, bad_date, unknown_status, misplaced_email, conflicting_email, duplicate_user_id, or left out.',
      })
    }
  })

  it('401 without a session cookie', async () => {
    const res = await quarantine('?reason=invalid_email', {})
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Sign in to continue.' })
  })
})

describe('GET /api/quarantine?file= (each run’s "View rejected rows")', () => {
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

  it('fails loud on a stored row whose field count is not the header’s (a real row, last field removed)', () => {
    const shortened = subscriberLine(1750).split(',').slice(0, -1).join(',')
    expect(() => quarantineFields('subscribers', shortened)).toThrow(/4 fields, header has 5/)
  })
})

describe('Rows to fix tab logic (src/needs-review.ts) on the real answers', () => {
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
    expect(group.fix).toBe('Correct the email in subscribers.csv, then re-import the file.')
    expect(group.columns.map((c) => c.label)).toEqual(['Email', 'Signup date', 'Status', 'Acquisition source'])
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

  // The real seed has none of these 4 reasons (the real data triggers none of them), so
  // each group here is built from a synthetic QuarantinedRow whose fields are a minimal edit
  // of a real row (the same edits test/ingest-seed.test.ts T-ING-8 and test/parity.test.ts
  // T-PAR-3b plant), rather than read from the live /api/quarantine answer.
  it('one group per newer quarantine reason: the exact sentence and fix text, never the fallback copy', () => {
    const row = (file: QuarantinedRow['file'], line_no: number, reason: QuarantinedRow['reason'], fields: Record<string, string>): QuarantinedRow => ({ file, line_no, reason, fields })

    const unknownStatus = reviewGroups([
      row('subscribers', 4, 'unknown_status', {
        email: 'megan.walker638@hotmail.com',
        signup_date: '2026-09-07',
        status: 'activ',
        acquisition_source: 'Instagram',
      }),
    ])
    expect(unknownStatus).toHaveLength(1)
    expect(unknownStatus[0].sentence).toBe("1 subscriber couldn't be added — their status isn't active or unsubscribed.")
    expect(unknownStatus[0].fix).toBe('Change the status to active or unsubscribed in subscribers.csv, then re-import the file.')

    const misplacedEmail = reviewGroups([
      row('web_events', 5405, 'misplaced_email', {
        visitor_id: 'v_c9e136fd6d',
        page: '/about',
        timestamp: '2026-09-02 16:52:04',
        utm_source: '',
        email: 'julia.evans230@gmail.com',
      }),
    ])
    expect(misplacedEmail).toHaveLength(1)
    expect(misplacedEmail[0].sentence).toBe("1 website visit couldn't be added — their email is on a page other than /subscribe.")
    expect(misplacedEmail[0].fix).toBe('Move the email to a /subscribe row, or remove it, in web_events.csv, then re-import the file.')

    const conflictingEmail = reviewGroups([
      row('web_events', 5442, 'conflicting_email', {
        visitor_id: 'v_c9e136fd6d',
        page: '/subscribe',
        timestamp: '2026-09-03 00:51:44',
        utm_source: '',
        email: 'julia.evans230@gmail.com',
      }),
    ])
    expect(conflictingEmail).toHaveLength(1)
    expect(conflictingEmail[0].sentence).toBe(
      "1 website visit couldn't be added — this visitor already signed up with a different email.",
    )
    expect(conflictingEmail[0].fix).toBe('Decide which email is right for this visitor in web_events.csv, then re-import the file.')

    const duplicateUserId = reviewGroups([
      row('app_users', 3, 'duplicate_user_id', {
        user_id: 'u_2b6447a3',
        email: 'daniel.hill389@gmail.com',
        created_at: '2026-09-20',
      }),
    ])
    expect(duplicateUserId).toHaveLength(1)
    expect(duplicateUserId[0].sentence).toBe("1 app account couldn't be added — this user ID is already used by an earlier row.")
    expect(duplicateUserId[0].fix).toBe('Give this row its own user ID in app_users.csv, then re-import the file.')

    // Every reason's sentence/fix differs from every other's (a generic fallback sentence never fires
    // silently for a reason that does have its own line).
    const sentences = [unknownStatus, misplacedEmail, conflictingEmail, duplicateUserId].map((g) => g[0].sentence)
    expect(new Set(sentences).size).toBe(sentences.length)
  })
})
