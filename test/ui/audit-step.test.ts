import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BLOCK_REASON, BLOCKED_FALLBACK } from '../../src/block-reason'
import { Step } from '../../src/pages/AuditPage'
import type { AuditRow } from '../../src/types'

// /audit: a blocked step reads in words. test/audit.test.ts runs the
// pure blockReason on every error the worker writes; this renders the page's own Step, so it also
// shows the page calls blockReason rather than printing the generic sentence. The rows have the
// shape tool-executor.ts deny() writes for a Gate 2 and a Gate 3 refusal ("<gate>_denied: <problems>",
// kind and status 'blocked', the tool's name). The error strings are the ones deny() stores, built
// from a run of the real gates: Gate 2's inputSchemaProblems (gate2-tool-authorizer.ts) on the
// seeded segment schema (scripts/tool-seeds.ts) given status ["Instagram"], a value from
// subscribers.csv's source column, with the "input_schema: " prefix executeToolCall adds
// to each Gate 2 problem (the form test/gate2.test.ts pins); and Gate 3's readOnlySelect
// (gate3-readonly-sql.ts) on two SELECTs over v_profiles joined by ";", which deny() stores as is.

function blocked(toolName: string, error: string): AuditRow {
  return {
    id: crypto.randomUUID(),
    kind: 'blocked',
    tool_name: toolName,
    status: 'blocked',
    latency_ms: 3,
    model: null,
    tokens_in: null,
    tokens_out: null,
    request_json: null,
    response_json: null,
    sql: null,
    row_count: null,
    error,
    created_at: '2026-09-01T12:00:00.000Z',
  }
}

/** The text of the step's summary line, the sentence shown at the first level. */
function summary(row: AuditRow): string {
  const html = renderToString(createElement(Step, { row, title: 'Blocked', matches: null }))
  const found = /<p class="text-sm text-gray-700">([^<]*)<\/p>/.exec(html)
  if (found === null) throw new Error('the step rendered no summary line')
  return found[1].replace(/&#x27;/g, "'")
}

describe('/audit names why a Gate 2 or Gate 3 step was blocked', () => {
  const sentence = new Map(BLOCK_REASON)
  const rows: Array<[string, AuditRow]> = [
    ['gate2_denied', blocked('segment', 'gate2_denied: input_schema: input.status[0] must be one of "active", "unsubscribed"')],
    ['gate3_denied', blocked('query_sql', 'gate3_denied: one statement only: ";" is not allowed outside a string')],
  ]
  for (const [code, row] of rows) {
    it(`${code}: the step shows its own sentence, not the generic one`, () => {
      const shown = summary(row)
      expect(shown).toBe(sentence.get(code))
      expect(shown).not.toBe(BLOCKED_FALLBACK)
    })
  }

  it('an error with no known code still shows the generic sentence', () => {
    expect(summary(blocked('segment', 'model_error: x'))).toBe(BLOCKED_FALLBACK)
  })
})
