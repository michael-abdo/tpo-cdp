/**
 * `npm run tools:seed -- --local` | `--remote` [`--update <name>[,<name>…]`]: writes
 * the scripts/tool-seeds.ts rows into assistant_tools, idempotent by `name`, then reads the table
 * back and fails unless every seeded name is there and every seeded row equals its seed
 * (description, input_schema, handler_type, execution_config). Run after the migrations.
 *
 * Fail safe: the target must be named; there is no default. --remote first requires the
 * database name (`cdp`) on stdin, like the other remote writes (scripts/db-remote.ts). The insert never
 * overwrites or deletes a row; only `--update` overwrites, and only the rows it names (their
 * seeded columns; `enabled` and `sort_order` stay). Fail loud: any wrangler failure exits
 * non-zero naming the step, and so does a seeded row that differs from its seed, naming the row,
 * its fields and the `--update` command, so a schema change (new keys on the `segment` row) can
 * never stay behind silently. Reads no secret.
 */
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { sqlLiteral } from '../worker/ingest/sql'
import { type StoredToolRow, staleToolRows, TOOL_SEEDS, toolSeedSql, toolSeedUpdateSql, toolSeedUpdateValues, toolSeedValues } from './tool-seeds'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DB = 'cdp'

type Target = '--local' | '--remote'

interface Args {
  where: Target
  /** Seeded rows to overwrite with their seed (`--update a,b` or `--update a --update b`). */
  update: string[]
}

function parseArgs(argv: readonly string[]): Args {
  const targets: Target[] = []
  const update: string[] = []
  const unknown: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--local' || a === '--remote') targets.push(a)
    else if (a === '--update') {
      const names = argv[i + 1]
      if (names === undefined || names.startsWith('--')) throw new Error('--update needs a tool name, e.g. --update segment')
      update.push(...names.split(',').map((n) => n.trim()).filter((n) => n !== ''))
      i++
    } else unknown.push(a)
  }
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(' ')}; use --local or --remote, optionally --update <name>`)
  if (targets.length !== 1) throw new Error('name exactly one target: --local or --remote')
  const seeded = new Set(TOOL_SEEDS.map((seed) => seed.name))
  const notSeeded = update.filter((n) => !seeded.has(n))
  if (notSeeded.length > 0) throw new Error(`--update names no seeded tool: ${notSeeded.join(', ')}; seeded: ${[...seeded].join(', ')}`)
  return { where: targets[0], update: [...new Set(update)] }
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
  const { where, update } = parseArgs(process.argv.slice(2))
  if (where === '--remote') await confirmRemote()
  const before = new Set(execute<{ name: string }>('read existing rows', where, 'SELECT name FROM assistant_tools').map((r) => r.name))
  const sql = TOOL_SEEDS.map((seed) => toolSeedSql(toolSeedValues(seed, crypto.randomUUID()).map(sqlLiteral))).join(';\n')
  execute('insert tool rows', where, sql)
  if (update.length > 0) {
    const updates = TOOL_SEEDS.filter((seed) => update.includes(seed.name)).map((seed) => toolSeedUpdateSql(toolSeedUpdateValues(seed).map(sqlLiteral)))
    execute('update tool rows', where, updates.join(';\n'))
  }
  const after = execute<StoredToolRow & { handler_type: string; enabled: number; sort_order: number }>(
    'read back',
    where,
    'SELECT name, description, input_schema, handler_type, execution_config, enabled, sort_order FROM assistant_tools ORDER BY sort_order, name',
  )
  const names = new Set(after.map((r) => r.name))
  const missing = TOOL_SEEDS.filter((seed) => !names.has(seed.name)).map((seed) => seed.name)
  if (missing.length > 0) throw new Error(`read back: assistant_tools is missing ${missing.join(', ')}`)
  const stale = staleToolRows(after)
  if (stale.length > 0) {
    const rows = stale.map((r) => `${r.name} (${r.fields.join(', ')})`).join('; ')
    throw new Error(
      `read back: assistant_tools row(s) differ from scripts/tool-seeds.ts: ${rows}. ` +
        `The insert never overwrites a row; to replace them with the seed run: npm run tools:seed -- ${where} --update ${stale.map((r) => r.name).join(',')}`,
    )
  }
  for (const seed of TOOL_SEEDS) {
    console.log(`${!before.has(seed.name) ? 'inserted' : update.includes(seed.name) ? 'updated ' : 'kept    '} ${seed.name}`)
  }
  console.log(`assistant_tools now holds ${after.length} row(s): ${after.map((r) => `${r.name}(${r.handler_type}${r.enabled ? '' : ', disabled'})`).join(', ')}`)
  console.log('every seeded row equals scripts/tool-seeds.ts')
}

main().catch((err: unknown) => {
  console.error(`tools:seed failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
