// T-VOC-1's retired words and allowed phrases (08; 09 D-66, 06 §Vocabulary), written once: the full scan
// (test/vocabulary.test.ts) and the Insights scan (test/insights-vocabulary.test.ts) both read them here.

/**
 * Retired anywhere user-facing (06 §Vocabulary, last line). "Reader(s)" stays only inside the brief's
 * own example question; "screen reader" names assistive technology, not a person on the list.
 */
export const RETIRED: readonly { name: string; pattern: RegExp }[] = [
  { name: 'reader(s)', pattern: /\breaders?\b/i },
  { name: 'Find a reader', pattern: /\bfind a reader\b/i },
  { name: 'Build a list', pattern: /\bbuil[dt] a list\b/i },
  { name: 'Newsletter list', pattern: /\bnewsletter list\b/i },
  { name: 'App users', pattern: /\bapp users?\b/i },
]
/**
 * Phrases that may hold a retired word: the brief's question (R5.2), whole, and assistive technology.
 * Only the full question passes (08 T-VOC-1 "the exact brief question"); "most engaged readers" on its
 * own, as a label or a sentence, is still flagged.
 */
export const ALLOWED = [/build me a list of our most engaged readers/gi, /screen[- ]readers?/gi]

export function retiredIn(text: string): string[] {
  const cleaned = ALLOWED.reduce((t, allowed) => t.replace(allowed, ''), text)
  return RETIRED.filter((r) => r.pattern.test(cleaned)).map((r) => r.name)
}
