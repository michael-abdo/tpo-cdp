// The non-component half of the shared listbox keyboard contract (../listbox.tsx holds the
// component; react/only-export-components, kept apart the same way src/events-poll.ts is kept
// out of src/pages/EventsPage.tsx and src/events-test-words.ts out of src/events-test-panel.tsx).
// 06 keyboard contract: ArrowUp/ArrowDown moves the active option, Enter picks it, Esc closes the
// list. Used by src/pages/LookupPage.tsx and src/events-test-panel.tsx (D-72: one home).

import { type KeyboardEvent, useState } from 'react'

/** Keyboard navigation over a flat list of options; `active` is -1 when nothing is highlighted. */
export interface ListNav {
  active: number
  setActive: (active: number) => void
  onKeyDown: (
    e: KeyboardEvent<HTMLInputElement>,
    opts: { itemCount: number; onPick: (index: number) => void; onClose: () => void },
  ) => void
}

/** The shared Up/Down/Enter/Escape handling; callers decide when the list is open at all. */
export function useListNav(): ListNav {
  const [active, setActive] = useState(-1)
  const onKeyDown: ListNav['onKeyDown'] = (e, { itemCount, onPick, onClose }) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => Math.max(-1, Math.min(itemCount - 1, i + step)))
    } else if (e.key === 'Enter' && active >= 0 && active < itemCount) {
      e.preventDefault()
      onPick(active)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      setActive(-1)
    }
  }
  return { active, setActive, onKeyDown }
}

/** The id of the `i`th option under `listboxId`, for `aria-activedescendant`. */
export function optionId(listboxId: string, i: number): string {
  return `${listboxId}-${i}`
}
