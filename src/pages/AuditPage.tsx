// /audit and /audit/:traceId (06 §/audit, R5.5; 05 §Proof surfaces): "AI audit log".
// The list (GET /api/audit?limit=, 04): the latest questions sent to the assistant, newest first:
// when, the question as the AI received it (emails already replaced by [email]), the result and
// the tokens used, with a Refresh button. Each question opens its trace.
// The trace (GET /api/audit/:trace_id): every stored step in order, each kind in plain words
// (sent to the AI, looked up data, blocked) with its result at level 1; level 2 (Details) holds
// timing, tokens and rows found; Technical details holds the raw names, ids, second-precise UTC
// times and the stored request_json, response_json and SQL exactly as stored (06 §UI principles 2).
// A search box counts matches in that stored text, so searching "@" shows zero (12 beat 5); the
// count is announced politely. The re-hydrated result is never stored (05 §Re-hydration), so it
// is on /assistant only.

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { errorMessage, getJson } from '../api'
import {
  Announcer,
  Button,
  type Column,
  Disclosure,
  EmptyState,
  ErrorLine,
  Field,
  Loading,
  PageHeader,
  ResponsiveTable,
  Tag,
  TechnicalDetails,
} from '../components'
import { humanDateTime, utc } from '../format'
import type { AuditList, AuditRow, AuditStatus, AuditTrace, AuditTraceSummary } from '../types'
import { type GetState, useGet } from '../useGet'

/** Questions the list shows (04 allows 1–100). */
const LIST_LIMIT = 50

const linkClass =
  'inline-flex min-h-6 items-center text-blue-700 underline underline-offset-2 hover:text-blue-900'

const fmt = (n: number) => n.toLocaleString('en-US')

/** A trace's result in words (the most severe row status). */
const TRACE_STATUS: Record<AuditStatus, string> = { success: 'Answered', error: 'Failed', blocked: 'Blocked' }
/** One step's result in words. */
const STEP_STATUS: Record<AuditStatus, string> = { success: 'Done', error: 'Failed', blocked: 'Blocked' }

/** Plain words for the seeded tools (scripts/tool-seeds.ts); any other tool is named in Technical details. */
const TOOL_LABEL: Record<string, string> = {
  segment: 'Built a list of readers',
  aggregate: 'Counted readers',
  query_sql: 'Ran a read-only query on the data',
}

/** Why a step was blocked, in words, from the stored error's code (worker/assistant writers). */
const BLOCK_REASON: Array<[string, string]> = [
  ['gate1', 'The question was refused by the input check before anything was sent to the AI.'],
  ['blocked_pii', 'Personal data was found, so the request was stopped and nothing more was sent.'],
  [
    'sql_in_output',
    "The AI's wording held database code, so it was replaced with a plain sentence from the server.",
  ],
  ['rate_limited', 'Too many questions were asked this hour.'],
  ['assistant_unavailable', 'The AI key is not set up on this server.'],
  ['no_tools', 'The assistant has no data tools turned on.'],
  ['tool_config_error', 'A data tool is set up wrongly.'],
  ['unknown_tool', 'The AI asked for a data tool that does not exist.'],
]

function blockReason(error: string | null): string {
  const found = BLOCK_REASON.find(([code]) => error?.startsWith(code))
  return found?.[1] ?? 'This step was blocked.'
}

/** `first`: the trace's first model request, which carried the question. */
function stepTitle(row: AuditRow, first: boolean): string {
  if (row.kind === 'model_request')
    return first ? 'Sent the question to the AI' : 'Sent the data it asked for back to the AI'
  if (row.kind === 'tool_call')
    return (row.tool_name !== null && TOOL_LABEL[row.tool_name]) || 'Used a data tool'
  return 'Blocked'
}

function stepSummary(row: AuditRow): string {
  if (row.kind === 'blocked') return blockReason(row.error)
  if (row.kind === 'model_request') {
    if (row.status === 'error') return 'The AI service did not answer.'
    return `The AI answered, using ${fmt((row.tokens_in ?? 0) + (row.tokens_out ?? 0))} tokens.`
  }
  if (row.status === 'error') return 'The tool could not run.'
  return row.row_count === null
    ? 'The tool ran.'
    : `Found ${fmt(row.row_count)} ${row.row_count === 1 ? 'row' : 'rows'}.`
}

/** Occurrences of `needle` in `text`, ignoring case. */
function occurrences(text: string | null, needle: string): number {
  if (text === null || needle === '') return 0
  const hay = text.toLowerCase()
  const n = needle.toLowerCase()
  let count = 0
  for (let at = hay.indexOf(n); at !== -1; at = hay.indexOf(n, at + n.length)) count += 1
  return count
}

/** Matches in every stored text field of one row. */
function rowMatches(row: AuditRow, needle: string): number {
  return [row.request_json, row.response_json, row.sql, row.error].reduce(
    (sum, field) => sum + occurrences(field, needle),
    0,
  )
}

function Stored({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null
  return (
    <div className="pt-2">
      <p className="font-medium">{label}</p>
      <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-all font-mono">{value}</pre>
    </div>
  )
}

function Step({ row, title, matches }: { row: AuditRow; title: string; matches: number | null }) {
  const tokens =
    row.tokens_in === null && row.tokens_out === null ? null : (row.tokens_in ?? 0) + (row.tokens_out ?? 0)
  return (
    <li className="space-y-2 rounded border border-gray-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold text-gray-900">{title}</h2>
        <Tag>{STEP_STATUS[row.status]}</Tag>
        {matches !== null && matches > 0 && (
          <Tag>{matches === 1 ? '1 match' : `${fmt(matches)} matches`}</Tag>
        )}
      </div>
      <p className="text-sm text-gray-700">{stepSummary(row)}</p>
      <Disclosure label="Details">
        <dl className="space-y-1">
          <Field label="When">{humanDateTime(row.created_at)}</Field>
          {row.latency_ms !== null && <Field label="Took">{fmt(row.latency_ms)} ms</Field>}
          {tokens !== null && (
            <Field label="Tokens">
              {fmt(row.tokens_in ?? 0)} sent, {fmt(row.tokens_out ?? 0)} received
            </Field>
          )}
          {row.row_count !== null && <Field label="Rows found">{fmt(row.row_count)}</Field>}
          {row.model !== null && <Field label="AI model">{row.model}</Field>}
        </dl>
        <TechnicalDetails>
          <p>
            id: <span className="font-mono break-all">{row.id}</span>
          </p>
          <p>
            kind: <span className="font-mono">{row.kind}</span> · status:{' '}
            <span className="font-mono">{row.status}</span>
            {row.tool_name !== null && (
              <>
                {' '}
                · tool_name: <span className="font-mono">{row.tool_name}</span>
              </>
            )}
          </p>
          <p>
            created_at: <span className="font-mono">{utc(row.created_at)}</span>
          </p>
          <Stored label="error" value={row.error} />
          <Stored label="sql" value={row.sql} />
          <Stored label="request_json (exactly as stored)" value={row.request_json} />
          <Stored label="response_json (exactly as stored)" value={row.response_json} />
        </TechnicalDetails>
      </Disclosure>
    </li>
  )
}

function TraceView({ traceId }: { traceId: string }) {
  const state = useGet<AuditTrace>(`/api/audit/${encodeURIComponent(traceId)}`)
  const [search, setSearch] = useState('')
  const needle = search.trim()

  const back = (
    <Link to="/audit" className={linkClass}>
      Back to all questions
    </Link>
  )
  const header = (purpose?: string) => (
    <PageHeader title="One question, step by step" purpose={purpose} action={back} />
  )

  if (state === null || state.status === 'loading') {
    return (
      <div className="space-y-6">
        {header()}
        <Loading label="Loading the stored steps…" />
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="space-y-6">
        {header()}
        <ErrorLine message={state.message} next="Pick a question from the AI audit log." />
      </div>
    )
  }

  const rows = state.data.rows
  const firstModel = rows.find((r) => r.kind === 'model_request')
  let question: string | null = null
  if (firstModel?.request_json != null) {
    try {
      const content = (JSON.parse(firstModel.request_json) as { messages?: { content?: unknown }[] })
        .messages?.[0]?.content
      if (typeof content === 'string') question = content
    } catch (err) {
      console.error('audit: request_json is not JSON', err)
    }
  }
  const titles = rows.map((row) => stepTitle(row, row === firstModel))
  const perRow = rows.map((row) => (needle === '' ? null : rowMatches(row, needle)))
  const total = perRow.reduce<number>((sum, n) => sum + (n ?? 0), 0)
  const stepsHit = perRow.filter((n) => n !== null && n > 0).length
  let searchResult = ''
  if (needle !== '') {
    searchResult =
      total === 0
        ? `No matches for “${needle}” in what was stored.`
        : `${fmt(total)} ${total === 1 ? 'match' : 'matches'} for “${needle}” in ${fmt(stepsHit)} ${stepsHit === 1 ? 'step' : 'steps'}.`
  }

  return (
    <div className="space-y-6">
      {header(
        question === null ? 'This request stopped before anything was sent to the AI.' : `“${question}”`,
      )}
      <p className="text-sm text-gray-600">
        {fmt(rows.length)} stored {rows.length === 1 ? 'step' : 'steps'}, started{' '}
        {humanDateTime(rows[0].created_at)}. An email in the question is replaced by [email] before anything
        is sent or stored.
      </p>

      <div className="space-y-1 rounded border border-gray-200 p-4">
        <label htmlFor="trace-search" className="block text-sm font-medium text-gray-900">
          Search what was stored for this question
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="trace-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-describedby="trace-search-hint"
            autoComplete="off"
            className="min-h-9 w-full max-w-sm rounded border border-gray-300 bg-white px-2 py-1 text-sm"
          />
          <Button onClick={() => setSearch('@')}>Search for “@”</Button>
        </div>
        <p id="trace-search-hint" className="text-sm text-gray-600">
          Searches everything sent to and from the AI for this question. Every email has an @, so “@” should
          find nothing.
        </p>
        <Announcer message={searchResult} visible />
      </div>

      <ol className="space-y-3" aria-label="Stored steps, in order">
        {rows.map((row, i) => (
          <Step key={row.id} row={row} title={`Step ${i + 1}: ${titles[i]}`} matches={perRow[i]} />
        ))}
      </ol>
    </div>
  )
}

function traceColumns(): Column<AuditTraceSummary>[] {
  return [
    {
      header: 'When (UTC)',
      cell: (t) => (
        <span className="whitespace-nowrap">{humanDateTime(t.started_at).replace(' UTC', '')}</span>
      ),
    },
    {
      header: 'Question',
      cell: (t) => (
        <Link to={`/audit/${t.trace_id}`} className={`${linkClass} break-words`}>
          {t.question ?? 'Stopped before it reached the AI'}
        </Link>
      ),
    },
    { header: 'Result', cell: (t) => TRACE_STATUS[t.status] },
    { header: 'Tokens used', cell: (t) => fmt(t.tokens_in + t.tokens_out), numeric: true },
  ]
}

/** A settled fetch: never 'loading', which is derived from the version instead. */
type Answer = Exclude<GetState<AuditList>, { status: 'loading' }>

function TraceList() {
  // Each Refresh bumps the version; the list stays on screen while a refresh is in flight.
  const [version, setVersion] = useState(0)
  const [settled, setSettled] = useState<{ version: number; state: Answer } | null>(null)

  useEffect(() => {
    let current = true
    getJson<AuditList>(`/api/audit?limit=${LIST_LIMIT}`).then(
      (data) => current && setSettled({ version, state: { status: 'ok', data } }),
      (err: unknown) =>
        current && setSettled({ version, state: { status: 'error', message: errorMessage(err) } }),
    )
    return () => {
      current = false
    }
  }, [version])

  const refreshing = settled !== null && settled.version !== version
  const traces = settled?.state.status === 'ok' ? settled.state.data.traces : null
  let announcement = ''
  if (refreshing) announcement = 'Refreshing…'
  else if (traces !== null)
    announcement = `${traces.length} ${traces.length === 1 ? 'question' : 'questions'} shown`

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI audit log"
        purpose={`Every question sent to the assistant, newest first (the last ${LIST_LIMIT}). Open one to see exactly what the AI was sent and what it sent back.`}
        action={
          <Button
            variant="primary"
            onClick={() => setVersion((v) => v + 1)}
            disabled={settled === null || refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      <Announcer message={announcement} />
      {settled === null ? (
        <Loading label="Loading the audit log…" />
      ) : settled.state.status === 'error' ? (
        <ErrorLine message={settled.state.message} />
      ) : settled.state.data.traces.length === 0 ? (
        <EmptyState
          action={
            <Link to="/assistant" className={linkClass}>
              Ask a question
            </Link>
          }
        >
          No questions yet. Ask one, then come back to see what the AI was sent.
        </EmptyState>
      ) : (
        <ResponsiveTable
          caption="Questions sent to the assistant, newest first"
          columns={traceColumns()}
          rows={settled.state.data.traces}
          rowKey={(t) => t.trace_id}
        />
      )}
    </div>
  )
}

export default function AuditPage() {
  const { traceId } = useParams()
  return traceId === undefined ? <TraceList /> : <TraceView key={traceId} traceId={traceId} />
}
