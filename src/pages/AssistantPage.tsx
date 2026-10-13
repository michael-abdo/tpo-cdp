// /assistant (06 §/assistant, R5): "Ask a question". One question box, the brief's three questions
// (R5.2) as one-click examples (06 §UI principles 6), and one typed result from POST /api/assistant
// (04): the answer text (announced politely, principle 7), the table, or the segment's count with
// "Open in builder", which loads its filters on /segments. A partial result says so. Level 2 "How
// this answer was worked out": the window, the filters and the definitions used, in words, with the
// definitions' plain text from DEFINITIONS (02 §Derived "one runtime source"); Technical details:
// the raw names, the result type and the trace id. The filters are the model's own words, so they
// pass the D-58 check first and are hidden whole on any sign of SQL (src/filters-applied.ts). Column and filter names show in the words
// /segments uses (src/labels.ts, principle 4); a segment answer also offers Export CSV (06
// §/assistant). Every answer links to its trace on /audit ("what the AI saw", 05 §Proof surfaces). The request takes 5–20 s (04), shown as a short text
// state. Errors show the 04 envelope's message; the 503 for a missing key names the hosted URL.
// Single-shot: there is no conversation history (09 D-34). "Explain this" on /growth opens this page
// with ?q=<question> (09 D-39): the box is filled in and nothing is sent until the reader presses Ask.

import { type FormEvent, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { DEFINITIONS } from '../../shared/derive'
import { ApiError, downloadSegmentCsv, errorMessage, postJson } from '../api'
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
import { humanDate } from '../format'
import { filtersAppliedView } from '../filters-applied'
import { columnLabel, DEFINITION_LABEL, sourceLabel, statusLabel } from '../labels'
import type { AssistantCell, AssistantResponse, SegmentFilters } from '../types'

/** The brief's three example questions, verbatim (R5.2). */
const BRIEF_QUESTIONS = [
  'how many Instagram signups went cold last month?',
  'build me a list of our most engaged readers',
  'which pages do new subscribers hit first?',
] as const

/** Rows shown before "Show all …" (principle 2: the rest is one click away). */
const FIRST_ROWS = 10

const fmt = (n: number) => n.toLocaleString('en-US')

/** A table cell in words, with the same display rules /segments uses for the same columns. */
function cellText(column: string, value: AssistantCell): string {
  if (value === null) {
    if (column === 'last_open_date') return 'Never opened'
    if (column === 'source') return 'Unknown'
    return 'None'
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') {
    if (column === 'engagement_score') return `${fmt(value)} / 100`
    if (column === 'rate') return `${(value * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
    return fmt(value)
  }
  if (column === 'source') return sourceLabel(value)
  if (column === 'status') return statusLabel(value)
  if (column === 'signup_date' || column === 'last_open_date') return humanDate(value)
  return value
}

/** Next steps for the 04 errors that have one; the message itself is the envelope's. */
function nextStep(code: string | null): string | undefined {
  switch (code) {
    case 'invalid_question':
      return 'Ask in plain words, without code, commands or personal details.'
    case 'rate_limited':
      return 'Wait a while, then ask again.'
    case 'model_error':
      return 'Try again in a minute.'
    case 'invalid_body':
      return 'Type a question first.'
    default:
      return undefined
  }
}

type State =
  | { status: 'loading'; question: string }
  | { status: 'error'; question: string; message: string; code: string | null }
  | { status: 'ok'; question: string; data: AssistantResponse }

function ResultTable({ table }: { table: NonNullable<AssistantResponse['table']> }) {
  const [showAll, setShowAll] = useState(false)
  const rows = table.rows.map((row, i) => ({ row, i }))
  const shown = showAll ? rows : rows.slice(0, FIRST_ROWS)
  const columns: Column<(typeof rows)[number]>[] = table.columns.map((name) => ({
    header: columnLabel(name),
    cell: ({ row }) => <span className="break-words">{cellText(name, row[name] ?? null)}</span>,
    numeric: rows.length > 0 && rows.every(({ row }) => typeof row[name] === 'number'),
  }))
  if (rows.length === 0) return <p className="text-sm text-gray-600">The table has no rows.</p>
  return (
    <div className="space-y-2">
      <ResponsiveTable caption="Answer table" columns={columns} rows={shown} rowKey={({ i }) => String(i)} />
      {!showAll && rows.length > FIRST_ROWS && (
        <Button onClick={() => setShowAll(true)}>Show all {fmt(rows.length)} rows</Button>
      )}
    </div>
  )
}

function Result({ data }: { data: AssistantResponse }) {
  const navigate = useNavigate()
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  async function exportCsv(filters: SegmentFilters) {
    setExporting(true)
    setExportError(null)
    try {
      await downloadSegmentCsv(filters)
    } catch (err) {
      console.error('assistant: export failed', err)
      setExportError(errorMessage(err))
    } finally {
      setExporting(false)
    }
  }

  // The model writes filters_applied; any D-58 sign of SQL in it hides it whole (src/filters-applied.ts).
  const filters = filtersAppliedView(data.filters_applied)
  const hasHow =
    data.window !== null ||
    filters.status === 'hidden' ||
    filters.fields.length > 0 ||
    data.definitions_used.length > 0
  return (
    <section aria-labelledby="answer-heading" className="space-y-4 rounded border border-gray-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="answer-heading" className="text-lg font-semibold text-gray-900">
          Answer
        </h2>
        {data.partial && <Tag>Incomplete answer</Tag>}
      </div>
      <p className="whitespace-pre-wrap text-gray-900">{data.text}</p>
      {data.partial && (
        <p className="text-sm text-gray-600">
          The assistant did not finish cleanly, so this answer may be missing parts. The audit log shows each
          step it took.
        </p>
      )}

      {data.segment !== null && (
        <div className="space-y-2 rounded bg-gray-50 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-medium text-gray-900">
              {data.segment.count === 1 ? '1 reader matches' : `${fmt(data.segment.count)} readers match`}
            </p>
            <Button
              variant="primary"
              onClick={() => navigate('/segments', { state: { filters: data.segment?.filters } })}
            >
              Open in builder
            </Button>
            <Button onClick={() => data.segment !== null && void exportCsv(data.segment.filters)} disabled={exporting}>
              {exporting ? 'Preparing download…' : 'Export CSV'}
            </Button>
          </div>
          <p className="text-sm text-gray-600">The builder shows the full list; Export CSV downloads it.</p>
          {exportError !== null && <ErrorLine message={exportError} next="Press Export CSV to try again." />}
        </div>
      )}

      {data.table !== null && <ResultTable table={data.table} />}

      <p className="text-sm">
        <Link
          to={`/audit/${data.audit_id}`}
          className="inline-flex min-h-6 items-center text-blue-700 underline underline-offset-2 hover:text-blue-900"
        >
          See exactly what the AI saw for this answer
        </Link>
      </p>

      <Disclosure label="How this answer was worked out" className="border-t border-gray-200 pt-3">
        {!hasHow && (
          <p className="text-sm text-gray-600">The answer names no time period, filters or definitions.</p>
        )}
        <dl className="space-y-1">
          {data.window !== null && (
            <Field label="Time period">
              {humanDate(data.window.from)} to {humanDate(data.window.to)}
            </Field>
          )}
          {filters.status === 'shown' &&
            filters.fields.map(({ key, label, value }) => (
              <Field key={key} label={label}>
                {value}
              </Field>
            ))}
        </dl>
        {filters.status === 'hidden' && <p className="text-sm text-gray-700">{filters.message}</p>}
        {data.definitions_used.length > 0 && (
          <dl className="space-y-2 text-sm">
            {data.definitions_used.map((key) => (
              <div key={key}>
                <dt className="font-medium text-gray-900">{DEFINITION_LABEL[key]}</dt>
                <dd className="text-gray-700">{DEFINITIONS[key].doc}</dd>
              </div>
            ))}
          </dl>
        )}
        <TechnicalDetails>
          <p>
            Result type: <span className="font-mono">{data.type}</span> · partial:{' '}
            <span className="font-mono">{String(data.partial)}</span>
          </p>
          <p>
            Audit trace id: <span className="font-mono break-all">{data.audit_id}</span>
          </p>
          {data.window !== null && (
            <p>
              Window: <span className="font-mono">{data.window.from}</span> to{' '}
              <span className="font-mono">{data.window.to}</span>
            </p>
          )}
          <p>
            Filters applied:{' '}
            {filters.status === 'shown' ? (
              <span className="font-mono break-all">{filters.raw}</span>
            ) : (
              <>
                hidden, D-58 sign <span className="font-mono">{filters.sign}</span>
              </>
            )}
          </p>
          {data.definitions_used.map((key) => (
            <p key={key}>
              <span className="font-mono">{DEFINITIONS[key].name}</span>:{' '}
              <span className="font-mono">{DEFINITIONS[key].formula}</span>
            </p>
          ))}
          {data.table !== null && (
            <p>
              Columns: <span className="font-mono">{data.table.columns.join(', ')}</span>
            </p>
          )}
          {data.segment !== null && (
            <p>
              Segment filters:{' '}
              <span className="font-mono break-all">{JSON.stringify(data.segment.filters)}</span>
            </p>
          )}
        </TechnicalDetails>
      </Disclosure>
    </section>
  )
}

/** The query parameter "Explain this" on /growth fills the box with (09 D-39). */
export const PREFILL_PARAM = 'q'

export default function AssistantPage() {
  // A question handed over by "Explain this" is filled in, not sent: the reader presses Ask.
  const [params] = useSearchParams()
  const prefilled = params.get(PREFILL_PARAM)?.trim() ?? ''
  const [question, setQuestion] = useState(prefilled)
  const [state, setState] = useState<State | null>(null)
  // Only the latest question's answer is shown, so a slow earlier request never replaces it.
  const latest = useRef(0)

  async function ask(text: string) {
    const asked = text.trim()
    const id = ++latest.current
    setState({ status: 'loading', question: asked })
    try {
      const data = await postJson<AssistantResponse>('/api/assistant', { question: asked })
      if (id === latest.current) setState({ status: 'ok', question: asked, data })
    } catch (err) {
      console.error('assistant: request failed', err)
      if (id === latest.current) {
        setState({
          status: 'error',
          question: asked,
          message: errorMessage(err),
          code: err instanceof ApiError ? err.code : null,
        })
      }
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    void ask(question)
  }

  function askExample(text: string) {
    setQuestion(text)
    void ask(text)
  }

  const loading = state?.status === 'loading'
  let announcement = ''
  // The loading line announces itself (Loading is a status region), so it is not repeated here.
  if (state?.status === 'error') announcement = 'The question could not be answered.'
  if (state?.status === 'ok')
    announcement = `${state.data.partial ? 'Incomplete answer: ' : 'Answer: '}${state.data.text}`

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ask a question"
        purpose="Ask about readers in plain words. Answers come from our data; no reader's email is sent to the AI."
      />
      <Announcer message={announcement} />

      <form onSubmit={submit} className="space-y-2 rounded border border-gray-200 p-4">
        <label htmlFor="question" className="block text-sm font-medium text-gray-900">
          Your question
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="question"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            aria-describedby="question-hint"
            autoComplete="off"
            className="min-h-9 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm"
          />
          <Button
            type="submit"
            variant="primary"
            disabled={loading || question.trim() === ''}
            className="px-5"
          >
            {loading ? 'Asking…' : 'Ask'}
          </Button>
        </div>
        <p id="question-hint" className="text-sm text-gray-600">
          One question at a time; each answer starts fresh.
        </p>
      </form>

      <div className="space-y-2">
        <p className="text-sm text-gray-700">Not sure what to ask? Try one of these:</p>
        <div className="flex flex-wrap gap-2">
          {BRIEF_QUESTIONS.map((q) => (
            <Button key={q} onClick={() => askExample(q)} disabled={loading}>
              {q}
            </Button>
          ))}
        </div>
      </div>

      {state === null && (
        <EmptyState>
          {prefilled !== '' && question === prefilled
            ? 'The question from the Growth page is filled in above. Press Ask to send it, or change it first.'
            : 'Type a question and press Ask, or pick one of the examples above.'}
        </EmptyState>
      )}
      {state?.status === 'loading' && (
        <Loading label="Working on your question… this usually takes 5 to 20 seconds." />
      )}
      {state?.status === 'error' && (
        <div className="space-y-2">
          <ErrorLine message={state.message} next={nextStep(state.code)} />
          {/* 04: every assistant error except invalid_body writes ai_audit rows. */}
          {state.code !== null && state.code !== 'invalid_body' && (
            <p className="text-sm text-gray-600">
              This attempt is listed in the{' '}
              <Link to="/audit" className="text-blue-700 underline underline-offset-2 hover:text-blue-900">
                AI audit log
              </Link>
              .
            </p>
          )}
        </div>
      )}
      {state?.status === 'ok' && <Result key={state.data.audit_id} data={state.data} />}
    </div>
  )
}
