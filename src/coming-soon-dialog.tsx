// The one "Coming soon" pop-up: activating a gated control (src/use-gated.ts) opens this modal,
// which shows that feature's label as its title, the "Coming soon" chip, the feature's note
// (both read from shared/features.ts, never retyped) and a "Got it" button. It is rendered once,
// by ComingSoonProvider, which src/App.tsx mounts once around every route (the shell and /login
// alike), so a page never holds two.
// The native <dialog> (the same pattern as src/insights/pin-dialog.tsx) gives the focus trap, Esc
// to close and the backdrop. "Got it" is a `method="dialog"` form's submit button, so it closes the
// dialog with no script of its own; a click on the backdrop closes it too. Every way of closing
// fires the dialog's close event, which clears the store and puts focus back on the control that
// opened it (src/coming-soon.ts). Opening sends no request and navigates nowhere.

import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { FEATURES, type FeatureId } from '../shared/features'
import { Button, ComingSoonTag } from './components'
import { ComingSoonContext, createComingSoonStore, type Focusable } from './coming-soon'

/** The focused element when a gated control is activated: that control. */
function focusedControl(): Focusable | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null
}

/** Holds the pop-up's state for everything under it and renders the pop-up itself, once. */
export function ComingSoonProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createComingSoonStore(focusedControl))
  const shown = useSyncExternalStore(store.subscribe, store.get, () => null)
  return (
    <ComingSoonContext.Provider value={store}>
      {children}
      <ComingSoonDialog feature={shown?.feature ?? null} onClose={store.close} />
    </ComingSoonContext.Provider>
  )
}

/**
 * The modal itself: open while `feature` is set. Focus lands on "Got it" when it opens. `onClose`
 * runs on every close (Got it, Esc, a backdrop click).
 */
export function ComingSoonDialog({ feature, onClose }: { feature: FeatureId | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const gotIt = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const bodyId = useId()
  const open = feature !== null

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    if (open && !dialog.open) {
      dialog.showModal()
      gotIt.current?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  // The dialog has no padding of its own (its inner div holds it), so a click whose target is the
  // dialog element itself landed on the backdrop.
  function onBackdrop(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === e.currentTarget) e.currentTarget.close()
  }

  const shown = feature === null ? null : FEATURES[feature]
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onClose={onClose}
      onClick={onBackdrop}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 text-ink shadow-soft backdrop:bg-black/40"
    >
      <div className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={titleId} className="font-display text-lg font-medium">
            {shown?.label}
          </h2>
          {shown !== null && <ComingSoonTag />}
        </div>
        <p id={bodyId} className="text-sm text-ink-muted">
          {shown?.note}
        </p>
        <form method="dialog" className="flex justify-end">
          <Button ref={gotIt} type="submit" variant="primary">
            Got it
          </Button>
        </form>
      </div>
    </dialog>
  )
}
