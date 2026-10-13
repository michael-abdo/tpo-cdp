/**
 * The seed pipeline's linking step (02 §Linking 1–3, §Derived; 09 D-08, D-44, D-46).
 * Pure apart from WebCrypto: three parsed CSVs and PII_KEY_SECRET in, every row the seed
 * writes out. Runs the existing per-file ingests, builds one profile per subscriber plus one
 * `app_only` profile per app email that is not a subscriber, and computes the stored derived
 * values with shared/derive.ts. scripts/csv2sql does the file I/O; sql.ts renders the SQL.
 */
import { daysBetween, DEFINITIONS } from '../../shared/derive'
import { pkeyForEmail, visitorHash } from '../../shared/pseudonym'
import { ingestApp, type AppUser } from './app'
import type { ParsedCsv } from './csv'
import { ingestSubscribers, type QuarantinedRow, type Subscriber } from './subscribers'
import { ingestWeb, type WebEvent, type WebVisitor } from './web'

export type ImportFile = 'subscribers' | 'web_events' | 'app_users'

export interface SeedCsvs {
  subscribers: ParsedCsv
  web_events: ParsedCsv
  app_users: ParsedCsv
}

export interface SubscriberRow extends Subscriber {
  /** Stored per 09 D-46. */
  cold_since: string
}

export interface ProfileRow {
  pkey: string
  email_norm: string
  kind: 'subscriber' | 'app_only'
  engagement_score: number
  /** 09 D-44: `signup_date` for a subscriber, the app `created_at` for an app-only profile. */
  created_at: string
}

export interface VisitorRow extends WebVisitor {
  visitor_hash: string
}

export interface ImportRun {
  file: ImportFile
  rows_in: number
  rows_out: number
  merged: number
  quarantined: QuarantinedRow[]
}

export interface Seed {
  subscribers: SubscriberRow[]
  /** Subscriber profiles first (subscriber order), then app-only profiles (app file order). */
  profiles: ProfileRow[]
  visitors: VisitorRow[]
  events: WebEvent[]
  app_users: AppUser[]
  /** One per file, in the order subscribers, web_events, app_users. */
  runs: ImportRun[]
  /** Distinct `/subscribe` emails with no subscriber: they get no profile (02 §Edge cases). */
  subscribe_emails_without_subscriber: number
}

function checkedRun(run: ImportRun): ImportRun {
  if (run.rows_in !== run.rows_out + run.merged + run.quarantined.length) {
    throw new Error(
      `${run.file}: rows_in ${run.rows_in} ≠ rows_out ${run.rows_out} + merged ${run.merged} + quarantined ${run.quarantined.length}`,
    )
  }
  return run
}

/** Web events in the last 30 days (`DEFINITIONS.last_n_days`) per linked email. */
function siteVisitsLast30d(
  events: readonly WebEvent[],
  visitors: ReadonlyMap<string, WebVisitor>,
): Map<string, number> {
  const window = DEFINITIONS.last_n_days.fn(30)
  const visits = new Map<string, number>()
  for (const event of events) {
    const email = visitors.get(event.visitor_id)?.email_norm ?? null
    if (email === null) continue
    if (daysBetween(window.from, event.event_ts) < 0 || daysBetween(event.event_ts, window.to) < 0) continue
    visits.set(email, (visits.get(email) ?? 0) + 1)
  }
  return visits
}

export async function buildSeed(csvs: SeedCsvs, secret: string): Promise<Seed> {
  const subs = ingestSubscribers(csvs.subscribers)
  const web = ingestWeb(csvs.web_events)
  const app = ingestApp(csvs.app_users)

  const subscribers: SubscriberRow[] = [...subs.subscribers.values()].map((s) => ({
    ...s,
    cold_since: DEFINITIONS.cold_since.fn(s.last_open_date, s.signup_date),
  }))

  const visits = siteVisitsLast30d(web.events, web.visitors)
  // App events only arrive by webhook, so every profile has 0 at seed (09 D-46).
  const score = (lastOpenDate: string | null, email: string) =>
    DEFINITIONS.engagement_score.fn({
      last_open_date: lastOpenDate,
      app_events_last_30d: 0,
      site_visits_last_30d: visits.get(email) ?? 0,
    })

  const profiles: ProfileRow[] = []
  for (const s of subscribers) {
    profiles.push({
      pkey: await pkeyForEmail(secret, s.email_norm),
      email_norm: s.email_norm,
      kind: 'subscriber',
      engagement_score: score(s.last_open_date, s.email_norm),
      created_at: s.signup_date,
    })
  }
  const appOnly = new Set<string>()
  for (const user of app.users.values()) {
    if (subs.subscribers.has(user.email_norm) || appOnly.has(user.email_norm)) continue
    appOnly.add(user.email_norm)
    profiles.push({
      pkey: await pkeyForEmail(secret, user.email_norm),
      email_norm: user.email_norm,
      kind: 'app_only',
      engagement_score: score(null, user.email_norm),
      created_at: user.created_at,
    })
  }

  const visitors: VisitorRow[] = []
  const unmatched = new Set<string>()
  for (const v of web.visitors.values()) {
    if (v.email_norm !== null && !subs.subscribers.has(v.email_norm)) unmatched.add(v.email_norm)
    visitors.push({ ...v, visitor_hash: await visitorHash(secret, v.visitor_id) })
  }

  const merged = subscribers.reduce((n, s) => n + s.merged_count - 1, 0)
  const runs = [
    checkedRun({
      file: 'subscribers',
      rows_in: csvs.subscribers.rows.length,
      rows_out: subscribers.length,
      merged,
      quarantined: subs.quarantined,
    }),
    checkedRun({
      file: 'web_events',
      rows_in: csvs.web_events.rows.length,
      rows_out: web.events.length,
      merged: 0,
      quarantined: web.quarantined,
    }),
    checkedRun({
      file: 'app_users',
      rows_in: csvs.app_users.rows.length,
      rows_out: app.users.size,
      merged: 0,
      quarantined: app.quarantined,
    }),
  ]

  return {
    subscribers,
    profiles,
    visitors,
    events: web.events,
    app_users: [...app.users.values()],
    runs,
    subscribe_emails_without_subscriber: unmatched.size,
  }
}
