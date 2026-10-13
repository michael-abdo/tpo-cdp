/**
 * `npm run tools:seed -- --local` | `--remote` (11 §Scripts): writes the scripts/tool-seeds.ts
 * rows into assistant_tools, idempotent by `name`, then reads the table back and fails unless
 * every seeded name is there. Run after the migrations.
 *
 * Fail safe: the target must be named; there is no default. --remote first requires the
 * database name (`cdp`) on stdin, like the other remote writes (11 §Reset). The insert never
 * overwrites or deletes a row. Fail loud: any wrangler failure exits non-zero naming the step.
 * Reads no secret.
 */
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { sqlLiteral } from '../worker/ingest/sql'
import { TOOL_SEEDS, toolSeedSql, toolSeedValues } from './tool-seeds'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DB = 'cdp'

type Target = '--local' | '--remote'

function target(argv: readonly string[]): Target {
  const args = argv.filter((a) => a === '--local' || a === '--remote')
  const unknown = argv.filter((a) => a !== '--local' && a !== '--remote')
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(' ')}; use --local or --remote`)
  if (args.length !== 1) throw new Error('name exactly one target: --local or --remote')
  return args[0] as Target
}

async function confirmRemote(): Promise<void> {
  process.stderr.write(`Type the database name (${DB}) to seed assistant_tools in the REMOTE database: `)
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

/** Runs one SQL command through wrangler with --json and returns the last statement's rows. */
function execute<T>(step: string, where: Target, sql: string): T[] {
  const res = spawnSync('npx', ['wrangler', 'd1', 'execute', DB, where, '--json', '--command', sql], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  })
  if (res.error) throw new Error(`${step}: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`${step}: wrangler exited with ${res.status ?? res.signal}: ${res.stdout}`)
  const start = res.stdout.indexOf('[')
  if (start < 0) throw new Error(`${step}: wrangler printed no JSON result`)
  const parsed = JSON.parse(res.stdout.slice(start)) as { results: T[]; success: boolean }[]
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((r) => r.success !== true)) {
    throw new Error(`${step}: a statement did not succeed`)
  }
  return parsed[parsed.length - 1].results
}

async function main(): Promise<void> {
  const where = target(process.argv.slice(2))
  if (where === '--remote') await confirmRemote()
  const before = new Set(execute<{ name: string }>('read existing rows', where, 'SELECT name FROM assistant_tools').map((r) => r.name))
  const sql = TOOL_SEEDS.map((seed) => toolSeedSql(toolSeedValues(seed, crypto.randomUUID()).map(sqlLiteral))).join(';\n')
  execute('insert tool rows', where, sql)
  const after = execute<{ name: string; handler_type: string; enabled: number; sort_order: number }>(
    'read back',
    where,
    'SELECT name, handler_type, enabled, sort_order FROM assistant_tools ORDER BY sort_order, name',
  )
  const names = new Set(after.map((r) => r.name))
  const missing = TOOL_SEEDS.filter((seed) => !names.has(seed.name)).map((seed) => seed.name)
  if (missing.length > 0) throw new Error(`read back: assistant_tools is missing ${missing.join(', ')}`)
  for (const seed of TOOL_SEEDS) {
    console.log(`${before.has(seed.name) ? 'kept    ' : 'inserted'} ${seed.name}`)
  }
  console.log(`assistant_tools now holds ${after.length} row(s): ${after.map((r) => `${r.name}(${r.handler_type}${r.enabled ? '' : ', disabled'})`).join(', ')}`)
}

main().catch((err: unknown) => {
  console.error(`tools:seed failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
