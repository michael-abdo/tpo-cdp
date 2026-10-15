/**
 * Read-time identity resolution for app events. Nothing here writes or caches: every call reads
 * D1, so a new event shows up with no restart, and the webhook never rewrites a stored event to
 * name its user. An identified event updates device_identity; anonymous events on that device
 * then resolve through it on the next read, in either arrival order (anonymous first or login
 * first), with no replay.
 *
 * - `direct`: the event carries the user_id.
 * - `login_stitch` (the UI's "stitched" tag): the event is anonymous (user_id NULL) and its
 *   device's device_identity row names a user, the device's most recent user by event_ts (not
 *   arrival order, so a late event cannot roll the mapping back), whether that user's identified
 *   event is earlier or later than this one. A device shared by several users gives all its
 *   anonymous events to that one user: the simplest rule that stitches a login in either order,
 *   with the shared-device miss stated rather than engineered around.
 * - unresolved (`null`, feed only): anonymous, on a device no identified event has named yet.
 */

import { pkeyForUnknownUser } from '../../shared/pseudonym'

export type AttachedVia = 'direct' | 'login_stitch'

export interface ResolvedAppEvent {
  event_id: string
  event: string
  device_id: string
  event_ts: string
  /** The stored properties JSON, parsed; `null` when the event had none. */
  properties: unknown
  attached_via: AttachedVia
}

interface AppEventRow {
  event_id: string
  event: string
  device_id: string
  event_ts: string
  properties: string | null
  attached_via: AttachedVia
}

/** Every app event that resolves to `userId`, ordered by event_ts (event_id breaks ties). */
export async function resolveUserEvents(db: D1Database, userId: string): Promise<ResolvedAppEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT event_id, event, device_id, event_ts, properties, 'direct' AS attached_via
         FROM app_events
        WHERE user_id = ?1
       UNION ALL
       SELECT e.event_id, e.event, e.device_id, e.event_ts, e.properties, 'login_stitch' AS attached_via
         FROM app_events e
         JOIN device_identity d ON d.device_id = e.device_id
        WHERE e.user_id IS NULL AND d.user_id = ?1
       ORDER BY event_ts, event_id`,
    )
    .bind(userId)
    .all<AppEventRow>()
  return results.map((row) => ({
    event_id: row.event_id,
    event: row.event,
    device_id: row.device_id,
    event_ts: row.event_ts,
    properties: row.properties === null ? null : JSON.parse(row.properties),
    attached_via: row.attached_via,
  }))
}

/** Distinct device ids seen with `userId`: on its own events, and where it is the device's most recent user. */
export async function devicesForUser(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT device_id FROM app_events WHERE user_id = ?1
       UNION
       SELECT device_id FROM device_identity WHERE user_id = ?1
       ORDER BY device_id`,
    )
    .bind(userId)
    .all<{ device_id: string }>()
  return results.map((row) => row.device_id)
}

/** One row of the recent-events feed (GET /api/events/recent), resolved by the rule above. */
export interface FeedEvent {
  event_id: string
  event: string
  device_id: string
  event_ts: string
  received_at: string
  /** The event's own user_id, else its device's most recent user; null when unresolved. */
  user_id: string | null
  /** null when the event resolves to no user (shown as "anonymous device"). */
  attached_via: AttachedVia | null
  /** The resolved user's profile key: the email profile, or the unknown user's stub. */
  pkey: string | null
  /** The resolved profile's email; null for an unresolved event or an unknown user's stub. */
  email: string | null
}

interface FeedRow {
  event_id: string
  event: string
  device_id: string
  event_ts: string
  received_at: string
  user_id: string | null
  attached_via: AttachedVia | null
  email_norm: string | null
  email_pkey: string | null
  user_known: number
}

function stubKey(stubKeys: ReadonlyMap<string, string>, userId: string): string {
  const key = stubKeys.get(userId)
  if (key === undefined) throw new Error('events feed: a stub key was not derived for a resolved unknown user')
  return key
}

/**
 * The resolution join shared by recentEvents and feedEventById (one home, so the two never differ): `where`
 * is a SQL fragment over `e`/`d`/`u`/`p` and `params` its bound values, in order, before `limit`.
 * An unknown user's stub key is derived with PII_KEY_SECRET and must exist; a
 * resolved user without an app_users row or a profile fails loud, since ingest always writes both.
 */
async function feedRows(
  db: D1Database,
  piiKeySecret: string,
  where: string,
  params: readonly unknown[],
  limit: number,
): Promise<FeedEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT e.event_id, e.event, e.device_id, e.event_ts, e.received_at,
              COALESCE(e.user_id, d.user_id) AS user_id,
              CASE WHEN e.user_id IS NOT NULL THEN 'direct'
                   WHEN d.user_id IS NOT NULL THEN 'login_stitch' END AS attached_via,
              u.email_norm, p.pkey AS email_pkey, u.user_id IS NOT NULL AS user_known
         FROM app_events e
         LEFT JOIN device_identity d ON e.user_id IS NULL AND d.device_id = e.device_id
         LEFT JOIN app_users u ON u.user_id = COALESCE(e.user_id, d.user_id)
         LEFT JOIN profiles p ON p.email_norm = u.email_norm
        WHERE ${where}
        ORDER BY e.received_at DESC, e.rowid DESC
        LIMIT ?`,
    )
    .bind(...params, limit)
    .all<FeedRow>()

  const stubKeys = new Map<string, string>()
  for (const row of results) {
    if (row.user_id === null) continue
    if (row.user_known !== 1) throw new Error('events feed: a resolved user has no app_users row')
    if (row.email_norm !== null) {
      if (row.email_pkey === null) throw new Error('events feed: an app user with an email has no profile')
    } else if (!stubKeys.has(row.user_id)) {
      stubKeys.set(row.user_id, await pkeyForUnknownUser(piiKeySecret, row.user_id))
    }
  }
  if (stubKeys.size > 0) {
    const keys = [...new Set(stubKeys.values())]
    const { results: found } = await db
      .prepare(
        `SELECT pkey FROM profiles WHERE kind = 'unknown_user_stub' AND pkey IN (${keys.map((_, i) => `?${i + 1}`).join(', ')})`,
      )
      .bind(...keys)
      .all<{ pkey: string }>()
    if (found.length !== keys.length)
      throw new Error(`events feed: ${keys.length - found.length} unknown users have no stub profile`)
  }

  return results.map((row) => ({
    event_id: row.event_id,
    event: row.event,
    device_id: row.device_id,
    event_ts: row.event_ts,
    received_at: row.received_at,
    user_id: row.user_id,
    attached_via: row.attached_via,
    pkey: row.user_id === null ? null : row.email_norm !== null ? row.email_pkey : stubKey(stubKeys, row.user_id),
    email: row.email_norm,
  }))
}

/**
 * The `limit` most recently received app events, newest first by received_at (insertion order
 * breaks ties within one second), each resolved to its user and profile.
 */
export async function recentEvents(db: D1Database, piiKeySecret: string, limit: number): Promise<FeedEvent[]> {
  return feedRows(db, piiKeySecret, '1 = 1', [], limit)
}

/**
 * One app event, resolved exactly as recentEvents shapes it; null when no event has this id.
 * The "Send a test event" panel reads its own send this way (`POST /api/events/test`),
 * so the row it shows is never a second, looser copy of the feed's resolution rule.
 */
export async function feedEventById(db: D1Database, piiKeySecret: string, eventId: string): Promise<FeedEvent | null> {
  const [row] = await feedRows(db, piiKeySecret, 'e.event_id = ?', [eventId], 1)
  return row ?? null
}
