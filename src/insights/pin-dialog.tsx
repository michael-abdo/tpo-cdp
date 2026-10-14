// "Pin to board" (06 §/insights, 09 D-64): a modal dialog with the tile's title (prefilled from the
// question) and, when the pinned lookup takes a time period, the choice "Rolling: last month" or
// "Fixed: Aug 1–31, 2026". Whether it takes one is the server's answer (`pin_window` of POST
// /api/assistant, the same reading POST /api/insights does), so the dialog never offers a choice
// the pin would drop; a lookup with its own dates shows them as plain text. The browser sends only
// the trace id and the title (04: never a tool, params or SQL); the server stores the window
// rolling when it equals a preset, else fixed. When the person chose the other kind, one PATCH sets it.
// The native <dialog> gives the focus trap, Esc to close and the backdrop; focus goes back to the
// button that opened it (06 §UI principles 7).

import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { ApiError, errorMessage, patchJson, postJson } from '../api'
import { Button, ErrorLine, ICONS } from '../components'
import { humanRange } from '../format'
import type { InsightWindow } from '../../shared/insight-window'
import type { InsightPatch, InsightTile } from '../types'
import { matchingPreset, PRESET_LABEL } from './windows'

type Choice = 'rolling' | 'fixed'

/** Next steps for the 04 POST /api/insights errors that have one; the message is the envelope's. */
function pinNext(code: string | null): string | undefined {
  switch (code) {
    case 'nothing_to_pin':
      return 'This answer did not come from a data lookup, so there is nothing to re-run. Ask a question about numbers or readers.'
    case 'not_found':
      return 'Ask the question again, then pin the new answer.'
    default:
      return undefined
  }
}

export function PinDialog({
  open,
  onClose,
  auditId,
  question,
  answerWindow,
  pinWindow,
  onPinned,
}: {
  open: boolean
  onClose: () => void
  auditId: string
  question: string
  /** The dates the answer covered (AssistantResponse.window). */
  answerWindow: { from: string; to: string } | null
  /** The time period the pin stores, or null when its lookup has none (AssistantResponse.pin_window). */
  pinWindow: { from: string; to: string } | null
  onPinned: (tile: InsightTile, note: string | null) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const inputId = useId()
  const [title, setTitle] = useState(question)
  const preset = pinWindow === null ? null : matchingPreset(pinWindow.from, pinWindow.to)
  const [choice, setChoice] = useState<Choice>(preset === null ? 'fixed' : 'rolling')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null)

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    let tile: InsightTile
    try {
      tile = await postJson<InsightTile>('/api/insights', { audit_id: auditId, title })
    } catch (err) {
      console.error('insights: pin failed', err)
      setError({ message: errorMessage(err), code: err instanceof ApiError ? err.code : null })
      setSaving(false)
      return
    }
    let note: string | null = null
    if (pinWindow !== null && tile.window === null) {
      // The server said this pin would keep a time period, then stored none: never silent.
      console.error('insights: pin_window promised a time period the pin did not store', tile.id)
      note = `Pinned “${tile.title}”, but its time period could not be kept.`
    } else if (pinWindow !== null && tile.window !== null && tile.window.kind !== choice) {
      const wanted: InsightWindow | null =
        choice === 'fixed' ? { fixed: [pinWindow.from, pinWindow.to] } : preset === null ? null : { rolling: preset }
      if (wanted !== null) {
        try {
          tile = await patchJson<InsightTile>(`/api/insights/${tile.id}`, { window: wanted } satisfies InsightPatch)
        } catch (err) {
          console.error('insights: setting the pinned window failed', err)
          note = `Pinned, but the time period could not be changed: ${errorMessage(err)} Change it from the tile's options.`
        }
      }
    }
    setSaving(false)
    onPinned(tile, note)
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 text-ink shadow-soft backdrop:bg-black/40"
    >
      <form onSubmit={submit} className="space-y-4 p-5 sm:p-6">
        <h2 id={titleId} className="font-display text-lg font-medium">
          Pin to board
        </h2>
        <p className="text-sm text-ink-muted">The tile re-runs this lookup each time the board opens. The AI is not asked again.</p>
        <div className="space-y-1">
          <label htmlFor={inputId} className="block text-sm font-medium text-ink">
            Tile title
          </label>
          <input
            id={inputId}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoComplete="off"
            className="min-h-11 w-full rounded-lg border border-line-strong bg-page px-3 py-2 text-base text-ink"
          />
        </div>
        {pinWindow === null && answerWindow !== null && (
          <p className="text-sm text-ink">
            <span className="font-medium">Time period:</span> uses its own dates ({humanRange(answerWindow.from, answerWindow.to)}).
            <span className="block text-ink-muted">The lookup behind this answer sets them, so the tile keeps them.</span>
          </p>
        )}
        {pinWindow !== null && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">Time period</legend>
            {preset !== null && (
              <label className="flex min-h-6 items-start gap-2 text-sm">
                <input type="radio" name="pin-window" checked={choice === 'rolling'} onChange={() => setChoice('rolling')} className="mt-1" />
                <span>
                  Rolling: {PRESET_LABEL[preset].toLowerCase()}
                  <span className="block text-ink-muted">Moves with today; now {humanRange(pinWindow.from, pinWindow.to)}.</span>
                </span>
              </label>
            )}
            <label className="flex min-h-6 items-start gap-2 text-sm">
              <input type="radio" name="pin-window" checked={choice === 'fixed'} onChange={() => setChoice('fixed')} className="mt-1" />
              <span>
                Fixed: {humanRange(pinWindow.from, pinWindow.to)}
                <span className="block text-ink-muted">Always these dates.</span>
              </span>
            </label>
          </fieldset>
        )}
        {error !== null && <ErrorLine message={error.message} next={pinNext(error.code)} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={ICONS.pin} disabled={saving || title.trim() === ''}>
            {saving ? 'Pinning…' : 'Pin to board'}
          </Button>
        </div>
      </form>
    </dialog>
  )
}
