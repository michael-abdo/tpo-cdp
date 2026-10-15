/**
 * The seed step: data/*.csv → seed/*.sql as literal-value SQL that
 * `wrangler d1 execute --file` loads after the migrations (`npm run db:seed:local`).
 *
 * Fail fast: every file is parsed and its header checked before anything is built, and a
 * missing PII_KEY_SECRET stops the run. Fail loud: per-file counts and every quarantine
 * reason (file line + reason, never the raw row, which may hold PII) are printed; any error
 * exits non-zero. The pipeline itself is pure (worker/ingest/link.ts, sql.ts); this file only
 * reads and writes files. PII_KEY_SECRET comes from the environment or, failing that, from
 * the one PII_KEY_SECRET line of .dev.vars; its value is never printed.
 *
 * import_runs.ran_at is the one wall-clock read here: it records when this script ran, which is
 * bookkeeping, not a business date (stamping it with TODAY would record a run that never
 * happened). Business dates use TODAY via shared/derive.ts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_COLUMNS } from '../worker/ingest/app'
import { parseCsv, type ParsedCsv } from '../worker/ingest/csv'
import { buildSeed, type SeedCsvs } from '../worker/ingest/link'
import { requireHeaders, SUBSCRIBER_COLUMNS } from '../worker/ingest/quarantine'
import { renderSqlFile, seedSql } from '../worker/ingest/sql'
import { WEB_COLUMNS } from '../worker/ingest/web'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SEED_DIR = join(ROOT, 'seed')
const SECRET_NAME = 'PII_KEY_SECRET'

const INPUTS: { key: keyof SeedCsvs; file: string; columns: readonly string[] }[] = [
  { key: 'subscribers', file: 'subscribers.csv', columns: SUBSCRIBER_COLUMNS },
  { key: 'web_events', file: 'web_events.csv', columns: WEB_COLUMNS },
  { key: 'app_users', file: 'app_users.csv', columns: APP_COLUMNS },
]

function readCsv(file: string, columns: readonly string[]): ParsedCsv {
  const path = join(ROOT, 'data', file)
  let parsed: ParsedCsv
  try {
    parsed = parseCsv(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`data/${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  requireHeaders(file, parsed.header, columns)
  return parsed
}

/** The secret from the environment, else the PII_KEY_SECRET line of .dev.vars only. */
function piiKeySecret(): string {
  const fromEnv = process.env[SECRET_NAME]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const path = join(ROOT, '.dev.vars')
  if (!existsSync(path)) throw new Error(`${SECRET_NAME} is not set and .dev.vars does not exist`)
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*PII_KEY_SECRET\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const value = match[1].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    if (value === '') break
    return value
  }
  throw new Error(`${SECRET_NAME} is not set in the environment or .dev.vars`)
}

async function main(): Promise<void> {
  const csvs = {} as SeedCsvs
  for (const input of INPUTS) csvs[input.key] = readCsv(input.file, input.columns)
  console.log('headers ok: subscribers.csv, web_events.csv, app_users.csv')

  const secret = piiKeySecret()
  const seed = await buildSeed(csvs, secret)
  // Wall clock for import_runs.ran_at only: when the seed ran, not a business date.
  const ranAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const files = seedSql(seed, ranAt)

  mkdirSync(SEED_DIR, { recursive: true })
  for (const stale of readdirSync(SEED_DIR).filter((f) => f.endsWith('.sql'))) rmSync(join(SEED_DIR, stale))
  for (const file of files) {
    writeFileSync(join(SEED_DIR, file.name), renderSqlFile(file))
    console.log(`wrote seed/${file.name} (${file.statements.length} statements)`)
  }

  for (const run of seed.runs) {
    console.log(
      `${run.file}: rows_in ${run.rows_in} · rows_out ${run.rows_out} · merged ${run.merged} · quarantined ${run.quarantined.length}`,
    )
    for (const q of run.quarantined) console.log(`  quarantined ${run.file} line ${q.line_no}: ${q.reason}`)
  }
  const byKind = (kind: string) => seed.profiles.filter((p) => p.kind === kind).length
  const linked = seed.visitors.filter((v) => v.email_norm !== null).length
  console.log(
    `tables: subscribers ${seed.subscribers.length} · profiles ${seed.profiles.length} ` +
      `(subscriber ${byKind('subscriber')}, app_only ${byKind('app_only')}) · web_visitors ${seed.visitors.length} ` +
      `(${linked} with a /subscribe email) · web_events ${seed.events.length} · app_users ${seed.app_users.length} · ` +
      `import_runs ${seed.runs.length}`,
  )
  console.log(
    `/subscribe emails with no subscriber (no profile): ${seed.subscribe_emails_without_subscriber}`,
  )
}

main().catch((err: unknown) => {
  console.error(`csv2sql failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
