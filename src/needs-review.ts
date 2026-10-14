// Overview's "Needs review" card (06 §Overview, 09 D-61): which set-aside rows a person can fix, the
// one plain sentence that says why, the fields to show as written, and what to do. Pure, so
// test/quarantine.test.ts runs it on the real GET /api/quarantine answer; src/pages/OverviewPage.tsx
// is the only other reader.

import type { QuarantineList } from './types'

export type QuarantinedRow = QuarantineList['rows'][number]
type SetAsideFile = QuarantinedRow['file']

/**
 * A blank row has nothing to correct, so it stays a count inside "How the data was combined";
 * every other reason (02 §Quarantine) names something a person can fix in the source file.
 */
export function needsReview(reason: string): boolean {
  return reason !== 'blank_row'
}

/** Per file: the CSV's name, the noun for its rows [one, many], the fields shown, and its date format (02 §Quarantine). */
const FILES: Record<
  SetAsideFile,
  { csv: string; unit: [string, string]; columns: { name: string; label: string }[]; dateFormat: string }
> = {
  subscribers: {
    csv: 'subscribers.csv',
    unit: ['subscriber', 'subscribers'],
    columns: [
      { name: 'email', label: 'Email' },
      { name: 'signup_date', label: 'Signed up' },
      { name: 'status', label: 'Status' },
      { name: 'acquisition_source', label: 'Source' },
    ],
    dateFormat: 'YYYY-MM-DD',
  },
  web_events: {
    csv: 'web_events.csv',
    unit: ['page view', 'page views'],
    columns: [
      { name: 'visitor_id', label: 'Visitor' },
      { name: 'page', label: 'Page' },
      { name: 'timestamp', label: 'Time' },
      { name: 'utm_source', label: 'Campaign source' },
      { name: 'email', label: 'Email' },
    ],
    dateFormat: 'YYYY-MM-DD HH:MM:SS',
  },
  app_users: {
    csv: 'app_users.csv',
    unit: ['app user', 'app users'],
    columns: [
      { name: 'user_id', label: 'App user' },
      { name: 'email', label: 'Email' },
      { name: 'created_at', label: 'Created' },
    ],
    dateFormat: 'YYYY-MM-DD',
  },
}

/** Why the rows could not be added, in words; blank_row never reaches here (needsReview). */
const WHY: Record<Exclude<QuarantinedRow['reason'], 'blank_row'>, string> = {
  invalid_email: "their email isn't valid",
  missing_field: 'a required field is empty',
  bad_date: "a date isn't written the way the file writes dates",
}

function fixText(file: SetAsideFile, reason: keyof typeof WHY): string {
  const { csv, dateFormat } = FILES[file]
  if (reason === 'invalid_email') return `Correct the email in ${csv}, then re-run the seed.`
  if (reason === 'missing_field') return `Fill in the empty field in ${csv}, then re-run the seed.`
  return `Write the date as ${dateFormat} in ${csv}, then re-run the seed.`
}

export interface ReviewGroup {
  key: string
  /** One plain sentence: "2 subscribers couldn't be added — their email isn't valid." */
  sentence: string
  /** What to do, naming the file. */
  fix: string
  /** The fields shown for each row, with plain labels (06 §UI principles 4). */
  columns: { name: string; label: string }[]
  rows: QuarantinedRow[]
}

/** The rows a person can fix, grouped by file and reason in the order the API lists them. */
export function reviewGroups(rows: readonly QuarantinedRow[]): ReviewGroup[] {
  const groups = new Map<string, { file: SetAsideFile; reason: keyof typeof WHY; rows: QuarantinedRow[] }>()
  for (const row of rows) {
    if (row.reason === 'blank_row') continue
    const key = `${row.file}:${row.reason}`
    const group = groups.get(key) ?? { file: row.file, reason: row.reason, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return [...groups].map(([key, g]) => {
    const [one, many] = FILES[g.file].unit
    const count = g.rows.length
    return {
      key,
      sentence: `${count.toLocaleString('en-US')} ${count === 1 ? one : many} couldn't be added — ${WHY[g.reason]}.`,
      fix: fixText(g.file, g.reason),
      columns: FILES[g.file].columns,
      rows: g.rows,
    }
  })
}

/** A field as written; an empty one says so instead of showing nothing. */
export function asWritten(value: string | undefined): string {
  return value === undefined || value === '' ? '(blank in the file)' : value
}

/** The file's name as people see it in a folder, for Technical details. */
export function csvName(file: SetAsideFile): string {
  return FILES[file].csv
}
