// /insights: one place to ask and to keep answers. Level 1 = the
// Ask bar (src/insights/ask.tsx) and the board below it (src/insights/board.tsx): the tiles of GET
// /api/insights, which the server re-runs on every request through the gated executor with no model
// call. The four built-in tiles are the former Growth panels. An answer's "Pin to board" adds
// a tile; a tile's "Explain this" fills the Ask bar and waits for Ask. /assistant and
// /growth redirect here, keeping ?q= (src/App.tsx), so an old "Explain this" link still fills the box.
// Every change ends with the board fetched again and a polite announcement for screen readers;
// a plain Refresh announces "Board updated." once the new tiles are in. Refresh stays focusable
// while it works (aria-disabled, clicks ignored), so a keyboard user keeps their place.

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { errorMessage, getJson } from '../api'
import { Announcer, Button, ComingSoonTag, EmptyState, ErrorLine, GatedNote, ICONS, Icon, Loading, PageHeader } from '../components'
import { useGated } from '../use-gated'
import { AskSection } from '../insights/ask'
import { BoardGrid } from '../insights/board'
import { PREFILL_PARAM } from '../insights/questions'
import type { InsightBoard, InsightTile } from '../types'

/**
 * The gated "Send the board" digest button (coming soon): beside Refresh, in
 * DOM order after it, so Tab reaches Refresh first. Shown only when the board loaded with at least
 * one tile — an empty or failed board has nothing to send.
 */
export function SendTheBoardButton() {
  const gated = useGated('schedules_and_digests')
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        {...gated.bind}
        onClick={gated.activate}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-surface-2 px-2.5 py-1.5 text-sm font-medium text-ink-subtle"
      >
        <Icon icon={ICONS.digest} />
        {gated.feature.controls![0]}
      </button>
      <ComingSoonTag />
      <GatedNote id={gated.noteId} text={gated.feature.note} />
    </span>
  )
}

type BoardState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; data: InsightBoard }

export default function InsightsPage() {
  const [params] = useSearchParams()
  const prefilled = params.get(PREFILL_PARAM)?.trim() ?? ''
  const [question, setQuestion] = useState(prefilled)
  const [filled, setFilled] = useState<string | null>(prefilled === '' ? null : prefilled)
  const input = useRef<HTMLInputElement>(null)
  const boardHeading = useRef<HTMLHeadingElement>(null)

  const [board, setBoard] = useState<BoardState>({ status: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  // Each load bumps the version; a fetch whose version was replaced never shows (the cleanup below).
  const [version, setVersion] = useState(0)
  // Set by the Refresh button: the load that answers it says so.
  const refreshNote = useRef(false)

  /** A new polite message; the same words twice still change the text, so they are read again. */
  function announce(message: string) {
    setAnnouncement((prev) => (prev === message ? `${message}\u00a0` : message))
  }

  useEffect(() => {
    let current = true
    getJson<InsightBoard>('/api/insights').then(
      (data) => {
        if (!current) return
        setRefreshing(false)
        setBoard({ status: 'ok', data })
        if (refreshNote.current) {
          refreshNote.current = false
          announce('Board updated.')
        }
      },
      (err: unknown) => {
        if (!current) return
        console.error('insights: board failed to load', err)
        setRefreshing(false)
        // A failed refresh keeps the tiles already on screen and says so.
        refreshNote.current = false
        setBoard((prev) => (prev.status === 'ok' ? prev : { status: 'error', message: errorMessage(err) }))
        announce(`The board could not be refreshed: ${errorMessage(err)}`)
      },
    )
    return () => {
      current = false
    }
  }, [version])

  function load() {
    setRefreshing(true)
    setVersion((v) => v + 1)
  }

  function refresh() {
    if (refreshing) return
    refreshNote.current = true
    load()
  }

  function changed(message: string) {
    announce(message)
    load()
  }

  function removed(message: string) {
    changed(message)
    boardHeading.current?.focus()
  }

  function explain(q: string) {
    setQuestion(q)
    setFilled(q)
    input.current?.focus()
  }

  function pinned(tile: InsightTile, note: string | null) {
    changed(note ?? `Pinned “${tile.title}” to the board.`)
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Insights"
        icon={ICONS.insights}
        purpose="Ask about subscribers, site visits and app activity, then pin the answers you want to keep."
      />
      <AskSection question={question} setQuestion={setQuestion} filled={filled} inputRef={input} onPinned={pinned} />

      <section aria-labelledby="board-heading" className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="board-heading" ref={boardHeading} tabIndex={-1} className="mr-auto font-display text-xl font-medium text-ink focus:outline-none">
            Your board
          </h2>
          <Button variant="quiet" icon={ICONS.refresh} onClick={refresh} aria-disabled={refreshing} className="aria-disabled:cursor-wait aria-disabled:opacity-60">
            {refreshing && board.status === 'ok' ? 'Refreshing…' : 'Refresh'}
          </Button>
          {board.status === 'ok' && board.data.tiles.length > 0 && <SendTheBoardButton />}
        </div>
        <Announcer message={announcement} visible />
        {board.status === 'loading' && <Loading label="Loading the board…" />}
        {board.status === 'error' && <ErrorLine message={board.message} next="Press Refresh to try again." />}
        {board.status === 'ok' &&
          (board.data.tiles.length === 0 ? (
            <EmptyState icon={ICONS.pin}>Ask a question, then pin the answer to keep it here.</EmptyState>
          ) : (
            <BoardGrid tiles={board.data.tiles} onChanged={changed} onRemoved={removed} onExplain={explain} />
          ))}
      </section>
    </div>
  )
}
