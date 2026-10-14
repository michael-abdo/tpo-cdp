// T-UI-ONE (09 D-72, 06 §UI principles): say one thing in one place. Per screen file, no sentence
// of four or more words is written twice (case, whitespace and punctuation ignored), and no
// placeholder's example value is shown again as a button's or link's text (the "Try an example"
// button beside a placeholder that already shows the example). The facts come from the TypeScript
// AST of every file ONE_PLACE_SCAN names (test/helpers/screen-text.ts), handed over by
// vitest.config.ts as SCREEN_TEXTS.onePlace, since the compiler cannot load inside workerd; the
// ONE_PLACE_FIXTURES prove the scan and the rules see what they must. A sentence that several
// exclusive states need (a retry line under three errors) lives in one constant, so the file holds
// it once; nothing is allow-listed.

import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { ONE_PLACE_FIXTURES, ONE_PLACE_SCAN, type ScreenFacts } from './helpers/screen-text'

/** A sentence is a run of at least this many words. */
const MIN_WORDS = 4

/** Lower case, straight apostrophes, letters, digits and apostrophes only, one space between words. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Words, not code: a class string, a path or a format chunk has hyphens, colons, slashes or
 * brackets in most of its tokens; prose has them in a few ("re-import") at most.
 */
function isProse(raw: string): boolean {
  const tokens = raw.trim().split(/\s+/)
  const code = tokens.filter((t) => /[-:/_[\]{}<>=\\|]/.test(t)).length
  return code / tokens.length <= 0.25
}

/** The sentences of one text run, normalized, keeping only prose of MIN_WORDS words or more. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .filter(isProse)
    .map(normalize)
    .filter((s) => s.split(' ').length >= MIN_WORDS)
}

/** Each sentence a screen writes twice or more: `"…" ×n`. */
export function duplicateSentences(facts: ScreenFacts): string[] {
  const counts = new Map<string, number>()
  for (const text of facts.texts) for (const s of sentencesOf(text)) counts.set(s, (counts.get(s) ?? 0) + 1)
  return [...counts].filter(([, n]) => n >= 2).map(([s, n]) => `"${s}" ×${n}`)
}

/** Lower case and one space between words; keeps "@", "." and "_", which example values carry. */
const valueText = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * The example value a placeholder shows, or null for a placeholder that is a hint in words
 * ("Search"). An example either follows a marker ("e.g.", "for example", "such as", "try") or looks
 * like a value: it holds an "@", a digit or a `u_` id.
 */
export function exampleValue(placeholder: string): string | null {
  const marker = /^\s*(?:e\.?g\.?|for example|example|such as|try)\s*[:,]?\s*/i.exec(placeholder)
  const value = valueText(marker === null ? placeholder : placeholder.slice(marker[0].length))
  if (value === '') return null
  if (marker === null && !/[@\d]|\bu_/.test(value)) return null
  return value
}

/** Each placeholder example that a button, link or summary on the same screen shows again. */
export function exampleShownTwice(facts: ScreenFacts): string[] {
  const out: string[] = []
  for (const p of facts.placeholders) {
    const value = exampleValue(p.text)
    for (const a of facts.actions) {
      const shared = p.identifiers.filter((id) => a.identifiers.includes(id))
      if (shared.length > 0) out.push(`placeholder and "${a.text.trim()}" both show ${shared.join(', ')}`)
      else if (value !== null && valueText(a.text).includes(value)) out.push(`placeholder and "${a.text.trim()}" both show ${value}`)
    }
  }
  return out
}

function offences(screens: Record<string, ScreenFacts>): string[] {
  const out: string[] = []
  for (const [path, facts] of Object.entries(screens)) {
    for (const line of duplicateSentences(facts)) out.push(`${path}: ${line}`)
    for (const line of exampleShownTwice(facts)) out.push(`${path}: ${line}`)
  }
  return out
}

describe('T-UI-ONE say one thing in one place (09 D-72)', () => {
  it('scans every screen file ONE_PLACE_SCAN names: each page (the Segments page included), the Insights pieces, the shell, the components and the sentence modules', () => {
    const scanned = Object.keys(env.SCREEN_TEXTS.onePlace)
    for (const file of ONE_PLACE_SCAN.files) expect(scanned).toContain(file)
    for (const page of ['LoginPage', 'OverviewPage', 'LookupPage', 'SegmentsPage', 'EventsPage', 'InsightsPage', 'AuditPage'])
      expect(scanned).toContain(`src/pages/${page}.tsx`)
    for (const piece of ['ask', 'board', 'charts', 'pin-dialog']) expect(scanned).toContain(`src/insights/${piece}.tsx`)
    expect(Object.values(env.SCREEN_TEXTS.onePlace).flatMap((f) => f.texts).length).toBeGreaterThan(500)
  })

  it('the scan reads placeholders and the text and identifiers of buttons and links', () => {
    const { flag_example_identifier, flag_example_literal, pass_hint_placeholder } = env.SCREEN_TEXTS.onePlaceFixtures
    expect(flag_example_identifier.placeholders).toEqual([{ text: 'e.g. ', identifiers: ['EXAMPLE'] }])
    // Children give 'EXAMPLE'; the onClick handler attribute also gives 'go' and 'EXAMPLE' (deduped).
    expect(flag_example_identifier.actions).toEqual([{ text: 'Try an example: ', identifiers: ['EXAMPLE', 'go'] }])
    expect(flag_example_literal.placeholders).toEqual([{ text: 'e.g. joy.hall830@protonmail.com', identifiers: [] }])
    expect(flag_example_literal.actions).toEqual([{ text: 'Try joy.hall830@protonmail.com', identifiers: [] }])
    expect(pass_hint_placeholder.placeholders).toEqual([{ text: 'Search', identifiers: [] }])
    // Plumbing attributes (className, type) are not text; the sentence rule never reads a class string.
    expect(env.SCREEN_TEXTS.onePlaceFixtures.pass_classes_twice.texts).toEqual([
      'inline-flex min-h-6 items-center gap-1 rounded-md text-sm',
      'Back',
    ])
  })

  it('the rules flag each flag_ fixture and pass each pass_ fixture', () => {
    for (const key of Object.keys(ONE_PLACE_FIXTURES) as (keyof typeof ONE_PLACE_FIXTURES)[]) {
      const found = offences({ [key]: env.SCREEN_TEXTS.onePlaceFixtures[key] })
      if (key.startsWith('flag_')) expect(found, key).not.toEqual([])
      else expect(found, key).toEqual([])
    }
    expect(exampleValue('e.g. joy.hall830@protonmail.com')).toBe('joy.hall830@protonmail.com')
    expect(exampleValue('For example: u_ceed5f12')).toBe('u_ceed5f12')
    expect(exampleValue('u_ceed5f12')).toBe('u_ceed5f12')
    expect(exampleValue('Search')).toBeNull()
    expect(exampleValue('Ask in plain English')).toBeNull()
    // Normalization: case, whitespace and punctuation are ignored; three words are not a sentence.
    expect(sentencesOf('  Type part of the EMAIL,  to see matches!\nType part of the email to see matches.')).toEqual([
      'type part of the email to see matches',
      'type part of the email to see matches',
    ])
    expect(sentencesOf('Try again. Try again.')).toEqual([])
  })

  it('no screen file writes the same sentence twice, and no screen shows a placeholder example again as a button or link', () => {
    expect(offences(env.SCREEN_TEXTS.onePlace)).toEqual([])
  })

  it('a screen is the page plus the shared components it imports, not one file in isolation (m11)', () => {
    // A synthetic page repeats the exact sentence its imported ErrorLine already shows; scanning
    // the page's own file alone would miss it (count 1), same as the bug this guards against.
    expect(offences({ 'fixture/pages/Page.tsx': env.SCREEN_TEXTS.onePlaceScreenFixture })).not.toEqual([])
  })
})
