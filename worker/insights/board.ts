// The insights board (design 09 D-64; 01 §insights; 04 §/api/insights board; 06 §/insights).
// One shared board of tiles, one table. A tile is a stored tool call, never a stored answer:
// every view re-runs every tile through the assistant's gated tool executor
// (worker/assistant/tools/tool-executor.ts: Gate 2, Gate 3 for SQL, the PII scan, the awaited
// audit row) with NO model call, so a re-run is deterministic and free (09 D-64 research: the BI
// tools re-run a stored query, never the LLM).
//
//   - pin (POST /api/insights {audit_id, title?}): the server, never the browser, decides what is
//     stored. It reads the trace's last successful `tool_call` row from ai_audit (its
//     request_json is the checked tool input, 03 row 11), refuses it unless its tool is pinnable,
//     re-validates it through Gate 2 against today's enabled assistant_tools rows (loadTools,
//     never the board's own insight_panel), and stores it. The body never carries a tool, params
//     or SQL.
//   - pinnable (09 D-64a): only fixed-SQL lookups, i.e. the `segment` and `aggregate` builtins and
//     enabled `query`-type rows. `query_sql` (SQL the model wrote) and `insight_panel` (board
//     only) are 400 `not_pinnable` with one plain sentence; the answer card learns this from
//     pinPeriod (`pin_refusal`) and offers no Pin. This removes the free-form-SQL leak class
//     instead of chasing it with an output denylist.
//   - windows: an aggregate input's window_from/window_to is stored as a window
//     (shared/insight-window.ts): rolling when it equals a preset on TODAY, else fixed. At run time
//     the window is resolved against TODAY (02 §Time) and written back as window_from/window_to,
//     two checked calendar dates from resolveWindow, never from a client; the executor then runs
//     the input through Gate 2 in full. A query row's dates live in its own SQL (`own_dates`).
//   - insight_panel: the four former /growth panels (worker/insights/*.ts) as one board-only
//     tool, so built-in tiles run through the same executor. It is NOT an assistant_tools row
//     and is never offered to the model: it exists only in the tool set this file builds for the
//     board runs (09 D-64 "tool insight_panel"), next to the loaded rows.
//   - segment tiles return the count and the filters only, never rows (06: "Open segment" opens
//     the builder). Any other tile whose rows name a subject (a pkey or visitor_hash column, a pk_
//     key in a cell, or a cell holding 8+ hex characters of a real key: KnownKeys) is refused: the
//     board holds aggregates only (04). This still matters after D-64a: a query row is data the
//     Growth team adds (09 D-41), and its fixed SQL may select pkey from a v_* view.
//   - failures: a call the gates or the handler refuse is the tile's `error` in plain words; a query
//     the database refuses, or any other server error, is "could not run right now" (a retry may
//     help). The raw problems go to console.error and the tile's `error_details` (Technical details),
//     never the level-1 `error` (09 D-64a; 06 §UI principles 2, 4).
//   - PII: the title, prompt and params are scanned before insert; on every run the whole stored
//     row (title, prompt, params) and the tool input built from it (with its SQL) are scanned
//     before the executor sees them, the executor scans every tool result, and the whole tile is
//     scanned again before it leaves (05 §Scanner). A hit is that tile's `blocked_pii` error,
//     never the board's, and the tile then carries none of its stored text.
//   - one tile's failure is that tile's `error`; the board still answers 200 (04). A failed
//     audit write is not a tile error: it fails the request loud (03 row 11).
//
// Audit: each board request opens one trace with no session_sub, so its tool_call rows sit in
// ai_audit like any other tool run but never count toward the assistant's per-session limit
// (09 D-40 counts traces per session_sub); /api/audit lists such a trace as a `board_run`
// (worker/routes/audit.ts). ran_at and created_at read the wall clock under 02 §Time's allow-list
// (`insights.created_at`, a tile's `ran_at`; 09 D-64); no date rule reads them.

import { pickChart, type ChartKind, CHART_OVERRIDES, type ChartOverride } from '../../shared/pick-chart'
import { TODAY } from '../../shared/config'
import { humanRange, PRESET_LABEL } from '../../shared/date-words'
import { detectWindow, type InsightWindow, isCalendarDate, type ResolvedWindow, resolveWindow, windowProblems } from '../../shared/insight-window'
import { type AuditTrace, AuditWriteError, startTrace } from '../assistant/audit/ai-audit'
import { authorizeToolCall } from '../assistant/gates/gate2-tool-authorizer'
import { lexSql, SqlLexError } from '../assistant/gates/gate3-readonly-sql'
import { findPII, guardPayload, loadKnownEmails, PiiBlockedError } from '../assistant/gates/pii-guard'
import type { BuiltinHandler, ResultRow, ToolOutput } from '../assistant/tools/builtin-handlers'
import { executeToolCall } from '../assistant/tools/tool-executor'
import { type LoadedTool, type LoadedTools, loadTools } from '../assistant/tools/tool-loader'
import { ApiError } from '../auth/middleware'
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
/** sort_order stays within ±SORT_ORDER_MAX, so a pin's max + 10 is always a safe integer. */
export const SORT_ORDER_MAX = 1_000_000_000

/**
 * The plain sentence of 400 `not_pinnable` (09 D-64a, verbatim), also returned with an answer as
 * `pin_refusal` so the answer card offers no Pin for it.
 */
export const NOT_PINNABLE_MESSAGE = "Answers written as free-form queries can't be pinned. Ask the Growth team to add this as a saved question type."
/** A tile whose lookup failed on the server side (a query the database refused, any other error): a retry may help (09 D-64a). */
export const TILE_RUN_FAILED_MESSAGE = 'This tile could not run right now. Press Refresh to try again.'
/** A pin whose first run or store failed on the server side (09 D-64a). */
export const PIN_FAILED_MESSAGE = 'The answer could not be pinned because of a server error. Try Pin to board again.'
/** The builtin handlers whose lookups can be pinned; every `query` row can be too (09 D-64a). */
const PINNABLE_BUILTINS: ReadonlySet<string> = new Set(['segment', 'aggregate'])
/** Tool names never pinned, even when their row is not loaded to say what it runs (09 D-64a). */
const NEVER_PINNED: ReadonlySet<string> = new Set(['query_sql', INSIGHT_PANEL_TOOL])
/** Columns of the v_* views that name one subject (01 §PII-free views, 05 §Pseudonymous key). */
const SUBJECT_COLUMNS = new Set(['pkey', 'visitor_hash'])
/** A pseudonymous key's shape anywhere in a cell (`pk_` + 16 hex, shared/pseudonym.ts), known or not. */
const PSEUDONYM = /pk_[0-9a-f]{16}/i
/**
 * The shortest piece of a real key that still names its subject. Eight hex characters is one in
 * 4.3 billion: a cell holding a run of them that occurs in a real key is read as that key cut short
 * (substr(pkey, 4, 15), substr(visitor_hash, 5, 10), …), whatever its length or its column name.
 */
export const KEY_PIECE_CHARS = 8
const HEX_RUN = new RegExp(`[0-9a-f]{${KEY_PIECE_CHARS},}`, 'gi')

/**
 * Every pseudonymous key the database holds (profiles.pkey, web_visitors.visitor_hash), indexed by
 * each of its KEY_PIECE_CHARS-long pieces, so a cell is checked in one pass of its hex runs. Loaded
 * per request (03 §No-restart: never cached), as loadKnownEmails is.
 */
export class KnownKeys {
  private readonly pieces: ReadonlySet<string>
  constructor(keys: Iterable<string>) {
    const pieces = new Set<string>()
    for (const key of keys) {
      const hex = key.toLowerCase().replace(/^pk_/, '')
      if (!/^[0-9a-f]+$/.test(hex) || hex.length < KEY_PIECE_CHARS) {
        // Never echo the value: it names a subject.
        throw new Error('insights-board: a stored pseudonymous key is not pk_ + hex')
      }
      for (let i = 0; i + KEY_PIECE_CHARS <= hex.length; i++) pieces.add(hex.slice(i, i + KEY_PIECE_CHARS))
    }
    this.pieces = pieces
  }

  /** True when `text` holds a run of KEY_PIECE_CHARS or more hex characters that occurs in a real key. */
  occursIn(text: string): boolean {
    for (const [run] of text.matchAll(HEX_RUN)) {
      const hex = run.toLowerCase()
      for (let i = 0; i + KEY_PIECE_CHARS <= hex.length; i++) if (this.pieces.has(hex.slice(i, i + KEY_PIECE_CHARS))) return true
    }
    return false
  }
}

export async function loadKnownKeys(db: D1Database): Promise<KnownKeys> {
  const { results } = await db.prepare('SELECT pkey AS k FROM profiles UNION ALL SELECT visitor_hash FROM web_visitors').all<{ k: string }>()
  return new KnownKeys(results.map((r) => r.k))
}

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

function toolSet(tools: readonly LoadedTool[], loadError: ApiError | null): BoardTools {
  return { tools: { tools, definitions: tools.map((t) => t.definition), byName: new Map(tools.map((t) => [t.name, t])) }, loadError }
}

/**
 * The enabled assistant_tools rows (validated by the loader, 03 row 3): what a pin is checked
 * against (09 D-64a). A loader refusal (no_tools, tool_config_error) is kept as `loadError`, not
 * thrown, so it becomes a pin's re-validation problem or the error of every tile that names an
 * assistant tool, and does not take the built-in tiles down with it.
 */
async function assistantTools(db: D1Database): Promise<BoardTools> {
  try {
    const loaded = (await loadTools(db)).tools
    if (loaded.some((t) => t.name === INSIGHT_PANEL_TOOL)) {
      throw new Error(`insights-board: an assistant_tools row is named ${INSIGHT_PANEL_TOOL}, which is the board's own tool`)
    }
    return toolSet(loaded, null)
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    console.error(JSON.stringify({ at: 'insights-board', error: err.code, message: err.message }))
    return toolSet([], err)
  }
}

/** What a board run may call: the enabled assistant_tools rows plus insight_panel, run-only. */
async function boardTools(db: D1Database): Promise<BoardTools> {
  const assistant = await assistantTools(db)
  return toolSet([...assistant.tools.tools, INSIGHT_PANEL], assistant.loadError)
}

/**
 * Whether an answer's tool can be pinned (09 D-64a): `pinnable`, `not_pinnable`, or `unknown`
 * when its row is not loaded (turned off or gone), which re-validation then reports.
 */
function pinnability(tools: BoardTools, tool: string): 'pinnable' | 'not_pinnable' | 'unknown' {
  if (NEVER_PINNED.has(tool)) return 'not_pinnable'
  const loaded = tools.tools.byName.get(tool)
  if (loaded === undefined) return 'unknown'
  return loaded.handlerType === 'query' || PINNABLE_BUILTINS.has(loaded.handlerName) ? 'pinnable' : 'not_pinnable'
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

/** The one `BETWEEN 'date' AND 'date'` of an SQL text; null when there is none or more than one. */
function sqlWindow(sql: string): { from: string; to: string } | null {
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
    if (from !== null && to !== null) found.push({ from, to })
  }
  return found.length === 1 && found[0].from <= found[0].to ? found[0] : null
}

/** The checked tool input → stored params (01 §insights), detecting its window on TODAY. Pure. */
export function storedParams(input: Params, today: string): Params {
  if (Object.hasOwn(input, 'window')) throw new ApiError(400, 'invalid_pin', 'This answer cannot be pinned: its tool input already has a "window" field.')
  const { window_from: from, window_to: to, ...rest } = input
  if (isCalendarDate(from) && isCalendarDate(to) && from <= to) return { ...rest, window: detectWindow(from, to, today) }
  return { ...input }
}

/**
 * The dates a lookup sets itself (06 §/insights "uses its own dates"): the one `BETWEEN 'date' AND
 * 'date'` of the SQL that ran, when the tile has no window to change. A query row renders its
 * dates from TODAY when the tools load (scripts/tool-seeds.ts), so these are TODAY's dates too.
 * Null when the SQL names none or more than one.
 */
export function ownDates(sql: string | null): { from: string; to: string } | null {
  if (sql === null) return null
  const found = sqlWindow(sql)
  return found === null ? null : { from: found.from, to: found.to }
}

/**
 * Stored params → the tool input for a run on `today`, and the window it covers. A stored window
 * always becomes window_from/window_to: a tool that takes neither (any tile but an aggregate, after
 * drift) is then refused by Gate 2, never run with its dates dropped.
 */
export function callInput(params: Params, today: string): { input: Params; window: ResolvedWindow | null } {
  if (!Object.hasOwn(params, 'window')) return { input: params, window: null }
  const { window: stored, ...rest } = params
  const problems = windowProblems(stored)
  if (problems.length > 0) throw new Error(`insights-board: stored window is invalid: ${problems.join('; ')}`)
  const window = resolveWindow(stored as InsightWindow, today)
  return { input: { ...rest, window_from: window.from, window_to: window.to }, window }
}

/**
 * Re-validation (09 D-64, D-64a): Gate 2 against today's enabled assistant_tools rows only
 * (assistantTools; never insight_panel). Problems, empty when the call would be allowed. A pinnable
 * tool runs no SQL of the call's own: a query row's template passed Gate 2 and Gate 3 when the
 * loader validated it (tool-loader.ts), and the first run passes both again in the executor.
 */
function revalidate(tools: BoardTools, tool: string, input: Params): string[] {
  const authorization = authorizeToolCall(tools.tools, { name: tool, input })
  if (!authorization.allowed && authorization.reason === 'unknown_tool') {
    return [tools.loadError?.message ?? `${tool} is not an enabled assistant tool`]
  }
  if (!authorization.allowed) return authorization.problems.map((p) => `input_schema: ${p}`)
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
  /** The dates the lookup sets itself when it has no window (ownDates), else null. */
  own_dates: { from: string; to: string } | null
  chart: ChartKind
  chart_override: ChartOverride | null
  result: { columns: string[]; rows: ResultRow[]; summary: Record<string, unknown> } | null
  segment: { count: number; filters: unknown } | null
  status: 'ok' | 'error'
  /** Why the tile did not run, in plain words (level 1); null when ok. */
  error: string | null
  /**
   * Technical details of a failed run: the gates' or the database's problems, already through the
   * executor's PII scan (09 D-64a: raw text only here). Null when ok, blocked or unexplained.
   */
  error_details: string | null
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
  keys: KnownKeys
}

/** The problems a failed executor call sent back (format-results.ts formatToolError: one "- " line each). */
function executorProblems(content: unknown): string[] {
  const text = typeof content === 'string' ? content : ''
  const lines = text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2))
  return lines.length > 0 ? lines : ['the tool did not run']
}

/** A result names a subscriber: a key column, a pk_ key in a cell, or a piece of a real key in a cell (04). */
function namesASubject(output: ToolOutput, keys: KnownKeys): boolean {
  return (
    output.columns.some((c) => SUBJECT_COLUMNS.has(c)) ||
    output.rows.some((row) => Object.values(row).some((v) => typeof v === 'string' && (PSEUDONYM.test(v) || keys.occursIn(v))))
  )
}

/**
 * The "Explain this" question of a pinned tile. With no window it is the question the tile was
 * pinned from. With one, the tile's title and the dates it shows now lead, and the pinned question
 * follows as context, so a tile moved to "Last 30 days" whose question says "last month" is
 * explained for the tile's dates only. The dates are the resolved window, never a client value.
 */
export function explainQuestion(title: string, prompt: string, window: ResolvedWindow | null): string {
  if (window === null) return prompt
  const range = humanRange(window.from, window.to)
  const period = window.kind === 'rolling' ? `${range} only (${PRESET_LABEL[window.preset].toLowerCase()})` : `${range} only`
  return `Explain “${title}” for ${period}. It was pinned from: ${prompt}`
}

/** What a tile blocked by the personal-data check shows in place of every stored text (04). */
export const BLOCKED_TILE_TITLE = 'Blocked tile'

/**
 * A tile that cannot run for a known reason; `message` is shown on the tile (level 1), `details`
 * (the gates' or the database's problems) only in its Technical details.
 */
class TileError extends Error {
  readonly code: 'outdated' | 'tools_unavailable' | 'refused' | 'query_failed' | 'not_aggregate'
  readonly details: readonly string[]
  constructor(code: TileError['code'], message: string, details: readonly string[] = []) {
    super(message)
    this.name = 'TileError'
    this.code = code
    this.details = details
  }
}

interface RunOutcome {
  tile: Tile
  /** Why the tile is `error`: a TileError code, blocked_pii or tile_failed; null when ok. */
  code: TileError['code'] | 'blocked_pii' | 'tile_failed' | null
  /** The problems behind a TileError (TileError.details); empty otherwise. */
  details: readonly string[]
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
    own_dates: null,
    chart: row.chart ?? 'table',
    chart_override: row.chart,
    result: null,
    segment: null,
    status: 'error',
    error: null,
    error_details: null,
    // Wall clock: when this run happened (02 §Time allow-list, tile `ran_at`; 09 D-64).
    ran_at: new Date().toISOString(),
    explain: row.prompt ?? row.title,
    params: {},
    sql: null,
  }
  try {
    // Every stored text leaves on the tile (title, prompt, explain, params), so the whole stored row
    // is scanned before anything else: a value that drifted to hold an email stops this tile here,
    // before it reaches the executor's audit row or the response (05 §Scanner; T-INS-9).
    await guardPayload(ctx.trace, { title: row.title, prompt: row.prompt, params: row.params }, 'audit_row', row.tool)
    if (row.tool_version !== INSIGHT_PARAMS_VERSION) {
      throw new TileError('outdated', `This tile was saved by an older version of the board (version ${row.tool_version}); pin the answer again.`)
    }
    const params: unknown = JSON.parse(row.params)
    if (!isObject(params)) throw new Error(`insights-board: params of tile ${row.id} is not a JSON object`)
    tile.params = params
    const { input, window } = callInput(params, TODAY)
    tile.window = window
    if (row.prompt !== null) tile.explain = explainQuestion(row.title, row.prompt, window)
    // The input built from the params (with its SQL and dates) is scanned before the executor
    // stores it in an audit row (05 §Scanner).
    await guardPayload(ctx.trace, { input }, 'audit_row', row.tool)
    if (!ctx.board.tools.byName.has(row.tool) && ctx.board.loadError !== null) throw new TileError('tools_unavailable', ctx.board.loadError.message)
    const executed = await executeToolCall({ db: ctx.db, trace: ctx.trace, tools: ctx.board.tools }, { id: `tile-${row.id}`, name: row.tool, input })
    const output = executed.output
    if (output === null) {
      // The executor audited the refusal (03 row 11); its problems are already PII-scanned.
      if (!ctx.board.tools.byName.has(row.tool)) {
        throw new TileError('refused', 'The data tool behind this tile is turned off or no longer exists, so the tile cannot run.')
      }
      const problems = executorProblems(executed.result.content)
      if (executed.refusal === 'query_failed') {
        // The database refused the query: a server-side failure, worth a retry (09 D-64a).
        console.error(JSON.stringify({ at: 'insights-board', trace_id: ctx.trace.traceId, tile: row.id, error: 'query_failed', problems }))
        throw new TileError('query_failed', TILE_RUN_FAILED_MESSAGE, problems)
      }
      // Gate 2 or Gate 3 denied the call, or the tool refused its input: the stored call is wrong.
      throw new TileError('refused', 'This tile’s saved lookup no longer passes today’s checks, so it cannot run. Technical details say why.', problems)
    }
    tile.sql = output.sql ?? null
    if (window === null) tile.own_dates = ownDates(tile.sql)
    if (output.segment !== undefined) {
      const { rows_listed: _listed, ...summary } = output.summary
      tile.result = { columns: [], rows: [], summary }
      tile.segment = { count: output.segment.count, filters: output.segment.filters }
    } else {
      if (namesASubject(output, ctx.keys)) {
        throw new TileError('not_aggregate', 'This tile lists individual subscribers; the board shows counts only. Pin a count or a segment instead.')
      }
      tile.result = { columns: output.columns, rows: output.rows, summary: output.summary }
      if (row.tool === INSIGHT_PANEL_TOOL && typeof output.summary.explain === 'string') tile.explain = output.summary.explain
    }
    // The whole tile leaves the server: scanned once more, past the executor's own scan and the
    // stored-row scan above (05 §Scanner). Defense in depth: every part was scanned on its way in,
    // so no reachable input trips this one; it stays so a new tile field cannot leave unscanned.
    const { status: _status, error: _error, ran_at: _ranAt, ...leaving } = tile
    await guardPayload(ctx.trace, leaving, 'tool_result', row.tool)
    tile.chart = pickChart({ columns: tile.result.columns, rows: tile.result.rows, segment: tile.segment }, row.chart)
    tile.status = 'ok'
    return { tile, code: null, details: [] }
  } catch (err) {
    if (err instanceof AuditWriteError) throw err
    const message =
      err instanceof TileError
        ? err.message
        : err instanceof PiiBlockedError
          ? 'This tile was blocked because it failed the personal-data check. The block has been logged.'
          : TILE_RUN_FAILED_MESSAGE
    if (err instanceof PiiBlockedError) {
      console.error(JSON.stringify({ at: 'insights-board', trace_id: ctx.trace.traceId, tile: row.id, error: 'blocked_pii', check: err.check }))
    } else if (!(err instanceof TileError)) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      console.error(JSON.stringify({ at: 'insights-board', trace_id: ctx.trace.traceId, tile: row.id, error: 'tile_failed', reason }))
    } else {
      console.warn(JSON.stringify({ at: 'insights-board', trace_id: ctx.trace.traceId, tile: row.id, outcome: 'tile_error' }))
    }
    const code = err instanceof TileError ? err.code : err instanceof PiiBlockedError ? 'blocked_pii' : 'tile_failed'
    const details = err instanceof TileError ? err.details : []
    // A blocked tile carries none of its stored text: a fixed title, no question, params or SQL.
    const scrubbed =
      err instanceof PiiBlockedError
        ? { title: BLOCKED_TILE_TITLE, explain: BLOCKED_TILE_TITLE, prompt: null, params: {}, sql: null, window: null, own_dates: null }
        : {}
    const error_details = details.length > 0 ? details.join('; ') : null
    return { tile: { ...tile, ...scrubbed, status: 'error', error: message, error_details, result: null, segment: null }, code, details }
  }
}

async function openContext(db: D1Database): Promise<RunContext> {
  // No session_sub: board runs never count toward the assistant's per-session limit (09 D-40).
  return { db, trace: await startTrace(db, null), board: await boardTools(db), keys: await loadKnownKeys(db) }
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

/** 400 invalid_body. `logged` replaces `details` in the log line when the details quote what the client sent. */
function invalidBody(details: string[], logged: string[] = details): ApiError {
  console.warn(JSON.stringify({ at: 'insights-board', outcome: 'invalid_body', details: logged }))
  return new ApiError(400, 'invalid_body', 'The request body is not valid for this endpoint.', details)
}

/**
 * A body that is a JSON object with only `allowed` keys. An unknown key is a client's text, so the
 * log names how many there were, never the keys (05 §Scanner "logging"); the response, which goes
 * back only to that client, names them.
 */
export function bodyObject(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isObject(body)) throw invalidBody(['body is not a JSON object'])
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) {
    throw invalidBody(
      unknown.map((k) => `unknown field: ${k}`),
      [`${unknown.length} unknown field${unknown.length === 1 ? '' : 's'}; allowed: ${allowed.join(', ')}`],
    )
  }
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

/**
 * POST /api/insights {audit_id, title?} → the new tile (04, 09 D-64). A server-side failure (a
 * database error, a failed audit write) is logged and answered with one plain retry sentence,
 * 500 internal_error (09 D-64a); nothing is stored.
 */
export async function pinFromTrace(db: D1Database, rawBody: unknown): Promise<Tile> {
  try {
    return await pin(db, rawBody)
  } catch (err) {
    if (err instanceof ApiError) throw err
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error(JSON.stringify({ at: 'insights-board', outcome: 'pin_failed', reason }))
    throw new ApiError(500, 'internal_error', PIN_FAILED_MESSAGE)
  }
}

async function pin(db: D1Database, rawBody: unknown): Promise<Tile> {
  const body = bodyObject(rawBody, ['audit_id', 'title'])
  if (typeof body.audit_id !== 'string' || body.audit_id === '') throw invalidBody(['audit_id must be the audit id of an answer'])
  const traceId = body.audit_id
  const rows = await db.prepare('SELECT count(*) AS n FROM ai_audit WHERE trace_id = ?').bind(traceId).first<number>('n')
  if (rows === 0) {
    console.warn(JSON.stringify({ at: 'insights-board', outcome: 'pin_not_found' }))
    throw new ApiError(404, 'not_found', 'There is no audit trace with this id.')
  }
  // Only an Ask answer is pinned: a trace with no model call (a board run, 03 row 11) has no answer to keep.
  const call = await pinnableCall(db, traceId)
  if (call === null) {
    console.warn(JSON.stringify({ at: 'insights-board', trace_id: traceId, outcome: 'nothing_to_pin' }))
    throw new ApiError(409, 'nothing_to_pin', 'This answer did not come from a data tool, so there is nothing to pin.')
  }
  const { tool_name: toolName, input } = call
  // Only fixed-SQL lookups are pinned (09 D-64a), checked against the enabled assistant_tools rows only.
  const tools = await assistantTools(db)
  if (pinnability(tools, toolName) === 'not_pinnable') {
    console.warn(JSON.stringify({ at: 'insights-board', trace_id: traceId, outcome: 'not_pinnable', tool_name: toolName }))
    throw new ApiError(400, 'not_pinnable', NOT_PINNABLE_MESSAGE)
  }

  const prompt = await tracePrompt(db, traceId)
  const title = body.title !== undefined ? checkedTitle(body.title) : prompt !== null ? defaultTitle(prompt) : null
  if (title === null) throw invalidBody(['title is required: this trace has no question to name the tile after'])

  const params = storedParams(input, TODAY)
  const problems = revalidate(tools, toolName, callInput(params, TODAY).input)
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
    tool: toolName,
    tool_version: INSIGHT_PARAMS_VERSION,
    params: JSON.stringify(params),
    chart: null,
    // A new tile goes last; sort_order is bounded (SORT_ORDER_MAX), so this stays a safe integer.
    sort_order: Math.min((max ?? 0) + 10, SORT_ORDER_MAX),
    built_in: 0,
    // Wall clock: when the tile was pinned (02 §Time allow-list, `insights.created_at`; 09 D-64).
    created_at: new Date().toISOString(),
  }
  const ctx = await openContext(db)
  const { tile, code, details } = await runTile(ctx, row)
  // Fail safe: a tile whose first run fails is never stored (04).
  if (code === 'not_aggregate') throw new ApiError(400, 'not_aggregate', tile.error ?? 'The board shows counts only.')
  if (code === 'blocked_pii') throw new ApiError(400, 'blocked_pii', 'This answer cannot be pinned: its result failed the personal-data check.')
  // runTile logged the reason (09 D-64a: a database failure is a 500 with a plain retry sentence).
  if (code === 'tile_failed' || code === 'query_failed') throw new ApiError(500, 'internal_error', PIN_FAILED_MESSAGE)
  if (code !== null) {
    console.warn(JSON.stringify({ at: 'insights-board', trace_id: traceId, outcome: 'first_run_refused', code }))
    throw new ApiError(400, 'invalid_pin', 'This answer can no longer be pinned: its saved lookup does not run today.', details.length > 0 ? [...details] : undefined)
  }
  await db
    .prepare(
      `INSERT INTO insights (id, title, prompt, tool, tool_version, params, chart, sort_order, built_in, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.title, row.prompt, row.tool, row.tool_version, row.params, row.chart, row.sort_order, row.built_in, row.created_at)
    .run()
  return tile
}

/**
 * The trace of an Ask answer: its last successful tool call (tool, the checked input and, for a
 * call that ran SQL, the SQL that ran), or null. Whether that call can be pinned is pinnability's.
 */
async function pinnableCall(db: D1Database, traceId: string): Promise<{ tool_name: string; input: Params; sql: string | null } | null> {
  // Only an Ask answer is pinned: a trace with no model call (a board run, 03 row 11) has no answer to keep.
  const modelCalls = await db.prepare("SELECT count(*) AS n FROM ai_audit WHERE trace_id = ? AND kind = 'model_request'").bind(traceId).first<number>('n')
  if (modelCalls === 0) return null
  const call = await db
    .prepare(
      `SELECT tool_name, request_json, sql FROM ai_audit
       WHERE trace_id = ? AND kind = 'tool_call' AND status = 'success'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(traceId)
    .first<{ tool_name: string; request_json: string | null; sql: string | null }>()
  if (call === null) return null
  const input: unknown = call.request_json === null ? null : JSON.parse(call.request_json)
  if (!isObject(input)) throw new Error(`insights-board: the tool_call row of trace ${traceId} holds no JSON object input`)
  return { tool_name: call.tool_name, input, sql: call.sql }
}

/**
 * What a pin of this answer would keep as its time period (04 POST /api/assistant): `window`, the
 * window it would store, resolved on TODAY, or null when its lookup takes none (a segment, a query
 * with its dates written in more than once) or there is nothing to pin; and `own_dates`, the dates
 * the lookup sets itself when it takes no window (ownDates of the SQL that ran), which the tile
 * then shows in its footer; `refusal`, the not_pinnable sentence when its tool can never be pinned
 * (09 D-64a), with no window. The same reading POST /api/insights does, so the pin dialog offers
 * Rolling/Fixed only when the server will keep the choice, and names dates only when the tile will.
 */
export async function pinPeriod(
  db: D1Database,
  traceId: string,
): Promise<{ window: ResolvedWindow | null; own_dates: { from: string; to: string } | null; refusal: string | null }> {
  const call = await pinnableCall(db, traceId)
  if (call === null) return { window: null, own_dates: null, refusal: null }
  // The same refusal POST /api/insights gives (09 D-64a): the card then offers no Pin and says why.
  if (pinnability(await assistantTools(db), call.tool_name) === 'not_pinnable') return { window: null, own_dates: null, refusal: NOT_PINNABLE_MESSAGE }
  if (Object.hasOwn(call.input, 'window')) return { window: null, own_dates: null, refusal: null }
  const window = callInput(storedParams(call.input, TODAY), TODAY).window
  return { window, own_dates: window === null ? ownDates(call.sql) : null, refusal: null }
}

/** The question as a default title, cut to TITLE_MAX_CHARS with an ellipsis. */
function defaultTitle(prompt: string): string {
  const chars = [...prompt.trim()]
  return chars.length <= TITLE_MAX_CHARS ? chars.join('') : `${chars.slice(0, TITLE_MAX_CHARS - 1).join('')}…`
}

/** A segment tile, by its tool: the loaded row's handler, or, when that row is not loaded, its name. */
function isSegmentTool(board: BoardTools, tool: string): boolean {
  const loaded = board.tools.byName.get(tool)
  return loaded === undefined ? tool === 'segment' : loaded.handlerType === 'builtin' && loaded.handlerName === 'segment'
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
    if (typeof body.sort_order !== 'number' || !Number.isSafeInteger(body.sort_order) || Math.abs(body.sort_order) > SORT_ORDER_MAX) {
      throw invalidBody([`sort_order must be a whole number from -${SORT_ORDER_MAX} to ${SORT_ORDER_MAX}`])
    }
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
    const gateProblems = revalidate(await assistantTools(db), row.tool, callInput(updated, TODAY).input)
    if (gateProblems.length > 0) {
      console.warn(JSON.stringify({ at: 'insights-board', tile: id, outcome: 'revalidation_failed', problems: gateProblems }))
      throw new ApiError(400, 'invalid_window', 'This window does not pass the checks for this tile.', gateProblems)
    }
    next.params = JSON.stringify(updated)
  }
  const ctx = await openContext(db)
  // A segment tile always shows its count and "Open segment" (09 D-64), so a chart override on it is
  // refused rather than drawn without them. Whether it is one is read from its tool, not from this
  // run, which may fail (a tool turned off) and still store the override.
  if (next.chart !== null && body.chart !== undefined && isSegmentTool(ctx.board, row.tool)) {
    throw invalidBody(['chart cannot be set on a segment tile: it always shows its count and "Open segment"'])
  }
  // The tile is run as it would be stored, then stored. A run the personal-data check blocks is
  // never stored (fail safe, as a pin); any other failed run still stores the change, so a tile
  // whose tool is turned off can be renamed or moved, and shows its error on the board (04).
  const { tile, code } = await runTile(ctx, next)
  if (code === 'blocked_pii') {
    throw new ApiError(400, 'blocked_pii', 'This change cannot be saved: the tile failed the personal-data check.')
  }
  await db
    .prepare('UPDATE insights SET title = ?, chart = ?, sort_order = ?, params = ? WHERE id = ?')
    .bind(next.title, next.chart, next.sort_order, next.params, id)
    .run()
  return tile
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
