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
//   2026-09-03) copied with the user_id's "1" removed (u_ceed5f2) and created_at set to 2026-08-22
//   (julia.evans230's, app_users.csv:2). The new account is her earliest, yet its id sorts AFTER
//   u_ceed5f12 and it is inserted last, so "earliest first" can only pass by created_at, never by
//   id or insertion order (both share the prefix u_ceed5f, so a user-id search finds both);
// - a second web visitor v_e792b1c600, a real anonymous visitor whose one row (web_events.csv:5440,
//   2026-09-03) comes after joy's first row (5400), so it is inserted after hers. It gets a copy of
//   web_events.csv:13 (the real visitor v_569d3a387c's '/' row, 2026-07-01 01:29:54) and a copy of
//   joy's /subscribe row 5421, both appended with its visitor_id. It is then her earliest browser,
//   yet its id sorts AFTER v_c9e136fd6d and it is inserted last: "earliest first" can only pass
//   by first_seen_ts.

export const JOY = 'joy.hall830@protonmail.com'
export const SECOND_ACCOUNT = 'u_ceed5f2'
export const SECOND_VISITOR = 'v_e792b1c600'

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
  const early = rowAt(csvs.web_events, 13)
  check('web_events.csv:13', early, ['v_569d3a387c', '/', '2026-07-01 01:29:54', '', ''])
  check('web_events.csv:5440', rowAt(csvs.web_events, 5440), [SECOND_VISITOR, '/subscribe', '2026-09-03 00:36:15', 'instagram', ''])
  append(csvs.web_events, [SECOND_VISITOR, ...early.slice(1)])
  append(csvs.web_events, [SECOND_VISITOR, ...subscribe.slice(1)])
  return csvs
}
