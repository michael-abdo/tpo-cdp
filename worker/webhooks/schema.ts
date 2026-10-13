// The app webhook body (04 §Webhook body and validation; R4.2–R4.4, 09 D-22, D-38).
// Exactly the brief's shape, one event per request; unknown fields are ignored (zod strips them).
// Issue texts are written here and never echo a submitted value or a property key (04 §Error envelope).

import { z } from 'zod'

/** The four events the app sends (R4.3); the CHECK on app_events.event in 0001_core.sql matches. */
export const APP_EVENTS = ['app_open', 'read_story', 'link_click', 'login'] as const

export type AppEventName = (typeof APP_EVENTS)[number]

export const ID_MAX_CHARS = 64
export const PROPERTY_VALUE_MAX_CHARS = 200

const EVENT_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/

/**
 * An ISO-8601 event time parsed leniently and normalized to UTC `YYYY-MM-DDTHH:MM:SSZ`, the same
 * form the seed stores (02 §Time, 09 D-38): `Z`, a `±HH:MM`/`±HHMM` offset, or no zone (= UTC);
 * `T` or a space between date and time. Fractional seconds are accepted and dropped, so every
 * stored event_ts has one width and sorts as text. Returns null for anything else, including
 * dates that do not exist on the calendar.
 */
export function normalizeEventTimestamp(value: string): string | null {
  const m = EVENT_TIMESTAMP.exec(value)
  if (!m) return null
  const [, y, mo, d, h, mi, s, , sign, oh, om] = m
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number)
  if (hour > 23 || minute > 59 || second > 59) return null
  const local = Date.UTC(year, month - 1, day, hour, minute, second)
  // Date.UTC rolls 2026-02-30 over into March; a round trip catches dates that do not exist.
  if (new Date(local).toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return null
  let offsetMinutes = 0
  if (sign !== undefined) {
    if (Number(oh) > 23 || Number(om) > 59) return null
    offsetMinutes = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om))
  }
  return new Date(local - offsetMinutes * 60_000).toISOString().slice(0, 19) + 'Z'
}

const id = (field: string) =>
  z
    .string({
      error: (iss) => (iss.input === undefined ? `${field} is required` : `${field} must be a string`),
    })
    .min(1, { error: `${field} must not be empty` })
    .max(ID_MAX_CHARS, { error: `${field} must be at most ${ID_MAX_CHARS} characters` })

const eventSchema = z.object({
  event_id: id('event_id'),
  event: z.enum(APP_EVENTS, { error: `event must be one of ${APP_EVENTS.join(', ')}` }),
  // R4.4: a string, null, or absent. Empty is rejected: no app user has an empty id.
  user_id: id('user_id').nullable().optional(),
  device_id: id('device_id'),
  timestamp: z
    .string({
      error: (iss) => (iss.input === undefined ? 'timestamp is required' : 'timestamp must be a string'),
    })
    .transform((value, ctx) => {
      const normalized = normalizeEventTimestamp(value)
      if (normalized === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'timestamp must be ISO-8601 date and time, with Z, an offset, or no zone (UTC)',
        })
        return z.NEVER
      }
      return normalized
    }),
  properties: z
    .record(
      z.string(),
      z.string({ error: 'properties values must be strings' }).max(PROPERTY_VALUE_MAX_CHARS, {
        error: `properties values must be at most ${PROPERTY_VALUE_MAX_CHARS} characters`,
      }),
      { error: 'properties must be an object' },
    )
    .optional(),
})

/** A validated event: ids as sent, `user_id` null when absent, `timestamp` normalized UTC. */
export interface WebhookEvent {
  event_id: string
  event: AppEventName
  user_id: string | null
  device_id: string
  timestamp: string
  properties: Record<string, string> | null
}

/** One entry of the 400 `details` list. `allowed` is set on the `event` entry. */
export interface SchemaIssue {
  field: string
  issue: string
  allowed?: readonly string[]
}

export type ParseResult = { ok: true; event: WebhookEvent } | { ok: false; details: SchemaIssue[] }

/** Validates an already JSON-parsed body. An array is "one event per request" (04). */
export function parseWebhookEvent(body: unknown): ParseResult {
  if (Array.isArray(body)) return { ok: false, details: [{ field: 'body', issue: 'one event per request' }] }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, details: [{ field: 'body', issue: 'body must be one JSON object' }] }
  }
  const parsed = eventSchema.safeParse(body)
  if (!parsed.success) {
    // Only the top-level field name: a properties key is sender-chosen text and is never echoed.
    const details = parsed.error.issues.map((issue): SchemaIssue => {
      const field = issue.path.length === 0 ? 'body' : String(issue.path[0])
      return field === 'event'
        ? { field, issue: issue.message, allowed: APP_EVENTS }
        : { field, issue: issue.message }
    })
    return { ok: false, details }
  }
  const { event_id, event, user_id, device_id, timestamp, properties } = parsed.data
  return {
    ok: true,
    event: {
      event_id,
      event,
      user_id: user_id ?? null,
      device_id,
      timestamp,
      properties: properties ?? null,
    },
  }
}
