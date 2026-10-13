/**
 * Remote D1 seed and reset (11 §Scripts, §Seed, §Reset; 09 D-13). The only way to write the
 * production database in bulk: there is no destructive action in the hosted UI.
 *
 *   npm run db:seed:remote    → scripts/csv2sql.ts, then every seed/*.sql via
 *                               `wrangler d1 execute cdp --remote --file`
 *   npm run db:reset:remote   → drop every table and view, re-apply migrations, then seed
 *
 * Fail safe: both modes first require the database name (`cdp`) on stdin; anything else, or no
 * answer, aborts before any remote call. Seed refuses a database whose seeded tables already
 * hold rows (a second seed would collide on primary keys halfway through); reset is the way
 * to re-seed. Fail fast and loud: every wrangler or csv2sql failure stops the run and exits
 * non-zero naming the step. Secrets: PII_KEY_SECRET is read by csv2sql.ts (environment, else
 * the one line of .dev.vars); this file never reads or prints a secret.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SEED_DIR = join(ROOT, 'seed')
const DB = 'cdp'

type Mode = '--seed' | '--reset'

/** Reads one line from stdin and aborts unless it is the database name (11 §Reset). */
async function confirm(mode: Mode): Promise<void> {
  const action = mode === '--reset' ? 'DROP every table, re-migrate and re-seed' : 'seed'
  process.stderr.write(`Type the database name (${DB}) to ${action} the REMOTE database: `)
  const rl = createInterface({ input: process.stdin })
  const answer = await new Promise<string | null>((resolve) => {
    rl.once('line', (line) => resolve(line))
    rl.once('close', () => resolve(null))
  })
  rl.close()
  process.stderr.write('\n')
  if (answer === null) throw new Error('no confirmation on stdin; nothing was changed')
  if (answer.trim() !== DB) throw new Error(`confirmation did not match "${DB}"; nothing was changed`)
}

/** Runs a command with inherited output; throws naming the step on a non-zero exit. */
function run(step: string, cmd: string, args: string[]): void {
  console.log(`\n▶ ${step}`)
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
  if (res.error) throw new Error(`${step}: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`${step}: exited with ${res.status ?? res.signal}`)
}

/** Runs SQL remotely with --json; every statement must succeed; returns the last one's rows. */
function query<T>(step: string, sql: string): T[] {
  const res = spawnSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  })
  if (res.error) throw new Error(`${step}: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`${step}: exited with ${res.status ?? res.signal}: ${res.stdout}`)
  const start = res.stdout.indexOf('[')
  if (start < 0) throw new Error(`${step}: no JSON in wrangler output: ${res.stdout}`)
  const parsed = JSON.parse(res.stdout.slice(start)) as { results: T[]; success: boolean }[]
  if (parsed.length === 0 || parsed.some((r) => !r.success))
    throw new Error(`${step}: query failed: ${res.stdout}`)
  return parsed[parsed.length - 1].results
}

function seedFiles(): string[] {
  const files = readdirSync(SEED_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  if (files.length === 0) throw new Error('csv2sql wrote no seed/*.sql files')
  return files
}

/** Every table the seed files insert into, read from the files themselves. */
function seededTables(files: string[]): string[] {
  const tables = new Set<string>()
  for (const file of files) {
    for (const m of readFileSync(join(SEED_DIR, file), 'utf8').matchAll(/^INSERT INTO (\w+)/gm))
      tables.add(m[1])
  }
  if (tables.size === 0) throw new Error('seed/*.sql holds no INSERT statements')
  return [...tables].sort()
}

/** Row counts of the given tables in one statement (D1 rejects long compound SELECTs). */
function countRows(step: string, tables: string[]): { name: string; n: number }[] {
  const [row] = query<Record<string, number>>(
    step,
    `SELECT ${tables.map((t) => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(', ')}`,
  )
  return tables.map((name) => {
    const n = row[name]
    if (typeof n !== 'number') throw new Error(`${step}: no count for ${name}`)
    return { name, n }
  })
}

function seed(): void {
  run('csv2sql: data/*.csv → seed/*.sql', 'npx', ['tsx', 'scripts/csv2sql.ts'])
  const files = seedFiles()
  const tables = seededTables(files)
  const nonEmpty = countRows('check the seeded tables are empty', tables).filter((c) => c.n > 0)
  if (nonEmpty.length > 0) {
    throw new Error(
      `remote ${DB} already holds seed rows (${nonEmpty.map((c) => `${c.name} ${c.n}`).join(', ')}); ` +
        'use npm run db:reset:remote to re-seed',
    )
  }
  for (const file of files) {
    run(`execute seed/${file}`, 'npx', [
      'wrangler',
      'd1',
      'execute',
      DB,
      '--remote',
      '--yes',
      `--file=seed/${file}`,
    ])
  }
  const after = countRows('count the seeded tables', tables)
  console.log(`\nremote ${DB}: ${after.map((c) => `${c.name} ${c.n}`).join(' · ')}`)
}

function reset(): void {
  // Views first, then tables newest-first so a child table goes before the table it
  // references; foreign keys are deferred to the end of the batch as a second guard.
  // sqlite_* and D1's internal _cf_* tables cannot be dropped and are left alone.
  const objects = query<{ type: 'table' | 'view'; name: string }>(
    'list tables and views',
    "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view') " +
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' " +
      "ORDER BY type = 'table', rowid DESC",
  )
  if (objects.length > 0) {
    const drops = objects.map((o) => `DROP ${o.type === 'view' ? 'VIEW' : 'TABLE'} "${o.name}"`)
    query('drop every table and view', ['PRAGMA defer_foreign_keys = on', ...drops].join('; '))
    console.log(`dropped ${objects.length}: ${objects.map((o) => o.name).join(', ')}`)
  }
  const left = query<{ name: string }>(
    'check nothing is left',
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') " +
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
  )
  if (left.length > 0) throw new Error(`drop left ${left.map((o) => o.name).join(', ')}`)
  run('re-apply migrations', 'npx', ['wrangler', 'd1', 'migrations', 'apply', DB, '--remote'])
  seed()
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (mode !== '--seed' && mode !== '--reset')
    throw new Error('usage: tsx scripts/db-remote.ts --seed | --reset')
  await confirm(mode)
  if (mode === '--seed') seed()
  else reset()
  console.log(`\n${mode === '--seed' ? 'seed' : 'reset'} of remote ${DB} done`)
}

main().catch((err: unknown) => {
  console.error(`db-remote failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
