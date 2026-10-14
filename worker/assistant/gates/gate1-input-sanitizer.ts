// Gate 1, the input sanitizer (design 03 §Gateway layers row 2; 04 §POST /api/assistant errors).
// Origin: palisade packages/workflows/src/gateway/gate1-input-sanitizer.ts L20-48 (patterns) and
// L53-109 (order). The 19 regexes, their flags and their \b word boundaries are copied verbatim
// from that source file (14 §4 "copy nearly verbatim"). 14 §3.4's transcription of them leaves
// out the \b anchors and words the system-prompt pattern differently; the origin source wins.
// The \b anchors matter: without them "migrant story" hits (GRANT|REVOKE)\s+\w and "impact as"
// hits "act as".
// Changes (14 §4, §6 #4/#5; 09 D-24, D-70 #1):
//   - email redaction to `[email]`: user text with an email is redacted and continues; so is the
//     local part of a known email typed on its own (`joy.hall830`), as a whole token
//   - a pattern hit or an over-long question is a 400 `invalid_question` with a loud log line and
//     an ai_audit row kind=blocked, not the origin's canned 200 reply
//   - the origin's "conversation >= 50 messages" check is not ported: the assistant is single-shot
//     (09 D-34), so there is no conversation to count
//   - the origin's DB/memory rate limiter (L117-226) is not ported: rate limiting is the Workers
//     binding (03 row 0)
// Patterns run on the question exactly as sent, before redaction, so redaction cannot hide or
// create a match.

import type { AuditTrace } from '../audit/ai-audit'
import { ApiError } from '../../auth/middleware'
import { decodeAt, type KnownEmails, redactEmails, redactKnownLocalParts } from './pii-guard'

/** The origin's cap (14 §3.4 "length > 2000 → length_exceeded"). */
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
  // SQL (origin L20-29)
  { id: 'sql_ddl', category: 'sql_injection', regex: /\b(DROP|DELETE|TRUNCATE|ALTER|CREATE|INSERT|UPDATE)\s+(TABLE|DATABASE|INDEX|ROLE|USER|SCHEMA|TRIGGER|FUNCTION)/i },
  { id: 'sql_grant_revoke', category: 'sql_injection', regex: /\b(GRANT|REVOKE)\s+\w/i },
  { id: 'sql_chained_statement', category: 'sql_injection', regex: /;\s*(DROP|DELETE|TRUNCATE|ALTER|GRANT|REVOKE)/i },
  { id: 'sql_line_comment', category: 'sql_injection', regex: /--\s*$/m },
  { id: 'sql_block_comment', category: 'sql_injection', regex: /\/\*.*\*\//s },
  { id: 'sql_union_select', category: 'sql_injection', regex: /\bUNION\s+(ALL\s+)?SELECT\b/i },
  { id: 'sql_into_outfile', category: 'sql_injection', regex: /\bINTO\s+(OUT|DUMP)FILE\b/i },
  { id: 'sql_exec', category: 'sql_injection', regex: /\bEXEC(UTE)?\s*\(/i },
  // Prompt injection (origin L32-41)
  { id: 'inject_ignore_previous', category: 'prompt_injection', regex: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior|earlier)\s+(instructions?|prompts?|rules?|context)/i },
  { id: 'inject_role_play', category: 'prompt_injection', regex: /\b(you\s+are\s+now|act\s+as|pretend\s+(to\s+be|you\s+are)|roleplay\s+as)\b/i },
  { id: 'inject_system_prompt', category: 'prompt_injection', regex: /\b(system\s+prompt|initial\s+prompt|original\s+prompt|hidden\s+prompt)\b/i },
  { id: 'inject_exfiltrate', category: 'prompt_injection', regex: /\b(exfiltrate|leak|extract|dump|reveal)\s+(data|information|secrets?|credentials?|passwords?|keys?|tokens?)/i },
  { id: 'inject_base64', category: 'prompt_injection', regex: /\bbase64\s*(encode|decode|output)\b/i },
  { id: 'inject_bypass', category: 'prompt_injection', regex: /\b(bypass|override|circumvent)\s+(security|auth|permission|access|restriction|filter|gate)/i },
  { id: 'inject_system_tag', category: 'prompt_injection', regex: /\[\s*SYSTEM\s*\]/i },
  { id: 'inject_system_fence', category: 'prompt_injection', regex: /```\s*system\b/i },
  // "PII" shapes (origin L44-48)
  { id: 'pii_ssn', category: 'pii_pattern', regex: /\b\d{3}-\d{2}-\d{4}\b/ },
  { id: 'pii_card', category: 'pii_pattern', regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/ },
  { id: 'pii_passport', category: 'pii_pattern', regex: /\b[A-Z]{2}\d{7}\b/ },
]

declare const gate1Passed: unique symbol

/**
 * A question that passed Gate 1, emails and known local parts redacted. Only `sanitizeQuestion` makes one, so the
 * request builder (build-request.ts) cannot be handed raw user text by mistake.
 */
export interface SanitizedQuestion {
  readonly text: string
  /** Email-shaped spans plus known local parts replaced by `[email]`. */
  readonly emailsRedacted: number
  readonly [gate1Passed]: true
}

export type Gate1Result =
  | { ok: true; question: SanitizedQuestion }
  | { ok: false; reason: 'length_exceeded'; length: number }
  | { ok: false; reason: Gate1Category; pattern: string }

/**
 * Pure. Order as the origin: length, then the patterns in list order, then (here) redaction:
 * email-shaped spans first, then the local parts of `known` (the request's known-email set).
 */
export function sanitizeQuestion(raw: string, known: KnownEmails): Gate1Result {
  if (raw.length > QUESTION_MAX_CHARS) return { ok: false, reason: 'length_exceeded', length: raw.length }
  for (const pattern of GATE1_PATTERNS) {
    if (pattern.regex.test(raw)) return { ok: false, reason: pattern.category, pattern: pattern.id }
  }
  // %40 is decoded first, so a URL-encoded address is redacted as an email (09 D-70 #1).
  const emails = redactEmails(decodeAt(raw))
  const locals = redactKnownLocalParts(emails.text, known)
  return { ok: true, question: { text: locals.text, emailsRedacted: emails.count + locals.count } as SanitizedQuestion }
}

/**
 * Gate 1 with its loud failure: a block logs one line (reason and pattern id, never the
 * question), writes the awaited ai_audit row `kind=blocked, status=blocked` with no payload
 * (the blocked text may itself hold an SSN- or card-shaped number), and throws 400
 * `invalid_question` (04).
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
