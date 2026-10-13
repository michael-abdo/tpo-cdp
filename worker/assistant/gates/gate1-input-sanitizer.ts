// Gate 1, the input sanitizer (design 03 §Gateway layers row 2; 04 §POST /api/assistant errors).
// Origin: palisade packages/workflows/src/gateway/gate1-input-sanitizer.ts L20-109, as
// recorded in 14 §3.4 — the 19 regexes and the 2,000-character cap are ported as written there.
// Changes (14 §4, §6 #4/#5; 09 D-24):
//   - email redaction to `[email]`: user text with an email is redacted and continues
//   - a pattern hit or an over-long question is a 400 `invalid_question` with a loud log line and
//     an ai_audit row kind=blocked, not the origin's canned 200 reply
//   - the origin's "conversation >= 50 messages" check is not ported: the assistant is single-shot
//     (09 D-34), so there is no conversation to count
//   - the origin's DB/memory rate limiter (L117-226) is not ported: rate limiting is the Workers
//     binding (03 row 0)
// 14 §3.4 records the multiline flag on the line-comment regex and dotAll on the block-comment
// regex; it records no case flag. SQL keywords and injection phrases are matched ignoring case
// here, so `drop table` is caught like `DROP TABLE`. The three PII-shape regexes are kept case-
// sensitive as written (the passport shape is two capital letters and seven digits).
// Patterns run on the question exactly as sent, before redaction, so redaction cannot hide or
// create a match.

import type { AuditTrace } from '../audit/ai-audit'
import { ApiError } from '../../auth/middleware'
import { redactEmails } from './pii-guard'

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
  { id: 'sql_ddl', category: 'sql_injection', regex: /(DROP|DELETE|TRUNCATE|ALTER|CREATE|INSERT|UPDATE)\s+(TABLE|DATABASE|INDEX|ROLE|USER|SCHEMA|TRIGGER|FUNCTION)/i },
  { id: 'sql_grant_revoke', category: 'sql_injection', regex: /(GRANT|REVOKE)\s+\w/i },
  { id: 'sql_chained_statement', category: 'sql_injection', regex: /;\s*(DROP|DELETE|TRUNCATE|ALTER|GRANT|REVOKE)/i },
  { id: 'sql_line_comment', category: 'sql_injection', regex: /--\s*$/m },
  { id: 'sql_block_comment', category: 'sql_injection', regex: /\/\*.*\*\//s },
  { id: 'sql_union_select', category: 'sql_injection', regex: /UNION\s+(ALL\s+)?SELECT/i },
  { id: 'sql_into_outfile', category: 'sql_injection', regex: /INTO\s+(OUT|DUMP)FILE/i },
  { id: 'sql_exec', category: 'sql_injection', regex: /EXEC(UTE)?\s*\(/i },
  // Prompt injection (origin L32-41)
  { id: 'inject_ignore_previous', category: 'prompt_injection', regex: /(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior|earlier)\s+(instructions?|prompts?|rules?|context)/i },
  { id: 'inject_role_play', category: 'prompt_injection', regex: /(you\s+are\s+now|act\s+as|pretend\s+(to\s+be|you\s+are)|roleplay\s+as)/i },
  { id: 'inject_system_prompt', category: 'prompt_injection', regex: /(system|initial|original|hidden)\s+prompt/i },
  { id: 'inject_exfiltrate', category: 'prompt_injection', regex: /(exfiltrate|leak|extract|dump|reveal)\s+(data|information|secrets?|credentials?|passwords?|keys?|tokens?)/i },
  { id: 'inject_base64', category: 'prompt_injection', regex: /base64\s*(encode|decode|output)/i },
  { id: 'inject_bypass', category: 'prompt_injection', regex: /(bypass|override|circumvent)\s+(security|auth|permission|access|restriction|filter|gate)/i },
  { id: 'inject_system_tag', category: 'prompt_injection', regex: /\[\s*SYSTEM\s*\]/i },
  { id: 'inject_system_fence', category: 'prompt_injection', regex: /```\s*system/i },
  // "PII" shapes (origin L44-48)
  { id: 'pii_ssn', category: 'pii_pattern', regex: /\d{3}-\d{2}-\d{4}/ },
  { id: 'pii_card', category: 'pii_pattern', regex: /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/ },
  { id: 'pii_passport', category: 'pii_pattern', regex: /[A-Z]{2}\d{7}/ },
]

declare const gate1Passed: unique symbol

/**
 * A question that passed Gate 1, emails redacted. Only `sanitizeQuestion` makes one, so the
 * request builder (build-request.ts) cannot be handed raw user text by mistake.
 */
export interface SanitizedQuestion {
  readonly text: string
  readonly emailsRedacted: number
  readonly [gate1Passed]: true
}

export type Gate1Result =
  | { ok: true; question: SanitizedQuestion }
  | { ok: false; reason: 'length_exceeded'; length: number }
  | { ok: false; reason: Gate1Category; pattern: string }

/** Pure. Order as the origin: length, then the patterns in list order, then (here) redaction. */
export function sanitizeQuestion(raw: string): Gate1Result {
  if (raw.length > QUESTION_MAX_CHARS) return { ok: false, reason: 'length_exceeded', length: raw.length }
  for (const pattern of GATE1_PATTERNS) {
    if (pattern.regex.test(raw)) return { ok: false, reason: pattern.category, pattern: pattern.id }
  }
  const { text, count } = redactEmails(raw)
  return { ok: true, question: { text, emailsRedacted: count } as SanitizedQuestion }
}

/**
 * Gate 1 with its loud failure: a block logs one line (reason and pattern id, never the
 * question), writes the awaited ai_audit row `kind=blocked, status=blocked` with no payload
 * (the blocked text may itself hold an SSN- or card-shaped number), and throws 400
 * `invalid_question` (04).
 */
export async function enforceGate1(trace: AuditTrace, raw: string): Promise<SanitizedQuestion> {
  const result = sanitizeQuestion(raw)
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
