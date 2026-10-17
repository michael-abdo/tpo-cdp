// The "Coming soon" pop-up's state: which gated feature it shows, and which control opened it so
// focus can go back there when it closes. Kept out of src/coming-soon-dialog.tsx (a
// components-only file, like src/use-gated.ts: react-refresh's only-export-components rule,
// oxlint) because this holds a hook, a context and a plain store, not a component.
//
// The store is plain TypeScript with no React and no DOM, so a test can drive open/close and the
// focus return directly (tests run inside workerd, which has no `document`). It holds one thing:
// the shown feature's id. Opening sends no request and changes nothing else on the page.

import { createContext, useContext } from 'react'
import type { FeatureId } from '../shared/features'

/** What a gated control can ask of the pop-up: show this feature. Nothing else. */
export interface ComingSoon {
  readonly open: (feature: FeatureId) => void
}

/** Anything focus can go back to: the control that opened the pop-up. */
export interface Focusable {
  readonly isConnected: boolean
  focus: () => void
}

/** The pop-up's state: the feature it shows and the control that opened it. */
export interface Shown {
  readonly feature: FeatureId
  readonly opener: Focusable | null
}

export interface ComingSoonStore extends ComingSoon {
  readonly get: () => Shown | null
  readonly subscribe: (onChange: () => void) => () => void
  readonly close: () => void
}

/**
 * One pop-up's state. `activeElement` reads the focused control at the moment `open` runs (the
 * control being activated), so `close` can put focus back on it. A second `open` while one is
 * already shown keeps the first (a checkbox fires both click and change in one event). `close`
 * is safe to call twice: the native dialog's own close event calls it again after "Got it", Esc
 * or a backdrop click have already closed it.
 */
export function createComingSoonStore(activeElement: () => Focusable | null): ComingSoonStore {
  let shown: Shown | null = null
  const listeners = new Set<() => void>()
  function emit() {
    for (const listener of listeners) listener()
  }
  return {
    get: () => shown,
    subscribe(onChange) {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    open(feature) {
      if (shown !== null) return
      shown = { feature, opener: activeElement() }
      emit()
    },
    close() {
      if (shown === null) return
      const { opener } = shown
      shown = null
      emit()
      if (opener !== null && opener.isConnected) opener.focus()
    },
  }
}

/** Outside a provider there is no pop-up to open: fail loud rather than do nothing silently. */
export const ComingSoonContext = createContext<ComingSoon>({
  open(feature) {
    throw new Error(`coming soon: no ComingSoonProvider above the control for "${feature}"`)
  },
})

/** The nearest pop-up's `open`. */
export function useComingSoon(): ComingSoon {
  return useContext(ComingSoonContext)
}
