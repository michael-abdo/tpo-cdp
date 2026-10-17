// `properties.story` and `properties.link` are the two event values v_app_events shows the
// assistant. The schema already holds them to a slug and an "@"-free URL (schema.ts); this check
// refuses them when they still carry personal data in a spelling the outbound scanner reads: a
// stored email or the name part of one ("joy-hall830-protonmail-com", "joy%2Ehall830"), the
// first and last name a stored email spells ("julia-evans" for julia.evans230), any
// email shape ("new.person%20at%20example%2Ecom"), or a raw app, device or visitor id. It runs
// the same detector as the model boundary (worker/assistant/gates/pii-guard.ts findPII), on the
// value alone, so a value stored here can never later stop the assistant, and a disguised address
// never reaches a tool result in the first place. It reads the stored emails only when the event
// has one of the two keys. The issue text never quotes the value.

import { findPII, loadKnownEmails, type PiiCheck } from '../assistant/gates/pii-guard'
import type { SchemaIssue, WebhookEvent } from './schema'

/** The properties keys v_app_events exposes (0002_views.sql); every other key is stored only. */
export const EXPOSED_PROPERTIES = ['story', 'link'] as const

export interface ExposedPropertyProblems {
  /** One 400 detail per refused key, in EXPOSED_PROPERTIES order. */
  issues: SchemaIssue[]
  /** Which scanner check refused each key, for the log line (never the value). */
  checks: PiiCheck[]
}

/** The refusal sentence for one key. */
export function personalDataIssue(key: (typeof EXPOSED_PROPERTIES)[number]): string {
  return `properties.${key} must not hold an email address, the name part of one, or an account id`
}

/** The exposed values of `event` that carry personal data; empty when there are none. */
export async function exposedPropertyProblems(db: D1Database, event: WebhookEvent): Promise<ExposedPropertyProblems> {
  const values = EXPOSED_PROPERTIES.flatMap((key) => {
    const value = event.properties?.[key]
    return typeof value === 'string' ? [{ key, value }] : []
  })
  if (values.length === 0) return { issues: [], checks: [] }
  const known = await loadKnownEmails(db)
  const issues: SchemaIssue[] = []
  const checks: PiiCheck[] = []
  for (const { key, value } of values) {
    const check = findPII(value, known)
    if (check === null) continue
    issues.push({ field: `properties.${key}`, issue: personalDataIssue(key) })
    checks.push(check)
  }
  return { issues, checks }
}
