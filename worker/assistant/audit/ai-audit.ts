// ai_audit writer (design 03 §Gateway layers row 11; table 01 §Tables ai_audit; 05 §Proof surfaces).
// Origin: palisade gateway/audit-logger.ts L19-87 (14 §4, §7), with the D-24 gaps closed: every
// write is awaited and a failed write is loud (the origin's `catch {}` swallowed it, 14 §3.8), and
// the stored payload is the post-scanner one with the question redacted, never the raw prompt
// (the origin persisted the raw prompt, 14 §6 #11).

import { findPII, type KnownEmails, loadKnownEmails } from '../gates/pii-guard'

export type AuditKind = 'model_request' | 'tool_call' | 'blocked'
export type AuditStatus = 'success' | 'error' | 'blocked'

/** One ai_audit row before it is written. JSON fields take the object; this module serializes it. */
export interface AuditEntry {
  kind: AuditKind
  status: AuditStatus
  /** NULL for model_request rows (01); required for tool_call rows. */
  tool_name?: string | null
  latency_ms?: number | null
  model?: string | null
  tokens_in?: number | null
  tokens_out?: number | null
  /** model_request: the exact payload sent, after `assertNoPII`. */
  request_json?: unknown
  response_json?: unknown
  /** query_sql tool_call rows only (01). */
  sql?: string | null
  row_count?: number | null
  error?: string | null
}

/** A write that did not happen. Thrown, never swallowed (CLAUDE.md "Loud"); onError renders a 500. */
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
 * The audit trail of one assistant request: one `trace_id` shared by every row it writes (03
 * row 11), returned to the UI as `audit_id` (04). Holds the request's known-email set so the
 * gates and this writer scan with the same data (05 §Scanner).
 */
export class AuditTrace {
  readonly traceId: string
  readonly knownEmails: KnownEmails
  /** The session's random `sub` (04 §Auth), stored on every row for the per-session limit (09 D-40); null outside a session. */
  readonly sessionSub: string | null
  private readonly db: D1Database

  constructor(db: D1Database, knownEmails: KnownEmails, sessionSub: string | null = null) {
    this.db = db
    this.knownEmails = knownEmails
    this.sessionSub = sessionSub
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
    // Wall clock: ai_audit.created_at is on the 02 §Time allow-list.
    const createdAt = new Date().toISOString()
    try {
      const result = await this.db
        .prepare(
          `INSERT INTO ai_audit (id, trace_id, kind, tool_name, status, latency_ms, model, tokens_in, tokens_out,
                                 request_json, response_json, sql, row_count, error, created_at, session_sub)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

/** Opens the trace for one assistant request: loads the request's known-email set (05 §Scanner). */
export async function startTrace(db: D1Database, sessionSub: string | null = null): Promise<AuditTrace> {
  return new AuditTrace(db, await loadKnownEmails(db), sessionSub)
}
