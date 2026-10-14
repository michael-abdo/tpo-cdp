// The board of /insights (06 §/insights, 09 D-64): tiles in sort_order, each re-run by the server
// on every GET /api/insights through the gated executor, with no model call (04). Level 1 per tile:
// its title, the chart (the server's `chart`: an override, else pickChart on the result), the
// window in words and "Updated just now" (the board was fetched for this view; the exact UTC time is
// in Technical details, so the page reads no wall clock, 02 §Time). One tile's error shows on that
// tile only. Level 2 = the tile's "Options" panel: Change window · Change chart · Rename · Move
// up/down · Remove (not on built-in tiles, which the server refuses with 409) · Explain this (fills
// the Ask bar) · Technical details. Each change is one PATCH or DELETE; the board is then fetched
// again, so what shows is always the server's. Inputs are sent as typed (02 §Normalization: the
// server validates and answers with the 04 envelope, shown in words).

import { type FormEvent, useId, useRef, useState } from 'react'
import { errorMessage, patchJson, request } from '../api'
import { Button, ErrorLine, ICONS, Icon, TechnicalDetails } from '../components'
import { utc } from '../format'
import type { ChartChoice, InsightPatch, InsightTile } from '../types'
import { InsightChart } from './charts'
import { CHART_LABEL, chartFits } from './shapes'
import type { RollingPreset } from '../../shared/insight-window'
import { CHART_OVERRIDES } from '../../shared/pick-chart'
import { PRESET_LABEL, PRESETS, windowText } from './windows'

const CHOICES: readonly ChartChoice[] = CHART_OVERRIDES

type Mode = 'list' | 'window' | 'chart' | 'rename' | 'remove'

/** What a finished change says (announced politely, 06 §UI principles 7). */
export type Changed = (message: string) => void

const panelLink =
  'inline-flex min-h-8 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-ink hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50'

function WindowForm({ tile, onSave, onCancel, saving }: { tile: InsightTile; onSave: (patch: InsightPatch) => void; onCancel: () => void; saving: boolean }) {
  const current = tile.window
  const [pick, setPick] = useState<RollingPreset | 'fixed'>(current?.kind === 'rolling' ? current.preset : 'fixed')
  const [from, setFrom] = useState(current?.from ?? '')
  const [to, setTo] = useState(current?.to ?? '')
  const name = useId()
  function submit(e: FormEvent) {
    e.preventDefault()
    onSave({ window: pick === 'fixed' ? { fixed: [from, to] } : { rolling: pick } })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-sm font-medium text-ink">Time period</legend>
        {PRESETS.map((preset) => (
          <label key={preset} className="flex min-h-6 items-center gap-2 text-sm">
            <input type="radio" name={name} checked={pick === preset} onChange={() => setPick(preset)} />
            Rolling: {PRESET_LABEL[preset].toLowerCase()}
          </label>
        ))}
        <label className="flex min-h-6 items-center gap-2 text-sm">
          <input type="radio" name={name} checked={pick === 'fixed'} onChange={() => setPick('fixed')} />
          Fixed dates
        </label>
      </fieldset>
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
          <input type="radio" name={name} checked={pick === 'auto'} onChange={() => setPick('auto')} />
          Automatic (best fit for the result)
        </label>
        {options.map((kind) => (
          <label key={kind} className="flex min-h-6 items-center gap-2 text-sm">
            <input type="radio" name={name} checked={pick === kind} onChange={() => setPick(kind)} />
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
 * The tile's level-2 panel. Built-in tiles have no Remove (09 D-64; the server would answer 409).
 * Moving swaps sort_order with the neighbour, one PATCH each.
 */
export function TileActions({
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
  const [mode, setMode] = useState<Mode>('list')
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
      setMode('list')
      if (removed) onRemoved(done)
      else onChanged(done)
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
    setMode('list')
    setError(null)
  }

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-3">
      {mode === 'list' && (
        <ul className="grid gap-0.5 sm:grid-cols-2">
          {tile.window !== null && (
            <li>
              <button type="button" className={panelLink} onClick={() => setMode('window')}>
                <Icon icon={ICONS.window} /> Change window
              </button>
            </li>
          )}
          {canChangeChart && (
            <li>
              <button type="button" className={panelLink} onClick={() => setMode('chart')}>
                <Icon icon={ICONS.chart} /> Change chart
              </button>
            </li>
          )}
          <li>
            <button type="button" className={panelLink} onClick={() => setMode('rename')}>
              <Icon icon={ICONS.rename} /> Rename
            </button>
          </li>
          <li>
            <button type="button" className={panelLink} onClick={() => onExplain(tile.explain)}>
              <Icon icon={ICONS.assistant} /> Explain this
            </button>
          </li>
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
              <button type="button" className={`${panelLink} text-danger`} onClick={() => setMode('remove')}>
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
        <div className="space-y-2">
          <p className="text-sm text-ink">Remove “{tile.title}” from the board? You can pin it again from a new answer.</p>
          <div className="flex flex-wrap gap-2">
            <Button
              icon={ICONS.remove}
              disabled={saving}
              className="border-danger-line text-danger"
              onClick={() => void run(async () => void (await request(path, { method: 'DELETE' })), `Removed “${tile.title}”.`, true)}
            >
              {saving ? 'Removing…' : 'Remove'}
            </Button>
            <Button onClick={cancel} disabled={saving}>
              Keep it
            </Button>
          </div>
        </div>
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
  const [open, setOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const panelId = useId()
  const close = () => {
    setOpen(false)
    toggle.current?.focus()
  }
  return (
    <article aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-soft sm:p-5">
      <div className="flex items-start gap-2">
        <h3 id={headingId} className="mr-auto min-w-0 font-display text-base font-medium break-words text-ink sm:text-lg">
          {tile.title}
        </h3>
        <Button
          ref={toggle}
          variant="quiet"
          icon={ICONS.tileOptions}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
          className="shrink-0"
        >
          Options<span className="sr-only"> for {tile.title}</span>
        </Button>
      </div>
      {open && (
        <div
          id={panelId}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
          }}
        >
          <TileActions
            tile={tile}
            above={above}
            below={below}
            onChanged={(message) => {
              close()
              onChanged(message)
            }}
            onRemoved={onRemoved}
            onExplain={(question) => {
              setOpen(false)
              onExplain(question)
            }}
          />
        </div>
      )}
      <div className="min-w-0 flex-1">
        {tile.status === 'error' ? (
          <ErrorLine message={tile.error ?? 'This tile could not be run.'} next="Press Refresh to try again." />
        ) : (
          <InsightChart kind={tile.chart} result={tile.result ?? { columns: [], rows: [] }} segment={tile.segment} caption={tile.title} />
        )}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-2 text-xs text-ink-muted">
        {tile.window !== null && (
          <span className="inline-flex items-center gap-1">
            <Icon icon={ICONS.window} className="size-3.5" />
            {windowText(tile.window)}
          </span>
        )}
        {tile.window !== null && <span aria-hidden="true">·</span>}
        <span>Updated just now</span>
      </p>
    </article>
  )
}

/** The tiles in sort_order, two columns from 768 px, one below (06 §UI principles 9). */
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
