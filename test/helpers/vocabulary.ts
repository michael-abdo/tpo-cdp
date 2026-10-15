// T-VOC-1's retired words and allowed phrases, written once: the full scan
// (test/vocabulary.test.ts) and the Insights scan (test/insights-vocabulary.test.ts) both read them here.

/**
 * Retired anywhere user-facing. "Reader(s)" stays only inside the brief's
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
 * Phrases that may hold a retired word: the brief's question, whole, and assistive technology.
 * Only the full question passes (T-VOC-1 "the exact brief question"); "most engaged readers" on its
 * own, as a label or a sentence, is still flagged.
 */
export const ALLOWED = [/build me a list of our most engaged readers/gi, /screen[- ]readers?/gi]

export function retiredIn(text: string): string[] {
  const cleaned = ALLOWED.reduce((t, allowed) => t.replace(allowed, ''), text)
  return RETIRED.filter((r) => r.pattern.test(cleaned)).map((r) => r.name)
}

/**
 * The `export const NAV = [...]` array literal's own source text from src/nav.ts, found
 * by balancing brackets rather than assuming a line shape — the nested Techy group's own `items: […]`
 * closes on an indented line too, which a naive "first ']' at a line start" search would stop at.
 * src/nav.ts imports icons from src/components.tsx, a .tsx module with real JSX; test/vocabulary.test.ts
 * and test/insights-vocabulary.test.ts run under tsconfig.worker.json, which has no "jsx" option, so
 * they read the array as text (`?raw`) rather than importing it (which would pull components.tsx's
 * JSX into a program that cannot parse it).
 */
export function navArrayText(appSource: string): string {
  const start = appSource.indexOf('const NAV')
  if (start === -1) throw new Error('no "const NAV" declaration in the given source')
  const open = appSource.indexOf('[', appSource.indexOf('=', start))
  let depth = 0
  for (let i = open; i < appSource.length; i++) {
    if (appSource[i] === '[') depth++
    else if (appSource[i] === ']') {
      depth--
      if (depth === 0) return appSource.slice(open, i + 1)
    }
  }
  throw new Error('the NAV array has no matching close bracket')
}
