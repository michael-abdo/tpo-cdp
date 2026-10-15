/// <reference types="vite/client" />
import { env } from 'cloudflare:test'
import appCsv from '../../data/app_users.csv?raw'
import subscribersCsv from '../../data/subscribers.csv?raw'
import webCsv from '../../data/web_events.csv?raw'
import { parseCsv } from '../../worker/ingest/csv'
import { buildSeed, type Seed, type SeedCsvs } from '../../worker/ingest/link'
import { seedSql, type SeedFile } from '../../worker/ingest/sql'

// Loads the three real data/*.csv files into the test D1 (migrations applied by test/setup.ts)
// through the production pipeline: parseCsv → buildSeed → seedSql, the same path
// scripts/csv2sql.ts takes. Storage is isolated per test file, so each file that
// needs data calls seedDatabase() in beforeAll; repeat calls in one file reuse the first load.

export interface SeededDb {
  seed: Seed
  files: SeedFile[]
  /** import_runs.ran_at of this load. */
  ranAt: string
}

/** PII_KEY_SECRET from .dev.vars; the value is never printed. */
export function piiKeySecret(): string {
  const value = env.PII_KEY_SECRET
  if (!value) throw new Error('PII_KEY_SECRET missing from .dev.vars; the test cannot run')
  return value
}

/** The three real CSVs, freshly parsed (callers may make minimal edits to their copies). */
export function realCsvs(): SeedCsvs {
  return { subscribers: parseCsv(subscribersCsv), web_events: parseCsv(webCsv), app_users: parseCsv(appCsv) }
}

let loaded: Promise<SeededDb> | undefined

async function load(): Promise<SeededDb> {
  const existing = await env.DB.prepare('SELECT count(*) AS n FROM import_runs').first<number>('n')
  if (existing !== 0)
    throw new Error(`seed helper: import_runs already holds ${existing} rows; refusing to seed twice`)
  const seed = await buildSeed(realCsvs(), piiKeySecret())
  // import_runs.ran_at is the wall-clock time the seed ran (one of the few wall-clock reads); the
  // helper stands in for the seed script, so it takes the clock the same way.
  const ranAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const files = seedSql(seed, ranAt)
  for (const file of files) {
    await env.DB.batch(file.statements.map((s) => env.DB.prepare(s)))
  }
  return { seed, files, ranAt }
}

export async function seedDatabase(): Promise<SeededDb> {
  loaded ??= load()
  const seeded = await loaded
  const subscribers = await env.DB.prepare('SELECT count(*) AS n FROM subscribers').first<number>('n')
  if (subscribers === 0) {
    throw new Error('seed helper: the database was emptied after seeding (storage is per test file)')
  }
  return seeded
}
