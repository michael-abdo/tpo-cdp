// ai_audit writer: the record of what the model was sent and what it did. Every write is awaited
// and a failed write is loud, so a call can never happen without its audit row; the stored
// payload is the one that passed the PII scanner, with the question redacted, never the raw
// prompt, so the audit table cannot become a second place PII is kept.

import { findPII, type KnownEmails, loadKnownEmails } from '../gates/pii-guard'

export type AuditKind = 'model_request' | 'tool_call' | 'blocked'
export type AuditStatus = 'success' | 'error' | 'blocked'

/** One ai_audit row before it is written. JSON fields take the object; this module serializes it. */
export interface AuditEntry {
  kind: AuditKind
  status: AuditStatus
  /** NULL for model_request rows; required for tool_call rows. */
  tool_name?: string | null
  latency_ms?: number | null
  model?: string | null
  tokens_in?: number | null
  tokens_out?: number | null
  /** Migration 0008: the usage meters a prompt-cached call reports; 0 or NULL on a cold call. */
  cache_read_tokens?: number | null
  cache_write_tokens?: number | null
  /** model_request: the exact payload sent, after `assertNoPII`. */
  request_json?: unknown
  response_json?: unknown
  /** query_sql tool_call rows only. */
  sql?: string | null
  row_count?: number | null
  error?: string | null
}

/** A write that did not happen. Thrown, never swallowed, so a missing audit row is never silent; onError renders a 500. */
export class AuditWriteError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options)
    this.name = 'AuditWriteError'
  }
}

function serialized(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  const text = JSON.stringify(value)
  if (text === undefined) throw new AuditWriteError('ai_audit: a JSON field has no JSON form')
  return text
}

function checkShape(entry: AuditEntry): void {
  const toolName = entry.tool_name ?? null
  if (entry.kind === 'model_request' && toolName !== null) {
    throw new AuditWriteError('ai_audit: a model_request row has no tool_name (01)')
  }
  if (entry.kind === 'model_request' && (entry.request_json === undefined || entry.request_json === null)) {
    throw new AuditWriteError('ai_audit: a model_request row must store the payload that was sent')
  }
  if (entry.kind === 'tool_call' && (toolName === null || toolName === '')) {
    throw new AuditWriteError('ai_audit: a tool_call row must name its tool')
  }
  if ((entry.kind === 'blocked') !== (entry.status === 'blocked')) {
    throw new AuditWriteError('ai_audit: kind=blocked and status=blocked go together (03 row 11)')
  }
}

/**
 * The audit trail of one assistant request: one `trace_id` shared by every row it writes,
 * returned to the UI as `audit_id`. Holds the request's known-email set so the gates and this
 * writer scan with the same data.
 */
export class AuditTrace {
  readonly traceId: string
  readonly knownEmails: KnownEmails
  /** The session's random `sub`, stored on every row for the per-session hourly limit; null outside a session. */
  readonly sessionSub: string | null
  /** The client's keyed network hash (shared/pseudonym.ts clientKeyHash), stored on every row for the per-client hourly count, so signing in again does not reset the limit; null outside a request. */
  readonly clientKey: string | null
  private readonly db: D1Database

  constructor(db: D1Database, knownEmails: KnownEmails, sessionSub: string | null = null, clientKey: string | null = null) {
    this.db = db
    this.knownEmails = knownEmails
    this.sessionSub = sessionSub
    this.clientKey = clientKey
    this.traceId = crypto.randomUUID()
  }

  /**
   * Writes one row and resolves to its id once D1 has stored it. Refuses (throws, writes
   * nothing) a row whose text fields fail the PII scan, so `request_json` never holds PII even
   * if a caller passed the wrong payload. Any D1 failure is logged and rethrown.
   */
  async write(entry: AuditEntry): Promise<string> {
    checkShape(entry)
    const fields = {
      request_json: serialized(entry.request_json),
      response_json: serialized(entry.response_json),
      sql: entry.sql ?? null,
      error: entry.error ?? null,
    }
    for (const [field, text] of Object.entries(fields)) {
      const check = text === null ? null : findPII(text, this.knownEmails)
      if (check !== null) {
        console.error(
          JSON.stringify({ at: 'ai_audit', trace_id: this.traceId, kind: entry.kind, error: 'pii_in_audit_row', field, check }),
        )
        throw new AuditWriteError(`ai_audit refused a row for trace ${this.traceId}: the ${field} field failed the PII scan`)
      }
    }
    const id = crypto.randomUUID()
    // Wall clock: created_at records when the call happened; no date rule reads it.
    const createdAt = new Date().toISOString()
    try {
      const result = await this.db
        .prepare(
          `INSERT INTO ai_audit (id, trace_id, kind, tool_name, status, latency_ms, model, tokens_in, tokens_out,
                                 request_json, response_json, sql, row_count, error, created_at, session_sub, client_key,
                                 cache_read_tokens, cache_write_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          this.traceId,
          entry.kind,
          entry.tool_name ?? null,
          entry.status,
          entry.latency_ms ?? null,
          entry.model ?? null,
          entry.tokens_in ?? null,
          entry.tokens_out ?? null,
          fields.request_json,
          fields.response_json,
          fields.sql,
          entry.row_count ?? null,
          fields.error,
          createdAt,
          this.sessionSub,
          this.clientKey,
          entry.cache_read_tokens ?? null,
          entry.cache_write_tokens ?? null,
        )
        .run()
      if (result.meta.changes !== 1) throw new Error(`expected 1 row written, D1 reported ${result.meta.changes}`)
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      console.error(JSON.stringify({ at: 'ai_audit', trace_id: this.traceId, kind: entry.kind, error: 'write_failed', reason }))
      throw new AuditWriteError(`ai_audit write failed for trace ${this.traceId}`, { cause: err })
    }
    return id
  }
}

/** Opens the trace for one assistant request: loads the request's known-email set for the PII scans. */
export async function startTrace(db: D1Database, sessionSub: string | null = null, clientKey: string | null = null): Promise<AuditTrace> {
  return new AuditTrace(db, await loadKnownEmails(db), sessionSub, clientKey)
}
