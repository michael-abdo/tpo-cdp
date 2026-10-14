// The Ask bar's fixed words (06 §/insights): the brief's example questions and the query parameter
// that fills the bar.

/** The brief's three example questions, verbatim (R5.2). */
export const BRIEF_QUESTIONS = [
  'how many Instagram signups went cold last month?',
  'build me a list of our most engaged readers',
  'which pages do new subscribers hit first?',
] as const

/** The query parameter that fills the Ask bar (09 D-39); /assistant?q= redirects here with it. */
export const PREFILL_PARAM = 'q'

