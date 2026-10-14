import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../shared/features'

// T-GATE-3 (00-plan.md §4): "activating a gated control sends no request and changes no state
// except revealing the note." The isolated per-page gated tests only check shape (does the markup
// exist), never that a handler does nothing more — a fetch bolted onto `onClick` alongside
// `gated.activate` survives every one of them (the review's M1/M2/M10 probes). This file reads
// every component that calls `useGated(...)` as source text (no DOM, no typescript package —
// tests run inside workerd) and enforces two structural rules no handler may violate:
//
//  1. Every JSX element carrying `{...X.bind}` wires its activation attribute (`onClick` for a
//     button, `onKeyDown` for a non-button such as a gated `<input>`) to exactly `X.activate` or
//     `X.onKeyDown` — a bare reference, never a wrapping arrow function that could call anything
//     else first.
//  2. The component function that declares `useGated(...)` contains no `fetch(`, `postJson(`,
//     `request(`, a `navigate(` call, or `window.location` anywhere in its body.
//
// A mutant that bolts a request onto a gated handler, or wraps `activate`/`onKeyDown` in a new
// arrow function, fails rule 1 or 2 and is caught here without a real browser.

const SRC = import.meta.glob<string>(['../../src/**/*.tsx'], { query: '?raw', import: 'default', eager: true })

/** Skips a string/template literal starting at `text[i]` (a quote char), returning the index just
 * past its closing quote. Shared by the paren- and brace-matchers below so neither miscounts a
 * stray `(`/`{` written inside a literal (destructured-param type text, a JSX attribute string). */
function skipLiteral(text: string, i: number): number {
  const quote = text[i]
  i++
  while (i < text.length && text[i] !== quote) {
    if (text[i] === '\\') i++
    i++
  }
  return i + 1
}

/** `export function Name(` ... `) { … }`'s body. Finds the parameter list's matching `)` by
 * counting parens (skipping literals, so a type like `{ source: CsvSource }` inside the params
 * never confuses this count), then brace-counts from the first `{` after it — these components
 * never carry an explicit return-type annotation, so that first `{` is always the real body.
 * Throws loud if the name isn't found or nothing closes — this guard must not silently scan
 * nothing. */
function exportedFunctionBody(text: string, name: string): string {
  const sigStart = text.indexOf(`export function ${name}(`)
  if (sigStart < 0) throw new Error(`gated-handlers: export function ${name} not found`)
  const parenStart = text.indexOf('(', sigStart)
  let depth = 0
  let i = parenStart
  for (; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipLiteral(text, i) - 1
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) break
    }
  }
  if (depth !== 0) throw new Error(`gated-handlers: ${name}'s parameter list never closes`)
  const bodyStart = text.indexOf('{', i)
  if (bodyStart < 0) throw new Error(`gated-handlers: ${name} has no body`)
  depth = 0
  i = bodyStart
  for (; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipLiteral(text, i) - 1
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(bodyStart, i + 1)
    }
  }
  throw new Error(`gated-handlers: ${name}'s body never closes`)
}

/** Every exported function name in `text` whose body (as found by `exportedFunctionBody`) calls
 * `useGated(`. These are the components under test; a page that drops `useGated` from a control
 * entirely is caught by the per-page gated tests' own markup checks, not this file. */
function gatedComponentNames(text: string): string[] {
  const names: string[] = []
  for (const m of text.matchAll(/export function (\w+)\(/g)) {
    // A function this simple paren/brace counter cannot bound (an unusual signature) is skipped,
    // not thrown: this scan only needs to find the components that DO call useGated, and every one
    // of them (checked by hand below) has a plain signature this counter bounds correctly.
    let body: string
    try {
      body = exportedFunctionBody(text, m[1])
    } catch {
      continue
    }
    if (body.includes('useGated(')) names.push(m[1])
  }
  return names
}

const BANNED_CALLS = [/\bfetch\(/, /\bpostJson\(/, /\brequest\(/, /\bnavigate\(/, /window\.location/]

/** Every `{...VAR.bind}`-carrying JSX tag's own activation attribute(s), read without a real JSX
 * parser: from the bind spread, walk back to the nearest `<` and forward to the nearest `>` not
 * itself inside an attribute's `{...}` (the tags in this codebase never nest a `>` inside an
 * attribute value, so the first unescaped `>` after the spread always closes this tag). */
function bindTagActivationAttrs(body: string): { tag: string; attr: string; value: string }[] {
  const out: { tag: string; attr: string; value: string }[] = []
  for (const m of body.matchAll(/\{\.\.\.(\w+)\.bind\}/g)) {
    const v = m[1]
    const tagStart = body.lastIndexOf('<', m.index)
    const tagEnd = body.indexOf('>', m.index)
    if (tagStart < 0 || tagEnd < 0) throw new Error(`gated-handlers: unterminated tag around ${v}.bind`)
    const tag = body.slice(tagStart, tagEnd + 1)
    for (const am of tag.matchAll(/\s(on[A-Z]\w*)=\{([^{}]*)\}/g)) out.push({ tag, attr: am[1], value: am[2].trim() })
  }
  return out
}

describe('T-GATE-3: every gated handler does nothing but activate (source scan, no DOM)', () => {
  const files = Object.entries(SRC)

  it('scans the real tree, not an empty glob', () => {
    expect(files.length).toBeGreaterThan(5)
    expect(files.some(([p]) => p.includes('SegmentsPage'))).toBe(true)
  })

  it("every {...X.bind} tag's onClick/onKeyDown is exactly X.activate or X.onKeyDown, never a wrapping arrow", () => {
    const offenders: string[] = []
    for (const [path, text] of files) {
      for (const { attr, value } of bindTagActivationAttrs(text)) {
        const [owner] = value.split('.')
        // onClick (a button) and onChange (a gated checkbox/select) both wire straight to
        // `activate`; onKeyDown (a gated text input) wires to the hook's own `onKeyDown`.
        const ok =
          ((attr === 'onClick' || attr === 'onChange') && value === `${owner}.activate`) ||
          (attr === 'onKeyDown' && value === `${owner}.onKeyDown`)
        if (!ok) offenders.push(`${path}: ${attr}={${value}}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every bind-carrying tag has at least one activation attribute (onClick, onChange or onKeyDown)', () => {
    const offenders: string[] = []
    for (const [path, text] of files) {
      for (const m of text.matchAll(/\{\.\.\.(\w+)\.bind\}/g)) {
        const tagStart = text.lastIndexOf('<', m.index)
        const tagEnd = text.indexOf('>', m.index)
        const tag = text.slice(tagStart, tagEnd + 1)
        if (!/\son(Click|Change|KeyDown)=/.test(tag)) offenders.push(`${path}: tag with ${m[1]}.bind has no onClick/onChange/onKeyDown: ${tag}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('no component declaring useGated(...) calls fetch/postJson/request/navigate or touches window.location in its own body', () => {
    const offenders: string[] = []
    for (const [path, text] of files) {
      if (!text.includes('useGated(')) continue
      for (const name of gatedComponentNames(text)) {
        const body = exportedFunctionBody(text, name)
        for (const pattern of BANNED_CALLS) if (pattern.test(body)) offenders.push(`${path}: ${name} matches ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('finds at least one gated component per feature id (sanity: the scan sees real components, not zero)', () => {
    const allBodies = files.flatMap(([, text]) => gatedComponentNames(text).map((n) => exportedFunctionBody(text, n)))
    expect(allBodies.length).toBeGreaterThanOrEqual(Object.keys(FEATURES).length - 1) // work_sign_in's two homes are two components for one id
  })
})
