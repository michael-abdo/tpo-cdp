// Shared assertions for every test/ui/*-gated.test.ts file. Plain string/regex checks
// over rendered HTML (renderToString output), with no DOM: tests run inside workerd, which has no
// `document`. Centralised so a stronger check (a strict `disabled` regex, an aria-describedby id
// that must resolve to the FEATURES note's exact text) is written once and every gated test
// inherits it, instead of each page's test re-deriving its own, weaker version.

import { GATED_LOOK } from '../../src/use-gated'

/** The hidden cue every gated control's description starts with (GatedNote, src/components.tsx). */
export const COMING_SOON_CUE = 'Coming soon. '

/**
 * Every gated control's opening tag in `html`: each `<button>`, `<input>` or `<select>` carrying
 * `aria-disabled="true"`. Throws loud if there are none, so a page that lost its gated controls
 * fails instead of passing an empty check.
 */
export function gatedControlTags(html: string): string[] {
  const tags = [...html.matchAll(/<(?:button|input|select)\b[^>]*aria-disabled="true"[^>]*>/g)].map((m) => m[0])
  if (tags.length === 0) throw new Error('gated-assertions: no aria-disabled control in rendered HTML')
  return tags
}

/** True if this opening tag's class list holds every class of the shared greyed look (GATED_LOOK). */
export function wearsGatedLook(tag: string): boolean {
  const classes = (/\sclass="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/)
  return GATED_LOOK.split(' ').every((c) => classes.includes(c))
}

/**
 * True if `html` shows a visible "Coming soon" chip: an element whose whole text is those words.
 * The hidden cue (`Coming soon. <note>`) never matches; only the pop-up may show the chip.
 */
export function showsComingSoonChip(html: string): boolean {
  return />\s*Coming soon\s*</.test(html.replaceAll('<!-- -->', ''))
}

/**
 * Catches `disabled` as a real HTML attribute (`disabled`, `disabled=""`, `disabled="disabled"`)
 * but never a class name, a prop that merely contains the word, or `aria-disabled`. A plain
 * `.not.toContain(' disabled')` misses `disabled=""class=…` (no space before `class`) and
 * `aria-disabled` already contains `-disabled`, not `' disabled'` with a leading space, so that
 * check alone is weaker than it looks; this regex is the one every gated test should use.
 */
const DISABLED_ATTRIBUTE = /(?<![\w-])disabled(="[^"]*")?(?=[\s/>])/

/** True if `html` carries a real `disabled` attribute anywhere (a gated control never does). */
export function hasDisabledAttribute(html: string): boolean {
  return DISABLED_ATTRIBUTE.test(html)
}

/**
 * True if `html` has exactly one `aria-describedby="<id>"` naming `id`, and an element with that
 * id whose full text content equals the hidden cue then `expectedText`, exactly (not merely
 * "contains"). Catches a
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
  const escapedExpected = `${COMING_SOON_CUE}${expectedText}`.replaceAll('"', '&quot;')
  // Strip the leading icon's empty comment node / nested tags, keep inner text runs only.
  const text = elMatch[1].replace(/<[^>]*>/g, '').trim()
  return text === escapedExpected
}

/**
 * Decodes the handful of HTML entities `renderToString` can leave inside a text node and
 * collapses whitespace (a multi-line JSX literal's own indentation). Shared by `elementText` and
 * `literalOccursIn` below.
 */
function normalizeText(raw: string): string {
  return raw
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The Nth (0-indexed; negative counts back from the end, so `-1` is the last one) `<tag>…</tag>`
 * element's own VISIBLE text: any nested `sr-only` span (a hidden disambiguating suffix, such as
 * FollowUpField's " a follow-up") dropped WHOLE, every remaining tag and comment node stripped
 * out, whitespace collapsed (a gated control carries no "Coming soon" chip, so none is dropped:
 * one nested by mistake makes the text differ). Used to pin a control's exact rendered text against shared/features.ts's
 * own `label`/`controls` strings — not merely "the text shows up somewhere on the page"
 * (`toContain`), which a mutant that renames the control AND removes the old text could still
 * satisfy by accident, but never "this exact element reads exactly this". Throws loud if `tag`
 * does not appear enough times, so a dropped/renamed element fails the test instead of silently
 * comparing against `undefined`.
 */
export function elementText(html: string, tag: string, n = 0): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  const matches = [...html.matchAll(re)]
  const i = n < 0 ? matches.length + n : n
  if (i < 0 || matches.length <= i) throw new Error(`gated-assertions: <${tag}> #${n} not found in rendered HTML (${matches.length} present)`)
  return normalizeText(
    matches[i][1]
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<span class="[^"]*\bsr-only\b[^"]*"[^>]*>[\s\S]*?<\/span>/g, '')
      .replace(/<[^>]*>/g, ''),
  )
}

/** `text` with every `/* … *\/` block comment and `// …` line comment blanked out (replaced by
 * spaces, so offsets stay stable), so a doc comment that quotes a feature's own words for
 * explanation — this file is full of them — is never mistaken for a second, hand-typed home. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)).replace(/\/\/.*/g, (m) => ' '.repeat(m.length))
}

/**
 * True if `phrase` appears in `text` (raw .tsx source, not rendered HTML, comments excluded)
 * either as a whole quoted string literal (`"phrase"` or `'phrase'`, the exact string, never a
 * substring of a longer one) or as one whole JSX text node (the full run of characters between
 * `>` and the next `<`, trimmed) equal to `phrase`. Used by the one-home source scan
 * (gated-plan.test.ts): a features.ts `label`/`controls` string hand-typed again in
 * `src/**\/*.tsx`, instead of read through `gated.feature.label`/`.controls[…]`, is exactly this —
 * a second home for the same fact, so a future edit to shared/features.ts would silently stop
 * matching what the page shows. A plain substring search would also flag unrelated text that
 * merely CONTAINS the phrase (e.g. "Ask" inside "Ask the AI assistant in plain English"), which is
 * why both checks require an exact, whole-token match, not a `.includes()`.
 */
export function literalOccursIn(text: string, phrase: string): boolean {
  const code = withoutComments(text)
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`["']${escaped}["']`).test(code)) return true
  for (const m of code.matchAll(/>([^<>{}]+)</g)) if (normalizeText(m[1]) === phrase) return true
  return false
}
