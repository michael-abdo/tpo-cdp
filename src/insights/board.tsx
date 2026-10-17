// The board of /insights: tiles in sort_order, each re-run by the server
// on every GET /api/insights through the gated executor, with no model call. Level 1 per tile:
// its title, the chart (the server's `chart`: an override, else pickChart on the result), the
// time period in words and "Updated just now" (the board was fetched for this view; the exact UTC
// time is in Technical details, so the page reads no wall clock). The time period is
// itself a button that opens "Change time period" directly (three clicks: period → choice → Save);
// a lookup that sets its own dates names them ("Set by this question · Aug 29 – Sep 28, 2026", the
// same words as the pin dialog); a tile with neither says "As of <TODAY>". One tile's error shows on
// that tile only, in the server's plain sentence; its raw problems only in Technical details. Level 2 =
// the tile's "Options" panel: Change time period · Change chart · Rename · Move up/down · Remove
// (not on built-in tiles, which the server refuses with 409) · Explain this (fills the Ask bar) ·
// Technical details. Focus never drops to the page: a form takes focus when it opens, and Cancel
// gives it back to the item that opened the form. Each change is one PATCH or DELETE; the board is then fetched
// again, so what shows is always the server's. Inputs are sent as typed (the server validates
// and answers with the error envelope, shown in words).

import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react'
import { TODAY } from '../../shared/config'
import { resolveWindow } from '../../shared/insight-window'
import { errorMessage, patchJson, request } from '../api'
import { Button, ErrorLine, GatedNote, ICONS, Icon, TechnicalDetails } from '../components'
import { GATED_LOOK, useGated } from '../use-gated'
import { humanDate, humanRange, utc } from '../format'
import type { ChartChoice, InsightPatch, InsightTile } from '../types'
import { InsightChart } from './charts'
import { CHART_LABEL, chartFits } from './shapes'
import type { RollingPreset } from '../../shared/insight-window'
import { CHART_OVERRIDES } from '../../shared/pick-chart'
import { tileElementId } from './questions'
import { ownDatesText, PRESET_LABEL, PRESETS, windowText } from './windows'

const CHOICES: readonly ChartChoice[] = CHART_OVERRIDES

type Mode = 'list' | 'window' | 'chart' | 'rename' | 'remove'
type FormMode = Exclude<Mode, 'list'>

/**
 * A failed tile always carries the server's sentence (`error`); one without it is a server bug,
 * logged loud here rather than covered with a copy of a server sentence.
 */
function unexplainedError(id: string): string {
  console.error(`insights: tile ${id} has status error but no error sentence from the server`)
  return 'This tile did not run.'
}

/** Focuses the element once, when the form that holds it opens (keyboard users land in it). */
function useFocusOnOpen<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return ref
}

/** What a finished change says (announced politely to screen readers). */
export type Changed = (message: string) => void

const panelLink =
  'inline-flex min-h-8 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-ink hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50'

function WindowForm({ tile, onSave, onCancel, saving }: { tile: InsightTile; onSave: (patch: InsightPatch) => void; onCancel: () => void; saving: boolean }) {
  const current = tile.window
  const [pick, setPick] = useState<RollingPreset | 'fixed'>(current?.kind === 'rolling' ? current.preset : 'fixed')
  const [from, setFrom] = useState(current?.from ?? '')
  const [to, setTo] = useState(current?.to ?? '')
  const name = useId()
  const hintId = useId()
  const checked = useFocusOnOpen<HTMLInputElement>()
  // A title naming a preset ("…last month") reads wrong once the period changes: say so, once.
  const titlePeriod = PRESETS.find((preset) => tile.title.toLowerCase().includes(PRESET_LABEL[preset].toLowerCase()))
  function submit(e: FormEvent) {
    e.preventDefault()
    onSave({ window: pick === 'fixed' ? { fixed: [from, to] } : { rolling: pick } })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <fieldset className="space-y-1.5" aria-describedby={hintId}>
        <legend className="mb-1 text-sm font-medium text-ink">Time period</legend>
        <p id={hintId} className="text-xs text-ink-muted">
          A rolling period moves with today; fixed dates stay.
        </p>
        {PRESETS.map((preset) => {
          // The dates each preset covers today, from the one shared rule.
          const dates = resolveWindow({ rolling: preset }, TODAY)
          return (
            <label key={preset} className="flex min-h-6 items-center gap-2 text-sm">
              <input ref={pick === preset ? checked : undefined} type="radio" name={name} checked={pick === preset} onChange={() => setPick(preset)} />
              <span>
                Rolling: {PRESET_LABEL[preset].toLowerCase()} <span className="text-ink-muted">({humanRange(dates.from, dates.to)})</span>
              </span>
            </label>
          )
        })}
        <label className="flex min-h-6 items-center gap-2 text-sm">
          <input ref={pick === 'fixed' ? checked : undefined} type="radio" name={name} checked={pick === 'fixed'} onChange={() => setPick('fixed')} />
          Fixed dates
        </label>
      </fieldset>
      {titlePeriod !== undefined && titlePeriod !== pick && (
        <p className="text-xs text-ink">
          The title says “{PRESET_LABEL[titlePeriod].toLowerCase()}”. After saving, use Rename so it matches the new period.
        </p>
      )}
      {pick === 'fixed' && (
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1 text-sm">
            <span className="block text-ink-muted">From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="min-h-9 rounded-lg border border-line-strong bg-page px-2 text-ink" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-ink-muted">To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="min-h-9 rounded-lg border border-line-strong bg-page px-2 text-ink" />
          </label>
        </div>
      )}
      <FormButtons saving={saving} onCancel={onCancel} disabled={pick === 'fixed' && (from === '' || to === '')} />
    </form>
  )
}

function ChartForm({ tile, onSave, onCancel, saving }: { tile: InsightTile; onSave: (patch: InsightPatch) => void; onCancel: () => void; saving: boolean }) {
  const [pick, setPick] = useState<ChartChoice | 'auto'>(tile.chart_override ?? 'auto')
  const name = useId()
  const checked = useFocusOnOpen<HTMLInputElement>()
  const result = tile.result ?? { columns: [], rows: [] }
  const options = CHOICES.filter((kind) => chartFits(kind, result, tile.segment))
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave({ chart: pick === 'auto' ? null : pick })
      }}
      className="space-y-3"
    >
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-sm font-medium text-ink">Show as</legend>
        <label className="flex min-h-6 items-center gap-2 text-sm">
          <input ref={pick === 'auto' ? checked : undefined} type="radio" name={name} checked={pick === 'auto'} onChange={() => setPick('auto')} />
          Automatic (best fit for the result)
        </label>
        {options.map((kind) => (
          <label key={kind} className="flex min-h-6 items-center gap-2 text-sm">
            <input ref={pick === kind ? checked : undefined} type="radio" name={name} checked={pick === kind} onChange={() => setPick(kind)} />
            {CHART_LABEL[kind]}
          </label>
        ))}
      </fieldset>
      <FormButtons saving={saving} onCancel={onCancel} />
    </form>
  )
}

function RenameForm({ tile, onSave, onCancel, saving }: { tile: InsightTile; onSave: (patch: InsightPatch) => void; onCancel: () => void; saving: boolean }) {
  const [title, setTitle] = useState(tile.title)
  const id = useId()
  const input = useFocusOnOpen<HTMLInputElement>()
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave({ title })
      }}
      className="space-y-3"
    >
      <div className="space-y-1">
        <label htmlFor={id} className="block text-sm font-medium text-ink">
          Tile title
        </label>
        <input
          ref={input}
          id={id}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoComplete="off"
          className="min-h-9 w-full rounded-lg border border-line-strong bg-page px-3 py-1.5 text-sm text-ink"
        />
      </div>
      <FormButtons saving={saving} onCancel={onCancel} disabled={title.trim() === ''} />
    </form>
  )
}

function RemoveConfirm({ tile, saving, onRemove, onCancel }: { tile: InsightTile; saving: boolean; onRemove: () => void; onCancel: () => void }) {
  const question = useFocusOnOpen<HTMLParagraphElement>()
  return (
    <div className="space-y-2">
      <p ref={question} tabIndex={-1} className="text-sm text-ink focus:outline-none">
        Remove “{tile.title}” from the board? You can pin it again from a new answer.
      </p>
      <div className="flex flex-wrap gap-2">
        {/* aria-disabled, not disabled, while it works: a disabled button drops focus to the page. */}
        <Button
          icon={ICONS.remove}
          aria-disabled={saving}
          className="border-danger-line text-danger aria-disabled:cursor-wait"
          onClick={() => {
            if (!saving) onRemove()
          }}
        >
          {saving ? 'Removing…' : 'Remove'}
        </Button>
        <Button onClick={onCancel} disabled={saving}>
          Keep it
        </Button>
      </div>
    </div>
  )
}

function FormButtons({ saving, onCancel, disabled = false }: { saving: boolean; onCancel: () => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" variant="primary" icon={ICONS.done} disabled={saving || disabled}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
      <Button onClick={onCancel} disabled={saving}>
        Cancel
      </Button>
    </div>
  )
}

/**
 * The gated "Set an alert" item (coming soon), shown only on a tile with one
 * number (chart 'number' or 'segment'): a bar, line or table has no single number to cross a line.
 * Shares its flag and note with the board header's "Send the board" (schedules_and_digests:
 * one flag, one note, written once). Activation only opens the shared "Coming soon" pop-up.
 */
export function SetAlertItem() {
  const gated = useGated('schedules_and_digests')
  return (
    <li className="space-y-1">
      <button
        type="button"
        {...gated.bind}
        onClick={gated.activate}
        className={`inline-flex min-h-8 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${GATED_LOOK}`}
      >
        <Icon icon={ICONS.notify} /> {gated.feature.controls![1]}
      </button>
      <GatedNote id={gated.noteId} text={gated.feature.note} />
    </li>
  )
}

/**
 * The tile's level-2 panel. Built-in tiles have no Remove (the server would answer 409).
 * Moving swaps sort_order with the neighbour, one PATCH each.
 */
export function TileActions({
  tile,
  above,
  below,
  onChanged,
  onRemoved,
  onExplain,
  onClose,
  initialMode = 'list',
}: {
  tile: InsightTile
  above: InsightTile | null
  below: InsightTile | null
  onChanged: Changed
  onRemoved: Changed
  onExplain: (question: string) => void
  /** Closes the panel; Cancel calls it when the form was opened straight from the time period. */
  onClose: () => void
  /** 'window' when the tile's time period was pressed: the form opens with no list first. */
  initialMode?: Mode
}) {
  const [mode, setMode] = useState<Mode>(initialMode)
  // The list item that opened the current form; Cancel gives focus back to it.
  const opener = useRef<FormMode | null>(null)
  const items = useRef<Partial<Record<FormMode, HTMLButtonElement | null>>>({})
  useEffect(() => {
    if (mode === 'list' && opener.current !== null) {
      items.current[opener.current]?.focus()
      opener.current = null
    }
  }, [mode])
  const open = (next: FormMode) => {
    opener.current = next
    setMode(next)
  }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const path = `/api/insights/${tile.id}`
  const result = tile.result ?? { columns: [], rows: [] }
  const canChangeChart = tile.chart !== 'segment' && CHOICES.filter((kind) => chartFits(kind, result, tile.segment)).length > 1

  async function run(action: () => Promise<void>, done: string, removed = false) {
    setSaving(true)
    setError(null)
    try {
      await action()
      setSaving(false)
      if (removed) {
        // The tile is about to unmount: no list item takes focus back (the [mode] effect would pull
        // it into a node that is then removed, dropping focus to the page). The page moves focus to
        // the board heading instead (InsightsPage removed()).
        opener.current = null
        onRemoved(done)
        return
      }
      setMode('list')
      onChanged(done)
    } catch (err) {
      console.error('insights: tile change failed', tile.id, err)
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  const save = (patch: InsightPatch, done: string) => run(async () => void (await patchJson<InsightTile>(path, patch)), done)

  async function move(neighbour: InsightTile, direction: 'up' | 'down') {
    // Equal positions still swap: the moved tile steps one past its neighbour.
    const mine = neighbour.sort_order === tile.sort_order ? neighbour.sort_order + (direction === 'up' ? -1 : 1) : neighbour.sort_order
    await run(async () => {
      await patchJson<InsightTile>(path, { sort_order: mine } satisfies InsightPatch)
      await patchJson<InsightTile>(`/api/insights/${neighbour.id}`, { sort_order: tile.sort_order } satisfies InsightPatch)
    }, `Moved “${tile.title}” ${direction}.`)
  }

  const cancel = () => {
    setError(null)
    // Opened straight from the time period: Cancel closes the panel and focus goes back there.
    if (opener.current === null) onClose()
    else setMode('list')
  }

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-3">
      {mode === 'list' && (
        <ul className="grid gap-0.5 sm:grid-cols-2">
          {tile.window !== null && (
            <li>
              <button type="button" ref={(el) => void (items.current.window = el)} className={panelLink} onClick={() => open('window')}>
                <Icon icon={ICONS.window} /> Change time period
              </button>
            </li>
          )}
          {canChangeChart && (
            <li>
              <button type="button" ref={(el) => void (items.current.chart = el)} className={panelLink} onClick={() => open('chart')}>
                <Icon icon={ICONS.chart} /> Change chart
              </button>
            </li>
          )}
          <li>
            <button type="button" ref={(el) => void (items.current.rename = el)} className={panelLink} onClick={() => open('rename')}>
              <Icon icon={ICONS.rename} /> Rename
            </button>
          </li>
          <li>
            <button type="button" className={panelLink} onClick={() => onExplain(tile.explain)}>
              <Icon icon={ICONS.assistant} /> Explain this
            </button>
          </li>
          {(tile.chart === 'number' || tile.chart === 'segment') && <SetAlertItem />}
          <li>
            <button type="button" className={panelLink} disabled={above === null || saving} onClick={() => above !== null && void move(above, 'up')}>
              <Icon icon={ICONS.moveUp} /> Move up
            </button>
          </li>
          <li>
            <button type="button" className={panelLink} disabled={below === null || saving} onClick={() => below !== null && void move(below, 'down')}>
              <Icon icon={ICONS.moveDown} /> Move down
            </button>
          </li>
          {!tile.built_in && (
            <li>
              <button type="button" ref={(el) => void (items.current.remove = el)} className={`${panelLink} text-danger`} onClick={() => open('remove')}>
                <Icon icon={ICONS.remove} /> Remove
              </button>
            </li>
          )}
        </ul>
      )}
      {mode === 'window' && <WindowForm tile={tile} saving={saving} onCancel={cancel} onSave={(p) => void save(p, `Changed the time period of “${tile.title}”.`)} />}
      {mode === 'chart' && <ChartForm tile={tile} saving={saving} onCancel={cancel} onSave={(p) => void save(p, `Changed the chart of “${tile.title}”.`)} />}
      {mode === 'rename' && <RenameForm tile={tile} saving={saving} onCancel={cancel} onSave={(p) => void save(p, `Renamed the tile to “${p.title ?? ''}”.`)} />}
      {mode === 'remove' && (
        <RemoveConfirm
          tile={tile}
          saving={saving}
          onCancel={cancel}
          onRemove={() => void run(async () => void (await request(path, { method: 'DELETE' })), `Removed “${tile.title}”.`, true)}
        />
      )}
      {error !== null && <ErrorLine message={error} next="Change it and try again, or press Cancel." />}
      {mode === 'list' && (
        <TechnicalDetails>
          <p>Tool: {tile.tool}{tile.built_in ? ' (built-in)' : ''}</p>
          {tile.prompt !== null && <p>Asked as: {tile.prompt}</p>}
          <p>
            Chart: {tile.chart}
            {tile.chart_override === null ? ' (automatic)' : ` (chosen: ${tile.chart_override})`}
          </p>
          {tile.window !== null && (
            <p>
              Window: {tile.window.kind}
              {tile.window.preset !== undefined ? ` ${tile.window.preset}` : ''} {tile.window.from} to {tile.window.to}
            </p>
          )}
          {tile.segment !== null && <p className="break-all">Segment filters: {JSON.stringify(tile.segment.filters)}</p>}
          <p className="break-all">Params: {JSON.stringify(tile.params)}</p>
          {tile.sql !== null && <p className="break-all">SQL: {tile.sql}</p>}
          {tile.result !== null && <p>Columns: {tile.result.columns.join(', ')}</p>}
          {tile.error_details !== null && <p className="break-all">Why it did not run: {tile.error_details}</p>}
          <p>Ran at: {utc(tile.ran_at)}</p>
          <p className="break-all">Tile id: {tile.id}</p>
        </TechnicalDetails>
      )}
    </div>
  )
}

function Tile({
  tile,
  above,
  below,
  onChanged,
  onRemoved,
  onExplain,
}: {
  tile: InsightTile
  above: InsightTile | null
  below: InsightTile | null
  onChanged: Changed
  onRemoved: Changed
  onExplain: (question: string) => void
}) {
  // Which panel is open: the Options list, or the time period form straight from the footer.
  const [open, setOpen] = useState<Mode | null>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const period = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const panelId = useId()
  const close = () => {
    const from = open === 'window' ? period.current : toggle.current
    setOpen(null)
    from?.focus()
  }
  return (
    <article
      id={tileElementId(tile.id)}
      tabIndex={-1}
      aria-labelledby={headingId}
      // Esc closes the open panel wherever focus is in the tile, the Options toggle included.
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open !== null) {
          e.stopPropagation()
          close()
        }
      }}
      className="flex min-w-0 scroll-mt-4 flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-soft sm:p-5"
    >
      <div className="flex items-start gap-2">
        <h3 id={headingId} className="mr-auto min-w-0 font-display text-base font-medium break-words text-ink sm:text-lg">
          {tile.title}
        </h3>
        <Button
          ref={toggle}
          variant="quiet"
          icon={ICONS.tileOptions}
          aria-expanded={open === 'list'}
          aria-controls={panelId}
          onClick={() => setOpen(open === 'list' ? null : 'list')}
          className="shrink-0"
        >
          Options<span className="sr-only"> for {tile.title}</span>
        </Button>
      </div>
      {open !== null && (
        <div id={panelId}>
          <TileActions
            key={open}
            initialMode={open}
            onClose={close}
            tile={tile}
            above={above}
            below={below}
            onChanged={(message) => {
              close()
              onChanged(message)
            }}
            onRemoved={onRemoved}
            onExplain={(question) => {
              setOpen(null)
              onExplain(question)
            }}
          />
        </div>
      )}
      <div className="min-w-0 flex-1">
        {tile.status === 'error' ? (
          // The server's sentence carries its own next step; raw problems sit in Technical details.
          <ErrorLine message={tile.error ?? unexplainedError(tile.id)} />
        ) : (
          <InsightChart kind={tile.chart} result={tile.result ?? { columns: [], rows: [] }} segment={tile.segment} caption={tile.title} />
        )}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-2 text-xs text-ink-muted">
        {tile.window !== null ? (
          <button
            ref={period}
            type="button"
            aria-expanded={open === 'window'}
            aria-controls={panelId}
            onClick={() => setOpen(open === 'window' ? null : 'window')}
            className="inline-flex min-h-6 items-center gap-1 rounded-md text-xs font-medium text-accent hover:text-accent-strong hover:underline hover:underline-offset-4"
          >
            <Icon icon={ICONS.window} className="size-3.5" />
            {windowText(tile.window)}
            <span className="sr-only">: change time period for {tile.title}</span>
          </button>
        ) : tile.own_dates !== null ? (
          <span className="inline-flex items-center gap-1">
            <Icon icon={ICONS.window} className="size-3.5" />
            {ownDatesText(tile.own_dates)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <Icon icon={ICONS.today} className="size-3.5" />
            As of {humanDate(TODAY)}
          </span>
        )}
        <span aria-hidden="true">·</span>
        <span>Updated just now</span>
      </p>
    </article>
  )
}

/** The tiles in sort_order, two columns from 768 px, one below (works on a phone). */
export function BoardGrid({
  tiles,
  onChanged,
  onRemoved,
  onExplain,
}: {
  tiles: InsightTile[]
  onChanged: Changed
  onRemoved: Changed
  onExplain: (question: string) => void
}) {
  const sorted = [...tiles].sort((a, b) => a.sort_order - b.sort_order)
  return (
    <div className="grid items-start gap-4 md:grid-cols-2">
      {sorted.map((tile, i) => (
        <Tile
          key={tile.id}
          tile={tile}
          above={sorted[i - 1] ?? null}
          below={sorted[i + 1] ?? null}
          onChanged={onChanged}
          onRemoved={onRemoved}
          onExplain={onExplain}
        />
      ))}
    </div>
  )
}
