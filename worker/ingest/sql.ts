/**
 * Seed SQL emission (11 §Seed). Pure: a built Seed in, the four seed files' statements out.
 * Literal values escaped here, at most 250 rows per INSERT and every statement under D1's
 * 100 KB limit, no BEGIN/COMMIT (`wrangler d1 execute --file` wraps the file). Tables are
 * written so every REFERENCES target precedes its referrer (migrations/0001_core.sql):
 * web_visitors before web_events, import_runs before quarantine. Column names are the ones in
 * 0001_core.sql.
 */
import type { ImportRun, Seed } from './link'

export const MAX_ROWS_PER_INSERT = 250
/** D1's per-statement SQL length limit, in bytes (11 §Seed). */
export const MAX_STATEMENT_BYTES = 100_000

export type SqlValue = string | number | null

/** `NULL`, a finite number as written, or a single-quoted string with `'` doubled. */
export function sqlLiteral(value: SqlValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`sql: cannot write non-finite number ${value}`)
    return String(value)
  }
  if (value.includes('\0')) throw new Error('sql: string value contains a NUL byte')
  return `'${value.replace(/'/g, "''")}'`
}

const encoder = new TextEncoder()

/**
 * `INSERT INTO table (cols) VALUES (...),(...)` statements without the trailing `;`, each
 * with at most MAX_ROWS_PER_INSERT rows and under MAX_STATEMENT_BYTES.
 * A single row that cannot fit throws, naming the table.
 */
export function insertStatements(
  table: string,
  columns: readonly string[],
  rows: readonly SqlValue[][],
): string[] {
  const head = `INSERT INTO ${table} (${columns.join(', ')}) VALUES `
  const headBytes = encoder.encode(head).length
  const statements: string[] = []
  let tuples: string[] = []
  let bytes = headBytes

  const flush = () => {
    if (tuples.length > 0) statements.push(head + tuples.join(','))
    tuples = []
    bytes = headBytes
  }

  rows.forEach((row, i) => {
    if (row.length !== columns.length) {
      throw new Error(`sql: ${table} row ${i} has ${row.length} values for ${columns.length} columns`)
    }
    const tuple = `(${row.map(sqlLiteral).join(',')})`
    const tupleBytes = encoder.encode(tuple).length + 1 // + the separating comma
    if (headBytes + tupleBytes >= MAX_STATEMENT_BYTES) {
      throw new Error(`sql: ${table} row ${i} alone exceeds ${MAX_STATEMENT_BYTES} bytes`)
    }
    if (tuples.length === MAX_ROWS_PER_INSERT || bytes + tupleBytes >= MAX_STATEMENT_BYTES) flush()
    tuples.push(tuple)
    bytes += tupleBytes
  })
  flush()
  return statements
}

export interface SeedFile {
  /** File name under seed/. */
  name: '0001_subscribers.sql' | '0002_web.sql' | '0003_app.sql' | '0004_import_report.sql'
  statements: string[]
}

const PROFILE_COLUMNS = ['pkey', 'email_norm', 'kind', 'engagement_score', 'created_at'] as const

function profileRows(seed: Seed, kind: 'subscriber' | 'app_only'): SqlValue[][] {
  return seed.profiles
    .filter((p) => p.kind === kind)
    .map((p) => [p.pkey, p.email_norm, p.kind, p.engagement_score, p.created_at])
}

/** import_runs ids are 1..3 in Seed.runs order so quarantine rows can reference them. */
function reportStatements(runs: readonly ImportRun[], ranAt: string): string[] {
  const runRows = runs.map((r, i) => [
    i + 1,
    r.file,
    r.rows_in,
    r.rows_out,
    r.merged,
    r.quarantined.length,
    ranAt,
  ])
  const quarantineRows = runs.flatMap((r, i) =>
    r.quarantined.map((q): SqlValue[] => [i + 1, r.file, q.line_no, q.reason, q.raw_row]),
  )
  return [
    ...insertStatements(
      'import_runs',
      ['id', 'file', 'rows_in', 'rows_out', 'merged', 'quarantined', 'ran_at'],
      runRows,
    ),
    ...insertStatements('quarantine', ['run_id', 'file', 'line_no', 'reason', 'raw_row'], quarantineRows),
  ]
}

/**
 * The four seed files in execution order. `ranAt` is the ISO-8601 UTC time of the run,
 * supplied by the caller (this module has no clock).
 */
export function seedSql(seed: Seed, ranAt: string): SeedFile[] {
  return [
    {
      name: '0001_subscribers.sql',
      statements: [
        ...insertStatements('profiles', PROFILE_COLUMNS, profileRows(seed, 'subscriber')),
        ...insertStatements(
          'subscribers',
          [
            'email_norm',
            'email_raw',
            'signup_date',
            'status',
            'source',
            'last_open_date',
            'cold_since',
            'merged_count',
          ],
          seed.subscribers.map((s) => [
            s.email_norm,
            s.email_raw,
            s.signup_date,
            s.status,
            s.source,
            s.last_open_date,
            s.cold_since,
            s.merged_count,
          ]),
        ),
      ],
    },
    {
      name: '0002_web.sql',
      statements: [
        ...insertStatements(
          'web_visitors',
          ['visitor_id', 'visitor_hash', 'email_norm', 'first_seen_ts', 'first_page', 'first_utm_source'],
          seed.visitors.map((v) => [
            v.visitor_id,
            v.visitor_hash,
            v.email_norm,
            v.first_seen_ts,
            v.first_page,
            v.first_utm_source,
          ]),
        ),
        ...insertStatements(
          'web_events',
          ['id', 'visitor_id', 'page', 'event_ts', 'utm_source'],
          seed.events.map((e, i) => [i + 1, e.visitor_id, e.page, e.event_ts, e.utm_source]),
        ),
      ],
    },
    {
      name: '0003_app.sql',
      statements: [
        ...insertStatements(
          'app_users',
          ['user_id', 'email_norm', 'created_at', 'from_csv'],
          seed.app_users.map((u) => [u.user_id, u.email_norm, u.created_at, u.from_csv]),
        ),
        ...insertStatements('profiles', PROFILE_COLUMNS, profileRows(seed, 'app_only')),
      ],
    },
    { name: '0004_import_report.sql', statements: reportStatements(seed.runs, ranAt) },
  ]
}

/** A seed file's text: each statement followed by `;` and a line break. */
export function renderSqlFile(file: SeedFile): string {
  return file.statements.map((s) => `${s};\n`).join('')
}
