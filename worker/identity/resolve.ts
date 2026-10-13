/**
 * Read-time identity resolution for one app user (01 §Identity resolution, 02 §Linking 4–5,
 * 09 D-43). Nothing here writes or caches (03 §No-restart): every call reads D1, so an
 * identified event that updates device_identity re-attaches that device's earlier anonymous
 * events on the next read, with no replay.
 *
 * - `direct`: the event carries the user_id.
 * - `login_stitch`: the event is anonymous (user_id NULL) and its device's device_identity row
 *   names this user, the device's most recent user by event_ts (D-43). A device shared by
 *   several users gives all its anonymous events to that one user (02 §Edge cases, D-18).
 */

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
