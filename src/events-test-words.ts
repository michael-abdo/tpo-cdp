// What the "Send a test event" panel's result line says (the one home for the sentence). Pure,
// so test/ui/events-test-panel.test.ts pins the exact words
// without rendering; src/events-test-panel.tsx is the only other caller. Kept out of that file,
// as src/events-poll.ts is kept out of src/pages/EventsPage.tsx, so the component file exports
// only the component (react/only-export-components).

import type { TestEventResult } from './types'

export function resultText(outcome: TestEventResult['outcome']): string {
  return outcome === 'duplicate' ? 'Already received — stored once, not added again.' : "Received — it's the top row below."
}
