// The Ask bar and its answer card on /insights (moved here from /assistant). One question box,
// the brief's three questions as one-click examples (so a first visit knows what to ask), and one
// typed result from POST /api/assistant: the answer text (announced
// politely to screen readers), the auto chart (shared/pick-chart.ts pickChart on the result's shape) or
// the segment's count with "Open segment", which loads its filters on /segments, plus Export CSV. A
// partial result says so. "Pin to board" opens the pin dialog (pin-dialog.tsx); an answer the server
// says can never be pinned (`pin_refusal`, e.g. free-form SQL) shows that sentence instead.
// Level 2 "Time period · Filters · Definitions": the window, the filters and the definitions used,
// in words, with the definitions' plain text from DEFINITIONS (their one runtime source);
// Technical details: the raw names, the result type and the trace id. The filters are the model's
// own words, so they pass the SQL-sign check first and are hidden whole on any sign of SQL
// (src/filters-applied.ts). Every answer links to its trace on /audit ("what the AI saw"), the
// proof of what the model was sent. The request takes 5–20 s, shown as a short text state. Errors
// show the envelope's message. Single-shot: there is no conversation history. A question handed
// over by "Explain this" or ?q= is filled in, never sent: the teammate presses Ask.

import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { DEFINITIONS } from '../../shared/derive'
import { pickChart } from '../../shared/pick-chart'
import { ApiError, downloadSegmentCsv, errorMessage, postJson } from '../api'
import {
  Announcer,
  Button,
  ComingSoonTag,
  Disclosure,
  ErrorLine,
  Field,
  GatedNote,
  ICONS,
  Icon,
  Loading,
  Tag,
  TechnicalDetails,
} from '../components'
import { useGated } from '../use-gated'
import { humanRange } from '../format'
import { filtersAppliedView } from '../filters-applied'
import { DEFINITION_LABEL } from '../labels'
import type { AssistantResponse, InsightTile, SegmentFilters } from '../types'
import { InsightChart, SegmentTile, TableTile } from './charts'
import { PinDialog } from './pin-dialog'
import { BRIEF_QUESTIONS, tileElementId } from './questions'

/** Next steps for the API errors that have one; the message itself is the envelope's. */
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
    case 'no_tools':
      return 'Ask your admin to turn it on.'
    default:
      return undefined
  }
}

/** Errors whose server text speaks to developers: plain words at level 1, raw text in Technical details. */
function plainMessage(code: string | null, message: string): string {
  if (code === 'no_tools') return "The assistant isn't set up yet, so it can't answer right now."
  if (/`|npm run/.test(message)) return "The assistant can't answer right now."
  return message
}

/**
 * The gated "Ask a follow-up" field (coming soon): the foot of the answer
 * card, after "Time period · Filters · Definitions". No `<form>` while gated, so Enter can never
 * submit; the input is readOnly and both it and the button point at the same note (one flag, one
 * note). Activation = a click or Enter/Space on the button, or the first keystroke in the box.
 */
export function FollowUpField() {
  const gated = useGated('follow_up_questions')
  const id = useId()
  return (
    <div className="space-y-1.5 border-t border-line pt-3">
      <div className="flex items-center gap-1">
        <label htmlFor={id} className="block text-sm font-medium text-ink">
          {gated.feature.controls![0]}
        </label>
        <ComingSoonTag />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={id}
          type="text"
          readOnly
          value=""
          {...gated.bind}
          onClick={gated.activate}
          onKeyDown={gated.onKeyDown}
          placeholder="and last month?"
          className="min-h-9 w-full rounded-lg border border-dashed border-line-strong bg-page px-3 py-1.5 text-sm text-ink-subtle placeholder:text-ink-subtle"
        />
        <button
          type="button"
          {...gated.bind}
          onClick={gated.activate}
          className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-surface-2 px-4 text-sm font-medium text-ink-subtle"
        >
          {gated.feature.controls![1]}
          <span className="sr-only"> a follow-up</span>
        </button>
      </div>
      <GatedNote id={gated.noteId} activated={gated.activated} text={gated.feature.note} />
    </div>
  )
}

export function AnswerCard({
  data,
  question,
  onPinned,
  stale = false,
}: {
  data: AssistantResponse
  question: string
  onPinned: (tile: InsightTile, note: string | null) => void
  /**
   * The Ask bar now holds another question ("Explain this"): the card gets a dashed border and says
   * so in words. No opacity: every text and control keeps its full contrast (WCAG 2.2 AA).
   */
  stale?: boolean
}) {
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [pinOpen, setPinOpen] = useState(false)
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const pinButton = useRef<HTMLButtonElement>(null)
  const seeTile = useRef<HTMLButtonElement>(null)

  // The Pin button is gone once pinned, so focus moves to the control that replaced it, never to
  // the page body (WCAG 2.4.3).
  useEffect(() => {
    if (pinnedId !== null) seeTile.current?.focus()
  }, [pinnedId])

  async function exportCsv(filters: SegmentFilters) {
    setExporting(true)
    setExportError(null)
    try {
      await downloadSegmentCsv(filters)
    } catch (err) {
      console.error('insights: export failed', err)
      setExportError(errorMessage(err))
    } finally {
      setExporting(false)
    }
  }

  function closePin() {
    setPinOpen(false)
    // Still mounted only when the dialog closed without a pin.
    pinButton.current?.focus()
  }

  function showTile() {
    if (pinnedId === null) return
    const tile = document.getElementById(tileElementId(pinnedId))
    if (tile === null) return
    tile.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    tile.focus({ preventScroll: true })
  }

  // The model writes filters_applied; any sign of SQL in it hides it whole (src/filters-applied.ts).
  const filters = filtersAppliedView(data.filters_applied)
  const hasHow = data.window !== null || filters.status === 'hidden' || filters.fields.length > 0 || data.definitions_used.length > 0
  const result = data.table ?? { columns: [], rows: [] }
  const kind = data.table === null && data.segment === null ? null : pickChart({ ...result, segment: data.segment })
  return (
    <section
      aria-labelledby="answer-heading"
      data-stale={stale ? '' : undefined}
      className={`space-y-4 rounded-xl border bg-surface p-5 shadow-soft sm:p-6 ${stale ? 'border-dashed border-line-strong' : 'border-line'}`}
    >
      {stale && (
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
          <Tag icon={ICONS.assistant}>Earlier question</Tag>
          This answer is for your earlier question: “{question}”.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="answer-heading" className="mr-auto font-display text-lg font-medium text-ink">
          Answer
        </h2>
        {data.partial && (
          <Tag tone="danger" icon={ICONS.error}>
            Incomplete answer
          </Tag>
        )}
        {pinnedId !== null ? (
          <>
            <Tag tone="success" icon={ICONS.done}>
              Pinned to the board
            </Tag>
            <Button ref={seeTile} variant="quiet" icon={ICONS.next} onClick={showTile}>
              See it on the board
            </Button>
          </>
        ) : data.pin_refusal === null ? (
          <Button ref={pinButton} icon={ICONS.pin} aria-haspopup="dialog" onClick={() => setPinOpen(true)}>
            Pin to board
          </Button>
        ) : null}
      </div>
      {data.pin_refusal !== null && (
        <p className="flex items-start gap-1.5 text-sm text-ink-muted">
          <Icon icon={ICONS.pin} className="mt-0.5 size-4" />
          {data.pin_refusal}
        </p>
      )}
      <p className="whitespace-pre-wrap text-base leading-relaxed text-ink">{data.text}</p>
      {data.partial && (
        <p className="text-sm text-ink-muted">The assistant did not finish cleanly, so this answer may be missing parts.</p>
      )}

      {kind === 'segment' && data.segment !== null ? (
        <div className="space-y-3 rounded-xl bg-surface-2 p-4">
          <SegmentTile segment={data.segment}>
            <Button icon={ICONS.export} onClick={() => data.segment !== null && void exportCsv(data.segment.filters)} disabled={exporting}>
              {exporting ? 'Preparing download…' : 'Export CSV'}
            </Button>
          </SegmentTile>
          {exportError !== null && <ErrorLine message={exportError} next="Press Export CSV to try again." />}
          {data.table !== null && data.table.rows.length > 0 && (
            <Disclosure label={`Show the first ${data.table.rows.length.toLocaleString('en-US')} subscribers`}>
              <TableTile result={data.table} caption="The first subscribers in the segment" />
            </Disclosure>
          )}
        </div>
      ) : (
        kind !== null && <InsightChart kind={kind} result={result} segment={data.segment} caption="Answer" />
      )}

      <p className="text-sm">
        <Link
          to={`/audit/${data.audit_id}`}
          className="inline-flex min-h-6 items-center gap-1.5 text-accent underline underline-offset-2 hover:text-accent-strong"
        >
          <Icon icon={ICONS.audit} />
          See exactly what the AI saw for this answer
        </Link>
      </p>

      <Disclosure label="Time period · Filters · Definitions" className="border-t border-line pt-3">
        {!hasHow && <p className="text-sm text-ink-muted">The answer names no time period, filters or definitions.</p>}
        <dl className="space-y-1">
          {data.window !== null && <Field label="Time period">{humanRange(data.window.from, data.window.to)}</Field>}
          {filters.status === 'shown' &&
            filters.fields.map(({ key, label, value }) => (
              <Field key={key} label={label}>
                {value}
              </Field>
            ))}
        </dl>
        {filters.status === 'hidden' && <p className="text-sm text-ink-muted">{filters.message}</p>}
        {data.definitions_used.length > 0 && (
          <dl className="space-y-2 text-sm">
            {data.definitions_used.map((key) => (
              <div key={key}>
                <dt className="font-medium text-ink">{DEFINITION_LABEL[key]}</dt>
                <dd className="text-ink-muted">{DEFINITIONS[key].doc}</dd>
              </div>
            ))}
          </dl>
        )}
        <TechnicalDetails>
          <p>
            Result type: <span className="font-mono">{data.type}</span> · partial: <span className="font-mono">{String(data.partial)}</span>
            {kind !== null && (
              <>
                {' '}
                · chart: <span className="font-mono">{kind}</span>
              </>
            )}
          </p>
          <p>
            Audit trace id: <span className="font-mono break-all">{data.audit_id}</span>
          </p>
          {data.window !== null && (
            <p>
              Window: <span className="font-mono">{data.window.from}</span> to <span className="font-mono">{data.window.to}</span>
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
              <span className="font-mono">{DEFINITIONS[key].name}</span>: <span className="font-mono">{DEFINITIONS[key].formula}</span>
            </p>
          ))}
          {data.table !== null && (
            <p>
              Columns: <span className="font-mono">{data.table.columns.join(', ')}</span>
            </p>
          )}
          {data.segment !== null && (
            <p>
              Segment filters: <span className="font-mono break-all">{JSON.stringify(data.segment.filters)}</span>
            </p>
          )}
        </TechnicalDetails>
      </Disclosure>

      <FollowUpField />

      {data.pin_refusal === null && (
        <PinDialog
          open={pinOpen}
          onClose={closePin}
          auditId={data.audit_id}
          question={question}
          ownDates={data.pin_own_dates}
          pinWindow={data.pin_window}
          segment={data.type === 'segment' && data.segment !== null}
          onPinned={(tile, note) => {
            setPinOpen(false)
            setPinnedId(tile.id)
            onPinned(tile, note)
          }}
        />
      )}
    </section>
  )
}

type AskState =
  | { status: 'loading'; question: string }
  | { status: 'error'; question: string; message: string; code: string | null }
  | { status: 'ok'; question: string; data: AssistantResponse }

/**
 * The Ask bar. The page holds the question, so "Explain this" on a tile can fill it; `filled` is the
 * question it handed over, which earns the "filled in above" line until the teammate changes it.
 */
export function AskSection({
  question,
  setQuestion,
  filled,
  inputRef,
  onPinned,
}: {
  question: string
  setQuestion: (q: string) => void
  filled: string | null
  inputRef: RefObject<HTMLInputElement | null>
  onPinned: (tile: InsightTile, note: string | null) => void
}) {
  const [state, setState] = useState<AskState | null>(null)
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
      console.error('insights: question failed', err)
      if (id === latest.current) {
        setState({ status: 'error', question: asked, message: errorMessage(err), code: err instanceof ApiError ? err.code : null })
      }
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    void ask(question)
  }

  const loading = state?.status === 'loading'
  let announcement = ''
  // The loading line announces itself (Loading is a status region), so it is not repeated here.
  if (state?.status === 'error') announcement = 'The question could not be answered.'
  if (state?.status === 'ok') announcement = `${state.data.partial ? 'Incomplete answer: ' : 'Answer: '}${state.data.text}`

  return (
    <div className="space-y-4">
      <Announcer message={announcement} />
      <form onSubmit={submit} className="space-y-3 rounded-xl border border-line bg-surface p-5 shadow-soft sm:p-6">
        <label htmlFor="question" className="block text-sm font-medium text-ink">
          Ask the AI assistant in plain English
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            ref={inputRef}
            id="question"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            aria-describedby="question-hint"
            autoComplete="off"
            className="min-h-11 w-full rounded-lg border border-line-strong bg-page px-3 py-2 text-base text-ink placeholder:text-ink-subtle"
          />
          <Button type="submit" variant="primary" icon={ICONS.next} disabled={loading || question.trim() === ''} className="min-h-11 px-5">
            {loading ? 'Asking…' : 'Ask'}
          </Button>
        </div>
        <p id="question-hint" className="text-sm text-ink-muted">
          {filled !== null && question === filled && state?.question !== filled
            ? 'This question is filled in for you. Press Ask to send it, or change it first.'
            : 'One question at a time; each answer starts fresh. No subscriber’s email is sent to the AI.'}
        </p>
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <span className="text-sm text-ink-muted">Try:</span>
          {BRIEF_QUESTIONS.map((q) => (
            <Button
              key={q}
              onClick={() => {
                setQuestion(q)
                void ask(q)
              }}
              disabled={loading}
              className="rounded-full text-left"
            >
              {q}
            </Button>
          ))}
        </div>
      </form>

      {state?.status === 'loading' && <Loading label="Working on your question… this usually takes 5 to 20 seconds." />}
      {state?.status === 'error' && (
        <div className="space-y-2">
          <ErrorLine message={plainMessage(state.code, state.message)} next={nextStep(state.code)} />
          {plainMessage(state.code, state.message) !== state.message && (
            <TechnicalDetails>
              <p>Error code: {state.code ?? 'none'}</p>
              <p>{state.message}</p>
            </TechnicalDetails>
          )}
          {/* 04: every assistant error except invalid_body writes ai_audit rows. */}
          {state.code !== null && state.code !== 'invalid_body' && (
            <p className="text-sm text-ink-muted">
              This attempt is listed in the{' '}
              <Link to="/audit" className="text-accent underline underline-offset-2 hover:text-accent-strong">
                AI audit log
              </Link>
              .
            </p>
          )}
        </div>
      )}
      {state?.status === 'ok' && (
        <AnswerCard
          key={state.data.audit_id}
          data={state.data}
          question={state.question}
          onPinned={onPinned}
          stale={filled !== null && question === filled && state.question !== filled}
        />
      )}
    </div>
  )
}
