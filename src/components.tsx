// Shared UI pieces every page uses. The screens are for non-technical staff on first sight, so
// they share one calm visual system: theme tokens from index.css, one ink-teal accent,
// lucide-react icons always beside a visible text label (icons are aria-hidden).
// Disclosure depth is fixed at two levels: Disclosure (level 2) may hold one TechnicalDetails
// (level 3); nothing nests deeper, so detail is one click away but never buried.

import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bell,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ChartColumn,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleUserRound,
  Download,
  Ellipsis,
  Eye,
  History,
  Inbox,
  Info,
  LayoutDashboard,
  ListFilter,
  LoaderCircle,
  LogOut,
  type LucideIcon,
  Menu,
  MessageCircleQuestion,
  Moon,
  Pencil,
  Pin,
  Radio,
  RefreshCw,
  ScrollText,
  Search,
  Send,
  ShieldBan,
  SlidersHorizontal,
  Sun,
  Trash2,
  TriangleAlert,
  Upload,
  UserSearch,
  Users,
  Wrench,
  X,
} from 'lucide-react'
import {
  type ButtonHTMLAttributes,
  Fragment,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { explain, isGlossaryKey, type TipKey } from '../shared/glossary'

export type { LucideIcon }

/**
 * One icon per meaning. Always render an icon next to its words, with aria-hidden — never
 * as the only carrier of meaning. Nav keys match the route; status keys match the outcome.
 */
export const ICONS = {
  // nav destinations
  overview: LayoutDashboard,
  lookup: UserSearch,
  segments: ListFilter,
  events: Activity,
  insights: ChartNoAxesCombined,
  audit: ScrollText,
  techy: Wrench,
  // asking (the Ask bar on /insights, "Explain this", the audit log's empty state)
  assistant: MessageCircleQuestion,
  // primary actions
  search: Search,
  preview: Eye,
  export: Download,
  next: ArrowRight,
  logout: LogOut,
  menu: Menu,
  navCaret: ChevronDown,
  themeLight: Sun,
  themeDark: Moon,
  today: CalendarDays,
  refresh: RefreshCw,
  info: Info,
  history: History,
  // insights board
  pin: Pin,
  tileOptions: Ellipsis,
  moveUp: ArrowUp,
  moveDown: ArrowDown,
  rename: Pencil,
  remove: Trash2,
  window: CalendarRange,
  chart: ChartColumn,
  openSegment: Users,
  close: X,
  done: Check,
  // status
  success: CircleCheck,
  blocked: ShieldBan,
  error: CircleAlert,
  warning: TriangleAlert,
  live: Radio,
  empty: Inbox,
  loading: LoaderCircle,
  // Gated future features: one icon per feature.
  upload: Upload,
  schedule: CalendarClock,
  settings: SlidersHorizontal,
  send: Send,
  digest: Send,
  notify: Bell,
  workSignIn: Building2,
  account: CircleUserRound,
} satisfies Record<string, LucideIcon>

/** Renders an ICONS entry (or any lucide icon) decoratively, sized to sit beside text. */
export function Icon({ icon: I, className = 'size-4' }: { icon: LucideIcon; className?: string }) {
  return <I aria-hidden="true" focusable="false" strokeWidth={1.75} className={`shrink-0 ${className}`} />
}

/** Primary = the one main action of a screen (each screen has one job); secondary = everything else. */
export function Button({
  variant = 'secondary',
  type = 'button',
  className = '',
  icon,
  children,
  ...rest
}: {
  variant?: 'primary' | 'secondary' | 'quiet'
  className?: string
  /** Optional lucide icon shown before the label (the label stays visible). */
  icon?: LucideIcon
  /** For returning focus to the button (a dialog or menu it opened has closed). */
  ref?: Ref<HTMLButtonElement>
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>) {
  const look =
    variant === 'primary'
      ? 'bg-accent text-on-accent shadow-soft hover:bg-accent-strong'
      : variant === 'quiet'
        ? 'text-ink-muted hover:bg-surface-2 hover:text-ink'
        : 'border border-line-strong bg-surface text-ink hover:border-ink-subtle hover:bg-surface-2'
  return (
    <button
      type={type}
      className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${look} ${className}`}
      {...rest}
    >
      {icon && <Icon icon={icon} />}
      {children}
    </button>
  )
}

/**
 * The page's one <h1> (its job in plain words), one plain purpose line and an optional primary
 * action. Render it in every state (loading, error, result) so the heading never disappears.
 * The h1 takes focus after a route change (App.tsx Shell).
 */
export function PageHeader({
  title,
  purpose,
  action,
  icon,
}: {
  title: string
  purpose?: ReactNode
  action?: ReactNode
  /** Optional icon in a soft tile before the title (use the page's ICONS nav entry). */
  icon?: LucideIcon
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 pt-2">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="mt-0.5 hidden size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent sm:inline-flex">
            <Icon icon={icon} className="size-5" />
          </span>
        )}
        <div className="min-w-0 space-y-1">
          <h1
            tabIndex={-1}
            className="font-display text-2xl font-medium text-ink focus:outline-none sm:text-[1.75rem] sm:leading-tight"
          >
            {title}
          </h1>
          {purpose !== undefined && <p className="max-w-prose text-sm text-ink-muted">{purpose}</p>}
        </div>
      </div>
      {/* min-w-0 max-w-full: without a cap here the flex item's content-based width (shrink-0)
          stays as wide as its content's one unwrapped line, which can push the page into
          sideways scroll on phone widths. Capped, a long line wraps instead. */}
      {action !== undefined && <div className="min-w-0 max-w-full shrink-0">{action}</div>}
    </div>
  )
}

function Chevron({ open }: { open?: boolean }) {
  // Inside <details> the rotation follows only its OWN <details> (direct summary child), so a closed
  // inner toggle never shows an open chevron when its outer one is open; a button passes `open`.
  const turn = open === undefined ? '[details[open]>summary>&]:rotate-90' : open ? 'rotate-90' : ''
  return (
    <ChevronRight
      aria-hidden="true"
      strokeWidth={2}
      className={`size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${turn}`}
    />
  )
}

/**
 * Level 2: a native <details>/<summary> with a chevron and words, so hidden
 * info has scent, opens by tap or keyboard (Enter/Space) and never needs hover.
 * `label` is what the toggle says ("Details", "How the data was combined", "Show all 9 visits").
 */
export function Disclosure({
  label,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  className = '',
}: {
  label: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  /** Controlled: whether it is open; pair with onOpenChange (the native toggle reports each change). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}) {
  return (
    <details
      className={className || undefined}
      open={open ?? defaultOpen}
      onToggle={onOpenChange && ((e) => onOpenChange(e.currentTarget.open))}
    >
      <summary className="inline-flex min-h-6 cursor-pointer items-center gap-1 rounded-md py-0.5 text-sm font-medium text-accent hover:text-accent-strong hover:underline hover:underline-offset-4">
        <Chevron />
        {label}
      </summary>
      <div className="mt-2 space-y-2">{children}</div>
    </details>
  )
}

/**
 * Level 3: the one fixed-labelled "Technical details" toggle. Use it only inside a
 * Disclosure (or a block that is itself level 2), never nested in another TechnicalDetails.
 * Holds raw names, codes, ids, pk_ keys, SQL shape and second-precise UTC times (format.ts utc()).
 */
export function TechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <details>
      <summary className="inline-flex min-h-6 cursor-pointer items-center gap-1 rounded-md py-0.5 text-xs font-medium text-ink-muted hover:text-ink hover:underline hover:underline-offset-4">
        <Chevron />
        Technical details
      </summary>
      <div className="mt-2 space-y-1 rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs break-words text-gray-700">
        {children}
      </div>
    </details>
  )
}

/**
 * A polite live region (for screen readers) for result counts and status changes. Keep it mounted and
 * change `message`, so screen readers hear each change. `visible` shows it as a quiet line too.
 */
export function Announcer({ message, visible = false }: { message: string; visible?: boolean }) {
  return (
    <p role="status" aria-live="polite" className={visible ? 'text-sm text-ink-muted' : 'sr-only'}>
      {message}
    </p>
  )
}

/** A short text loading state, announced politely; text, not a spinner alone. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" aria-live="polite" className="inline-flex items-center gap-2 text-sm text-ink-muted">
      <Icon icon={ICONS.loading} className="size-4 animate-spin motion-reduce:animate-none" />
      {label}
    </p>
  )
}

/** fetch() rejects with these messages when the server can't be reached at all. */
const NETWORK_FAILURE = /failed to fetch|networkerror|load failed/i

/**
 * Shows the error envelope's message and an optional next step.
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
  const shown = NETWORK_FAILURE.test(message)
    ? "Couldn't reach the server. Check your connection, then try again."
    : message
  return (
    <p
      role="alert"
      id={id}
      className={`flex items-start gap-2 text-sm text-danger ${compact ? '' : 'rounded-lg border border-danger-line bg-danger-soft px-3 py-2.5'}`}
    >
      <Icon icon={ICONS.error} className="mt-0.5 size-4" />
      <span>
        {shown}
        {next !== undefined && <> {next}</>}
      </span>
    </p>
  )
}

/**
 * An explicit empty state that says what to do next and may offer a
 * one-click example, so a first visit is never a blank page. `children` = the message; keep test-locked texts verbatim.
 */
export function EmptyState({
  children,
  action,
  icon = ICONS.empty,
}: {
  children: ReactNode
  action?: ReactNode
  icon?: LucideIcon | null
}) {
  return (
    <div className="flex gap-3 rounded-xl border border-dashed border-line-strong bg-surface-2 p-4 text-sm text-gray-700 sm:p-5">
      {icon && (
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-ink-subtle shadow-soft">
          <Icon icon={icon} className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-3 self-center">
        <div>{children}</div>
        {action !== undefined && <div className="flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  )
}

/** Kept for existing pages; same as EmptyState without an action. */
export function Empty({ children }: { children: ReactNode }) {
  return <EmptyState>{children}</EmptyState>
}

/** A titled box with an optional one-line summary under the title. */
export function Section({
  title,
  summary,
  children,
  icon,
}: {
  title: string
  summary?: ReactNode
  children: ReactNode
  /** Optional icon before the title. */
  icon?: LucideIcon
}) {
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-4 shadow-soft sm:p-5">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 font-display text-lg font-medium text-ink">
          {icon && <Icon icon={icon} className="size-4 text-accent" />}
          {title}
        </h2>
        {/* A div, not a p: a caller's summary (OverviewPage's FactLine) is a <ul>, which a <p> cannot
            legally contain (invalid nesting, a hydration warning). */}
        {summary !== undefined && <div className="text-sm text-ink-muted">{summary}</div>}
      </div>
      {children}
    </section>
  )
}

/**
 * A label/value pair inside a <dl>. Labels are plain words, never raw field names.
 * The value wraps at word boundaries by default, so plain prose never breaks mid-word; a caller
 * showing a raw id or hash with no natural break point (a profile key, a device or visitor id)
 * passes `breakAll` so a long token still wraps inside its column instead of overflowing it.
 */
export function Field({ label, children, breakAll = false }: { label: string; children: ReactNode; breakAll?: boolean }) {
  return (
    <div className="flex gap-2 text-sm">
      <dt className="w-28 shrink-0 text-ink-muted">{label}</dt>
      <dd className={breakAll ? 'break-all' : 'break-words'}>{children}</dd>
    </div>
  )
}

/** Gap between the popover and the viewport edge, px (never wider than a phone screen). */
const TIP_EDGE = 16
/** The popover's widest size, px. */
const TIP_WIDTH = 288

/**
 * A toggletip: an ⓘ button beside a term; click, tap, Enter or
 * Space opens a small popover with the term's text from the glossary or DEFINITIONS
 * (shared/glossary.ts explain()); Esc (focus returns to the button), a click outside, scrolling or
 * resizing closes it. Never hover-only. The popover is a polite live region that is always in the
 * DOM and filled only while open, so aria-controls always names an element and screen readers hear
 * the text when it opens. It is portalled to <body> and `position: fixed`: inside the page, the
 * page-enter animation's transform would make `fixed` relative to the page block instead of the
 * viewport, and a table's overflow would clip it; from <body> it does neither and never widens the
 * page. The button is `select-none`, so copying the text around it never picks up its
 * screen-reader words (no "Mergedwhat Merged means85"). Where there is no `document` (a server
 * render, as test/ui renders pages) the popover is left out, as React's server renderer cannot
 * render portals; the app renders only in the browser (createRoot), where it is always there.
 */
export function InfoTip({ term }: { term: TipKey }) {
  const { term: words, text } = explain(term)
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLSpanElement>(null)

  // Place the popover under the button (above it when there is no room), inside the viewport.
  useLayoutEffect(() => {
    const b = button.current
    const p = pop.current
    if (!open || b === null || p === null) return
    const r = b.getBoundingClientRect()
    const width = Math.min(TIP_WIDTH, window.innerWidth - 2 * TIP_EDGE)
    const left = Math.min(
      Math.max(TIP_EDGE, r.left + r.width / 2 - width / 2),
      window.innerWidth - TIP_EDGE - width,
    )
    p.style.width = `${width}px`
    p.style.left = `${left}px`
    const below = r.bottom + 6
    const above = r.top - 6 - p.offsetHeight
    p.style.top = `${below + p.offsetHeight > window.innerHeight - TIP_EDGE && above >= TIP_EDGE ? above : below}px`
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onPointer = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Node) || !(wrap.current?.contains(t) || pop.current?.contains(t))) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      close()
      button.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <span ref={wrap} className="inline-flex align-middle">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-subtle select-none hover:bg-surface-2 hover:text-accent aria-expanded:text-accent"
      >
        <Icon icon={ICONS.info} className="size-3.5" />
        <span className="sr-only"> What “{words}” means </span>
      </button>
      {/* No portal without a real body: server rendering and the tests' stub document have none. */}
      {typeof document !== 'undefined' &&
        document.body != null &&
        createPortal(
          <span
            ref={pop}
            id={id}
            role="status"
            className={
              open
                ? 'fixed z-30 block rounded-lg border border-line-strong bg-surface p-3 text-left text-sm font-normal tracking-normal text-ink normal-case shadow-soft'
                : 'sr-only'
            }
          >
            {open && (
              <>
                <span className="block font-medium">{words}</span>{' '}
                <span className="mt-1 block text-ink-muted">{text}</span>
              </>
            )}
          </span>,
          document.body,
        )}
    </span>
  )
}

/**
 * An app event name as the brief writes it (app_open, read_story, link_click, login), with its plain
 * gloss in an InfoTip from the glossary; a name with no gloss shows as sent.
 */
export function EventName({ event, nameId }: { event: string; nameId?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span id={nameId} className="font-mono">
        {event}
      </span>
      {isGlossaryKey(event) && <InfoTip term={event} />}
    </span>
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
export function StatTile({
  label,
  value,
  note,
  icon,
  tip,
}: {
  label: string
  value: number
  note?: ReactNode
  icon?: LucideIcon
  /** An InfoTip after the label. */
  tip?: ReactNode
}) {
  return (
    <div className="flex flex-col rounded-xl border border-line bg-surface p-4 shadow-soft sm:p-5">
      <dt className="order-2 mt-1 flex items-center gap-1.5 text-sm text-ink-muted">
        {icon && <Icon icon={icon} className="size-4 text-accent" />}
        {label}
        {tip}
      </dt>
      <dd className="order-1 font-display text-3xl font-medium tabular-nums text-ink">
        {value.toLocaleString('en-US')}
      </dd>
      {note !== undefined && <dd className="order-3 mt-2 text-sm">{note}</dd>}
    </div>
  )
}

/**
 * A headline number with its plain label and an InfoTip that explains it. `term`
 * names the glossary or DEFINITIONS entry; the label stays visible text.
 */
export function Metric({
  value,
  label,
  term,
  icon,
}: {
  value: number
  label: string
  term: TipKey
  icon?: LucideIcon
}) {
  return <StatTile label={label} value={value} icon={icon} tip={<InfoTip term={term} />} />
}

/**
 * A small badge that carries its meaning in words, never colour alone (WCAG 2.2 AA). With
 * `onClick` it is a button (a status chip that opens what it counts), 24 px tall (the minimum target size).
 */
export function Tag({
  children,
  tone = 'neutral',
  icon,
  onClick,
}: {
  children: ReactNode
  /** Colour only reinforces the words; never the only signal. */
  tone?: 'neutral' | 'accent' | 'success' | 'danger'
  icon?: LucideIcon
  onClick?: () => void
}) {
  const look = {
    neutral: 'border-line-strong bg-surface-2 text-gray-800',
    accent: 'border-transparent bg-accent-soft text-accent-strong',
    success: 'border-transparent bg-success-soft text-success',
    danger: 'border-danger-line bg-danger-soft text-danger',
  }[tone]
  const shape = `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${look}`
  const content = (
    <>
      {icon && <Icon icon={icon} className="size-3.5" />}
      {children}
    </>
  )
  if (onClick === undefined) return <span className={shape}>{content}</span>
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${shape} min-h-6 cursor-pointer text-left hover:underline hover:underline-offset-2`}
    >
      {content}
    </button>
  )
}

/**
 * A visible, always-in-the-name "Coming soon" chip, the one home of its words: every
 * gated control sits beside exactly one of these, so the state is never shown by colour alone.
 */
export function ComingSoonTag() {
  return <Tag tone="neutral">Coming soon</Tag>
}

/**
 * The note `useGated` (src/use-gated.ts) describes: always in the DOM with its real text and
 * always `sr-only`, so `aria-describedby` resolves from the first render and a screen reader hears
 * what the control will do before it is activated. The note is shown on screen only in the
 * "Coming soon" pop-up (src/coming-soon-dialog.tsx), which is read out when it opens.
 */
export function GatedNote({ id, text }: { id: string; text: string }) {
  return (
    <p id={id} className="sr-only">
      {text}
    </p>
  )
}

export interface Column<T> {
  /** Plain-language header; also the label in the stacked cards. */
  header: string
  cell: (row: T) => ReactNode
  /** Right-aligns the column in the table. */
  numeric?: boolean
  /** The header is for screen readers only; cards show the cell without a label row. */
  hideLabel?: boolean
}

/** Below Tailwind's `sm` (640 px), where ResponsiveTable shows stacked cards. */
const NARROW_QUERY = '(max-width: 639.98px)'

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** True on a phone-width viewport; false when rendered outside a browser. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  )
}

/**
 * A table from 640 px up; stacked label:value cards below, so the page never scrolls
 * sideways on a phone. `details` adds a per-row toggle ("Details" by default) for level-2 fields.
 * Both layouts share one set of open rows, and an open row's details mount only in the layout on
 * screen, so a panel that fetches or holds state exists once. Pass `open` and `onOpenChange` to
 * control which rows are open from outside (a control elsewhere on the row that opens it).
 */
export function ResponsiveTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  details,
  detailsLabel = 'Details',
  open: openRows,
  onOpenChange,
}: {
  caption: string
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  details?: (row: T) => ReactNode
  detailsLabel?: string
  /** Controlled: the keys of the open rows; pair with onOpenChange. */
  open?: ReadonlySet<string>
  onOpenChange?: (key: string, open: boolean) => void
}) {
  const [ownOpen, setOwnOpen] = useState<ReadonlySet<string>>(new Set())
  const open = openRows ?? ownOpen
  const narrow = useNarrow()
  function setRow(key: string, isOpen: boolean) {
    if (open.has(key) === isOpen) return
    if (onOpenChange) onOpenChange(key, isOpen)
    if (openRows === undefined) {
      setOwnOpen((prev) => {
        const next = new Set(prev)
        if (isOpen) next.add(key)
        else next.delete(key)
        return next
      })
    }
  }
  const span = columns.length + (details ? 1 : 0)
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border border-line bg-surface shadow-soft sm:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left text-xs tracking-wide text-ink-muted uppercase">
              {columns.map((c) => (
                <th
                  key={c.header}
                  scope="col"
                  className={`px-3 py-2.5 font-semibold ${c.numeric ? 'text-right' : ''}`}
                >
                  {c.hideLabel ? <span className="sr-only">{c.header}</span> : c.header}
                </th>
              ))}
              {details && (
                <th scope="col" className="px-3 py-2.5">
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
                  <tr className="border-b border-line align-top transition-colors duration-150 last:border-b-0 hover:bg-surface-2">
                    {columns.map((c) => (
                      <td
                        key={c.header}
                        className={`px-3 py-2.5 ${c.numeric ? 'text-right tabular-nums' : ''}`}
                      >
                        {c.cell(row)}
                      </td>
                    ))}
                    {details && (
                      <td className="px-3 py-1.5 text-right">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-controls={panelId}
                          onClick={() => setRow(key, !isOpen)}
                          className="inline-flex min-h-6 items-center gap-1 rounded-md px-1 py-0.5 text-sm font-medium text-accent hover:text-accent-strong hover:underline hover:underline-offset-4"
                        >
                          <Chevron open={isOpen} />
                          {detailsLabel}
                        </button>
                      </td>
                    )}
                  </tr>
                  {details && isOpen && !narrow && (
                    <tr id={panelId} className="border-b border-line bg-surface-2">
                      <td colSpan={span} className="px-4 py-3">
                        {details(row)}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 sm:hidden" aria-label={caption}>
        {rows.map((row) => (
          <li key={rowKey(row)} className="rounded-xl border border-line bg-surface p-4 shadow-soft">
            <dl className="space-y-1">
              {columns.map((c) =>
                c.hideLabel ? (
                  <div key={c.header} className="flex gap-2 text-sm">
                    <dt className="sr-only">{c.header}</dt>
                    <dd className="min-w-0 break-words">{c.cell(row)}</dd>
                  </div>
                ) : (
                  <div key={c.header} className="flex gap-2 text-sm">
                    <dt className="w-28 shrink-0 text-ink-muted">{c.header}</dt>
                    <dd className="min-w-0 break-words">{c.cell(row)}</dd>
                  </div>
                ),
              )}
            </dl>
            {details && (
              <Disclosure
                label={detailsLabel}
                className="mt-2"
                open={open.has(rowKey(row))}
                onOpenChange={(isOpen) => setRow(rowKey(row), isOpen)}
              >
                {open.has(rowKey(row)) && narrow && details(row)}
              </Disclosure>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}
