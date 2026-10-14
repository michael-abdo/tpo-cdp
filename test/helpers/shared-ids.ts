/// <reference types="vite/client" />
import appCsv from '../../data/app_users.csv?raw'
import subscribersCsv from '../../data/subscribers.csv?raw'
import webCsv from '../../data/web_events.csv?raw'
import { parseCsv, type ParsedCsv } from '../../worker/ingest/csv'
import type { SeedCsvs } from '../../worker/ingest/link'

// The real data/*.csv with one profile given two app accounts and two web visitors (09 D-70 item 4,
// 08 T-HARD-4), for test/hardening-ids.test.ts (the API on a seeded D1) and
// test/ui/lookup-profile.test.ts (the page). Pure, so both test projects can import it. Every
// value introduced occurs in data/*.csv or is a removal (09 D-47):
// - a second app account for joy.hall830@protonmail.com: her row app_users.csv:303 (u_ceed5f12,
//   2026-09-03) copied with the user_id's last character removed (u_ceed5f1) and created_at set to
//   2026-08-22 (julia.evans230's, app_users.csv:2), so the new account is her earliest;
// - a second web visitor: her /subscribe row web_events.csv:5421 copied with visitor_id set to
//   v_569d3a387c, a real anonymous visitor (web_events.csv:13, 5 rows, first seen 2026-07-01), so
//   that visitor's whole history links to her as her earliest browser.

export const JOY = 'joy.hall830@protonmail.com'
export const SECOND_ACCOUNT = 'u_ceed5f1'
export const SECOND_VISITOR = 'v_569d3a387c'

/** A copy of a real parsed row by its file line. */
export function rowAt(csv: ParsedCsv, lineNo: number): string[] {
  const i = csv.lineNos.indexOf(lineNo)
  if (i === -1) throw new Error(`no row starts on line ${lineNo}`)
  return [...csv.rows[i]]
}

/** Appends a row as the file's next line. */
function append(csv: ParsedCsv, row: string[]): void {
  csv.rows.push(row)
  csv.lineNos.push(csv.lineNos[csv.lineNos.length - 1] + 1)
}

/** Fails loud when a real row is not the one the derivation names. */
function check(what: string, actual: readonly string[], expected: readonly string[]): void {
  if (actual.join(',') !== expected.join(','))
    throw new Error(`shared-ids helper: ${what} is "${actual.join(',')}", expected "${expected.join(',')}"`)
}

/** Freshly parsed real CSVs with joy's second app account and second web visitor added. */
export function sharedIdCsvs(): SeedCsvs {
  const csvs = { subscribers: parseCsv(subscribersCsv), web_events: parseCsv(webCsv), app_users: parseCsv(appCsv) }
  check('app_users.csv:303', rowAt(csvs.app_users, 303), ['u_ceed5f12', JOY, '2026-09-03'])
  const julia = rowAt(csvs.app_users, 2)
  check('app_users.csv:2', julia, ['u_2b6447a3', 'julia.evans230@gmail.com', '2026-08-22'])
  append(csvs.app_users, [SECOND_ACCOUNT, JOY, julia[2]])
  const subscribe = rowAt(csvs.web_events, 5421)
  check('web_events.csv:5421', subscribe, ['v_c9e136fd6d', '/subscribe', '2026-09-02 20:40:04', '', JOY])
  check('web_events.csv:13 visitor', rowAt(csvs.web_events, 13).slice(0, 1), [SECOND_VISITOR])
  append(csvs.web_events, [SECOND_VISITOR, ...subscribe.slice(1)])
  return csvs
}
