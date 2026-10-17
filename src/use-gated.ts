// The shared "future feature, drawn in place" wiring: a feature saved for later is drawn where it
// will live, greyed out with a "Coming soon" chip, so the screen shows where the product is going.
// Kept out of src/components.tsx
// (a components-only export, like src/nav.ts: react-refresh's only-export-components rule, oxlint)
// because this is a hook, not a component. Render the real control with `bind` spread onto it,
// wire `activate` as its onClick (or `onKeyDown` for a non-button element, such as a gated input),
// and render `<GatedNote>` (src/components.tsx) right after it with `noteId` and the feature's
// `note`. Activating the control opens the one shared "Coming soon" pop-up
// (src/coming-soon-dialog.tsx) on that feature.

import { useId } from 'react'
import { FEATURES, type Feature, type FeatureId } from '../shared/features'
import { useComingSoon } from './coming-soon'

/** What `useGated` hands a real-looking control: never the `disabled` attribute, which would take it out of the Tab order. */
export interface GatedBind {
  'aria-disabled': true
  'aria-describedby': string
  'aria-haspopup': 'dialog'
}

/**
 * Whether a keydown opens the pop-up: only Enter or Space. Exported (and used by `onKeyDown`
 * below) so a test can check every key in isolation with no React rendering — Tab, a typed
 * character and every other key must read `false`: tabbing past a gated control must not open a
 * pop-up, and a gated text input stays read-only rather than popping a window per keystroke.
 */
export function isActivatingKey(key: string): boolean {
  return key === 'Enter' || key === ' '
}

/**
 * A gated control keeps its real shape, icon and label, stays focusable and in the Tab order
 * (never `disabled`), and does nothing when activated except open the shared pop-up on its
 * feature. `bind` spreads onto the real control (`aria-disabled`, `aria-describedby` naming the
 * always-hidden note, `aria-haspopup="dialog"`); `activate` is the control's `onClick` (a
 * `type="button"` already turns Enter/Space into that click); `onKeyDown` is for an element that
 * is not a button (a gated `<input>`, checkbox or select), where Enter must never submit a form
 * and Space must not also toggle or open the native control. `activate` takes no argument and
 * calls nothing but the pop-up's `open`, so a control wired to it can never reach a fetch, a
 * navigation or a route.
 */
export function useGated(feature: FeatureId): {
  readonly feature: Feature
  readonly noteId: string
  readonly bind: GatedBind
  readonly activate: () => void
  readonly onKeyDown: (e: { key: string; preventDefault: () => void }) => void
} {
  const { open } = useComingSoon()
  const noteId = useId()
  function activate() {
    open(feature)
  }
  function onKeyDown(e: { key: string; preventDefault: () => void }) {
    // Only Enter or Space opens the pop-up. Every other key — Tab, a typed character, Escape, the
    // arrows… — passes through untouched. Enter must never submit an enclosing <form>, and Space
    // must not also toggle a checkbox or open a select (its keyup would land on "Got it").
    if (!isActivatingKey(e.key)) return
    e.preventDefault()
    activate()
  }
  return {
    feature: FEATURES[feature],
    noteId,
    bind: { 'aria-disabled': true, 'aria-describedby': noteId, 'aria-haspopup': 'dialog' },
    activate,
    onKeyDown,
  }
}
