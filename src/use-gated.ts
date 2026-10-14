// The shared "future feature, drawn in place" wiring (09 D-80). Kept out of src/components.tsx
// (a components-only export, like src/nav.ts: react-refresh's only-export-components rule, oxlint)
// because this is a hook, not a component. Render the real control with `bind` spread onto it,
// wire `activate` as its onClick (or `onKeyDown` for a non-button element, such as a gated input),
// and render `<GatedNote>` (src/components.tsx) right after it with `noteId`/`activated`/the
// feature's `note`.

import { useId, useState } from 'react'
import { FEATURES, type Feature, type FeatureId } from '../shared/features'

/** What `useGated` hands a real-looking control: never the `disabled` attribute (09 D-80). */
export interface GatedBind {
  'aria-disabled': true
  'aria-describedby': string
}

/**
 * Whether a keydown activates a gated control: only Enter, Space or a single printable character.
 * Exported (and used by `onKeyDown` below) so a test can check every key in isolation with no
 * React rendering — Tab, the other navigation/modifier keys, and anything else multi-character
 * (Backspace, F1, …) must all read `false` (09 D-80, the Tab-reveals-every-note regression).
 */
export function isActivatingKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key.length === 1
}

/**
 * A gated control keeps its real shape, icon and label, stays focusable and in the Tab order
 * (never `disabled`), and does nothing when activated except reveal its note and announce it once.
 * `bind` spreads onto the real control (`aria-disabled`, `aria-describedby`); `activate` is the
 * control's `onClick` (a `type="button"` already stops Enter/Space from doing anything else other
 * than that click); `onKeyDown` is for an element that is not a button (a gated `<input>`), where
 * Enter must never submit a form and a keystroke still counts as activation. `activate` takes no
 * argument and calls nothing outside this hook's own state, so a control wired to it can never
 * reach a fetch, a navigation or a route. A second activation changes nothing (09 D-80's own "does
 * nothing new").
 */
export function useGated(feature: FeatureId): {
  readonly feature: Feature
  readonly activated: boolean
  readonly noteId: string
  readonly bind: GatedBind
  readonly activate: () => void
  readonly onKeyDown: (e: { key: string; preventDefault: () => void }) => void
} {
  const [activated, setActivated] = useState(false)
  const noteId = useId()
  function activate() {
    if (!activated) setActivated(true)
  }
  function onKeyDown(e: { key: string; preventDefault: () => void }) {
    // Only Enter, Space or a printable character (one code unit: `e.key.length === 1`) counts as
    // activation. Every other key — Tab, Shift, Alt, Control, Meta, Escape, the arrows, Home/End,
    // PageUp/PageDown, function keys, Backspace… — passes through untouched: a sighted-free Tab
    // sweep through a form (09 D-80's own "activating it does nothing but reveal…") must not
    // activate every gated input it lands on, which would flood the polite live regions. Enter
    // must also never submit an enclosing <form> (segments.md B.0, ask.tsx's follow-up).
    if (!isActivatingKey(e.key)) return
    if (e.key === 'Enter') e.preventDefault()
    activate()
  }
  return {
    feature: FEATURES[feature],
    activated,
    noteId,
    bind: { 'aria-disabled': true, 'aria-describedby': noteId },
    activate,
    onKeyDown,
  }
}
