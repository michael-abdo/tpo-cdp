// Re-hydration. The model answers in
// pk_ keys; after it has finished and its output has been scanned, the server swaps each key for
// the subscriber's email for the authenticated UI. Only the HTTP response carries the emails:
// nothing hydrated is written to ai_audit or sent back to the model (single-shot: no next turn).
//
// `collectPkeys` and `rehydrate` are pure; `loadEmailsByPkey` is the one read, by bound
// parameters in chunks under D1's 100-parameter cap.

import type { Cell } from './tools/builtin-handlers'
import type { AssistantResult } from './respond'

/** A pseudonymous key (shared/pseudonym.ts): pk_ and 16 hex characters. */
const PKEY = /\bpk_[0-9a-f]{16}\b/g

const CHUNK = 100

/** Every distinct pk_ key in the text and the table cells, in first-seen order. */
export function collectPkeys(result: AssistantResult): string[] {
  const found = new Set<string>()
  const scan = (text: string) => {
    for (const match of text.matchAll(PKEY)) found.add(match[0])
  }
  scan(result.text)
  for (const row of result.table?.rows ?? []) {
    for (const value of Object.values(row)) if (typeof value === 'string') scan(value)
  }
  return [...found]
}

/** email_norm for each key that has one (unknown-user stub profiles have none). */
export async function loadEmailsByPkey(db: D1Database, pkeys: readonly string[]): Promise<Map<string, string>> {
  const emails = new Map<string, string>()
  for (let i = 0; i < pkeys.length; i += CHUNK) {
    const chunk = pkeys.slice(i, i + CHUNK)
    const { results } = await db
      .prepare(`SELECT pkey, email_norm FROM profiles WHERE email_norm IS NOT NULL AND pkey IN (${chunk.map(() => '?').join(', ')})`)
      .bind(...chunk)
      .all<{ pkey: string; email_norm: string }>()
    for (const row of results) emails.set(row.pkey, row.email_norm)
  }
  return emails
}

function swap(text: string, emails: ReadonlyMap<string, string>): string {
  return text.replace(PKEY, (key) => emails.get(key) ?? key)
}

/**
 * A copy of `result` for the UI: pk_ keys in the text and the table replaced by emails, and a
 * `pkey` column renamed `email` (a key with no email, a stub profile, stays as the key). The
 * segment's filters and count hold no key and pass through unchanged.
 */
export function rehydrate(result: AssistantResult, emails: ReadonlyMap<string, string>): AssistantResult {
  const table =
    result.table === null
      ? null
      : {
          columns: result.table.columns.map((c) => (c === 'pkey' ? 'email' : c)),
          rows: result.table.rows.map((row) => {
            const out: Record<string, Cell> = {}
            for (const [column, value] of Object.entries(row)) {
              out[column === 'pkey' ? 'email' : column] = typeof value === 'string' ? swap(value, emails) : value
            }
            return out
          }),
        }
  return { ...result, text: swap(result.text, emails), table }
}
