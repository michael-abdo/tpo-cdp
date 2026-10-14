// The source registry (09 D-63, 04 §GET /api/sources, 06 §Overview): the only home of each data
// source's id, plain name, kind, record unit and how it loads. GET /api/sources, the quarantine
// `file` filter and every screen that names a source read it; nothing else spells a source's name.
// The numbers about a source never live here: they come from import_runs, quarantine and app_events.

export interface SourceEntry {
  /** The stored id: import_runs.file / quarantine.file for a CSV, the table name for the webhook. */
  readonly id: string
  /** What people call it on screen (06 §UI principles 4). */
  readonly name: string
  /** `csv` = a file the seed script loads; `webhook` = events the app sends as they happen. */
  readonly kind: 'csv' | 'webhook'
  /** One record of this source, [one, many]; `many` is the API's `unit`. */
  readonly unit: readonly [string, string]
  /** How records arrive today: the CLI seed (11 §Seed) or POST /webhooks/app (04 §Webhook). */
  readonly loads_by: 'seed' | 'webhook'
  /** The file in data/ for a CSV source; null for the webhook. */
  readonly file: string | null
}

/** Registry order is the order every screen and GET /api/sources lists them in (08 T-SRC-1). */
export const SOURCES = [
  {
    id: 'subscribers',
    name: 'Newsletter list',
    kind: 'csv',
    unit: ['subscriber', 'subscribers'],
    loads_by: 'seed',
    file: 'subscribers.csv',
  },
  {
    id: 'web_events',
    name: 'Website visits',
    kind: 'csv',
    unit: ['page view', 'page views'],
    loads_by: 'seed',
    file: 'web_events.csv',
  },
  {
    id: 'app_users',
    name: 'App users',
    kind: 'csv',
    unit: ['app user', 'app users'],
    loads_by: 'seed',
    file: 'app_users.csv',
  },
  {
    id: 'app_events',
    name: 'App events',
    kind: 'webhook',
    unit: ['event', 'events'],
    loads_by: 'webhook',
    file: null,
  },
] as const satisfies readonly SourceEntry[]

/** Plain words for how a source loads, shown as "Loads by: …" in Technical details (06 §/ Overview). */
export const LOADS_BY_LABEL: Readonly<Record<SourceEntry['loads_by'], string>> = {
  seed: 'seed script',
  webhook: 'webhook',
}

export type Source = (typeof SOURCES)[number]
export type SourceId = Source['id']
/** The sources the seed loads from a file: the values of import_runs.file and quarantine.file. */
export type CsvSourceId = Extract<Source, { kind: 'csv' }>['id']

const BY_ID: ReadonlyMap<string, Source> = new Map(SOURCES.map((s) => [s.id, s]))

export function isSourceId(value: string): value is SourceId {
  return BY_ID.has(value)
}

/** The registry entry for an id; an id outside the registry is a bug, so it throws (fail loud). */
export function sourceById(id: string): Source {
  const source = BY_ID.get(id)
  if (source === undefined) throw new Error(`sources: "${id}" is not in the source registry`)
  return source
}
