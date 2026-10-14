// "Send a test event" on /events (06 §/events panel, 09 D-73; D-55 levels: collapsed = one
// button, reusing <Disclosure>). Expanded: pick a real app account (suggestions from
// GET /api/lookup/search, filtered to rows with a user_id — D-11/D-47, no invented accounts),
// pick one of the four APP_EVENTS, press Send. POST /api/events/test (04) builds, signs and
// ingests the event through the real webhook path and returns the stored row shaped like
// GET /api/events/recent; the result line says what happened in plain words (the one home for
// that sentence, D-72) and offers "Send again" for the identical event. `onSent` tells the page
// to refresh its list at once (src/events-poll.ts FetchKind 'sent'), without waiting on the 5 s
// poll.

import { type ChangeEvent, type KeyboardEvent, useEffect, useState } from 'react'
import { APP_EVENTS, type AppEventName } from '../shared/app-events'
import { QUERY_FRAGMENT_MIN_LENGTH } from '../shared/normalize'
import { ApiError, errorMessage, getJson, postJson } from './api'
import { Announcer, Button, Disclosure, ErrorLine, EventName, ICONS, Loading } from './components'
import { resultText } from './events-test-words'
import { optionId, useListNav } from './list-nav'
import { ListboxOption } from './listbox'
import type { LookupSearch, RecentEvent, TestEventResult } from './types'

const SUGGEST_DEBOUNCE_MS = 250
const LISTBOX_ID = 'test-event-account-suggestions'
const INPUT_ID = 'test-event-account'

/** A lookup/search match that names a real app account (user_id present). */
interface AccountMatch {
  user_id: string
  email: string | null
}

type Suggestions =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; matches: AccountMatch[] }

/**
 * Debounced GET /api/lookup/search?q= (09 D-52's endpoint, reused as the brief asks), kept to
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
          setSettled({ fragment, state: { status: 'ok', matches } })
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

export function TestEventPanel({ onSent }: { onSent: (event: RecentEvent) => void }) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [fragment, setFragment] = useState('')
  const [userId, setUserId] = useState<string | null>(null)
  const [eventName, setEventName] = useState<AppEventName>(APP_EVENTS[0])
  const [sending, setSending] = useState(false)
  const [sentEventId, setSentEventId] = useState<string | null>(null)
  // A counter rides along with the text so the same sentence twice in a row (Send, Send again,
  // Send again on the same account+event) is still a change the screen reader announces, as
  // src/pages/EventsPage.tsx's own `said` does for the same reason.
  const [said, setSaid] = useState({ text: '', n: 0 })
  const [error, setError] = useState<string | null>(null)
  // Esc dismisses the open list without discarding the typed fragment or re-querying; typing
  // again (onInput) reopens it. (06 keyboard contract, WCAG 2.2 AA 4.1.2 via ../listbox.)
  const [dismissed, setDismissed] = useState(false)
  const nav = useListNav()
  const suggestions = useAccountSuggestions(fragment, userId === null)
  const listShown = userId === null && suggestions.status !== 'idle' && !dismissed
  const matches = suggestions.status === 'ok' ? suggestions.matches : []

  const pick = (m: AccountMatch) => {
    setUserId(m.user_id)
    setFragment(m.email ?? m.user_id)
    nav.setActive(-1)
  }

  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    setFragment(e.target.value)
    setUserId(null)
    setError(null)
    setDismissed(false)
    nav.setActive(-1)
    // A different or now-unmatched account cannot resend the last account's event.
    setSentEventId(null)
    setSaid({ text: '', n: 0 })
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!listShown) return
    nav.onKeyDown(e, {
      itemCount: matches.length,
      onPick: (i) => pick(matches[i]),
      onClose: () => setDismissed(true),
    })
  }

  async function send(body: { user_id: string; event: AppEventName } | { resend: string }): Promise<void> {
    if (sending) return // ignore a press while one is in flight (native disabled removed below)
    setSending(true)
    setError(null)
    try {
      const data = await postJson<TestEventResult>('/api/events/test', body)
      setSentEventId(data.event.event_id)
      setSaid((s) => ({ text: resultText(data.outcome), n: s.n + 1 }))
      onSent(data.event)
    } catch (err) {
      setError(errorMessage(err))
      setSaid({ text: '', n: 0 }) // an old success line never sits under a new, contradicting error
    } finally {
      setSending(false)
    }
  }

  return (
    <Disclosure label="Send a test event" open={panelOpen} onOpenChange={setPanelOpen}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (userId !== null) void send({ user_id: userId, event: eventName })
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
            placeholder="Type the start of a user ID or an email, e.g. u_2b64"
            className="block w-full min-h-9 rounded-lg border border-line-strong bg-surface px-2 py-1 text-sm text-ink"
          />
          {listShown && suggestions.status === 'loading' && <Loading label="Finding accounts…" />}
          {listShown && suggestions.status === 'error' && <ErrorLine message={suggestions.message} compact />}
          {listShown && suggestions.status === 'ok' && (
            <ul
              id={LISTBOX_ID}
              role="listbox"
              aria-label="Matching app accounts"
              className="max-h-48 space-y-0.5 overflow-auto rounded-lg border border-line bg-surface-2 p-1"
            >
              {matches.length === 0 ? (
                <li role="presentation" className="px-2 py-1 text-sm text-gray-600">
                  No app account matches.
                </li>
              ) : (
                matches.map((m, i) => (
                  <ListboxOption
                    key={m.user_id}
                    id={optionId(LISTBOX_ID, i)}
                    active={i === nav.active}
                    onPick={() => pick(m)}
                    className={`flex min-h-8 items-center gap-2 rounded-md px-2 py-1 text-sm ${
                      i === nav.active ? 'bg-surface' : ''
                    }`}
                  >
                    <span className="shrink-0 font-mono text-xs text-gray-600">{m.user_id}</span>
                    {m.email !== null && <span className="truncate">{m.email}</span>}
                  </ListboxOption>
                ))
              )}
            </ul>
          )}
        </div>

        <fieldset className="space-y-1">
          <legend className="block text-sm font-medium text-ink">Event</legend>
          <div className="flex flex-col gap-1.5">
            {APP_EVENTS.map((name) => (
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

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            icon={ICONS.events}
            disabled={userId === null}
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
      </form>
    </Disclosure>
  )
}
