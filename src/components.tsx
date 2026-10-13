// Shared UI pieces every page uses (06 §UI principles, 09 D-55; 06 §Empty and error states).
// One calm visual system: gray neutrals, one blue accent, Tailwind defaults (09 D-45).
// Disclosure depth is fixed at two levels: Disclosure (level 2) may hold one TechnicalDetails
// (level 3); nothing nests deeper (principle 2).

import { type ButtonHTMLAttributes, Fragment, type ReactNode, useState } from 'react'

/** Primary = the one main action of a screen (principle 1); secondary = everything else. */
export function Button({
  variant = 'secondary',
  type = 'button',
  className = '',
  ...rest
}: { variant?: 'primary' | 'secondary'; className?: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>) {
  const look =
    variant === 'primary'
      ? 'bg-gray-900 text-white hover:bg-gray-700'
      : 'border border-gray-300 bg-white text-gray-900 hover:bg-gray-50'
  return (
    <button
      type={type}
      className={`inline-flex min-h-9 items-center justify-center gap-1 rounded px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${look} ${className}`}
      {...rest}
    />
  )
}

/**
 * The page's one <h1> (its job in plain words), one plain purpose line and an optional primary
 * action. Render it in every state (loading, error, result) so the heading never disappears.
 * The h1 takes focus after a route change (App.tsx Shell).
 */
export function PageHeader({ title, purpose, action }: { title: string; purpose?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h1 tabIndex={-1} className="text-xl font-semibold text-gray-900 focus:outline-none">
          {title}
        </h1>
        {purpose !== undefined && <p className="text-sm text-gray-600">{purpose}</p>}
      </div>
      {action !== undefined && <div className="shrink-0">{action}</div>}
    </div>
  )
}

function Chevron({ open }: { open?: boolean }) {
  // Inside <details> the rotation follows group-open; a button passes `open`.
  const turn = open === undefined ? 'group-open:rotate-90' : open ? 'rotate-90' : ''
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={`size-4 shrink-0 transition-transform motion-reduce:transition-none ${turn}`}>
      <path d="M7 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Level 2 (principles 2, 3): a native <details>/<summary> with a chevron and words, so hidden
 * info has scent, opens by tap or keyboard (Enter/Space) and never needs hover.
 * `label` is what the toggle says ("Details", "How the data was combined", "Show all 9 visits").
 */
export function Disclosure({
  label,
  children,
  defaultOpen = false,
  className = '',
}: {
  label: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
}) {
  return (
    <details className={`group ${className}`} open={defaultOpen}>
      <summary className="inline-flex min-h-6 cursor-pointer items-center gap-1 rounded py-0.5 text-sm font-medium text-blue-700 hover:underline">
        <Chevron />
        {label}
      </summary>
      <div className="mt-2 space-y-2">{children}</div>
    </details>
  )
}

/**
 * Level 3 (principle 2): the one fixed-labelled "Technical details" toggle. Use it only inside a
 * Disclosure (or a block that is itself level 2), never nested in another TechnicalDetails.
 * Holds raw names, codes, ids, pk_ keys, SQL shape and second-precise UTC times (format.ts utc()).
 */
export function TechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <details className="group">
      <summary className="inline-flex min-h-6 cursor-pointer items-center gap-1 rounded py-0.5 text-xs text-gray-600 hover:underline">
        <Chevron />
        Technical details
      </summary>
      <div className="mt-2 space-y-1 rounded bg-gray-50 p-3 text-xs text-gray-700">{children}</div>
    </details>
  )
}

/**
 * A polite live region (principle 7) for result counts and status changes. Keep it mounted and
 * change `message`, so screen readers hear each change. `visible` shows it as a quiet line too.
 */
export function Announcer({ message, visible = false }: { message: string; visible?: boolean }) {
  return (
    <p role="status" aria-live="polite" className={visible ? 'text-sm text-gray-600' : 'sr-only'}>
      {message}
    </p>
  )
}

/** A short text loading state, announced politely (principles 7, 8). */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" aria-live="polite" className="text-sm text-gray-600">
      {label}
    </p>
  )
}

/** fetch() rejects with these messages when the server can't be reached at all. */
const NETWORK_FAILURE = /failed to fetch|networkerror|load failed/i

/**
 * Shows the 04 error envelope's message (06 §Empty and error states) and an optional next step.
 * Pass `id` so an input can point at it with aria-describedby. A network failure becomes plain
 * guidance. `compact` drops the box (for the top bar).
 */
export function ErrorLine({
  message,
  next,
  id,
  compact = false,
}: {
  message: string
  next?: ReactNode
  id?: string
  compact?: boolean
}) {
  const shown = NETWORK_FAILURE.test(message) ? "Couldn't reach the server. Check your connection, then try again." : message
  return (
    <p
      role="alert"
      id={id}
      className={compact ? 'text-sm text-red-800' : 'rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800'}
    >
      {shown}
      {next !== undefined && <> {next}</>}
    </p>
  )
}

/**
 * An explicit empty state (06 §Empty and error states) that says what to do next and may offer a
 * one-click example (principle 6). `children` = the message; keep test-locked texts verbatim.
 */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="space-y-3 rounded border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
      <div>{children}</div>
      {action !== undefined && <div className="flex flex-wrap gap-2">{action}</div>}
    </div>
  )
}

/** Kept for existing pages; same as EmptyState without an action. */
export function Empty({ children }: { children: ReactNode }) {
  return <EmptyState>{children}</EmptyState>
}

/** A titled box with an optional one-line summary under the title. */
export function Section({ title, summary, children }: { title: string; summary?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded border border-gray-200 p-4">
      <div className="space-y-1">
        <h2 className="font-semibold text-gray-900">{title}</h2>
        {summary !== undefined && <p className="text-sm text-gray-600">{summary}</p>}
      </div>
      {children}
    </section>
  )
}

/** A label/value pair inside a <dl>. Labels are plain words, never raw field names (principle 4). */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-sm">
      <dt className="w-28 shrink-0 text-gray-600">{label}</dt>
      <dd className="break-all">{children}</dd>
    </div>
  )
}

/** Headline numbers as one <dl>; children are StatTile. Two columns on phones, four from 768 px. */
export function StatGrid({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <dl aria-label={label} className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
      {children}
    </dl>
  )
}

/** One headline number. Screen readers hear the label first (dt, then dd); `note` = optional next step. */
export function StatTile({ label, value, note }: { label: string; value: number; note?: ReactNode }) {
  return (
    <div className="flex flex-col rounded border border-gray-200 p-4">
      <dt className="order-2 text-sm text-gray-600">{label}</dt>
      <dd className="order-1 text-2xl font-semibold tabular-nums text-gray-900">{value.toLocaleString('en-US')}</dd>
      {note !== undefined && <dd className="order-3 mt-1 text-sm">{note}</dd>}
    </div>
  )
}

/** A small badge that carries its meaning in words, never colour alone (principle 7). */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded border border-gray-300 bg-gray-50 px-1.5 py-0.5 text-xs font-medium text-gray-800">
      {children}
    </span>
  )
}

export interface Column<T> {
  /** Plain-language header (principle 4); also the label in the stacked cards. */
  header: string
  cell: (row: T) => ReactNode
  /** Right-aligns the column in the table. */
  numeric?: boolean
}

/**
 * A table from 640 px up; stacked label:value cards below (principle 9), so the page never scrolls
 * sideways. `details` adds a per-row toggle ("Details" by default) for level-2 fields (principle 2).
 */
export function ResponsiveTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  details,
  detailsLabel = 'Details',
}: {
  caption: string
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  details?: (row: T) => ReactNode
  detailsLabel?: string
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const span = columns.length + (details ? 1 : 0)
  return (
    <>
      <table className="hidden w-full border-collapse text-sm sm:table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-600">
            {columns.map((c) => (
              <th key={c.header} scope="col" className={`px-2 py-2 font-medium ${c.numeric ? 'text-right' : ''}`}>
                {c.header}
              </th>
            ))}
            {details && (
              <th scope="col" className="px-2 py-2">
                <span className="sr-only">{detailsLabel}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row)
            const isOpen = open.has(key)
            const panelId = `row-details-${key}`
            return (
              <Fragment key={key}>
                <tr className="border-b border-gray-100 align-top">
                  {columns.map((c) => (
                    <td key={c.header} className={`px-2 py-2 ${c.numeric ? 'text-right tabular-nums' : ''}`}>
                      {c.cell(row)}
                    </td>
                  ))}
                  {details && (
                    <td className="px-2 py-1 text-right">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={panelId}
                        onClick={() => toggle(key)}
                        className="inline-flex min-h-6 items-center gap-1 rounded px-1 py-0.5 text-sm font-medium text-blue-700 hover:underline"
                      >
                        <Chevron open={isOpen} />
                        {detailsLabel}
                      </button>
                    </td>
                  )}
                </tr>
                {details && isOpen && (
                  <tr id={panelId} className="border-b border-gray-100 bg-gray-50">
                    <td colSpan={span} className="px-3 py-3">
                      {details(row)}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      <ul className="space-y-3 sm:hidden" aria-label={caption}>
        {rows.map((row) => (
          <li key={rowKey(row)} className="rounded border border-gray-200 p-3">
            <dl className="space-y-1">
              {columns.map((c) => (
                <div key={c.header} className="flex gap-2 text-sm">
                  <dt className="w-28 shrink-0 text-gray-600">{c.header}</dt>
                  <dd className="min-w-0 break-words">{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
            {details && (
              <Disclosure label={detailsLabel} className="mt-2">
                {details(row)}
              </Disclosure>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}
