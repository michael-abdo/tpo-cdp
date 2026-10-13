// Stores one validated app event (03 §Other request flows, Webhook; 07 §A–C, §G).
// Origin: palisade app/api/webhooks/[provider]/route.ts L111-126 (14 §3.10, §7), dedupe intent only:
// the origin read then wrote; here the event_id primary key makes the insert itself the dedupe.
//
// One D1 batch, which D1 runs as a single transaction, so a stored event never lacks its stub or
// its device mapping:
//   1. INSERT OR IGNORE app_events by event_id (R4.8). A duplicate changes nothing: first write wins.
//   2. device_identity upsert (01 §Identity resolution, 09 D-43), only when statement 1 inserted a
//      row (`changes() = 1`, 07 §B) and the event carries a user_id; it overwrites only when the
//      event_ts is not older than the stored last_seen_ts, so out-of-order arrival (R4.7) cannot
//      regress the mapping.
//   3–4. Unknown user_id → stub app_users(from_csv 0, email_norm NULL) + unknown_user_stub profile
//      (02 §Linking 4, R4.6). Both read the stored row and are INSERT OR IGNORE, so they are
//      no-ops for known users, for a stub that already exists, and for a duplicate whose body
//      differs from the stored one.
//   5. The resolved user and profile for the response, by the read-time rule of 01 §Identity
//      resolution (the same joins as v_app_events in 0002_views.sql).
// Nothing is cached (03 §No-restart): the next lookup or segment read sees the row.

import { DEFINITIONS } from '../../shared/derive'
import { pkeyForUnknownUser } from '../../shared/pseudonym'
import type { WebhookEvent } from './schema'

export type IngestResult =
  /** event_id was already stored; nothing was written (R4.8). */
  | { duplicate: true }
  /** Stored. The user the event resolves to and that user's profile key; both null when unresolved. */
  | { duplicate: false; resolved: { user_id: string | null; pkey: string | null } }

interface ResolvedRow {
  user_id: string | null
  email_norm: string | null
  email_pkey: string | null
}

/**
 * A new stub profile's score: no email means no opens and no site visits, and app events are
 * not counted at creation, the same inputs the seed gives every profile (worker/ingest/link.ts).
 */
const STUB_ENGAGEMENT_SCORE = DEFINITIONS.engagement_score.fn({
  last_open_date: null,
  app_events_last_30d: 0,
  site_visits_last_30d: 0,
})

/**
 * Writes one event. `receivedAt` is the wall-clock arrival time (02 §Time allow-list); it is the
 * stored received_at and the created_at of any stub it creates (09 D-44).
 */
export async function ingestEvent(
  db: D1Database,
  piiKeySecret: string,
  event: WebhookEvent,
  receivedAt: string,
): Promise<IngestResult> {
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
      db
        .prepare(
          `INSERT OR IGNORE INTO profiles (pkey, email_norm, kind, engagement_score, created_at)
           SELECT ?3, NULL, 'unknown_user_stub', ?4, e.received_at
             FROM app_events e JOIN app_users u ON u.user_id = e.user_id
            WHERE e.event_id = ?1 AND e.user_id = ?2 AND u.from_csv = 0 AND u.email_norm IS NULL`,
        )
        .bind(
          event.event_id,
          event.user_id,
          await pkeyForUnknownUser(piiKeySecret, event.user_id),
          STUB_ENGAGEMENT_SCORE,
        ),
    )
  }
  statements.push(
    db
      .prepare(
        `SELECT COALESCE(e.user_id, d.user_id) AS user_id, u.email_norm, p.pkey AS email_pkey
           FROM app_events e
           LEFT JOIN device_identity d ON e.user_id IS NULL AND d.device_id = e.device_id
           LEFT JOIN app_users u ON u.user_id = COALESCE(e.user_id, d.user_id)
           LEFT JOIN profiles p ON p.email_norm = u.email_norm
          WHERE e.event_id = ?1`,
      )
      .bind(event.event_id),
  )

  const results = await db.batch(statements)
  const inserted = results[0].meta.changes
  if (inserted !== 0 && inserted !== 1)
    throw new Error(`webhook ingest: the event insert changed ${inserted} rows`)
  if (inserted === 0) return { duplicate: true }

  const rows = results[results.length - 1].results as ResolvedRow[]
  if (rows.length !== 1)
    throw new Error(`webhook ingest: ${rows.length} resolution rows for the stored event`)
  return {
    duplicate: false,
    resolved: { user_id: rows[0].user_id, pkey: await profileKey(db, piiKeySecret, rows[0]) },
  }
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
