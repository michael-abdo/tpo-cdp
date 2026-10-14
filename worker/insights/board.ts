// The insights board (design 09 D-64; 01 §insights; 04 §/api/insights board; 06 §/insights).
// One shared board of tiles, one table. A tile is a stored tool call, never a stored answer:
// every view re-runs every tile through the assistant's gated tool executor
// (worker/assistant/tools/tool-executor.ts: Gate 2, Gate 3 for SQL, the PII scan, the awaited
// audit row) with NO model call, so a re-run is deterministic and free (09 D-64 research: the BI
// tools re-run a stored query, never the LLM).
//
//   - pin (POST /api/insights {audit_id, title?}): the server, never the browser, decides what is
//     stored. It reads the trace's last successful `tool_call` row from ai_audit (its
//     request_json is the checked tool input, 03 row 11), re-validates it through Gate 2 (and
//     Gate 2's view check + Gate 3 for query_sql) against today's tool rows, and stores it.
//     The body never carries a tool, params or SQL.
//   - windows: a tool input's window_from/window_to (aggregate) or its one
//     `BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'` (query_sql) is stored as a window
//     (shared/insight-window.ts): rolling when it equals a preset on TODAY, else fixed. A
//     query_sql window is stored as `:window_from`/`:window_to` in the SQL text (01 §insights).
//     At run time the window is resolved against TODAY (02 §Time) and written back into the tool
//     input: window_from/window_to as values, or, for query_sql, the two placeholders as date
//     literals. That substitution happens before the executor, so the SQL that runs is the
//     ordinary query_sql input and passes Gate 2 and Gate 3 in full; the dates come only from
//     resolveWindow (two checked calendar dates), never from a client.
//   - insight_panel: the four former /growth panels (worker/insights/*.ts) as one board-only
//     tool, so built-in tiles run through the same executor. It is NOT an assistant_tools row
//     and is never offered to the model: it exists only in the tool set this file builds for the
//     board (09 D-64 "tool insight_panel"), next to the loaded rows.
//   - segment tiles return the count and the filters only, never rows (06: "Open list" opens the
//     builder). Any other tile whose rows name a subject (a pkey or visitor_hash column, a pk_
//     cell) is refused at pin: the board holds aggregates only (04).
//   - PII: the title, prompt and params are scanned before insert; the executor scans every
//     tool result, and the tile's whole result is scanned again before it leaves (05 §Scanner).
//   - one tile's failure is that tile's `error`; the board still answers 200 (04). A failed
//     audit write is not a tile error: it fails the request loud (03 row 11).
//
// Audit: each board request opens one trace with no session_sub, so its tool_call rows sit in
// ai_audit like any other tool run but never count toward the assistant's per-session limit
// (09 D-40 counts traces per session_sub). ran_at and created_at are wall-clock operational
// timestamps like ai_audit.created_at; no date rule reads them.

import { pickChart, type ChartKind, CHART_OVERRIDES, type ChartOverride } from '../../shared/pick-chart'
import { TODAY } from '../../shared/config'
import { detectWindow, type InsightWindow, isCalendarDate, type ResolvedWindow, resolveWindow, windowProblems } from '../../shared/insight-window'
import { type AuditTrace, AuditWriteError, startTrace } from '../assistant/audit/ai-audit'
import { authorizeToolCall, validateSqlAgainstViews } from '../assistant/gates/gate2-tool-authorizer'
import { GateDenied, lexSql, readOnlySelect, SqlLexError } from '../assistant/gates/gate3-readonly-sql'
import { findPII, loadKnownEmails, PiiBlockedError } from '../assistant/gates/pii-guard'
import { viewSchemas } from '../assistant/schema-context'
import type { BuiltinHandler, ResultRow, ToolOutput } from '../assistant/tools/builtin-handlers'
import { executeToolCall } from '../assistant/tools/tool-executor'
import { type LoadedTool, type LoadedTools, loadTools, rewritePlaceholders } from '../assistant/tools/tool-loader'
import { ApiError } from '../auth/middleware'
import { sqlLiteral } from '../ingest/sql'
import { dataQuality } from './data-quality'
import { funnel } from './funnel'
import { goingCold } from './going-cold'
import { sourceAppConversion } from './source-app'

/** The board-only tool behind the built-in tiles (01 §insights `tool`). */
export const INSIGHT_PANEL_TOOL = 'insight_panel'
/** The four former /growth panels, by their GET /api/insights/{panel} path (04). */
export const INSIGHT_PANELS = ['source-app-conversion', 'funnel', 'going-cold', 'data-quality'] as const
export type InsightPanel = (typeof INSIGHT_PANELS)[number]
/**
 * The shape of `params` this file writes and reads (01 §insights `tool_version`). A row written
 * under another version is not guessed at: its tile reports `outdated`.
 */
export const INSIGHT_PARAMS_VERSION = 1
/** 01 §insights: titles are at most 120 characters. */
export const TITLE_MAX_CHARS = 120

const WINDOW_FROM = ':window_from'
const WINDOW_TO = ':window_to'
/** Columns of the v_* views that name one subject (01 §PII-free views, 05 §Pseudonymous key). */
const SUBJECT_COLUMNS = new Set(['pkey', 'visitor_hash'])
const PSEUDONYM_PREFIX = 'pk_'

// ── the insight_panel tool ───────────────────────────────────────────────────────────────

const rowsWithout = <T extends object>(rows: readonly T[], drop: keyof T): ResultRow[] =>
  rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== drop)) as ResultRow)

/**
 * One panel as a tool result. The bar is the first number column (shared/pick-chart.ts), so the
 * share (rate) comes first, as the Growth page showed it; the panel's total and its other parts
 * go in the summary; `summary.explain` is the panel's "Explain this" question (09 D-39).
 */
async function panelOutput(db: D1Database, panel: InsightPanel): Promise<ToolOutput> {
  const output = (columns: string[], rows: ResultRow[], summary: Record<string, unknown>): ToolOutput => ({
    tool: INSIGHT_PANEL_TOOL,
    columns,
    rows: rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null])) as ResultRow),
    total_rows: rows.length,
    summary: { panel, ...summary },
  })
  switch (panel) {
    case 'source-app-conversion': {
      const d = await sourceAppConversion(db)
      const { explain, ...total } = d.total
      return output(['source', 'rate', 'with_app_after_signup', 'subscribers'], rowsWithout(d.by_source, 'explain'), {
        total,
        definitions_used: d.definitions_used,
        explain,
      })
    }
    case 'funnel': {
      const d = await funnel(db)
      const { explain, ...total } = d.total
      return output(['first_page', 'rate', 'subscribed', 'visitors'], rowsWithout(d.by_first_page, 'explain'), {
        total,
        by_first_utm: rowsWithout(d.by_first_utm, 'explain'),
        explain,
      })
    }
    case 'going-cold': {
      const d = await goingCold(db)
      const { explain, ...total } = d.total
      return output(['source', 'rate', 'at_risk', 'active'], rowsWithout(d.by_source, 'explain'), {
        total,
        hidden_unsubscribed: d.hidden_unsubscribed.count,
        definitions_used: d.definitions_used,
        explain,
      })
    }
    case 'data-quality': {
      const d = await dataQuality(db)
      const rows = d.checks.map((c): ResultRow => ({ check: c.key, rate: c.rate, count: c.count, of: c.of }))
      const { by_file_reason, ...imports } = d.import
      // The panel has no single total question; its first check's question stands for it.
      return output(['check', 'rate', 'count', 'of'], rows, { import: imports, set_aside: by_file_reason, explain: d.checks[0].explain })
    }
  }
}

const insightPanelHandler: BuiltinHandler = {
  inputKeys: ['panel'],
  run: (db, input) => panelOutput(db, input.panel as InsightPanel),
}

/** The board's extra tool, shaped like a loaded row so Gate 2 and the executor treat it the same. */
export const INSIGHT_PANEL: LoadedTool = {
  id: INSIGHT_PANEL_TOOL,
  name: INSIGHT_PANEL_TOOL,
  definition: {
    name: INSIGHT_PANEL_TOOL,
    description: 'One of the four built-in Growth panels, pre-aggregated. Board only; never offered to the model.',
    input_schema: {
      type: 'object',
      properties: { panel: { type: 'string', enum: [...INSIGHT_PANELS] } },
      required: ['panel'],
    },
  },
  handlerType: 'builtin',
  handlerName: INSIGHT_PANEL_TOOL,
  handler: insightPanelHandler,
}

/** The tools a tile may name, and why the assistant rows are missing when they could not load. */
interface BoardTools {
  tools: LoadedTools
  loadError: ApiError | null
}

/**
 * The enabled assistant_tools rows (validated by the loader, 03 row 3) plus insight_panel. A
 * loader refusal (no_tools, tool_config_error) does not take the built-in tiles down with it:
 * it becomes the error of every tile that names an assistant tool.
 */
async function boardTools(db: D1Database): Promise<BoardTools> {
  let loaded: readonly LoadedTool[] = []
  let loadError: ApiError | null = null
  try {
    loaded = (await loadTools(db)).tools
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    console.error(JSON.stringify({ at: 'insights-board', error: err.code, message: err.message }))
    loadError = err
  }
  if (loaded.some((t) => t.name === INSIGHT_PANEL_TOOL)) {
    throw new Error(`insights-board: an assistant_tools row is named ${INSIGHT_PANEL_TOOL}, which is the board's own tool`)
  }
  const tools = [...loaded, INSIGHT_PANEL]
  return { tools: { tools, definitions: tools.map((t) => t.definition), byName: new Map(tools.map((t) => [t.name, t])) }, loadError }
}

// ── params and windows ───────────────────────────────────────────────────────────────────

/** A row of the insights table as D1 returns it (01 §insights). */
export interface InsightRow {
  id: string
  title: string
  prompt: string | null
  tool: string
  tool_version: number
  params: string
  chart: ChartOverride | null
  sort_order: number
  built_in: number
  created_at: string
}

type Params = Record<string, unknown>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The quoted `'YYYY-MM-DD'` of a string token, or null. */
function dateLiteral(text: string | undefined): string | null {
  if (text === undefined || !/^'\d{4}-\d{2}-\d{2}'$/.test(text)) return null
  const date = text.slice(1, -1)
  return isCalendarDate(date) ? date : null
}

/**
 * The one `BETWEEN 'date' AND 'date'` of a query_sql text, as offsets of its two literals.
 * Null when there is none or more than one: such a query keeps its dates as written (no window).
 */
function sqlWindow(sql: string): { from: string; to: string; spans: [[number, number], [number, number]] } | null {
  let tokens
  try {
    tokens = lexSql(sql)
  } catch (err) {
    if (err instanceof SqlLexError) return null
    throw err
  }
  const found = []
  for (let i = 0; i + 3 < tokens.length; i++) {
    const [between, a, and, b] = tokens.slice(i, i + 4)
    if (between.kind !== 'word' || between.text.toUpperCase() !== 'BETWEEN' || and.kind !== 'word' || and.text.toUpperCase() !== 'AND') continue
    const from = a.kind === 'string' ? dateLiteral(a.text) : null
    const to = b.kind === 'string' ? dateLiteral(b.text) : null
    if (from !== null && to !== null) found.push({ from, to, spans: [[a.start, a.end], [b.start, b.end]] as [[number, number], [number, number]] })
  }
  return found.length === 1 && found[0].from <= found[0].to ? found[0] : null
}

/** The checked tool input → stored params (01 §insights), detecting its window on TODAY. Pure. */
export function storedParams(tool: string, input: Params, today: string): Params {
  if (Object.hasOwn(input, 'window')) throw new ApiError(400, 'invalid_pin', 'This answer cannot be pinned: its tool input already has a "window" field.')
  if (tool === 'query_sql' && typeof input.sql === 'string') {
    const found = sqlWindow(input.sql)
    if (found === null) return { ...input }
    const [[aStart, aEnd], [bStart, bEnd]] = found.spans
    const sql = input.sql.slice(0, aStart) + WINDOW_FROM + input.sql.slice(aEnd, bStart) + WINDOW_TO + input.sql.slice(bEnd)
    return { ...input, sql, window: detectWindow(found.from, found.to, today) }
  }
  const { window_from: from, window_to: to, ...rest } = input
  if (isCalendarDate(from) && isCalendarDate(to) && from <= to) return { ...rest, window: detectWindow(from, to, today) }
  return { ...input }
}

/** The SQL with its two window placeholders replaced by the resolved dates as literals. */
function fillSqlWindow(sql: string, window: ResolvedWindow): string {
  const { sql: marked, placeholders } = rewritePlaceholders(sql)
  if (placeholders.length !== 2 || placeholders[0] !== WINDOW_FROM || placeholders[1] !== WINDOW_TO) {
    throw new Error(`insights-board: a windowed query_sql tile must hold ${WINDOW_FROM} then ${WINDOW_TO} once each`)
  }
  // The lexer finds the two `?` markers outside strings; a `?` inside a string is not one.
  const markers = lexSql(marked).filter((t) => t.kind === 'param')
  const [a, b] = markers
  return marked.slice(0, a.start) + sqlLiteral(window.from) + marked.slice(a.end, b.start) + sqlLiteral(window.to) + marked.slice(b.end)
}

/** Stored params → the tool input for a run on `today`, and the window it covers. */
export function callInput(tool: string, params: Params, today: string): { input: Params; window: ResolvedWindow | null } {
  if (!Object.hasOwn(params, 'window')) return { input: params, window: null }
  const { window: stored, ...rest } = params
  const problems = windowProblems(stored)
  if (problems.length > 0) throw new Error(`insights-board: stored window is invalid: ${problems.join('; ')}`)
  const window = resolveWindow(stored as InsightWindow, today)
  if (tool === 'query_sql') return { input: { ...rest, sql: fillSqlWindow(String(rest.sql), window) }, window }
  return { input: { ...rest, window_from: window.from, window_to: window.to }, window }
}

/**
 * Re-validation (09 D-64): Gate 2 against today's tool rows, and for query_sql Gate 2's view
 * check and Gate 3's read-only checks. Problems, empty when the call would be allowed.
 */
async function revalidate(db: D1Database, board: BoardTools, tool: string, input: Params): Promise<string[]> {
  const authorization = authorizeToolCall(board.tools, { name: tool, input })
  if (!authorization.allowed && authorization.reason === 'unknown_tool') {
    return [board.loadError?.message ?? `${tool} is not an enabled assistant tool`]
  }
  if (!authorization.allowed) return authorization.problems.map((p) => `input_schema: ${p}`)
  if (tool === 'query_sql') {
    try {
      validateSqlAgainstViews(String(input.sql), await viewSchemas(db))
      readOnlySelect(String(input.sql))
    } catch (err) {
      if (err instanceof GateDenied) return err.problems.map((p) => `${err.gate}: ${p}`)
      throw err
    }
  }
  return []
}

// ── running a tile ───────────────────────────────────────────────────────────────────────

/** One tile of GET /api/insights (04). */
export interface Tile {
  id: string
  title: string
  prompt: string | null
  tool: string
  built_in: boolean
  sort_order: number
  window: ResolvedWindow | null
  chart: ChartKind
  chart_override: ChartOverride | null
  result: { columns: string[]; rows: ResultRow[]; summary: Record<string, unknown> } | null
  segment: { count: number; filters: unknown } | null
  status: 'ok' | 'error'
  error: string | null
  ran_at: string
  explain: string
  /** Technical details (06 tile menu): the stored params and the SQL that ran. */
  params: Params
  sql: string | null
}

interface RunContext {
  db: D1Database
  trace: AuditTrace
  board: BoardTools
}

/** The problems a failed executor call sent back (format-results.ts formatToolError: one "- " line each). */
function executorProblems(content: unknown): string {
  const text = typeof content === 'string' ? content : ''
  const lines = text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2))
  return lines.length > 0 ? lines.join('; ') : 'the tool did not run'
}

function namesASubject(output: ToolOutput): boolean {
  return (
    output.columns.some((c) => SUBJECT_COLUMNS.has(c)) ||
    output.rows.some((row) => Object.values(row).some((v) => typeof v === 'string' && v.startsWith(PSEUDONYM_PREFIX)))
  )
}

/** A tile that cannot run for a reason the viewer can act on; `message` is shown on the tile. */
class TileError extends Error {
  readonly code: 'outdated' | 'tools_unavailable' | 'refused' | 'not_aggregate'
  constructor(code: TileError['code'], message: string) {
    super(message)
    this.name = 'TileError'
    this.code = code
  }
}

interface RunOutcome {
  tile: Tile
  /** Why the tile is `error`: a TileError code, blocked_pii or tile_failed; null when ok. */
  code: TileError['code'] | 'blocked_pii' | 'tile_failed' | null
}

/** Runs one tile through the executor (no model call); its failure is its own `error`. */
async function runTile(ctx: RunContext, row: InsightRow): Promise<RunOutcome> {
  const tile: Tile = {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    tool: row.tool,
    built_in: row.built_in === 1,
    sort_order: row.sort_order,
    window: null,
    chart: row.chart ?? 'table',
    chart_override: row.chart,
    result: null,
    segment: null,
    status: 'error',
    error: null,
    // Wall clock: when this run happened ("Updated just now", 06); no date rule reads it.
    ran_at: new Date().toISOString(),
    explain: row.prompt ?? row.title,
    params: {},
    sql: null,
  }
  try {
    if (row.tool_version !== INSIGHT_PARAMS_VERSION) {
      throw new TileError('outdated', `This tile was saved by an older version of the board (version ${row.tool_version}); pin the answer again.`)
    }
    const params: unknown = JSON.parse(row.params)
    if (!isObject(params)) throw new Error(`insights-board: params of tile ${row.id} is not a JSON object`)
    tile.params = params
    const { input, window } = callInput(row.tool, params, TODAY)
    tile.window = window
    if (!ctx.board.tools.byName.has(row.tool) && ctx.board.loadError !== null) throw new TileError('tools_unavailable', ctx.board.loadError.message)
    const executed = await executeToolCall({ db: ctx.db, trace: ctx.trace, tools: ctx.board.tools }, { id: `tile-${row.id}`, name: row.tool, input })
    const output = executed.output
    if (output === null) {
      // Gate 2 denied the call (an unknown tool or input), or the tool refused its input; the executor audited it.
      throw new TileError(
        'refused',
        ctx.board.tools.byName.has(row.tool)
          ? `This tile could not run: ${executorProblems(executed.result.content)}.`
          : 'The data tool behind this tile is turned off or no longer exists, so the tile cannot run.',
      )
    }
    tile.sql = output.sql ?? null
    if (output.segment !== undefined) {
      const { rows_listed: _listed, ...summary } = output.summary
      tile.result = { columns: [], rows: [], summary }
      tile.segment = { count: output.segment.count, filters: output.segment.filters }
    } else {
      if (namesASubject(output)) throw new TileError('not_aggregate', 'This tile lists individual readers; the board shows counts only. Pin a count or a segment instead.')
      tile.result = { columns: output.columns, rows: output.rows, summary: output.summary }
      if (row.tool === INSIGHT_PANEL_TOOL && typeof output.summary.explain === 'string') tile.explain = output.summary.explain
    }
    // The whole tile leaves the server: scanned once more, past the executor's own scan (05 §Scanner).
    const check = findPII({ result: tile.result, segment: tile.segment, params: tile.params, sql: tile.sql }, ctx.trace.knownEmails)
    if (check !== null) throw new PiiBlockedError(check, 'tool_result')
    tile.chart = pickChart({ columns: tile.result.columns, rows: tile.result.rows, segment: tile.segment }, row.chart)
    tile.status = 'ok'
    return { tile, code: null }
  } catch (err) {
    if (err instanceof AuditWriteError) throw err
    const message =
      err instanceof TileError
        ? err.message
        : err instanceof PiiBlockedError
          ? 'This tile was blocked because its result failed the personal-data check. The block has been logged.'
          : 'This tile could not run because of a server error. The error has been logged.'
    if (err instanceof PiiBlockedError) {
      console.error(JSON.stringify({ at: 'insights-board', trace_id: ctx.trace.traceId, tile: row.id, error: 'blocked_pii', check: err.check }))
    } else if (!(err instanceof TileError)) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      console.error(JSON.stringify({ at: 'insights-board', trace_id: ctx.trace.traceId, tile: row.id, error: 'tile_failed', reason }))
    } else {
      console.warn(JSON.stringify({ at: 'insights-board', trace_id: ctx.trace.traceId, tile: row.id, outcome: 'tile_error' }))
    }
    const code = err instanceof TileError ? err.code : err instanceof PiiBlockedError ? 'blocked_pii' : 'tile_failed'
    return { tile: { ...tile, status: 'error', error: message, result: null, segment: null }, code }
  }
}

async function openContext(db: D1Database): Promise<RunContext> {
  // No session_sub: board runs never count toward the assistant's per-session limit (09 D-40).
  return { db, trace: await startTrace(db, null), board: await boardTools(db) }
}

const SELECT_ROW = 'SELECT id, title, prompt, tool, tool_version, params, chart, sort_order, built_in, created_at FROM insights'

async function rowById(db: D1Database, id: string): Promise<InsightRow> {
  const row = await db.prepare(`${SELECT_ROW} WHERE id = ?`).bind(id).first<InsightRow>()
  if (row === null) {
    console.warn(JSON.stringify({ at: 'insights-board', outcome: 'not_found' }))
    throw new ApiError(404, 'not_found', 'There is no tile with this id.')
  }
  return row
}

// ── the four operations ──────────────────────────────────────────────────────────────────

/** GET /api/insights: every tile, re-run now (04). */
export async function listBoard(db: D1Database): Promise<{ today: string; tiles: Tile[] }> {
  const { results } = await db.prepare(`${SELECT_ROW} ORDER BY sort_order, created_at, id`).all<InsightRow>()
  const ctx = await openContext(db)
  const tiles: Tile[] = []
  for (const row of results) tiles.push((await runTile(ctx, row)).tile)
  return { today: TODAY, tiles }
}

function invalidBody(details: string[]): ApiError {
  console.warn(JSON.stringify({ at: 'insights-board', outcome: 'invalid_body', details }))
  return new ApiError(400, 'invalid_body', 'The request body is not valid for this endpoint.', details)
}

/** A body that is a JSON object with only `allowed` keys. */
export function bodyObject(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isObject(body)) throw invalidBody(['body is not a JSON object'])
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) throw invalidBody(unknown.map((k) => `unknown field: ${k}`))
  return body
}

/** A title as sent: a string, not blank, at most TITLE_MAX_CHARS characters once trimmed. */
function checkedTitle(value: unknown): string {
  if (typeof value !== 'string') throw invalidBody(['title must be a string'])
  const title = value.trim()
  if (title === '' || [...title].length > TITLE_MAX_CHARS) throw invalidBody([`title must be 1 to ${TITLE_MAX_CHARS} characters`])
  return title
}

/** Title, prompt and params must be PII-free before they are stored (01 §insights; 05 §Scanner). */
async function assertStorable(db: D1Database, fields: Record<string, unknown>): Promise<void> {
  const known = await loadKnownEmails(db)
  for (const [field, value] of Object.entries(fields)) {
    const check = findPII(value ?? '', known)
    if (check !== null) {
      console.warn(JSON.stringify({ at: 'insights-board', outcome: 'blocked_pii', field, check }))
      throw new ApiError(400, 'blocked_pii', `The ${field} contains an email address or a raw id, so it cannot be saved.`, [{ field, check }])
    }
  }
}

/** The question a trace's model received (Gate 1 redacted), or null when no model call was stored. */
async function tracePrompt(db: D1Database, traceId: string): Promise<string | null> {
  return db
    .prepare(
      `SELECT CASE json_type(request_json, '$.messages[0].content') WHEN 'text' THEN json_extract(request_json, '$.messages[0].content') END AS q
       FROM ai_audit WHERE trace_id = ? AND kind = 'model_request' ORDER BY created_at, rowid LIMIT 1`,
    )
    .bind(traceId)
    .first<string | null>('q')
}

/** POST /api/insights {audit_id, title?} → the new tile (04, 09 D-64). */
export async function pinFromTrace(db: D1Database, rawBody: unknown): Promise<Tile> {
  const body = bodyObject(rawBody, ['audit_id', 'title'])
  if (typeof body.audit_id !== 'string' || body.audit_id === '') throw invalidBody(['audit_id must be the audit id of an answer'])
  const traceId = body.audit_id
  const rows = await db.prepare('SELECT count(*) AS n FROM ai_audit WHERE trace_id = ?').bind(traceId).first<number>('n')
  if (rows === 0) {
    console.warn(JSON.stringify({ at: 'insights-board', outcome: 'pin_not_found' }))
    throw new ApiError(404, 'not_found', 'There is no audit trace with this id.')
  }
  // Only an Ask answer is pinned: a trace with no model call (a board run, 03 row 11) has no answer to keep.
  const modelCalls = await db.prepare("SELECT count(*) AS n FROM ai_audit WHERE trace_id = ? AND kind = 'model_request'").bind(traceId).first<number>('n')
  const call = await db
    .prepare(
      `SELECT tool_name, request_json FROM ai_audit
       WHERE trace_id = ? AND kind = 'tool_call' AND status = 'success'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(traceId)
    .first<{ tool_name: string; request_json: string | null }>()
  if (call === null || modelCalls === 0) {
    console.warn(JSON.stringify({ at: 'insights-board', trace_id: traceId, outcome: 'nothing_to_pin' }))
    throw new ApiError(409, 'nothing_to_pin', 'This answer did not come from a data tool, so there is nothing to pin.')
  }
  const input: unknown = call.request_json === null ? null : JSON.parse(call.request_json)
  if (!isObject(input)) throw new Error(`insights-board: the tool_call row of trace ${traceId} holds no JSON object input`)

  const prompt = await tracePrompt(db, traceId)
  const title = body.title !== undefined ? checkedTitle(body.title) : prompt !== null ? defaultTitle(prompt) : null
  if (title === null) throw invalidBody(['title is required: this trace has no question to name the tile after'])

  const params = storedParams(call.tool_name, input, TODAY)
  const board = await boardTools(db)
  const problems = await revalidate(db, board, call.tool_name, callInput(call.tool_name, params, TODAY).input)
  if (problems.length > 0) {
    console.warn(JSON.stringify({ at: 'insights-board', trace_id: traceId, outcome: 'revalidation_failed', problems }))
    throw new ApiError(400, 'invalid_pin', 'This answer can no longer be pinned: its saved tool call does not pass today’s checks.', problems)
  }
  await assertStorable(db, { title, question: prompt, 'saved input': params })

  const max = await db.prepare('SELECT coalesce(max(sort_order), 0) AS m FROM insights').first<number>('m')
  const row: InsightRow = {
    id: crypto.randomUUID(),
    title,
    prompt,
    tool: call.tool_name,
    tool_version: INSIGHT_PARAMS_VERSION,
    params: JSON.stringify(params),
    chart: null,
    sort_order: (max ?? 0) + 10,
    built_in: 0,
    // Wall clock: when the tile was pinned; operational, no date rule reads it.
    created_at: new Date().toISOString(),
  }
  const ctx = await openContext(db)
  const { tile, code } = await runTile(ctx, row)
  if (code === 'not_aggregate') throw new ApiError(400, 'not_aggregate', tile.error ?? 'The board shows counts only.')
  await db
    .prepare(
      `INSERT INTO insights (id, title, prompt, tool, tool_version, params, chart, sort_order, built_in, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.title, row.prompt, row.tool, row.tool_version, row.params, row.chart, row.sort_order, row.built_in, row.created_at)
    .run()
  return tile
}

/** The question as a default title, cut to TITLE_MAX_CHARS with an ellipsis. */
function defaultTitle(prompt: string): string {
  const chars = [...prompt.trim()]
  return chars.length <= TITLE_MAX_CHARS ? chars.join('') : `${chars.slice(0, TITLE_MAX_CHARS - 1).join('')}…`
}

/** PATCH /api/insights/:id {title?, window?, chart?, sort_order?} → the tile, re-run (04). */
export async function patchInsight(db: D1Database, id: string, rawBody: unknown): Promise<Tile> {
  const body = bodyObject(rawBody, ['title', 'window', 'chart', 'sort_order'])
  if (Object.keys(body).length === 0) throw invalidBody(['send at least one of title, window, chart, sort_order'])
  const row = await rowById(db, id)
  const next: InsightRow = { ...row }
  if (body.title !== undefined) {
    next.title = checkedTitle(body.title)
    await assertStorable(db, { title: next.title })
  }
  if (body.chart !== undefined) {
    if (body.chart !== null && !(CHART_OVERRIDES as readonly unknown[]).includes(body.chart)) {
      throw invalidBody([`chart must be null (automatic) or one of ${CHART_OVERRIDES.join(', ')}`])
    }
    next.chart = body.chart as ChartOverride | null
  }
  if (body.sort_order !== undefined) {
    if (typeof body.sort_order !== 'number' || !Number.isSafeInteger(body.sort_order)) throw invalidBody(['sort_order must be a whole number'])
    next.sort_order = body.sort_order
  }
  if (body.window !== undefined) {
    const problems = windowProblems(body.window)
    if (problems.length > 0) throw invalidBody(problems)
    const params: unknown = JSON.parse(row.params)
    if (!isObject(params) || !Object.hasOwn(params, 'window')) {
      throw new ApiError(400, 'no_window', 'This tile has no date window to change.')
    }
    const updated = { ...params, window: body.window }
    const board = await boardTools(db)
    const gateProblems = await revalidate(db, board, row.tool, callInput(row.tool, updated, TODAY).input)
    if (gateProblems.length > 0) {
      console.warn(JSON.stringify({ at: 'insights-board', tile: id, outcome: 'revalidation_failed', problems: gateProblems }))
      throw new ApiError(400, 'invalid_window', 'This window does not pass the checks for this tile.', gateProblems)
    }
    next.params = JSON.stringify(updated)
  }
  await db
    .prepare('UPDATE insights SET title = ?, chart = ?, sort_order = ?, params = ? WHERE id = ?')
    .bind(next.title, next.chart, next.sort_order, next.params, id)
    .run()
  return (await runTile(await openContext(db), next)).tile
}

/** DELETE /api/insights/:id → 204; a built-in tile is never deleted (04, 409 built_in). */
export async function deleteInsight(db: D1Database, id: string): Promise<void> {
  const row = await rowById(db, id)
  if (row.built_in === 1) {
    console.warn(JSON.stringify({ at: 'insights-board', tile: id, outcome: 'built_in' }))
    throw new ApiError(409, 'built_in', 'Built-in tiles cannot be removed. You can rename or move them.')
  }
  const result = await db.prepare('DELETE FROM insights WHERE id = ? AND built_in = 0').bind(id).run()
  if (result.meta.changes !== 1) throw new Error(`insights-board: expected to delete 1 tile, D1 reported ${result.meta.changes}`)
}
