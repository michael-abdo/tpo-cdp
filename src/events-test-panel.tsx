// "Send a test event" on /events, so a non-technical reviewer can prove live events work without
// a terminal (collapsed = one button, reusing <Disclosure>). Expanded: pick "Anonymous (no user)"
// (the list's first choice, shown as soon as the field has focus) or a real app account
// (suggestions from GET /api/lookup/search, filtered to rows with a user_id — no invented
// accounts), pick an event (all four APP_EVENTS for an account; no login when anonymous), press
// Send. "Same device as the last test event" (usable once this panel has sent one) reuses that
// event's device, so anonymous events and then a login on one device show the login stitch; after
// a login a link opens that account in Look up, where the earlier events now count as its own. POST /api/events/test builds, signs and
// ingests the event through the real webhook path and returns the stored row shaped like
// GET /api/events/recent; the result line says what happened in plain words (the one home for
// that sentence) and offers "Send again" for the identical event. `onSent` tells the page
// to refresh its list at once (src/events-poll.ts FetchKind 'sent'), without waiting on the 5 s
// poll.

import { type ChangeEvent, type KeyboardEvent, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { APP_EVENTS, type AppEventName } from '../shared/app-events'
import { QUERY_FRAGMENT_MIN_LENGTH } from '../shared/normalize'
import { ApiError, errorMessage, getJson, postJson } from './api'
import { Announcer, Button, Disclosure, ErrorLine, EventName, ICONS, Loading } from './components'
import {
  ANONYMOUS_CHOICE,
  eventChoices,
  lookupAfterLogin,
  newEventRequest,
  type TestEventRequest,
  type TestEventSender,
} from './events-test-choices'
import { resultText } from './events-test-words'
import { optionId, useListNav } from './list-nav'
import { ListboxOption } from './listbox'
import type { LookupSearch, RecentEvent, TestEventResult } from './types'

const SUGGEST_DEBOUNCE_MS = 250
const LISTBOX_ID = 'test-event-account-suggestions'
const INPUT_ID = 'test-event-account'
const SAME_DEVICE_ID = 'test-event-same-device'

/** A lookup/search match that names a real app account (user_id present). */
interface AccountMatch {
  user_id: string
  email: string | null
}

type Suggestions =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; matches: AccountMatch[]; truncated: boolean }

/**
 * Debounced GET /api/lookup/search?q= (Look up's own search, reused rather than a second one), kept to
 * matches with a real user_id: a subscriber with no app account cannot receive a test event.
 * `active` is false once an account is picked, so editing stops re-searching a filled-in value.
 */
function useAccountSuggestions(fragment: string, active: boolean): Suggestions {
  const searchable = active && fragment.length >= QUERY_FRAGMENT_MIN_LENGTH
  const [settled, setSettled] = useState<{ fragment: string; state: Suggestions } | null>(null)
  useEffect(() => {
    if (!searchable) return // nothing to ask; render derives 'idle' below with no state change here
    let current = true
    const timer = setTimeout(() => {
      getJson<LookupSearch>(`/api/lookup/search?q=${encodeURIComponent(fragment)}`).then(
        (data) => {
          if (!current) return
          const matches: AccountMatch[] = data.matches
            .filter((m) => m.user_id !== null)
            .map((m) => ({ user_id: m.user_id as string, email: m.email }))
          // Look up's "+ more — keep typing" (truncated) is the suggestion list's own line,
          // not this panel's to reword: passed through from GET /api/lookup/search
          // unchanged, exactly whenever the server's own list hit its cap — this panel filters
          // out non-account rows for display, but never reinterprets `truncated` itself.
          setSettled({ fragment, state: { status: 'ok', matches, truncated: data.truncated } })
        },
        (err: unknown) => {
          if (!current) return
          const tooShort = err instanceof ApiError && err.status === 400 && err.code === 'query_too_short'
          setSettled({ fragment, state: tooShort ? { status: 'idle' } : { status: 'error', message: errorMessage(err) } })
        },
      )
    }, SUGGEST_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [fragment, searchable])
  if (!searchable) return { status: 'idle' }
  if (settled === null || settled.fragment !== fragment) return { status: 'loading' }
  return settled.state
}

export function TestEventPanel({
  onSent,
  onOpenChange,
}: {
  onSent: (event: RecentEvent) => void
  /** Told whenever the panel opens or closes, so the page can keep one primary button on
   *  screen: Send while this panel is open, Refresh while it is not. */
  onOpenChange?: (open: boolean) => void
}) {
  const [panelOpen, setPanelOpenState] = useState(false)
  const setPanelOpen = (open: boolean) => {
    setPanelOpenState(open)
    onOpenChange?.(open)
  }
  const [fragment, setFragment] = useState('')
  const [sender, setSender] = useState<TestEventSender>(null)
  const [eventName, setEventName] = useState<AppEventName>(APP_EVENTS[0])
  const [sending, setSending] = useState(false)
  const [sentEventId, setSentEventId] = useState<string | null>(null)
  // The last event this panel sent in this page session (never cleared by a new pick), which
  // "Same device as the last test event" reuses; the box stays unusable until there is one.
  const [lastSentId, setLastSentId] = useState<string | null>(null)
  const [sameDevice, setSameDevice] = useState(false)
  const [lookupLink, setLookupLink] = useState<{ href: string; label: string } | null>(null)
  // The list opens on focus too, so "Anonymous (no user)" is offered before anything is typed.
  const [focused, setFocused] = useState(false)
  // A counter rides along with the text so the same sentence twice in a row (Send, Send again,
  // Send again on the same account+event) is still a change the screen reader announces, as
  // src/pages/EventsPage.tsx's own `said` does for the same reason.
  const [said, setSaid] = useState({ text: '', n: 0 })
  const [error, setError] = useState<string | null>(null)
  // Esc dismisses the open list without discarding the typed fragment or re-querying; typing
  // again (onInput) reopens it. (The shared keyboard contract, WCAG 2.2 AA 4.1.2 via ../listbox.)
  const [dismissed, setDismissed] = useState(false)
  const nav = useListNav()
  const suggestions = useAccountSuggestions(fragment, sender === null)
  const listShown = sender === null && (focused || suggestions.status !== 'idle') && !dismissed
  const matches = suggestions.status === 'ok' ? suggestions.matches : []
  const truncated = suggestions.status === 'ok' && suggestions.truncated
  const events = eventChoices(sender)
  const sameDeviceAs = sameDevice && lastSentId !== null ? lastSentId : null

  const pick = (m: AccountMatch) => {
    setSender({ kind: 'account', user_id: m.user_id })
    setFragment(m.email ?? m.user_id)
    setError(null)
    nav.setActive(-1)
  }

  const pickAnonymous = () => {
    const anonymous: TestEventSender = { kind: 'anonymous' }
    setSender(anonymous)
    setFragment(ANONYMOUS_CHOICE)
    setError(null)
    nav.setActive(-1)
    // A login needs a user, so it is not offered here; fall back to the first event that is.
    if (!eventChoices(anonymous).includes(eventName)) setEventName(eventChoices(anonymous)[0])
  }

  /** Option 0 is "Anonymous (no user)"; the account matches follow it. */
  const pickOption = (i: number) => (i === 0 ? pickAnonymous() : pick(matches[i - 1]))

  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    setFragment(e.target.value)
    setSender(null)
    setError(null)
    setDismissed(false)
    nav.setActive(-1)
    // A different or now-unmatched account cannot resend the last account's event.
    setSentEventId(null)
    setSaid({ text: '', n: 0 })
    setLookupLink(null)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!listShown) return
    // Enter with nothing highlighted: an exact single match is picked outright (as the brief's
    // one-account case always is); otherwise the box says what to do next instead of doing
    // nothing (no native submit fires — Send stays disabled with no sender picked).
    if (e.key === 'Enter' && nav.active < 0) {
      e.preventDefault()
      if (matches.length === 1) pick(matches[0])
      else setError('Pick an account from the list')
      return
    }
    nav.onKeyDown(e, {
      itemCount: matches.length + 1,
      onPick: pickOption,
      onClose: () => setDismissed(true),
    })
  }

  async function send(body: TestEventRequest): Promise<void> {
    if (sending) return // ignore a press while one is in flight (native disabled removed below)
    setSending(true)
    setError(null)
    try {
      const data = await postJson<TestEventResult>('/api/events/test', body)
      setSentEventId(data.event.event_id)
      setLastSentId(data.event.event_id)
      setLookupLink(lookupAfterLogin(data.event))
      setSaid((s) => ({ text: resultText(data.outcome), n: s.n + 1 }))
      onSent(data.event)
    } catch (err) {
      setError(errorMessage(err))
      setSaid({ text: '', n: 0 }) // an old success line never sits under a new, contradicting error
      setLookupLink(null)
    } finally {
      setSending(false)
    }
  }

  return (
    <Disclosure label="Send a test event" open={panelOpen} onOpenChange={setPanelOpen}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const body = newEventRequest(sender, eventName, sameDeviceAs)
          if (body !== null) void send(body)
        }}
        className="space-y-4 rounded-xl border border-line bg-surface p-4"
      >
        <div className="relative space-y-1">
          <label htmlFor={INPUT_ID} className="block text-sm font-medium text-ink">
            App account
          </label>
          <input
            id={INPUT_ID}
            type="text"
            role="combobox"
            aria-expanded={listShown}
            aria-controls={listShown ? LISTBOX_ID : undefined}
            aria-autocomplete="list"
            aria-activedescendant={listShown && nav.active >= 0 ? optionId(LISTBOX_ID, nav.active) : undefined}
            autoComplete="off"
            value={fragment}
            onChange={onInput}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Type the start of a user ID or an email, e.g. u_2b64"
            className="block w-full min-h-9 rounded-lg border border-line-strong bg-surface px-2 py-1 text-sm text-ink"
          />
          {listShown && (
            <ul
              id={LISTBOX_ID}
              role="listbox"
              aria-label="Matching app accounts"
              className="max-h-48 space-y-0.5 overflow-auto rounded-lg border border-line bg-surface-2 p-1"
            >
              <ListboxOption
                id={optionId(LISTBOX_ID, 0)}
                active={nav.active === 0}
                onPick={pickAnonymous}
                className="flex min-h-8 items-center gap-2 px-2 py-1 text-sm"
              >
                {ANONYMOUS_CHOICE}
              </ListboxOption>
              {suggestions.status === 'ok' && matches.length === 0 && (
                <li role="presentation" className="px-2 py-1 text-sm text-gray-600">
                  No app account matches.
                </li>
              )}
              {matches.map((m, i) => (
                <ListboxOption
                  key={m.user_id}
                  id={optionId(LISTBOX_ID, i + 1)}
                  active={i + 1 === nav.active}
                  onPick={() => pick(m)}
                  // The active row's bar-and-fill treatment lives in the shared ListboxOption
                  // (one home, with its contrast checked there), not a tint duplicated here.
                  className="flex min-h-8 items-center gap-2 px-2 py-1 text-sm"
                >
                  <span className="shrink-0 font-mono text-xs text-gray-600">{m.user_id}</span>
                  {m.email !== null && <span className="truncate">{m.email}</span>}
                </ListboxOption>
              ))}
              {truncated && (
                <li role="presentation" className="px-2 py-1 text-sm text-gray-600">
                  + more — keep typing
                </li>
              )}
            </ul>
          )}
          {listShown && suggestions.status === 'loading' && <Loading label="Finding accounts…" />}
          {listShown && suggestions.status === 'error' && <ErrorLine message={suggestions.message} compact />}
        </div>

        <fieldset className="space-y-1">
          <legend className="block text-sm font-medium text-ink">Event</legend>
          <div className="flex flex-col gap-1.5">
            {events.map((name) => (
              <label key={name} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="test-event-name"
                  className="size-4"
                  checked={eventName === name}
                  onChange={() => {
                    setEventName(name)
                    setSentEventId(null)
                    setSaid({ text: '', n: 0 })
                  }}
                  aria-labelledby={`test-event-name-${name}`}
                />
                <EventName event={name} nameId={`test-event-name-${name}`} />
              </label>
            ))}
          </div>
        </fieldset>

        <div className="space-y-1">
          <label htmlFor={SAME_DEVICE_ID} className="flex min-h-8 items-center gap-2 text-sm text-ink">
            <input
              id={SAME_DEVICE_ID}
              type="checkbox"
              className="size-4 disabled:opacity-60"
              checked={sameDeviceAs !== null}
              disabled={lastSentId === null}
              aria-describedby={lastSentId === null ? `${SAME_DEVICE_ID}-note` : undefined}
              onChange={(e) => setSameDevice(e.target.checked)}
            />
            Same device as the last test event
          </label>
          {lastSentId === null && (
            <p id={`${SAME_DEVICE_ID}-note`} className="text-sm text-gray-600">
              Available after this panel sends its first event.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            icon={ICONS.events}
            disabled={sender === null}
            aria-disabled={sending}
            className="aria-disabled:cursor-wait aria-disabled:opacity-60"
          >
            {sending ? 'Sending…' : 'Send'}
          </Button>
          {sentEventId !== null && (
            <Button
              type="button"
              variant="secondary"
              aria-disabled={sending}
              className="aria-disabled:cursor-wait aria-disabled:opacity-60"
              onClick={() => void send({ resend: sentEventId })}
            >
              Send again
            </Button>
          )}
        </div>

        {error !== null && <ErrorLine message={error} />}
        <Announcer message={said.n % 2 === 0 ? said.text : `${said.text} `} visible={sentEventId !== null} />
        {lookupLink !== null && (
          <p className="text-sm text-ink">
            Earlier events on this device now count for this account:{' '}
            <Link
              to={lookupLink.href}
              className="break-all text-blue-700 underline underline-offset-2 hover:text-blue-900"
            >
              Look up {lookupLink.label}
            </Link>
          </p>
        )}
      </form>
    </Disclosure>
  )
}
