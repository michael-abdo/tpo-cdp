// The Ask bar's fixed words: the brief's example questions, the query parameter
// that fills the bar, and the id that takes an answer's "See it on the board" to its new tile.

/** The brief's three example questions, verbatim. */
export const BRIEF_QUESTIONS = [
  'how many Instagram signups went cold last month?',
  'build me a list of our most engaged readers',
  'which pages do new subscribers hit first?',
] as const

/** The query parameter that fills the Ask bar ("Explain this" links use it); /assistant?q= redirects here with it. */
export const PREFILL_PARAM = 'q'


/** The DOM id of a tile's card: an answer's "See it on the board" scrolls to and focuses it after a pin. */
export function tileElementId(id: string): string {
  return `tile-${id}`
}
