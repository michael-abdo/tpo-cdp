// The charts of /insights (06 §/insights, 09 D-64): our own SVG, no chart library and no CDN. The
// kind comes from the result's shape (shared/pick-chart.ts pickChart, or a tile's chart override);
// this file only draws it. Colours are theme tokens (index.css), so light and dark both hold.
// Every chart carries its numbers as text (06 §UI principles 7): the SVG is decoration
// (aria-hidden) and the same rows sit in a real <table> that screen readers always read; "Show the
// numbers" makes that table visible too, so no value lives only in a bar's length or a line's height.
// A number and a segment are text already. Each drawing needs a column shape (shapes.ts); a stored
// kind whose shape the result lacks falls back to the table and says so.

import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { ChartKind } from '../../shared/pick-chart'
import { Button, type Column, ICONS, ResponsiveTable } from '../components'
import { humanDate, humanMonth } from '../format'
import { columnLabel } from '../labels'
import { cellText, fmt, isRateColumn } from './cells'
import {
  type BarShape,
  barShape,
  cell,
  CHART_LABEL,
  type ChartResult,
  type ChartSegment,
  FIRST_ROWS,
  type LineShape,
  lineShape,
  type NumberShape,
  numberShape,
} from './shapes'

/** A time value in words: `Aug 2026` or `Aug 1, 2026`. */
function timeText(value: string): string {
  return value.length === 7 ? humanMonth(value) : humanDate(value)
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// ── the numbers as text ──────────────────────────────────────────────────────────────────

/**
 * Every row of the result as a table. Screen readers always read it; sighted readers see it after
 * "Show the numbers". One table, so nothing is read twice.
 */
function NumbersTable({ id, caption, result, visible }: { id: string; caption: string; result: ChartResult; visible: boolean }) {
  // The wrapper clips: a <table> ignores the 1px box sr-only gives it and would widen the page.
  return (
    <div id={id} className={visible ? 'overflow-x-auto' : 'sr-only'}>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-muted">
            {result.columns.map((c) => (
              <th key={c} scope="col" className="py-1.5 pr-3 font-semibold">
                {columnLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className="border-b border-line last:border-b-0">
              {result.columns.map((c) => (
                <td key={c} className={`py-1.5 pr-3 ${typeof cell(row, c) === 'number' ? 'tabular-nums' : ''}`}>
                  {cellText(c, cell(row, c))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A drawn chart with its numbers table and the "Show the numbers" toggle. */
function ChartFigure({ caption, result, children }: { caption: string; result: ChartResult; children: ReactNode }) {
  const [visible, setVisible] = useState(false)
  const tableId = useId()
  return (
    <figure className="space-y-2">
      <div aria-hidden="true">{children}</div>
      <NumbersTable id={tableId} caption={caption} result={result} visible={visible} />
      <figcaption>
        <button
          type="button"
          aria-expanded={visible}
          aria-controls={tableId}
          onClick={() => setVisible(!visible)}
          className="inline-flex min-h-6 items-center gap-1 rounded-md py-0.5 text-sm font-medium text-accent hover:text-accent-strong hover:underline hover:underline-offset-4"
        >
          {visible ? 'Hide the numbers' : 'Show the numbers'}
          <span className="sr-only"> for {caption}</span>
        </button>
      </figcaption>
    </figure>
  )
}

// ── the five kinds ───────────────────────────────────────────────────────────────────────

export function NumberTile({ shape }: { shape: NumberShape }) {
  return (
    <div className="space-y-1">
      <p className="font-display text-4xl font-medium tabular-nums text-ink">{cellText(shape.column, shape.value)}</p>
      <p className="text-sm text-ink-muted">{columnLabel(shape.column)}</p>
      {shape.others.length > 0 && (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-sm">
          {shape.others.map(({ column, value }) => (
            <div key={column} className="flex gap-1.5">
              <dt className="text-ink-muted">{columnLabel(column)}:</dt>
              <dd className="tabular-nums text-ink">{cellText(column, value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

const BAR_ROW = 36
/** The longest bar's share of the width; the rest leaves room for its value label. */
const BAR_SPAN = 78

export function BarChart({ shape, result, caption }: { shape: BarShape; result: ChartResult; caption: string }) {
  const rows: { key: string; label: string; value: number | null; muted: boolean }[] = shape.bars.map((b) => ({ ...b, muted: false }))
  if (shape.other !== null) {
    rows.push({ key: 'other', label: `Other (${fmt(shape.other.count)} more)`, value: shape.other.value, muted: true })
  }
  const width = (v: number | null) => (v === null || shape.max <= 0 ? 0 : (Math.max(0, v) / shape.max) * BAR_SPAN)
  return (
    <ChartFigure caption={caption} result={result}>
      <p className="mb-1 flex justify-between gap-3 text-xs text-ink-muted">
        <span>{columnLabel(shape.category)}</span>
        <span>{columnLabel(shape.value)}</span>
      </p>
      <svg width="100%" height={rows.length * BAR_ROW} focusable="false" className="block overflow-visible">
        {rows.map((r, i) => {
          const top = i * BAR_ROW
          const w = width(r.value)
          return (
            <g key={r.key}>
              <text x="0" y={top + 12} fontSize="12" fill="var(--ink)">
                {shorten(r.label, 48)}
              </text>
              <rect x="0" y={top + 18} width="100%" height="10" rx="5" fill="var(--surface-2)" />
              <rect x="0" y={top + 18} width={`${w}%`} height="10" rx="5" fill={r.muted ? 'var(--ink-subtle)' : 'var(--accent)'} />
              <text x={`${w}%`} dx="6" y={top + 27} fontSize="12" fill="var(--ink-muted)" className="tabular-nums">
                {r.value === null ? '' : cellText(shape.value, r.value)}
              </text>
            </g>
          )
        })}
      </svg>
    </ChartFigure>
  )
}

/** The chart's drawing width: the box's measured width in the browser, `fallback` until then. */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.round(entry.contentRect.width))))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/** A rounded-up top for the value axis: 1, 2 or 5 times a power of ten. */
function niceMax(max: number, rate: boolean): number {
  if (rate) return max <= 0 ? 1 : Math.min(1, Math.ceil(max * 10) / 10)
  if (max <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(max))
  const step = [1, 2, 5, 10].find((m) => m * power >= max) ?? 10
  return step * power
}

const LINE_HEIGHT = 200
const PAD = { top: 16, right: 20, bottom: 28, left: 52 }

export function LineChart({ shape, result, caption }: { shape: LineShape; result: ChartResult; caption: string }) {
  const [ref, width] = useWidth(560)
  const rate = isRateColumn(shape.value)
  const top = niceMax(Math.max(...shape.points.map((p) => p.y)), rate)
  const plotW = width - PAD.left - PAD.right
  const plotH = LINE_HEIGHT - PAD.top - PAD.bottom
  const n = shape.points.length
  const x = (i: number) => PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const y = (v: number) => PAD.top + plotH - (Math.max(0, v) / top) * plotH
  const path = shape.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')
  const ticks = [0, top / 2, top]
  // First, last and (with five or more points) the middle point carry a time label.
  const labelled = new Set([0, n - 1, ...(n >= 5 ? [Math.floor((n - 1) / 2)] : [])])
  const last = shape.points[n - 1]
  return (
    <ChartFigure caption={caption} result={result}>
      <p className="mb-1 text-xs text-ink-muted">{columnLabel(shape.value)}</p>
      <div ref={ref}>
        <svg width={width} height={LINE_HEIGHT} focusable="false" className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
              <text x={PAD.left - 8} y={y(t) + 4} fontSize="12" textAnchor="end" fill="var(--ink-muted)" className="tabular-nums">
                {cellText(shape.value, t)}
              </text>
            </g>
          ))}
          <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          {shape.points.map((p, i) => (
            <circle key={p.x} cx={x(i)} cy={y(p.y)} r="3.5" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2" />
          ))}
          {shape.points.map((p, i) =>
            labelled.has(i) ? (
              <text
                key={p.x}
                x={x(i)}
                y={LINE_HEIGHT - 8}
                fontSize="12"
                textAnchor={n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
                fill="var(--ink-muted)"
              >
                {timeText(p.x)}
              </text>
            ) : null,
          )}
          <text x={x(n - 1)} y={y(last.y) - 10} fontSize="12" fontWeight="600" textAnchor={n === 1 ? 'middle' : 'end'} fill="var(--ink)" className="tabular-nums">
            {cellText(shape.value, last.y)}
          </text>
        </svg>
      </div>
    </ChartFigure>
  )
}

export function TableTile({ result, caption }: { result: ChartResult; caption: string }) {
  const [showAll, setShowAll] = useState(false)
  if (result.rows.length === 0) return <p className="text-sm text-ink-muted">No rows match.</p>
  const rows = result.rows.map((row, i) => ({ row, i }))
  const shown = showAll ? rows : rows.slice(0, FIRST_ROWS)
  const columns: Column<(typeof rows)[number]>[] = result.columns.map((name) => ({
    header: columnLabel(name),
    cell: ({ row }) => <span className="break-words">{cellText(name, cell(row, name))}</span>,
    numeric: rows.every(({ row }) => typeof cell(row, name) === 'number'),
  }))
  return (
    <div className="space-y-2">
      <ResponsiveTable caption={caption} columns={columns} rows={shown} rowKey={({ i }) => String(i)} />
      {!showAll && rows.length > FIRST_ROWS && <Button onClick={() => setShowAll(true)}>Show all {fmt(rows.length)} rows</Button>}
    </div>
  )
}

/** A list's size and the way to it; never its rows (09 D-64). "Open list" loads the filters on /segments. */
export function SegmentTile({ segment, children }: { segment: ChartSegment; children?: ReactNode }) {
  const navigate = useNavigate()
  return (
    <div className="space-y-3">
      <p className="font-display text-3xl font-medium tabular-nums text-ink">
        {segment.count === 1 ? '1 reader matches' : `${fmt(segment.count)} readers match`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={ICONS.openList} onClick={() => navigate('/segments', { state: { filters: segment.filters } })}>
          Open list
        </Button>
        {children}
      </div>
    </div>
  )
}

/**
 * Draws `kind`. A kind the result cannot draw (a stale override, a server choice this file cannot
 * honour) shows the table with a visible note and an error in the console, never a blank box.
 */
export function InsightChart({
  kind,
  result,
  segment,
  caption,
}: {
  kind: ChartKind
  result: ChartResult
  segment: ChartSegment | null
  caption: string
}) {
  if (kind === 'segment' && segment !== null) return <SegmentTile segment={segment} />
  if (kind === 'number') {
    const shape = numberShape(result)
    if (shape !== null) return <NumberTile shape={shape} />
  }
  if (kind === 'bar') {
    const shape = barShape(result)
    if (shape !== null) return <BarChart shape={shape} result={result} caption={caption} />
  }
  if (kind === 'line') {
    const shape = lineShape(result)
    if (shape !== null) return <LineChart shape={shape} result={result} caption={caption} />
  }
  if (kind !== 'table') {
    console.error(`insights: "${caption}" asked for a ${kind} chart its result cannot draw; showing a table`, result.columns)
    return (
      <div className="space-y-2">
        <p className="text-sm text-ink-muted">This result can&apos;t be drawn as a {CHART_LABEL[kind].toLowerCase()}, so it is shown as a table.</p>
        <TableTile result={result} caption={caption} />
      </div>
    )
  }
  return <TableTile result={result} caption={caption} />
}
