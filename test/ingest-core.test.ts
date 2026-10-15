/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import subscribersCsv from '../data/subscribers.csv?raw'
import { parseCsv, type ParsedCsv } from '../worker/ingest/csv'
import { classifySubscriberRow, requireHeaders, SUBSCRIBER_COLUMNS } from '../worker/ingest/quarantine'
import { ingestSubscribers, type SubscriberIngest } from '../worker/ingest/subscribers'

// Quarantine, dedupe and merge precedence: T-ING-2..4.
// Input is the real data/subscribers.csv. No test introduces a value that is not in data/*.csv.
// Tests that change the real file or its rows, and how:
// - CRLF vs LF: the real file text with CRLF replaced by LF.
// - ragged row: ",active" deleted from real line 70.
// - missing column: "signup_date" deleted from the real header.
// - missing_field: the signup_date or the email of real line 70 emptied.
// - T-ING-4 ("a conflicting pair built from real rows"): lines 70/2269 with fields set to
//   values that occur in the real file (2026-07-01, 2026-09-28, unsubscribed, Facebook, blank),
//   because no pair in the data disagrees.
// - three-row merge (T-ING-3): real line 70 fed three times, unchanged, because no
//   address occurs three times in the data.

let loaded: { parsed: ParsedCsv; result: SubscriberIngest } | undefined
/** Parses and ingests the real file once, inside a test, so a throw fails named tests. */
function real(): { parsed: ParsedCsv; result: SubscriberIngest } {
  if (!loaded) {
    const parsed = parseCsv(subscribersCsv)
    loaded = { parsed, result: ingestSubscribers(parsed) }
  }
  return loaded
}

/** The real row that starts on `lineNo`, copied so a test can change it. */
function rowAt(lineNo: number): string[] {
  const { parsed } = real()
  const i = parsed.lineNos.indexOf(lineNo)
  if (i === -1) throw new Error(`no row starts on line ${lineNo}`)
  return [...parsed.rows[i]]
}

describe('parseCsv on the real file', () => {
  it('reads 2,995 rows under the 5-column header with file line numbers', () => {
    const { parsed } = real()
    expect(parsed.header).toEqual([...SUBSCRIBER_COLUMNS])
    expect(parsed.rows).toHaveLength(2995)
    expect(parsed.lineNos[0]).toBe(2)
    expect(parsed.lineNos.at(-1)).toBe(2996)
    expect(rowAt(70)).toEqual(['chloe.reed603@yahoo.com', '2026-08-12', 'active', 'Instagram', '2026-09-20'])
  })

  it('CRLF and LF give the same records', () => {
    expect(subscribersCsv).toContain('\r\n')
    expect(parseCsv(subscribersCsv.replace(/\r\n/g, '\n'))).toEqual(real().parsed)
  })

  it('fails loud on a ragged row, naming its line', () => {
    const lines = subscribersCsv.split('\r\n')
    lines[69] = lines[69].replace(',active', '')
    expect(() => parseCsv(lines.join('\r\n'))).toThrow('CSV line 70: 4 fields, header has 5')
  })
})

describe('required headers fail fast', () => {
  it('names the file and the missing column', () => {
    const { parsed } = real()
    const header = parsed.header.filter((h) => h !== 'signup_date')
    expect(() => requireHeaders('subscribers.csv', header, SUBSCRIBER_COLUMNS)).toThrow(
      'subscribers.csv: missing required column "signup_date"',
    )
    expect(() => ingestSubscribers({ ...parsed, header })).toThrow('missing required column "signup_date"')
  })
})

describe('T-ING-2 quarantine (02 §Quarantine, §Counts)', () => {
  it('quarantines exactly the 8 blank rows and 2 invalid emails, by line', () => {
    const { result } = real()
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
    const { result } = real()
    const byLine = new Map(result.quarantined.map((q) => [q.line_no, q.raw_row]))
    expect(byLine.get(235)).toBe(',,,,')
    expect(byLine.get(1750)).toBe('not-an-email,2026-08-14,active,Instagram,')
    expect(byLine.get(1788)).toBe('@gmail.com,2026-09-02,active,Google,')
  })

  it('missing_field fires on a real row with a required field emptied', () => {
    const { parsed } = real()
    const noSignup = rowAt(70)
    noSignup[1] = ''
    expect(classifySubscriberRow(parsed.header, noSignup, 70)).toBe('missing_field')
    const noEmail = rowAt(70)
    noEmail[0] = ''
    expect(classifySubscriberRow(parsed.header, noEmail, 70)).toBe('missing_field')
    expect(classifySubscriberRow(parsed.header, rowAt(70), 70)).toBeNull()
  })
})

describe('T-ING-3 dedupe (02 §Dedupe, §Counts)', () => {
  it('collapses Chloe.Reed603@Yahoo.Com and its lowercase spelling into one entry', () => {
    expect(rowAt(2269)[0]).toBe('Chloe.Reed603@Yahoo.Com')
    expect(real().result.subscribers.get('chloe.reed603@yahoo.com')).toEqual({
      email_norm: 'chloe.reed603@yahoo.com',
      email_raw: 'chloe.reed603@yahoo.com', // line 70 comes before line 2269
      signup_date: '2026-08-12',
      status: 'active',
      source: 'instagram',
      last_open_date: '2026-09-20',
      merged_count: 2,
    })
  })

  it('merged_count sums every collapsed row: real line 70 fed three times gives 3 (D-47)', () => {
    // The data has no triple, so the real counts cannot tell a sum from a constant 2.
    const merged = ingestSubscribers({
      header: real().parsed.header,
      rows: [rowAt(70), rowAt(70), rowAt(70)],
      lineNos: [70, 70, 70],
    }).subscribers
    expect([...merged.keys()]).toEqual(['chloe.reed603@yahoo.com'])
    expect(merged.get('chloe.reed603@yahoo.com')?.merged_count).toBe(3)
  })

  it('2,995 rows − 10 quarantined − 85 merged = 2,900 subscribers', () => {
    const { parsed, result } = real()
    const subs = [...result.subscribers.values()]
    expect(subs).toHaveLength(2900)
    const merged = subs.reduce((n, s) => n + s.merged_count - 1, 0)
    expect(merged).toBe(85)
    expect(subs.filter((s) => s.merged_count === 2)).toHaveLength(85)
    expect(parsed.rows.length - result.quarantined.length - merged).toBe(2900)
  })

  it('post-dedupe status counts are 2,610 active and 290 unsubscribed', () => {
    const subs = [...real().result.subscribers.values()]
    expect(subs.filter((s) => s.status === 'active')).toHaveLength(2610)
    expect(subs.filter((s) => s.status === 'unsubscribed')).toHaveLength(290)
  })
})

describe('T-ING-4 merge precedence on a conflicting pair built from real rows (D-27)', () => {
  const ingestPair = (first: string[], second: string[]) =>
    ingestSubscribers({
      header: real().parsed.header,
      rows: [first, second],
      lineNos: [70, 2269],
    }).subscribers.get('chloe.reed603@yahoo.com')

  /** Line 2269 changed: unsubscribed, a later open, an earlier signup, and a different real source. */
  function changedPair(): { original: string[]; changed: string[] } {
    const changed = rowAt(2269)
    changed[1] = '2026-07-01'
    changed[2] = 'unsubscribed'
    changed[3] = 'Facebook'
    changed[4] = '2026-09-28'
    return { original: rowAt(70), changed }
  }

  it('unsubscribed wins, earliest signup, latest open, source from the earliest-signup row', () => {
    const { original, changed } = changedPair()
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
    const { original, changed } = changedPair()
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

  it('unsubscribed wins from any row, even one with neither the earliest signup nor the latest open', () => {
    // Line 70 changed: active, an earlier signup, a different real source, a later open.
    // Line 2269 changed only to unsubscribed, so it keeps signup 2026-08-12 and open 2026-09-20.
    // A "status from the earliest-signup row" or "status from the latest-open row" rule fails here.
    const earlierAndLater = rowAt(70)
    earlierAndLater[1] = '2026-07-01'
    earlierAndLater[3] = 'Facebook'
    earlierAndLater[4] = '2026-09-28'
    const unsubscribedOnly = rowAt(2269)
    unsubscribedOnly[2] = 'unsubscribed'
    for (const merged of [
      ingestPair(earlierAndLater, unsubscribedOnly),
      ingestPair(unsubscribedOnly, earlierAndLater),
    ]) {
      expect(merged?.status).toBe('unsubscribed')
      expect(merged?.signup_date).toBe('2026-07-01')
      expect(merged?.source).toBe('facebook')
      expect(merged?.last_open_date).toBe('2026-09-28')
      expect(merged?.merged_count).toBe(2)
    }
  })

  it('latest open is taken across rows, not from the earliest-signup row; null never wins', () => {
    const original = rowAt(70)
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
