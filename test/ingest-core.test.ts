/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import subscribersCsv from '../data/subscribers.csv?raw'
import { parseCsv } from '../worker/ingest/csv'
import { classifySubscriberRow, requireHeaders, SUBSCRIBER_COLUMNS } from '../worker/ingest/quarantine'
import { ingestSubscribers } from '../worker/ingest/subscribers'

// 02 §Quarantine, §Dedupe, §Counts; 09 D-27, D-28; tests 08 T-ING-2..4 (R1.3, C5).
// Input is the real data/subscribers.csv. T-ING-4 and the parser checks change real rows
// or real file text in place, because no pair in the data disagrees (02 §Dedupe).

const parsed = parseCsv(subscribersCsv)
const result = ingestSubscribers(parsed)

/** The real row that starts on `lineNo`, copied so a test can change it. */
function rowAt(lineNo: number): string[] {
  const i = parsed.lineNos.indexOf(lineNo)
  if (i === -1) throw new Error(`no row starts on line ${lineNo}`)
  return [...parsed.rows[i]]
}

describe('parseCsv on the real file', () => {
  it('reads 2,995 rows under the 5-column header with file line numbers', () => {
    expect(parsed.header).toEqual([...SUBSCRIBER_COLUMNS])
    expect(parsed.rows).toHaveLength(2995)
    expect(parsed.lineNos[0]).toBe(2)
    expect(parsed.lineNos.at(-1)).toBe(2996)
    expect(rowAt(70)).toEqual(['chloe.reed603@yahoo.com', '2026-08-12', 'active', 'Instagram', '2026-09-20'])
  })

  it('CRLF and LF give the same records', () => {
    expect(subscribersCsv).toContain('\r\n')
    expect(parseCsv(subscribersCsv.replace(/\r\n/g, '\n'))).toEqual(parsed)
  })

  it('a quoted field and an escaped quote read back as the field text', () => {
    const lines = subscribersCsv.split('\r\n')
    lines[69] = '"chloe.reed603@yahoo.com","2026-08-12",active,"Insta""gram",2026-09-20'
    const quoted = parseCsv(lines.join('\r\n'))
    expect(quoted.rows[68]).toEqual([
      'chloe.reed603@yahoo.com',
      '2026-08-12',
      'active',
      'Insta"gram',
      '2026-09-20',
    ])
  })

  it('fails loud on a ragged row, naming its line', () => {
    const lines = subscribersCsv.split('\r\n')
    lines[69] = lines[69].replace(',active', '')
    expect(() => parseCsv(lines.join('\r\n'))).toThrow('CSV line 70: 4 fields, header has 5')
  })
})

describe('required headers fail fast', () => {
  it('names the file and the missing column', () => {
    const header = parsed.header.map((h) => (h === 'signup_date' ? 'signed_up' : h))
    expect(() => requireHeaders('subscribers.csv', header, SUBSCRIBER_COLUMNS)).toThrow(
      'subscribers.csv: missing required column "signup_date"',
    )
    expect(() => ingestSubscribers({ ...parsed, header })).toThrow('missing required column "signup_date"')
  })
})

describe('T-ING-2 quarantine (02 §Quarantine, §Counts)', () => {
  it('quarantines exactly the 8 blank rows and 2 invalid emails, by line', () => {
    expect(result.quarantined).toHaveLength(10)
    expect(result.quarantined.map((q) => [q.line_no, q.reason])).toEqual([
      [235, 'blank_row'],
      [630, 'blank_row'],
      [1587, 'blank_row'],
      [1750, 'invalid_email'],
      [1788, 'invalid_email'],
      [2391, 'blank_row'],
      [2402, 'blank_row'],
      [2674, 'blank_row'],
      [2722, 'blank_row'],
      [2864, 'blank_row'],
    ])
  })

  it('keeps the raw row of each quarantined line', () => {
    const byLine = new Map(result.quarantined.map((q) => [q.line_no, q.raw_row]))
    expect(byLine.get(235)).toBe(',,,,')
    expect(byLine.get(1750)).toBe('not-an-email,2026-08-14,active,Instagram,')
    expect(byLine.get(1788)).toBe('@gmail.com,2026-09-02,active,Google,')
  })

  it('missing_field and bad_date fire on real rows with a field emptied or broken', () => {
    const noSignup = rowAt(70)
    noSignup[1] = ''
    expect(classifySubscriberRow(parsed.header, noSignup, 70)).toBe('missing_field')
    const noEmail = rowAt(70)
    noEmail[0] = '   '
    expect(classifySubscriberRow(parsed.header, noEmail, 70)).toBe('missing_field')
    const badOpen = rowAt(70)
    badOpen[4] = '2026-09-31'
    expect(classifySubscriberRow(parsed.header, badOpen, 70)).toBe('bad_date')
    const badSignup = rowAt(70)
    badSignup[1] = '12/08/2026'
    expect(classifySubscriberRow(parsed.header, badSignup, 70)).toBe('bad_date')
    expect(classifySubscriberRow(parsed.header, rowAt(70), 70)).toBeNull()
  })

  it('an unknown status throws with its line instead of guessing a reason', () => {
    const row = rowAt(70)
    row[2] = 'paused'
    expect(() => classifySubscriberRow(parsed.header, row, 70)).toThrow(
      'subscribers.csv line 70: status "paused"',
    )
  })
})

describe('T-ING-3 dedupe (02 §Dedupe, §Counts)', () => {
  it('collapses Chloe.Reed603@Yahoo.Com and its lowercase spelling into one entry', () => {
    expect(rowAt(2269)[0]).toBe('Chloe.Reed603@Yahoo.Com')
    expect(result.subscribers.get('chloe.reed603@yahoo.com')).toEqual({
      email_norm: 'chloe.reed603@yahoo.com',
      email_raw: 'chloe.reed603@yahoo.com', // line 70 comes before line 2269
      signup_date: '2026-08-12',
      status: 'active',
      source: 'instagram',
      last_open_date: '2026-09-20',
      merged_count: 2,
    })
  })

  it('2,995 rows − 10 quarantined − 85 merged = 2,900 subscribers', () => {
    const subs = [...result.subscribers.values()]
    expect(subs).toHaveLength(2900)
    const merged = subs.reduce((n, s) => n + s.merged_count - 1, 0)
    expect(merged).toBe(85)
    expect(subs.filter((s) => s.merged_count === 2)).toHaveLength(85)
    expect(parsed.rows.length - result.quarantined.length - merged).toBe(2900)
  })

  it('post-dedupe status counts are 2,610 active and 290 unsubscribed', () => {
    const subs = [...result.subscribers.values()]
    expect(subs.filter((s) => s.status === 'active')).toHaveLength(2610)
    expect(subs.filter((s) => s.status === 'unsubscribed')).toHaveLength(290)
  })
})

describe('T-ING-4 merge precedence on a conflicting pair built from real rows (D-27)', () => {
  const ingestPair = (first: string[], second: string[]) =>
    ingestSubscribers({ header: parsed.header, rows: [first, second], lineNos: [70, 2269] }).subscribers.get(
      'chloe.reed603@yahoo.com',
    )

  // Line 2269 changed: unsubscribed, a later open, an earlier signup, and a different real source.
  const original = rowAt(70)
  const changed = rowAt(2269)
  changed[1] = '2026-07-01'
  changed[2] = 'unsubscribed'
  changed[3] = 'Facebook'
  changed[4] = '2026-09-28'

  it('unsubscribed wins, earliest signup, latest open, source from the earliest-signup row', () => {
    expect(ingestPair(original, changed)).toEqual({
      email_norm: 'chloe.reed603@yahoo.com',
      email_raw: 'chloe.reed603@yahoo.com',
      signup_date: '2026-07-01',
      status: 'unsubscribed',
      source: 'facebook',
      last_open_date: '2026-09-28',
      merged_count: 2,
    })
  })

  it('the same holds with the rows in the other order, except the first spelling kept', () => {
    expect(ingestPair(changed, original)).toEqual({
      email_norm: 'chloe.reed603@yahoo.com',
      email_raw: 'Chloe.Reed603@Yahoo.Com',
      signup_date: '2026-07-01',
      status: 'unsubscribed',
      source: 'facebook',
      last_open_date: '2026-09-28',
      merged_count: 2,
    })
  })

  it('latest open is taken across rows, not from the earliest-signup row; null never wins', () => {
    const neverOpened = rowAt(2269)
    neverOpened[1] = '2026-07-01'
    neverOpened[3] = 'Facebook'
    neverOpened[4] = ''
    for (const merged of [ingestPair(original, neverOpened), ingestPair(neverOpened, original)]) {
      expect(merged?.signup_date).toBe('2026-07-01')
      expect(merged?.source).toBe('facebook')
      expect(merged?.last_open_date).toBe('2026-09-20')
      expect(merged?.status).toBe('active')
    }
  })
})
