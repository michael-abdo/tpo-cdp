// The PII-free view schema the model is told about: one sqlite_master query plus PRAGMA
// table_info per view. Only `v_*` views are listed, never a table.
//
// Cached per isolate: the column list changes only with a migration, which is a deploy. The cache
// holds names and types only, never data, so new events still show up without a restart and
// lookup and segments are unaffected.

import { PII_COLUMNS } from '../../shared/pii'

export interface ViewColumn {
  name: string
  /** The declared type SQLite reports for the view column; '' for a computed expression. */
  type: string
}

export interface ViewSchema {
  name: string
  columns: readonly ViewColumn[]
}

const VIEW_NAME = /^v_[a-z_]+$/
const PII = new Set<string>(PII_COLUMNS)

let cached: Promise<readonly ViewSchema[]> | undefined

/** One uncached discovery: every `v_*` view's columns, refusing any view that selects a PII column. */
export async function discoverViewSchemas(db: D1Database): Promise<readonly ViewSchema[]> {
  const { results: views } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'v\\_%' ESCAPE '\\' ORDER BY name")
    .all<{ name: string }>()
  if (views.length === 0) throw new Error('schema-context: no v_* views exist; migrations/0002_views.sql has not been applied')
  const schemas: ViewSchema[] = []
  for (const { name } of views) {
    // PRAGMA takes no bound parameters; the name is checked against a strict pattern first.
    if (!VIEW_NAME.test(name)) throw new Error(`schema-context: unexpected view name ${JSON.stringify(name)}`)
    const { results } = await db.prepare(`PRAGMA table_info(${name})`).all<{ name: string; type: string }>()
    if (results.length === 0) throw new Error(`schema-context: PRAGMA table_info(${name}) returned no columns`)
    const leaked = results.filter((column) => PII.has(column.name)).map((column) => column.name)
    // T-PII-2 tests the same rule; this is the runtime refusal, so a bad view can never reach a prompt.
    if (leaked.length > 0) throw new Error(`schema-context: view ${name} selects PII column(s) ${leaked.join(', ')}`)
    schemas.push({ name, columns: results.map((column) => ({ name: column.name, type: column.type })) })
  }
  return schemas
}

/**
 * The `v_*` views and their columns, discovered on the first call in this isolate and reused
 * after. A failed discovery is not cached: the next call tries again.
 */
export function viewSchemas(db: D1Database): Promise<readonly ViewSchema[]> {
  if (cached === undefined) {
    cached = discoverViewSchemas(db)
    // Not a swallow: the caller awaits `cached` and gets the rejection; this only clears the slot.
    cached.catch(() => {
      cached = undefined
    })
  }
  return cached
}
