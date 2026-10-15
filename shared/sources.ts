// The source registry: the only home of each data
// source's id, plain name, kind, record unit and how it loads. GET /api/sources, the quarantine
// `file` filter and every screen that names a source read it; nothing else spells a source's name.
// The numbers about a source never live here: they come from import_runs, quarantine and app_events.
// Each entry also declares its checks: what GET /api/sources counts for it and Overview shows as
// Status chips and tabs, so a problem shows up next to the source it came from. The check kinds
// are glossary keys, so each chip finds its words.

/**
 * The checks a source can declare, in the order chips and tabs list them:
 * - rows_to_fix: rows the newest sync set aside that a person can fix (quarantine, every reason but
 *   blank_row). Every CSV source declares it, so a fixable row in any file reaches a screen;
 * - possible_duplicates: scored pairs in the review or auto band with no decision yet (nothing
 *   merges on its own, so both bands need a person).
 */
export const CHECK_KINDS = ['rows_to_fix', 'possible_duplicates'] as const
export type CheckKind = (typeof CHECK_KINDS)[number]

export interface SourceEntry {
  /** The stored id: import_runs.file / quarantine.file for a CSV, the table name for the webhook. */
  readonly id: string
  /** What people call it on screen: the brief's own word for it. */
  readonly name: string
  /** `csv` = a file the seed script loads; `webhook` = events the app sends as they happen. */
  readonly kind: 'csv' | 'webhook'
  /** One record of this source, [one, many]; `many` is the API's `unit`. */
  readonly unit: readonly [string, string]
  /** How records arrive today: the CLI seed (scripts/csv2sql.ts) or POST /webhooks/app. */
  readonly loads_by: 'seed' | 'webhook'
  /** The file in data/ for a CSV source; null for the webhook. */
  readonly file: string | null
  /** The checks GET /api/sources counts for this source, in CHECK_KINDS order. */
  readonly checks: readonly CheckKind[]
}

/** Registry order is the order every screen and GET /api/sources lists them in (08 T-SRC-1). */
export const SOURCES = [
  {
    id: 'subscribers',
    name: 'beehiiv',
    kind: 'csv',
    unit: ['subscriber', 'subscribers'],
    loads_by: 'seed',
    file: 'subscribers.csv',
    checks: ['rows_to_fix', 'possible_duplicates'],
  },
  {
    id: 'web_events',
    name: 'Website',
    kind: 'csv',
    unit: ['website visit', 'website visits'],
    loads_by: 'seed',
    file: 'web_events.csv',
    checks: ['rows_to_fix'],
  },
  {
    id: 'app_users',
    name: 'App accounts',
    kind: 'csv',
    unit: ['app account', 'app accounts'],
    loads_by: 'seed',
    file: 'app_users.csv',
    checks: ['rows_to_fix'],
  },
  {
    id: 'app_events',
    name: 'App events',
    kind: 'webhook',
    unit: ['event', 'events'],
    loads_by: 'webhook',
    file: null,
    checks: [],
  },
] as const satisfies readonly SourceEntry[]

/** Plain words for how a source loads, shown as "Loads by: …" in Technical details on Overview. */
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

/**
 * Which sources get the gated "Automatic daily sync" switch (a coming-soon feature): beehiiv and
 * App accounts. GA4 can't carry an email, so a Website/GA4 pull would break site-visit linking;
 * Website keeps Upload only. Kept here, the one home of source ids (T-SRC-2: Overview spells no
 * source id as a literal), not in OverviewPage.tsx.
 */
export const DAILY_SYNC_SOURCE_IDS: readonly SourceId[] = ['subscribers', 'app_users']

/** The registry entry for an id; an id outside the registry is a bug, so it throws (fail loud). */
export function sourceById(id: string): Source {
  const source = BY_ID.get(id)
  if (source === undefined) throw new Error(`sources: "${id}" is not in the source registry`)
  return source
}
