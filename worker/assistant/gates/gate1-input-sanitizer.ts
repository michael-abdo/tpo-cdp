// Gate 1, the input sanitizer: the first check on a teammate's question, before anything is sent
// to the model. 19 regexes (SQL statements, prompt-injection phrases, SSN/card/passport shapes)
// plus a length cap. The \b word boundaries matter: without them "migrant story" hits
// (GRANT|REVOKE)\s+\w and "impact as" hits "act as".
//   - email redaction to `[email]`: user text with an email is redacted and continues; so is the
//     local part of a known email typed on its own (`joy.hall830`), as a whole token or as whole
//     words with spaces between them (`joy hall 830`)
//   - name redaction to `[name]`: a subscriber's first and last name as their email spells it
//     (`Julia Evans` for julia.evans230), any case, also before a possessive (`Julia Evans's`);
//     a single first name, or a name no stored email spells, stays as typed
//   - a pattern hit or an over-long question is a 400 `invalid_question` with a loud log line and
//     an ai_audit row kind=blocked, never a quiet 200 that would hide the block
//   - there is no conversation-length check: the assistant is single-shot, so there is no
//     conversation to count
//   - rate limiting is the Workers rate-limit binding, not a check in this file
// Patterns run on the question exactly as sent, before redaction, so redaction cannot hide or
// create a match.

import type { AuditTrace } from '../audit/ai-audit'
import { ApiError } from '../../auth/middleware'
import { type KnownEmails, redactEmails, redactKnownLocalParts, redactKnownNames } from './pii-guard'

/** The length cap: a longer question is length_exceeded. */
export const QUESTION_MAX_CHARS = 2000

export type Gate1Category = 'sql_injection' | 'prompt_injection' | 'pii_pattern'

export interface Gate1Pattern {
  /** Stable name for logs and the audit row; never the matched text. */
  id: string
  category: Gate1Category
  regex: RegExp
}

// No `g` flags: a global regex keeps `lastIndex` between `.test()` calls.
export const GATE1_PATTERNS: readonly Gate1Pattern[] = [
  // SQL
  { id: 'sql_ddl', category: 'sql_injection', regex: /\b(DROP|DELETE|TRUNCATE|ALTER|CREATE|INSERT|UPDATE)\s+(TABLE|DATABASE|INDEX|ROLE|USER|SCHEMA|TRIGGER|FUNCTION)/i },
  { id: 'sql_grant_revoke', category: 'sql_injection', regex: /\b(GRANT|REVOKE)\s+\w/i },
  { id: 'sql_chained_statement', category: 'sql_injection', regex: /;\s*(DROP|DELETE|TRUNCATE|ALTER|GRANT|REVOKE)/i },
  { id: 'sql_line_comment', category: 'sql_injection', regex: /--\s*$/m },
  { id: 'sql_block_comment', category: 'sql_injection', regex: /\/\*.*\*\//s },
  { id: 'sql_union_select', category: 'sql_injection', regex: /\bUNION\s+(ALL\s+)?SELECT\b/i },
  { id: 'sql_into_outfile', category: 'sql_injection', regex: /\bINTO\s+(OUT|DUMP)FILE\b/i },
  { id: 'sql_exec', category: 'sql_injection', regex: /\bEXEC(UTE)?\s*\(/i },
  // Prompt injection
  { id: 'inject_ignore_previous', category: 'prompt_injection', regex: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior|earlier)\s+(instructions?|prompts?|rules?|context)/i },
  { id: 'inject_role_play', category: 'prompt_injection', regex: /\b(you\s+are\s+now|act\s+as|pretend\s+(to\s+be|you\s+are)|roleplay\s+as)\b/i },
  { id: 'inject_system_prompt', category: 'prompt_injection', regex: /\b(system\s+prompt|initial\s+prompt|original\s+prompt|hidden\s+prompt)\b/i },
  { id: 'inject_exfiltrate', category: 'prompt_injection', regex: /\b(exfiltrate|leak|extract|dump|reveal)\s+(data|information|secrets?|credentials?|passwords?|keys?|tokens?)/i },
  { id: 'inject_base64', category: 'prompt_injection', regex: /\bbase64\s*(encode|decode|output)\b/i },
  { id: 'inject_bypass', category: 'prompt_injection', regex: /\b(bypass|override|circumvent)\s+(security|auth|permission|access|restriction|filter|gate)/i },
  { id: 'inject_system_tag', category: 'prompt_injection', regex: /\[\s*SYSTEM\s*\]/i },
  { id: 'inject_system_fence', category: 'prompt_injection', regex: /```\s*system\b/i },
  // "PII" shapes
  { id: 'pii_ssn', category: 'pii_pattern', regex: /\b\d{3}-\d{2}-\d{4}\b/ },
  { id: 'pii_card', category: 'pii_pattern', regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/ },
  { id: 'pii_passport', category: 'pii_pattern', regex: /\b[A-Z]{2}\d{7}\b/ },
]

declare const gate1Passed: unique symbol

/**
 * A question that passed Gate 1, emails, known local parts and known names redacted. Only `sanitizeQuestion` makes one, so the
 * request builder (build-request.ts) cannot be handed raw user text by mistake.
 */
export interface SanitizedQuestion {
  readonly text: string
  /** Email-shaped spans plus known local parts replaced by `[email]` (names replaced by `[name]` are not counted). */
  readonly emailsRedacted: number
  readonly [gate1Passed]: true
}

export type Gate1Result =
  | { ok: true; question: SanitizedQuestion }
  | { ok: false; reason: 'length_exceeded'; length: number }
  | { ok: false; reason: Gate1Category; pattern: string }

/**
 * Pure. Order: length, then the patterns in list order, then redaction:
 * email-shaped spans first, then the local parts of `known` (the request's known-email set),
 * then the names those local parts spell.
 */
export function sanitizeQuestion(raw: string, known: KnownEmails): Gate1Result {
  if (raw.length > QUESTION_MAX_CHARS) return { ok: false, reason: 'length_exceeded', length: raw.length }
  for (const pattern of GATE1_PATTERNS) {
    if (pattern.regex.test(raw)) return { ok: false, reason: pattern.category, pattern: pattern.id }
  }
  // redactEmails normalizes first (shared/pii.ts normalizeForScan), so a disguised address —
  // percent- or entity-encoded, bracketed, or spelled out — redacts as an email.
  const emails = redactEmails(raw)
  const locals = redactKnownLocalParts(emails.text, known)
  const names = redactKnownNames(locals.text, known)
  return { ok: true, question: { text: names.text, emailsRedacted: emails.count + locals.count } as SanitizedQuestion }
}

/**
 * Gate 1 with its loud failure: a block logs one line (reason and pattern id, never the
 * question), writes the awaited ai_audit row `kind=blocked, status=blocked` with no payload
 * (the blocked text may itself hold an SSN- or card-shaped number), and throws 400
 * `invalid_question`.
 */
export async function enforceGate1(trace: AuditTrace, raw: string): Promise<SanitizedQuestion> {
  const result = sanitizeQuestion(raw, trace.knownEmails)
  if (result.ok) return result.question
  const detail =
    result.reason === 'length_exceeded'
      ? `length_exceeded (${result.length} > ${QUESTION_MAX_CHARS} characters)`
      : `${result.reason}/${result.pattern}`
  console.error(JSON.stringify({ at: 'gate1', trace_id: trace.traceId, error: 'invalid_question', detail }))
  await trace.write({ kind: 'blocked', status: 'blocked', error: `gate1: ${detail}` })
  const message =
    result.reason === 'length_exceeded'
      ? `Questions can be at most ${QUESTION_MAX_CHARS} characters.`
      : 'The question was refused by the input filter. Ask about subscribers, site visits or app activity in plain words.'
  const details =
    result.reason === 'length_exceeded'
      ? [{ reason: result.reason, max_chars: QUESTION_MAX_CHARS }]
      : [{ reason: result.reason }] // the pattern id stays server-side: naming it would help an evasion
  throw new ApiError(400, 'invalid_question', message, details)
}
