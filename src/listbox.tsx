// The one home (D-72) for a suggestion-listbox option, shared by src/pages/LookupPage.tsx and
// src/events-test-panel.tsx so neither re-implements or drifts from the WCAG 2.2 AA 4.1.2
// contract: role="option" picked by onMouseDown (the input keeps focus, the list is not closed
// first by a blur), never an inner <button> (Tab never lands on it, so a keyboard pick never
// moves focus off the input: 2.4.3 Focus Order). The keyboard handling itself (ArrowUp/ArrowDown/
// Enter/Escape) is the non-component half, ../list-nav.ts (react/only-export-components).
//
// The active row's styling is also here, not in each caller (06 §UI principles 7, ≥ 3:1 against
// its own fill in both light and dark — the theme tokens in src/index.css follow the OS/
// `[data-theme]` blocks, so no caller needs its own dark-mode class): a left bar plus a fill,
// never a surface tint alone, so the active option is never carried by colour contrast that low.

import type { ReactNode } from 'react'

/** The active row's own classes; merged after the caller's `className` so they always win. */
const ACTIVE_CLASSES = 'border-l-4 border-blue-600 bg-blue-50'
const INACTIVE_CLASSES = 'border-l-4 border-transparent'

/**
 * One row of a suggestion listbox. Picked by mousedown with `preventDefault`, never a click, so
 * the input keeps focus throughout (no inner `<button>`: WCAG 2.2 AA 4.1.2 nested-interactive).
 */
export function ListboxOption({
  id,
  active,
  onPick,
  className,
  children,
}: {
  id?: string
  active: boolean
  onPick: () => void
  className?: string
  children?: ReactNode
}) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      onMouseDown={(e) => {
        e.preventDefault()
        onPick()
      }}
      className={`${className ?? ''} ${active ? ACTIVE_CLASSES : INACTIVE_CLASSES}`}
    >
      {children}
    </li>
  )
}
