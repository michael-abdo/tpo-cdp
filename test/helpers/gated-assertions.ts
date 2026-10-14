// Shared assertions for every test/ui/*-gated.test.ts file (09 D-80). Plain string/regex checks
// over rendered HTML (renderToString output), with no DOM: tests run inside workerd, which has no
// `document`. Centralised so a stronger check (a strict `disabled` regex, an aria-describedby id
// that must resolve to the FEATURES note's exact text) is written once and every gated test
// inherits it, instead of each page's test re-deriving its own, weaker version.

/**
 * Catches `disabled` as a real HTML attribute (`disabled`, `disabled=""`, `disabled="disabled"`)
 * but never a class name, a prop that merely contains the word, or `aria-disabled`. A plain
 * `.not.toContain(' disabled')` misses `disabled=""class=…` (no space before `class`) and
 * `aria-disabled` already contains `-disabled`, not `' disabled'` with a leading space, so that
 * check alone is weaker than it looks; this regex is the one every gated test should use.
 */
const DISABLED_ATTRIBUTE = /(?<![\w-])disabled(="[^"]*")?(?=[\s/>])/

/** True if `html` carries a real `disabled` attribute anywhere (09 D-80: a gated control never does). */
export function hasDisabledAttribute(html: string): boolean {
  return DISABLED_ATTRIBUTE.test(html)
}

/**
 * True if `html` has exactly one `aria-describedby="<id>"` naming `id`, and an element with that
 * id whose full text content equals `expectedText` exactly (not merely "contains"). Catches a
 * describedby that targets the wrong id (a hard-coded id, or `noteId + 'x'`) as well as a note
 * element whose text has drifted from `shared/features.ts`.
 */
export function describedByResolvesTo(html: string, expectedText: string): boolean {
  const idMatch = /aria-describedby="([^"]+)"/.exec(html)
  if (idMatch === null) return false
  const id = idMatch[1]
  const elMatch = new RegExp(`<p id="${id}"[^>]*>(.*?)</p>`, 's').exec(html)
  if (elMatch === null) return false
  // renderToString escapes a few characters inside text nodes (notably `"`); the comparison
  // normalizes the expected text the same way rather than the raw string.
  const escapedExpected = expectedText.replaceAll('"', '&quot;')
  // Strip the leading icon's empty comment node / nested tags, keep inner text runs only.
  const text = elMatch[1].replace(/<[^>]*>/g, '').trim()
  return text === escapedExpected
}
