import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { TOOL_SEEDS, toolSeedInsert } from '../scripts/tool-seeds'
import { PII_COLUMNS } from '../shared/pii'
import { startTrace } from '../worker/assistant/audit/ai-audit'
import { findPII, loadKnownEmails } from '../worker/assistant/gates/pii-guard'
import { DESCRIBE_SCHEMA_COLUMNS } from '../worker/assistant/tools/builtin-handlers'
import { executeToolCall } from '../worker/assistant/tools/tool-executor'
import { loadTools } from '../worker/assistant/tools/tool-loader'
import { seedDatabase } from './helpers/seed'

// describe_schema (16 §If time remains item 1; 14 §4.2 draft; 03 §Gateway layers rows 3, 9; 05
// §What the model receives). Inputs: the seeded D1 (data/*.csv via test/helpers/seed.ts, so the
// views have rows the tool must not return) and the assistant_tools rows of scripts/tool-seeds.ts.
// The expected views and columns are read from sqlite_master and PRAGMA here, independently of
// schema-context.ts. The one bad input is `profiles`, a real table name, which the tool must refuse.

const PKEY_VALUE = /pk_[0-9a-f]{16}/

let expected: Map<string, { name: string; type: string }[]>

beforeAll(async () => {
  await seedDatabase()
  for (const seed of TOOL_SEEDS) {
    const { sql, params } = toolSeedInsert(seed)
    await env.DB.prepare(sql).bind(...params).run()
  }
  const { results: views } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name").all<{ name: string }>()
  expected = new Map()
  for (const { name } of views) {
    if (!name.startsWith('v_')) continue
    const { results } = await env.DB.prepare(`PRAGMA table_info(${name})`).all<{ name: string; type: string }>()
    expected.set(name, results.map((c) => ({ name: c.name, type: c.type })))
  }
})

async function run(input: unknown) {
  const trace = await startTrace(env.DB)
  const executed = await executeToolCall({ db: env.DB, trace, tools: await loadTools(env.DB) }, { id: 'toolu_describe_schema', name: 'describe_schema', input })
  const { results: audit } = await env.DB.prepare('SELECT kind, status, tool_name, sql, row_count, error FROM ai_audit WHERE trace_id = ? ORDER BY created_at, rowid')
    .bind(trace.traceId)
    .all<{ kind: string; status: string; tool_name: string | null; sql: string | null; row_count: number | null; error: string | null }>()
  return { executed, audit }
}

describe('describe_schema: v_* view names and PRAGMA columns only (16 parked item 1)', () => {
  it('loads from its assistant_tools row as a builtin, verbatim', async () => {
    const seed = TOOL_SEEDS.find((s) => s.name === 'describe_schema')!
    const loaded = (await loadTools(env.DB)).byName.get('describe_schema')
    expect(loaded?.handlerType).toBe('builtin')
    expect(loaded?.handlerName).toBe('describe_schema')
    expect(loaded?.definition).toEqual({ name: 'describe_schema', description: seed.description, input_schema: seed.inputSchema })
  })

  it('returns every v_* view and exactly its PRAGMA columns, no table, no PII column, no row, and passes the scanner', async () => {
    expect(expected.size).toBeGreaterThan(0)
    const { executed, audit } = await run({})
    const output = executed.output!
    expect(executed.result.is_error).toBeUndefined()
    expect(output.columns).toEqual([...DESCRIBE_SCHEMA_COLUMNS])

    const names = [...new Set(output.rows.map((r) => r.view as string))]
    expect(names.every((n) => n.startsWith('v_'))).toBe(true)
    expect(names.sort()).toEqual([...expected.keys()].sort())
    const content = executed.result.content as string
    // The model sees only the first rows of the table (format-results.ts MODEL_ROW_CAP), so the
    // summary carries every view's full column list: it must be the PRAGMA columns, in order.
    expect(Object.keys(output.summary.views as Record<string, string[]>).sort()).toEqual([...expected.keys()].sort())
    // The whole output shape is pinned, so no extra key (e.g. sample rows of a view) can ride along.
    expect(Object.keys(output).sort()).toEqual(['columns', 'rows', 'summary', 'tool', 'total_rows'])
    expect(Object.keys(output.summary).sort()).toEqual(['note', 'views'])
    for (const [view, columns] of expected) {
      expect(output.rows.filter((r) => r.view === view).map((r) => ({ name: r.column, type: r.type }))).toEqual(columns)
      const described = columns.map((c) => (c.type === '' ? c.name : `${c.name} ${c.type}`))
      expect((output.summary.views as Record<string, string[]>)[view]).toEqual(described)
      // ...and the string the model receives names every one of them.
      for (const entry of described) expect(content).toContain(JSON.stringify(entry))
    }
    expect(output.rows.some((r) => (PII_COLUMNS as readonly string[]).includes(r.column as string))).toBe(false)

    // No row of any view: the seeded views hold pk_ keys, and none appears anywhere in the result.
    expect(PKEY_VALUE.test(content)).toBe(false)
    expect(PKEY_VALUE.test(JSON.stringify(output.rows))).toBe(false)
    const known = await loadKnownEmails(env.DB)
    expect(findPII(content, known)).toBeNull()
    expect(findPII({ rows: output.rows, summary: output.summary }, known)).toBeNull()

    expect(audit).toEqual([{ kind: 'tool_call', status: 'success', tool_name: 'describe_schema', sql: null, row_count: output.rows.length, error: null }])
  })

  it('describes one view when named', async () => {
    const { executed } = await run({ view: 'v_profiles' })
    expect(new Set(executed.output!.rows.map((r) => r.view))).toEqual(new Set(['v_profiles']))
    expect(executed.output!.rows.map((r) => r.column)).toEqual(expected.get('v_profiles')!.map((c) => c.name))
  })

  it('refuses a table name back to the model as invalid_input, listing only the v_* views', async () => {
    const { executed, audit } = await run({ view: 'profiles' })
    expect(executed.output).toBeNull()
    expect(executed.result.is_error).toBe(true)
    expect(executed.result.content).toContain(`view must be one of ${[...expected.keys()].join(', ')}`)
    // The refusal never repeats what the model sent (`v_profiles` has no word boundary before `profiles`).
    expect(executed.result.content).not.toMatch(/\bprofiles\b/)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ kind: 'tool_call', status: 'error', tool_name: 'describe_schema' })
    expect(audit[0].error).toMatch(/^invalid_input: /)
  })

  it('refuses a part of a view name: only an exact v_* name selects a view', async () => {
    for (const view of ['v_', 'v_prof']) {
      const { executed } = await run({ view })
      expect(executed.output).toBeNull()
      expect(executed.result.is_error).toBe(true)
      expect(executed.result.content).toContain(`view must be one of ${[...expected.keys()].join(', ')}`)
    }
  })
})
