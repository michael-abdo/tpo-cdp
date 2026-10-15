// Stores one validated app event. The event_id primary key makes the insert itself the dedupe,
// so two copies of one event racing in can never both be stored (a read-then-write check could).
//
// One D1 batch, which D1 runs as a single transaction, so a stored event never lacks its stub or
// its device mapping:
//   1. INSERT OR IGNORE app_events by event_id. A duplicate changes nothing: first write wins.
//   2. device_identity upsert (the device's most recent user), only when statement 1 inserted a
//      row (`changes() = 1`) and the event carries a user_id; it overwrites only when the
//      event_ts is not older than the stored last_seen_ts, so out-of-order arrival cannot
//      regress the mapping.
//   3–4. Unknown user_id → stub app_users(from_csv 0, email_norm NULL) + unknown_user_stub profile
//      (an unknown user is never dropped). Both read the stored row and are INSERT OR IGNORE, so they are
//      no-ops for known users, for a stub that already exists, and for a duplicate whose body
//      differs from the stored one.
//   5. The resolved user and profile, by the read-time identity rule (the
//      same joins as v_app_events in 0002_views.sql). They drive the score recompute below and are
//      returned to the caller; POST /webhooks/app does not put them in its public response.
// Then profiles.engagement_score is recomputed with DEFINITIONS and stored for every profile the
// event can change, so a new event shows in lookup and segments with no re-import: the resolved
// user's, and the device's previous owner's when
// the event carries a user_id, since the device_identity upsert can move that device's anonymous
// events away from them. The recompute runs after the batch has committed, so it can fail with
// the event stored; the sender then retries and gets a 200 duplicate. A duplicate therefore
// re-runs the recompute for the stored event, so a failed recompute heals on the retry: its resolved user, and when it carries
// a user_id every user with an event on its device (the previous owner is one of them, since
// device_identity is only ever written from app_events). The recompute is deterministic, so on a
// healthy store the re-run writes the scores already there.
// Nothing is cached: the next lookup or segment read sees the row.

import { daysBetween, DEFINITIONS } from '../../shared/derive'
import { pkeyForUnknownUser } from '../../shared/pseudonym'
import { resolveUserEvents } from '../identity/resolve'
import type { WebhookEvent } from './schema'

export type IngestResult =
  /** event_id was already stored; no event, stub or mapping was written; scores re-run. */
  | { duplicate: true }
  /** Stored. The user the event resolves to and that user's profile key; both null when unresolved. */
  | { duplicate: false; resolved: { user_id: string | null; pkey: string | null } }

interface ResolvedRow {
  user_id: string | null
  email_norm: string | null
  email_pkey: string | null
  /** The stored event's own user_id and device (for a duplicate: the first write's). */
  event_user_id: string | null
  device_id: string
}

/** Who a stored event resolves to, by the read-time identity rule; the caller adds the WHERE. */
const RESOLUTION_SQL = `SELECT COALESCE(e.user_id, d.user_id) AS user_id, u.email_norm, p.pkey AS email_pkey,
                e.user_id AS event_user_id, e.device_id
           FROM app_events e
           LEFT JOIN device_identity d ON e.user_id IS NULL AND d.device_id = e.device_id
           LEFT JOIN app_users u ON u.user_id = COALESCE(e.user_id, d.user_id)
           LEFT JOIN profiles p ON p.email_norm = u.email_norm`

/**
 * A retry of an event already stored, answered before any validation: true when one of
 * `eventIds` (as sent, and trimmed) is in app_events. Then nothing is written but the scores the
 * stored event can change, recomputed exactly as a duplicate through ingestEvent recomputes them,
 * so a failed recompute still heals on the retry. A body that would fail today's rules still gets
 * its 200 duplicate when its event_id was stored before those rules existed: the first write wins.
 */
export async function replayStoredEvent(db: D1Database, piiKeySecret: string, eventIds: readonly string[]): Promise<boolean> {
  if (eventIds.length === 0) return false
  const row = await db
    .prepare(`${RESOLUTION_SQL} WHERE e.event_id IN (${eventIds.map(() => '?').join(', ')}) ORDER BY e.event_id LIMIT 1`)
    .bind(...eventIds)
    .first<ResolvedRow>()
  if (row === null) return false
  await recomputeEngagement(db, piiKeySecret, await duplicateAffected(db, row))
  return true
}

/**
 * The score a new stub profile is created with: no email means no opens and no site visits, and
 * its one app event is the event that creates it. Device-stitched events are added by the
 * recompute that runs right after the batch.
 */
function stubFirstScore(eventTs: string): number {
  return DEFINITIONS.engagement_score.fn({
    last_open_date: null,
    app_events_last_30d: appEventInLast30d(eventTs) ? 1 : 0,
    site_visits_last_30d: 0,
  })
}

/**
 * Writes one event. `receivedAt` is the wall-clock arrival time (bookkeeping, not a business
 * date); it is the stored received_at and the created_at of any stub it creates.
 */
export async function ingestEvent(
  db: D1Database,
  piiKeySecret: string,
  event: WebhookEvent,
  receivedAt: string,
): Promise<IngestResult> {
  // The device's owner before this event; the upsert below may hand the device to someone else.
  const previousOwner =
    event.user_id === null
      ? null
      : await db
          .prepare('SELECT user_id FROM device_identity WHERE device_id = ?')
          .bind(event.device_id)
          .first<string>('user_id')

  const statements = [
    db
      .prepare(
        `INSERT OR IGNORE INTO app_events (event_id, event, user_id, device_id, event_ts, received_at, properties)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        event.event_id,
        event.event,
        event.user_id,
        event.device_id,
        event.timestamp,
        receivedAt,
        event.properties === null ? null : JSON.stringify(event.properties),
      ),
    // changes() still reports statement 1 here: no other write has run in between.
    db
      .prepare(
        `INSERT INTO device_identity (device_id, user_id, last_seen_ts)
         SELECT device_id, user_id, event_ts FROM app_events
          WHERE event_id = ?1 AND user_id IS NOT NULL AND changes() = 1
         ON CONFLICT (device_id) DO UPDATE SET user_id = excluded.user_id, last_seen_ts = excluded.last_seen_ts
          WHERE excluded.last_seen_ts >= device_identity.last_seen_ts`,
      )
      .bind(event.event_id),
  ]
  if (event.user_id !== null) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO app_users (user_id, email_norm, created_at, from_csv)
           SELECT user_id, NULL, received_at, 0 FROM app_events WHERE event_id = ?1 AND user_id = ?2`,
        )
        .bind(event.event_id, event.user_id),
      // INSERT ... ON CONFLICT, not INSERT OR IGNORE: a stub created on a database
      // that took webhooks before migration 0011 added profiles.user_id has that column NULL, so
      // IGNORE would leave it unhealed forever (its events would keep vanishing from v_app_events
      // at pkey NULL, with no error). The next event for the same user_id now heals it. The
      // WHERE on the DO UPDATE only ever matches that pre-0011 row: a healthy stub already has
      // user_id = excluded.user_id (a no-op write) and a non-stub profile cannot share this pkey.
      db
        .prepare(
          `INSERT INTO profiles (pkey, email_norm, user_id, kind, engagement_score, created_at)
           SELECT ?3, NULL, ?2, 'unknown_user_stub', ?4, e.received_at
             FROM app_events e JOIN app_users u ON u.user_id = e.user_id
            WHERE e.event_id = ?1 AND e.user_id = ?2 AND u.from_csv = 0 AND u.email_norm IS NULL
           ON CONFLICT (pkey) DO UPDATE SET user_id = excluded.user_id
            WHERE profiles.kind = 'unknown_user_stub' AND profiles.user_id IS NULL`,
        )
        .bind(
          event.event_id,
          event.user_id,
          await pkeyForUnknownUser(piiKeySecret, event.user_id),
          stubFirstScore(event.timestamp),
        ),
    )
  }
  statements.push(db.prepare(`${RESOLUTION_SQL} WHERE e.event_id = ?1`).bind(event.event_id))

  const results = await db.batch(statements)
  const inserted = results[0].meta.changes
  if (inserted !== 0 && inserted !== 1)
    throw new Error(`webhook ingest: the event insert changed ${inserted} rows`)

  const rows = results[results.length - 1].results as ResolvedRow[]
  if (rows.length !== 1)
    throw new Error(`webhook ingest: ${rows.length} resolution rows for the stored event`)

  if (inserted === 0) {
    await recomputeEngagement(db, piiKeySecret, await duplicateAffected(db, rows[0]))
    return { duplicate: true }
  }

  const resolved = { user_id: rows[0].user_id, pkey: await profileKey(db, piiKeySecret, rows[0]) }

  const affected = new Set<string>()
  if (resolved.user_id !== null) affected.add(resolved.user_id)
  if (previousOwner !== null) affected.add(previousOwner)
  await recomputeEngagement(db, piiKeySecret, affected)

  return { duplicate: false, resolved }
}

/**
 * The users whose scores the stored event could have changed when it was first written: its
 * resolved user, and for an event with a user_id every user with an event on its device.
 */
async function duplicateAffected(db: D1Database, row: ResolvedRow): Promise<Set<string>> {
  const affected = new Set<string>()
  if (row.user_id !== null) affected.add(row.user_id)
  if (row.event_user_id !== null) {
    const { results } = await db
      .prepare('SELECT DISTINCT user_id FROM app_events WHERE device_id = ? AND user_id IS NOT NULL')
      .bind(row.device_id)
      .all<{ user_id: string }>()
    for (const { user_id } of results) affected.add(user_id)
  }
  return affected
}

/** `TODAY − 30 .. TODAY` ("last N days"), the window of both 30-day score inputs. */
const SCORE_WINDOW = DEFINITIONS.last_n_days.fn(30)

/**
 * An app event counts toward app_events_last_30d when it is at most 30 days old; one newer than
 * TODAY counts as 0 days old (a live event is never thrown away), so only the window's start applies.
 */
function appEventInLast30d(eventTs: string): boolean {
  return daysBetween(SCORE_WINDOW.from, eventTs) >= 0
}

/** A site visit counts inside TODAY − 30 .. TODAY, the same test the seed applies (ingest/link.ts). */
function siteVisitInLast30d(eventTs: string): boolean {
  return daysBetween(SCORE_WINDOW.from, eventTs) >= 0 && daysBetween(eventTs, SCORE_WINDOW.to) >= 0
}

interface ScoreSubject {
  pkey: string
  last_open_date: string | null
  /** Every app user of the profile: the stub's one id, or each app_users row with its email. */
  user_ids: string[]
  /** event_ts of every web event of the profile's linked visitors. */
  web_event_ts: string[]
}

/** The stored inputs of one app user's profile. Fails loud on a user or profile that is missing. */
async function scoreSubject(db: D1Database, piiKeySecret: string, userId: string): Promise<ScoreSubject> {
  const user = await db
    .prepare(
      `SELECT u.email_norm, p.pkey AS email_pkey, s.last_open_date
         FROM app_users u
         LEFT JOIN profiles p ON p.email_norm = u.email_norm
         LEFT JOIN subscribers s ON s.email_norm = u.email_norm
        WHERE u.user_id = ?`,
    )
    .bind(userId)
    .first<{ email_norm: string | null; email_pkey: string | null; last_open_date: string | null }>()
  if (user === null) throw new Error('webhook ingest: an affected app user has no app_users row')
  if (user.email_norm === null) {
    return {
      pkey: await pkeyForUnknownUser(piiKeySecret, userId),
      last_open_date: null,
      user_ids: [userId],
      web_event_ts: [],
    }
  }
  if (user.email_pkey === null) throw new Error('webhook ingest: an app user with an email has no profile')
  const [users, web] = await db.batch([
    db.prepare('SELECT user_id FROM app_users WHERE email_norm = ? ORDER BY user_id').bind(user.email_norm),
    db
      .prepare(
        `SELECT we.event_ts FROM web_events we
           JOIN web_visitors wv ON wv.visitor_id = we.visitor_id
          WHERE wv.email_norm = ?`,
      )
      .bind(user.email_norm),
  ])
  return {
    pkey: user.email_pkey,
    last_open_date: user.last_open_date,
    user_ids: (users.results as { user_id: string }[]).map((r) => r.user_id),
    web_event_ts: (web.results as { event_ts: string }[]).map((r) => r.event_ts),
  }
}

/**
 * Recomputes engagement_score with DEFINITIONS for the profiles of `userIds` and stores it
 * (computed here, never in SQL). App events are counted through identity/resolve.ts, so direct and device-stitched
 * events count exactly as lookup shows them. Every UPDATE must hit its one profile row.
 */
async function recomputeEngagement(
  db: D1Database,
  piiKeySecret: string,
  userIds: ReadonlySet<string>,
): Promise<void> {
  const scores = new Map<string, number>()
  for (const userId of userIds) {
    const subject = await scoreSubject(db, piiKeySecret, userId)
    if (scores.has(subject.pkey)) continue
    let appEvents = 0
    for (const id of subject.user_ids) {
      for (const e of await resolveUserEvents(db, id)) if (appEventInLast30d(e.event_ts)) appEvents++
    }
    scores.set(
      subject.pkey,
      DEFINITIONS.engagement_score.fn({
        last_open_date: subject.last_open_date,
        app_events_last_30d: appEvents,
        site_visits_last_30d: subject.web_event_ts.filter(siteVisitInLast30d).length,
      }),
    )
  }
  if (scores.size === 0) return
  const updates = [...scores].map(([pkey, score]) =>
    db.prepare('UPDATE profiles SET engagement_score = ? WHERE pkey = ?').bind(score, pkey),
  )
  const results = await db.batch(updates)
  results.forEach((r, i) => {
    if (r.meta.changes !== 1)
      throw new Error(
        `webhook ingest: the score update for affected profile ${i + 1} changed ${r.meta.changes} rows`,
      )
  })
}

/** The profile key of a resolved user. Fails loud if a resolved user has no profile: every app user has one. */
async function profileKey(db: D1Database, piiKeySecret: string, row: ResolvedRow): Promise<string | null> {
  if (row.user_id === null) return null
  if (row.email_norm !== null) {
    if (row.email_pkey === null) throw new Error('webhook ingest: an app user with an email has no profile')
    return row.email_pkey
  }
  const pkey = await pkeyForUnknownUser(piiKeySecret, row.user_id)
  const stub = await db
    .prepare(`SELECT pkey FROM profiles WHERE pkey = ? AND kind = 'unknown_user_stub'`)
    .bind(pkey)
    .first<{ pkey: string }>()
  if (stub === null) throw new Error('webhook ingest: an app user without an email has no stub profile')
  return stub.pkey
}
