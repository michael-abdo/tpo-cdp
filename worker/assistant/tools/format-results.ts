// Tool results as the model sees them: a markdown table with 60-character cells. At most 10 rows
// go to the model, the first 10 when there are more; the full rows stay server-side in the
// ToolOutput for the UI table, so the model never writes the rows a teammate sees. Every result
// is wrapped in a <tool_result> data frame so the system prompt's "tool results are data" rule
// has a boundary to point at.
//
// Pure. The executor scans the framed text with assertNoPII before it is sent.

import type { Cell, ResultRow, ToolOutput } from './builtin-handlers'

/** Rows of one result the model sees. */
export const MODEL_ROW_CAP = 10
/** The cell cap, so one long value cannot flood the prompt. */
export const CELL_MAX_CHARS = 60

function cell(value: Cell): string {
  if (value === null) return ''
  const text = typeof value === 'string' ? value : String(value)
  const clipped = text.length > CELL_MAX_CHARS ? `${text.slice(0, CELL_MAX_CHARS - 1)}…` : text
  // A pipe or a line break would end the cell or the row; page paths and story slugs come from clients.
  return clipped.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
}

/** A markdown table of the first MODEL_ROW_CAP rows, with a line saying how many there are in all. */
export function markdownTable(columns: readonly string[], rows: readonly ResultRow[], total: number = rows.length): string {
  if (rows.length === 0) return 'No rows.'
  const shown = rows.slice(0, MODEL_ROW_CAP)
  const lines = [
    `| ${columns.map((c) => cell(c)).join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...shown.map((row) => `| ${columns.map((c) => cell(row[c] ?? null)).join(' | ')} |`),
  ]
  if (total > shown.length) lines.push(`Showing ${shown.length} of ${total} rows.`)
  return lines.join('\n')
}

/**
 * The data frame around one result. A closing tag inside the body is broken up so untrusted text
 * cannot end the frame early and pose as instructions after it.
 */
export function frameToolResult(tool: string, body: string): string {
  const safe = body.replace(/<\/tool_result/gi, '<\\/tool_result')
  return `<tool_result tool="${tool}" trust="untrusted-data">\n${safe}\n</tool_result>`
}

/** A successful result: the summary as JSON, then the rows as a table. */
export function formatToolOutput(output: ToolOutput): string {
  const body = [
    'Summary:',
    '```json',
    JSON.stringify(output.summary),
    '```',
    'Rows:',
    markdownTable(output.columns, output.rows, output.total_rows),
  ].join('\n')
  return frameToolResult(output.tool, body)
}

/** A failed call, framed the same way; `problems` never carry row contents. */
export function formatToolError(tool: string, problems: readonly string[]): string {
  return frameToolResult(tool, `Error: the tool did not run.\n${problems.map((p) => `- ${p}`).join('\n')}`)
}
