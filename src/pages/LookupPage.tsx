// /lookup (06 §/lookup, R2): one search box, then one profile in three columns: newsletter,
// website, app. The raw input goes to GET /api/lookup?q= unchanged; the server normalizes it
// (02 §Normalization). Absent sections render the labelled empty states from 06.
// Partial lookup (06 §/lookup, 09 D-52): after QUERY_FRAGMENT_MIN_LENGTH typed characters the
// box lists GET /api/lookup/search suggestions (debounced); Find goes to the exact lookup and
// falls back to the suggestions on 404. The raw input is sent unchanged and the server alone
// folds it (02 §Normalization: the browser never normalizes): this file never trims or
// lowercases, a 400 query_too_short just means "no list yet" (test/lookup-search.test.ts pins it).
// Fuzzy lookup (06 §/lookup, 09 D-59): when the list is empty the API may send did_you_mean,
// shown as "Did you mean …?" links under the no-match text. Find also takes a pk_, d_ or v_ id
// (04 §/api/lookup); level 1 names only email and app id, the rest sits in a collapsed note.
// Disclosure (06 §UI principles 2): level 1 = who, status, signup, last open and one summary per
// column; "Details" per column = visit / event lists; "Technical details" = ids, keys, merge
// counts, second-precise UTC times, raw field values and formulas.

import {
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Link, useSearchParams } from 'react-router'
import { COLD_DAYS, DEFINITIONS, isCold } from '../../shared/derive'
import { QUERY_FRAGMENT_MIN_LENGTH } from '../../shared/normalize'
import { ApiError, errorMessage, getJson } from '../api'
import { AppWindow, Globe, Mail } from 'lucide-react'
import {
  Announcer,
  Button,
  Disclosure,
  ErrorLine,
  EventName,
  Field,
  ICONS,
  Icon,
  type LucideIcon,
  Loading,
  PageHeader,
  Tag,
  TechnicalDetails,
} from '../components'
import { capitalized, humanDate, humanDateTime, utc } from '../format'
import type { Lookup, LookupSearch } from '../types'

/** Wait after the last keystroke before asking for suggestions (06: ~250 ms). */
const SUGGEST_DEBOUNCE_MS = 250
const NO_MATCH = 'No profile matches — try part of the email'
/** The page's one-line purpose, the brief's own words for it (06 §Vocabulary, 09 D-66). */
const PURPOSE = 'Finds anyone: newsletter info, site visits and app activity in one view.'
const LISTBOX_ID = 'lookup-suggestions'
const HINT_ID = 'lookup-hint'
/** A demo subject from 02 §Counts, offered as the one-click first step (06 §UI principles 6). */
const EXAMPLE = 'joy.hall830@protonmail.com'

const KIND_LABEL: Record<Lookup['profile']['kind'], string> = {
  subscriber: 'Subscriber',
  app_only: 'App account only',
  unknown_user_stub: 'Unknown app account (created from webhook)',
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/** The newest stored timestamp of a list (ISO strings sort by time), or null for an empty list. */
function latest(timestamps: string[]): string | null {
  return timestamps.reduce<string | null>((max, ts) => (max === null || ts > max ? ts : max), null)
}

/** The bar is decoration; the words carry the number (principle 7: never colour alone). */
function ScoreMeter({ score }: { score: number }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-gray-800">
      <span aria-hidden="true" className="inline-block h-2 w-24 overflow-hidden rounded-full bg-surface-2">
        <span
          className="block h-full rounded-full bg-accent"
          style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
        />
      </span>
      Engagement {score} of 100
    </span>
  )
}

/** A column of the profile: an h3, one or two summary lines, then its level-2 Disclosure. */
function Column({
  title,
  summary,
  children,
  icon,
}: {
  title: string
  summary: ReactNode
  children?: ReactNode
  icon?: LucideIcon
}) {
  return (
    <section className="space-y-2 rounded-xl border border-line bg-surface p-5 shadow-soft">
      <h3 className="flex items-center gap-2 font-semibold text-ink">
        {icon && <Icon icon={icon} className="size-4 text-accent" />}
        {title}
      </h3>
      <div className="space-y-0.5 text-sm text-gray-700">{summary}</div>
      {children}
    </section>
  )
}

function Header({ data }: { data: Lookup }) {
  const { profile, newsletter, app } = data
  // A profile with no email is named in words; the raw app id lives in Technical details (06 §UI principles 2, 4).
  const identity = profile.email ?? 'App account with no email on file'
  const facts: string[] = []
  // The kind word only when it says something the columns don't (principle 5).
  if (!(profile.kind === 'subscriber' && newsletter !== null)) facts.push(KIND_LABEL[profile.kind])
  if (newsletter !== null) {
    facts.push(capitalized(newsletter.status))
    if (newsletter.source !== null) facts.push(`from ${capitalized(newsletter.source)}`)
    facts.push(`signed up ${humanDate(newsletter.signup_date)}`)
  }
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface p-5 shadow-soft">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 className="break-all text-lg font-semibold text-gray-900">{identity}</h2>
        <ScoreMeter score={profile.engagement_score} />
      </div>
      {facts.length > 0 && <p className="text-sm text-gray-700">{facts.join(' · ')}</p>}
      <Disclosure label="How engagement is scored">
        <p className="text-sm text-gray-700">{DEFINITIONS.engagement_score.doc}</p>
        <TechnicalDetails>
          <dl className="space-y-1">
            <Field label="Profile key">
              <span className="font-mono">{profile.pkey}</span>
            </Field>
            <Field label="Kind">
              <span className="font-mono">{profile.kind}</span>
            </Field>
            {app !== null && (
              <Field label="User ID">
                <span className="font-mono">{app.user_id}</span>
              </Field>
            )}
            <Field label="Score formula">
              <span className="font-mono">{DEFINITIONS.engagement_score.formula}</span>
            </Field>
          </dl>
          <p>All timestamps are UTC.</p>
        </TechnicalDetails>
      </Disclosure>
    </div>
  )
}

function coldLine(coldSince: string, neverOpened: boolean): string {
  if (!isCold(coldSince)) return `Goes cold ${humanDate(coldSince)} if no opens`
  return `Gone cold since ${humanDate(coldSince)} (${neverOpened ? 'never opened' : `no opens for ${COLD_DAYS} days`})`
}

function Newsletter({ data, coldSince }: { data: Lookup['newsletter']; coldSince: string | null }) {
  if (data === null) return <Column title="Newsletter info" icon={Mail} summary={<p>No newsletter record</p>} />
  const summary = (
    <>
      <p>
        {data.last_open_date === null
          ? 'Never opened an email'
          : `Last opened ${humanDate(data.last_open_date)}`}
      </p>
      {coldSince !== null && <p>{coldLine(coldSince, data.last_open_date === null)}</p>}
    </>
  )
  return (
    <Column title="Newsletter info" icon={Mail} summary={summary}>
      <Disclosure label="Details">
        <p className="text-sm text-gray-700">{DEFINITIONS.cold_since.doc}</p>
        <TechnicalDetails>
          <dl className="space-y-1">
            <Field label="Status">{data.status}</Field>
            <Field label="Acquisition source">{data.source ?? 'none recorded'}</Field>
            <Field label="Signup date">{data.signup_date}</Field>
            <Field label="Last open date">{data.last_open_date ?? 'never'}</Field>
            {coldSince !== null && <Field label="Cold date">{coldSince}</Field>}
            <Field label="Rows deduped into this profile">{data.merged_count}</Field>
          </dl>
        </TechnicalDetails>
      </Disclosure>
    </Column>
  )
}

function Website({ data, hasNewsletter }: { data: Lookup['web']; hasNewsletter: boolean }) {
  if (data === null) return <Column title="Site visits" icon={Globe} summary={<p>No website history</p>} />
  const visits = data.events
  const before = visits.filter((e) => e.pre_signup).length
  const last = latest(visits.map((e) => e.event_ts))
  const summary =
    visits.length === 0 ? (
      <p>No site visits yet</p>
    ) : (
      <>
        <p>
          {plural(visits.length, 'visit', 'visits')}
          {hasNewsletter && `, ${before} before signing up`}
          {last !== null && ` · last on ${humanDate(last)}`}
        </p>
        <p>
          First page:{' '}
          {data.first_page === '/' ? 'the home page' : <span className="font-mono">{data.first_page}</span>}
          {data.first_utm_source !== null && `, came from ${capitalized(data.first_utm_source)}`}
        </p>
      </>
    )
  return (
    <Column title="Site visits" icon={Globe} summary={summary}>
      <Disclosure
        label={visits.length === 0 ? 'Details' : `Show ${plural(visits.length, 'visit', 'visits')}`}
      >
        {visits.length > 0 && (
          <ol className="space-y-1 text-sm">
            {visits.map((e, i) => (
              <li
                key={`${e.event_ts}-${i}`}
                className={`rounded px-2 py-1 ${e.pre_signup ? 'bg-gray-50' : ''}`}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-mono text-gray-900">{e.page}</span>
                  {e.pre_signup && <Tag>Before signing up</Tag>}
                </span>
                <span className="block text-gray-700">
                  {humanDateTime(e.event_ts)}
                  {/* The first visit's source is already in the summary (principle 5). */}
                  {e.utm_source !== null &&
                    !(i === 0 && e.utm_source === data.first_utm_source) &&
                    ` · from ${capitalized(e.utm_source)}`}
                </span>
              </li>
            ))}
          </ol>
        )}
        <TechnicalDetails>
          <dl className="space-y-1">
            <Field label="Visitor ID">
              <span className="font-mono">{data.visitor_id}</span>
            </Field>
            <Field label="First UTM source">{data.first_utm_source ?? 'none'}</Field>
          </dl>
          {visits.length > 0 && (
            <ol className="space-y-0.5 font-mono">
              {visits.map((e, i) => (
                <li key={`${e.event_ts}-${i}`} className="break-all">
                  {utc(e.event_ts)} {e.page}
                  {e.utm_source !== null && ` utm_source=${e.utm_source}`}
                  {e.pre_signup && ' pre_signup'}
                </li>
              ))}
            </ol>
          )}
        </TechnicalDetails>
      </Disclosure>
    </Column>
  )
}

/** When the app account came relative to the newsletter signup, in words (02 §Linking 6). */
function joinedWhen(
  app: NonNullable<Lookup['app']>,
  newsletter: Lookup['newsletter'],
  afterSignup: boolean,
): string {
  if (newsletter === null) return ''
  if (afterSignup) return ', after signing up'
  return app.created_at.slice(0, 10) === newsletter.signup_date
    ? ', the day they signed up'
    : ', before signing up'
}

function AppActivity({
  data,
  newsletter,
  afterSignup,
  isStub,
}: {
  data: Lookup['app']
  newsletter: Lookup['newsletter']
  afterSignup: boolean
  isStub: boolean
}) {
  if (data === null) return <Column title="App activity" icon={AppWindow} summary={<p>No app account</p>} />
  const events = data.events
  const last = latest(events.map((e) => e.event_ts))
  const summary = (
    <>
      <p>
        {isStub
          ? `First seen in the app ${humanDate(data.created_at)}`
          : `Joined the app ${humanDate(data.created_at)}${joinedWhen(data, newsletter, afterSignup)}`}
      </p>
      <p>
        {last === null
          ? 'No app activity yet'
          : `${plural(events.length, 'app event', 'app events')} · last on ${humanDate(last)}`}
      </p>
    </>
  )
  return (
    <Column title="App activity" icon={AppWindow} summary={summary}>
      <Disclosure
        label={events.length === 0 ? 'Details' : `Show ${plural(events.length, 'app event', 'app events')}`}
      >
        {events.length > 0 && (
          <ol className="space-y-1 text-sm">
            {events.map((e, i) => (
              <li key={`${e.event_ts}-${i}`} className="rounded px-2 py-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-gray-900">
                    <EventName event={e.event} />
                  </span>
                  {e.attached_via === 'login_stitch' && <Tag>Linked by login</Tag>}
                </span>
                <span className="block text-gray-700">{humanDateTime(e.event_ts)}</span>
              </li>
            ))}
          </ol>
        )}
        <dl className="space-y-1">
          <Field label="Added">
            {data.from_csv ? 'Imported from the app accounts file' : 'Created from an app event'}
          </Field>
          <Field label="Devices">
            {data.devices.length === 0 ? 'none seen yet' : plural(data.devices.length, 'device', 'devices')}
          </Field>
        </dl>
        <TechnicalDetails>
          <dl className="space-y-1">
            <Field label="User ID">
              <span className="font-mono">{data.user_id}</span>
            </Field>
            <Field label="Created date">{data.created_at}</Field>
            <Field label="Origin">{data.from_csv ? 'app_users.csv' : 'created from webhook'}</Field>
            {data.devices.length > 0 && (
              <Field label="Device IDs">
                <span className="font-mono">{data.devices.join(', ')}</span>
              </Field>
            )}
          </dl>
          {events.length > 0 && (
            <ol className="space-y-0.5 font-mono">
              {events.map((e, i) => (
                <li key={`${e.event_ts}-${i}`} className="break-all">
                  {utc(e.event_ts)} {e.event} attached_via={e.attached_via}
                  {e.properties !== null && ` ${JSON.stringify(e.properties)}`}
                </li>
              ))}
            </ol>
          )}
        </TechnicalDetails>
      </Disclosure>
    </Column>
  )
}

type Match = LookupSearch['matches'][number]
type Suggestion = LookupSearch['did_you_mean'][number]

/** The exact lookup's answer; a 404 is kept apart because it opens the suggestion fallback. */
type ExactState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'not_found'; message: string }
  | { status: 'ok'; data: Lookup }

/** `value`, once it has stopped changing for `ms`. */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** What the exact lookup takes for a picked suggestion: the email, or the u_… of an email-less stub. */
function lookupKey(match: Match): string {
  const key = match.email ?? match.user_id
  if (key === null) throw new Error(`lookup: suggestion ${match.pkey} has neither an email nor a user id`)
  return key
}

/**
 * Whether to ask for suggestions at all: the raw length, not folded, so it can only let through
 * inputs the server then answers with 400 query_too_short (never hold back one it would answer).
 */
function searchable(raw: string): boolean {
  return raw.length >= QUERY_FRAGMENT_MIN_LENGTH
}

/** The suggestion list's answer; `too_short` is the server's 400 query_too_short: no list yet. */
type SuggestState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'too_short' }
  | { status: 'ok'; data: LookupSearch }

/** GETs `path` whenever it changes (null = nothing to ask); a stale answer never shows. */
function useSuggestions(path: string | null): SuggestState | null {
  const [settled, setSettled] = useState<{ path: string; state: SuggestState } | null>(null)
  useEffect(() => {
    if (path === null) return
    let current = true
    getJson<LookupSearch>(path).then(
      (data) => current && setSettled({ path, state: { status: 'ok', data } }),
      (err: unknown) => {
        if (!current) return
        const tooShort = err instanceof ApiError && err.status === 400 && err.code === 'query_too_short'
        setSettled({
          path,
          state: tooShort ? { status: 'too_short' } : { status: 'error', message: errorMessage(err) },
        })
      },
    )
    return () => {
      current = false
    }
  }, [path])
  if (path === null) return null
  if (settled === null || settled.path !== path) return { status: 'loading' }
  return settled.state
}

/** The listbox of matches (06 keyboard contract: ↑/↓ moves, Enter picks, Esc closes). */
function SuggestionList({
  matches,
  truncated,
  active,
  onPick,
}: {
  matches: Match[]
  truncated: boolean
  active: number
  onPick: (match: Match) => void
}) {
  return (
    <ul
      id={LISTBOX_ID}
      role="listbox"
      aria-label="Matching profiles"
      className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface text-sm shadow-soft"
    >
      {matches.map((m, i) => {
        const isActive = i === active
        return (
          <li
            key={m.pkey}
            id={`${LISTBOX_ID}-${i}`}
            role="option"
            aria-selected={isActive}
            // mousedown, not click: the input keeps focus, so the list is not closed first.
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(m)
            }}
            // The active row gets a bar and a fill, not a faint tint alone (principle 7).
            className={`flex cursor-pointer flex-wrap gap-x-3 border-l-4 px-3 py-2 hover:bg-gray-50 ${
              isActive ? 'border-blue-600 bg-blue-50' : 'border-transparent'
            }`}
          >
            <span className="break-all font-medium text-gray-900">{m.email ?? m.user_id}</span>
            {/* The kind only when it is not the usual one (principle 5). */}
            {m.kind !== 'subscriber' && <span className="text-gray-700">{KIND_LABEL[m.kind]}</span>}
            {m.status !== null && <span className="text-gray-700">{capitalized(m.status)}</span>}
          </li>
        )
      })}
      {truncated && (
        <li role="presentation" className="px-3 py-2 text-gray-700">
          + more — keep typing
        </li>
      )}
    </ul>
  )
}

/** A plain left click opens the profile here; with a modifier the browser opens a new tab and this page stays. */
function plainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey
}

/**
 * The "Did you mean …?" links (06 §/lookup, 09 D-59). Real links, so they open in a new tab too.
 * mousedown keeps focus in the search box, so its blur never closes the list under the pointer.
 */
function DidYouMean({ suggestions, onPick }: { suggestions: Suggestion[]; onPick: (email: string) => void }) {
  const link = (s: Suggestion) => (
    <Link
      to={{ search: `?${new URLSearchParams({ q: s.email })}` }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => plainClick(e) && onPick(s.email)}
      className="inline-flex min-h-6 items-center break-all font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900"
    >
      {s.email}
    </Link>
  )
  if (suggestions.length === 1) {
    return <p className="text-sm text-gray-800">Did you mean {link(suggestions[0])}?</p>
  }
  return (
    <div className="space-y-1 text-sm text-gray-800">
      <p>Did you mean one of these?</p>
      <ul className="space-y-0.5">
        {suggestions.map((s) => (
          <li key={s.pkey}>{link(s)}</li>
        ))}
      </ul>
    </div>
  )
}

export default function LookupPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q')
  const [input, setInput] = useState(q ?? '')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  /** The no-match block: focus moving into it (Tab to a "Did you mean" link) keeps the list open. */
  const nearbyRef = useRef<HTMLDivElement>(null)
  const fragment = useDebounced(input, SUGGEST_DEBOUNCE_MS)
  const suggestions = useSuggestions(
    open && searchable(fragment) ? `/api/lookup/search?q=${encodeURIComponent(fragment)}` : null,
  )
  const matches = suggestions?.status === 'ok' ? suggestions.data.matches : []

  const [exact, setExact] = useState<{ q: string; state: ExactState } | null>(null)
  useEffect(() => {
    if (q === null || q === '') return
    let current = true
    getJson<Lookup>(`/api/lookup?q=${encodeURIComponent(q)}`).then(
      (data) => current && setExact({ q, state: { status: 'ok', data } }),
      (err: unknown) => {
        if (!current) return
        if (err instanceof ApiError && err.status === 404) {
          setExact({ q, state: { status: 'not_found', message: err.message } })
          setOpen(true) // 06: on 404 Find falls back to the suggestion list
        } else {
          setExact({ q, state: { status: 'error', message: errorMessage(err) } })
        }
      },
    )
    return () => {
      current = false
    }
  }, [q])
  const state: ExactState | null =
    q === null || q === '' ? null : exact === null || exact.q !== q ? { status: 'loading' } : exact.state

  function go(key: string) {
    setInput(key)
    setOpen(false)
    setActive(-1)
    setParams({ q: key })
  }

  function pick(match: Match) {
    go(lookupKey(match))
  }

  /** A "Did you mean" link: the Link sets ?q=, so only the box and the list follow it here. */
  function pickNearby(email: string) {
    setInput(email)
    setOpen(false)
    setActive(-1)
  }

  function onBlur(e: FocusEvent<HTMLInputElement>) {
    const to = e.relatedTarget
    if (to instanceof Node && nearbyRef.current?.contains(to)) return
    setOpen(false)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setActive(-1)
    // Find again on the same unmatched q re-opens its fallback list; otherwise the list closes.
    setOpen(input === q && state?.status === 'not_found')
    setParams(input === '' ? {} : { q: input })
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!searchable(input)) return
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => Math.max(-1, Math.min(matches.length - 1, i + step)))
    } else if (e.key === 'Enter' && open && active >= 0 && active < matches.length) {
      e.preventDefault()
      pick(matches[active])
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      setOpen(false)
      setActive(-1)
    }
  }

  // The fallback after a 404 is the list itself; with the list closed (Esc) the 404 message stays.
  const listShown = suggestions !== null && suggestions.status !== 'too_short'
  const suggested = suggestions?.status === 'ok' ? suggestions.data : null
  const listboxShown = suggested !== null && suggested.matches.length > 0
  const zeroMatches = suggested !== null && suggested.matches.length === 0
  // The API sends did_you_mean only with no matches (04); the guard keeps the UI to 06 regardless.
  const nearby = zeroMatches ? suggested.did_you_mean : []
  // A 404 with no list to fall back to (fragment too short) means nothing was searched.
  const noFallback = !searchable(q ?? '') || suggestions?.status === 'too_short'
  const notFound = state?.status === 'not_found' ? state : null
  const result = state?.status === 'ok' ? state.data : null

  // One polite live region for every result change (principle 7); visible when it is the answer.
  let message = ''
  let messageVisible = false
  if (suggested !== null) {
    if (zeroMatches) {
      // With near spellings the no-match line is drawn above the links, and the live region reads both.
      message =
        nearby.length === 0
          ? NO_MATCH
          : `${NO_MATCH}. Did you mean ${nearby.map((m) => m.email).join(' or ')}?`
      messageVisible = nearby.length === 0
    } else {
      const lead = notFound !== null ? `${notFound.message} Did you mean one of these? ` : ''
      const more = suggested.truncated ? ', more if you keep typing' : ''
      message = `${lead}${plural(suggested.matches.length, 'match', 'matches')}${more}.`
    }
  } else if (notFound !== null && !listShown) {
    message = noFallback ? `Type at least ${QUERY_FRAGMENT_MIN_LENGTH} letters to search.` : notFound.message
    messageVisible = true
  } else if (result !== null) {
    message = `Showing profile for ${result.profile.email ?? 'an app account with no email on file'}.`
  }
  // The one-click first step (principle 6): on the empty page and after a search that found nobody.
  // Near spellings are the better next step, so the example steps aside for them (principle 5).
  const showExample =
    nearby.length === 0 &&
    ((state === null && !listShown) || (notFound !== null && (zeroMatches || !listShown)))

  return (
    <div className="space-y-5">
      <PageHeader title="Look up a subscriber" purpose={PURPOSE} icon={ICONS.lookup} />
      <form onSubmit={submit} className="max-w-xl space-y-1.5">
        <label htmlFor="lookup-q" className="block text-sm font-medium text-gray-900">
          Email or user ID
        </label>
        <div className="flex gap-2">
          <input
            id="lookup-q"
            type="search"
            role="combobox"
            aria-expanded={listboxShown}
            aria-controls={listboxShown ? LISTBOX_ID : undefined}
            aria-autocomplete="list"
            aria-describedby={result === null ? HINT_ID : undefined}
            aria-activedescendant={listboxShown && active >= 0 ? `${LISTBOX_ID}-${active}` : undefined}
            autoComplete="off"
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setOpen(true)
              setActive(-1)
            }}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            placeholder={`e.g. ${EXAMPLE}`}
            className="min-h-9 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-gray-500"
          />
          <Button type="submit" variant="primary" icon={ICONS.search} className="px-4">
            Find
          </Button>
        </div>
        {result === null && (
          <p id={HINT_ID} className="text-sm text-gray-600">
            Type a subscriber's email or an app account's user ID (starts with u_), or just part of it. Suggestions appear after{' '}
            {QUERY_FRAGMENT_MIN_LENGTH} letters.
          </p>
        )}
        {result === null && (
          <Disclosure label="More ways to look someone up">
            <p className="text-sm text-gray-700">
              Find also opens a profile from a profile key, a device ID or a visitor ID, copied from a
              profile's Technical details. Suggestions search emails and user IDs only.
            </p>
            <TechnicalDetails>
              <dl className="space-y-1">
                <Field label="Profile key">
                  <span className="font-mono">pk_…</span>
                </Field>
                <Field label="Device ID">
                  <span className="font-mono">d_…</span> (the device's most recent app account)
                </Field>
                <Field label="Visitor ID">
                  <span className="font-mono">v_…</span> (visitors who signed up)
                </Field>
              </dl>
              <p>IDs are matched exactly as stored.</p>
            </TechnicalDetails>
          </Disclosure>
        )}
      </form>

      <div className="max-w-xl space-y-3">
        {listShown && suggestions.status === 'loading' && <Loading label="Finding matches…" />}
        {listShown && suggestions.status === 'error' && <ErrorLine message={suggestions.message} />}
        {listboxShown && notFound !== null && (
          <p className="text-sm text-gray-800">{notFound.message} Did you mean one of these?</p>
        )}
        {listboxShown && (
          <SuggestionList
            matches={suggested.matches}
            truncated={suggested.truncated}
            active={active}
            onPick={pick}
          />
        )}
        {state?.status === 'loading' && <Loading label="Looking up…" />}
        {state?.status === 'error' && <ErrorLine message={state.message} />}
        {nearby.length > 0 && (
          <div ref={nearbyRef} className="space-y-1">
            <p className="text-sm text-gray-600">{NO_MATCH}</p>
            <DidYouMean suggestions={nearby} onPick={pickNearby} />
          </div>
        )}
        <Announcer message={message} visible={messageVisible} />
        {showExample && (
          <Button icon={ICONS.next} onClick={() => go(EXAMPLE)}>
            Try an example: {EXAMPLE}
          </Button>
        )}
      </div>

      {/* While suggestions are open the old profile steps aside, so the current profile is never in doubt. */}
      {result !== null && !listboxShown && (
        <div className="space-y-4">
          <Header data={result} />
          <div className="grid gap-4 md:grid-cols-3">
            <Newsletter data={result.newsletter} coldSince={result.profile.cold_since} />
            <Website data={result.web} hasNewsletter={result.newsletter !== null} />
            <AppActivity
              data={result.app}
              newsletter={result.newsletter}
              afterSignup={result.profile.app_after_signup}
              isStub={result.profile.kind === 'unknown_user_stub'}
            />
          </div>
        </div>
      )}
    </div>
  )
}
