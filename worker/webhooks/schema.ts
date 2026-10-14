// The app webhook body (04 §Webhook body and validation; R4.2–R4.4, 09 D-22, D-38, D-70 #2, #3).
// Exactly the brief's shape, one event per request; unknown fields are ignored (zod strips them).
// Issue texts are written here and never echo a submitted value or a sender-chosen property key
// (04 §Error envelope); `story` and `link` are our keys (v_app_events reads them), so an issue
// about one names it as `properties.story` / `properties.link`.

import { z } from 'zod'
import { APP_EVENTS, type AppEventName } from '../../shared/app-events'

/** The four events the app sends (R4.3); their one home is shared/app-events.ts. */
export { APP_EVENTS, type AppEventName }

export const ID_MAX_CHARS = 64
export const PROPERTY_VALUE_MAX_CHARS = 200

/**
 * `properties.story` (09 D-70 #2): a lowercase slug, as the brief's `supreme-court-ruling-explained`.
 * v_app_events exposes it to the model, so free text (a name, an instruction) is refused here.
 */
export const STORY_PATTERN = /^[a-z0-9-]{1,120}$/

/**
 * `properties.link` (09 D-70 #2): an http(s) URL with no "@" anywhere (no userinfo, no address in
 * a path or query). v_app_events exposes it to the model, and the outbound PII scan looks for a
 * literal "@", so the "@" test also sees through the spellings that scan would miss: printable
 * ASCII only (no whitespace, control, bidi or fullwidth characters, so no "＠"), and no "@" after
 * one round of percent-decoding ("%40", "%EF%BC%A0" = "＠"). A "%" left after that round (double
 * encoding, "%2540") or a malformed escape is refused, not decoded again.
 */
export function isAllowedLink(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || !/^[\x21-\x7e]+$/.test(value) || value.includes('@')) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return false // URIError: a "%" that starts no valid escape; the caller's 400 names properties.link
  }
  if (decoded.includes('%') || decoded.normalize('NFKC').includes('@')) return false
  return URL.canParse(value)
}

/**
 * How far the event time may run ahead of the server clock (09 D-70 #3). A later time would win
 * every device_identity comparison and pin the device to its user for good. Events after TODAY
 * within this bound are stored and count as 0 days old (09 D-01).
 */
export const MAX_FUTURE_MS = 24 * 60 * 60 * 1000

const EVENT_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)?$/

/**
 * An ISO-8601 event time parsed leniently and normalized to UTC `YYYY-MM-DDTHH:MM:SSZ`, the same
 * form the seed stores (02 §Time, 09 D-38): `Z`, a `±HH:MM`/`±HHMM`/`±HH` offset, or no zone
 * (= UTC); `T` or a space between date and time. Fractional seconds are accepted and dropped, so
 * every stored event_ts has one width and sorts as text. Returns null for anything else, including
 * dates that do not exist on the calendar and a date with no time of day (an event time needs one;
 * accepting it would invent midnight).
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
    const offsetHours = Number(oh)
    const offsetMins = om === undefined ? 0 : Number(om)
    if (offsetHours > 23 || offsetMins > 59) return null
    offsetMinutes = (sign === '-' ? -1 : 1) * (offsetHours * 60 + offsetMins)
  }
  return new Date(local - offsetMinutes * 60_000).toISOString().slice(0, 19) + 'Z'
}

/**
 * The deepest `properties` nesting the store accepts, the object itself counting as 1: the
 * json_valid CHECK on app_events.properties (0001_core.sql) fails past SQLite's JSON_MAX_DEPTH of
 * 1000, so a deeper value would turn a sender's mistake into a 500 instead of a 400.
 */
export const PROPERTIES_MAX_DEPTH = 1000

/**
 * The first rule a properties object breaks, or null: a string anywhere in it (a value, an array
 * item or a nested object's value) over PROPERTY_VALUE_MAX_CHARS, or nesting past
 * PROPERTIES_MAX_DEPTH. Walks with an explicit stack, so a deeply nested body cannot overflow the
 * call stack. Keys are the sender's own text and are never part of the message.
 */
function propertiesProblem(properties: Record<string, unknown>): string | null {
  const stack: { value: unknown; depth: number }[] = [{ value: properties, depth: 1 }]
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!
    if (typeof value === 'string') {
      if (value.length > PROPERTY_VALUE_MAX_CHARS)
        return `properties strings must be at most ${PROPERTY_VALUE_MAX_CHARS} characters`
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    if (depth > PROPERTIES_MAX_DEPTH) return `properties must nest at most ${PROPERTIES_MAX_DEPTH} levels`
    for (const child of Array.isArray(value) ? value : Object.values(value))
      stack.push({ value: child, depth: depth + 1 })
  }
  return null
}

const id = (field: string) =>
  z
    .string({
      error: (iss) => (iss.input === undefined ? `${field} is required` : `${field} must be a string`),
    })
    .min(1, { error: `${field} must not be empty` })
    .max(ID_MAX_CHARS, { error: `${field} must be at most ${ID_MAX_CHARS} characters` })

/** The schema for a request received at `nowMs` (wall clock; 09 D-70 #3). */
const eventSchema = (nowMs: number) => z.object({
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
      if (Date.parse(normalized) - nowMs > MAX_FUTURE_MS) {
        ctx.addIssue({ code: 'custom', message: 'timestamp must be at most 24 hours after the server clock' })
        return z.NEVER
      }
      return normalized
    }),
  // 04: "properties object or absent; any string value > 200 chars → 400" (09 D-22). Any JSON
  // value may sit inside the object; the cap reaches nested strings so nesting cannot dodge it.
  properties: z
    .record(z.string(), z.unknown(), { error: 'properties must be an object' })
    .superRefine((value, ctx) => {
      const problem = propertiesProblem(value)
      if (problem !== null) ctx.addIssue({ code: 'custom', message: problem })
      // 09 D-70 #2: the two keys v_app_events exposes must be slugs; other keys are stored only.
      if ('story' in value && !(typeof value.story === 'string' && STORY_PATTERN.test(value.story))) {
        ctx.addIssue({ code: 'custom', path: ['story'], message: 'properties.story must be a slug: a-z, 0-9 and "-", 1 to 120 characters' })
      }
      if ('link' in value && !(typeof value.link === 'string' && isAllowedLink(value.link))) {
        ctx.addIssue({ code: 'custom', path: ['link'], message: 'properties.link must be an http(s) URL with no "@"' })
      }
    })
    .optional(),
})

/** A validated event: ids as sent, `user_id` null when absent, `timestamp` normalized UTC. */
export interface WebhookEvent {
  event_id: string
  event: AppEventName
  user_id: string | null
  device_id: string
  timestamp: string
  /** The sender's JSON object, unchanged; null when absent. */
  properties: Record<string, unknown> | null
}

/** One entry of the 400 `details` list. `allowed` is set on the `event` entry. */
export interface SchemaIssue {
  field: string
  issue: string
  allowed?: readonly string[]
}

export type ParseResult = { ok: true; event: WebhookEvent } | { ok: false; details: SchemaIssue[] }

/** The names a `properties` issue may carry: our own keys only, never a sender's (see the header). */
const NAMED_PROPERTIES = ['story', 'link']

/**
 * Validates an already JSON-parsed body received at `nowMs` (wall clock, the bound of 09 D-70 #3).
 * An array is "one event per request" (04).
 */
export function parseWebhookEvent(body: unknown, nowMs: number): ParseResult {
  if (Array.isArray(body)) return { ok: false, details: [{ field: 'body', issue: 'one event per request' }] }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, details: [{ field: 'body', issue: 'body must be one JSON object' }] }
  }
  const parsed = eventSchema(nowMs).safeParse(body)
  if (!parsed.success) {
    // Only the top-level field name, or properties.story / properties.link: any other properties
    // key is sender-chosen text and is never echoed.
    const details = parsed.error.issues.map((issue): SchemaIssue => {
      const [top, key] = issue.path
      const field =
        top === undefined
          ? 'body'
          : top === 'properties' && typeof key === 'string' && NAMED_PROPERTIES.includes(key) && issue.path.length === 2
            ? `properties.${key}`
            : String(top)
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
