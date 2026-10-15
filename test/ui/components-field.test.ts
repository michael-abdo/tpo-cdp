import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Field } from '../../src/components'
import lookupSource from '../../src/pages/LookupPage.tsx?raw'

// src/components.tsx Field: the value wraps at word boundaries by default, so
// plain prose never breaks mid-word; a caller showing a raw id or hash with no natural break
// point passes `breakAll` so a long token still wraps inside its column instead of overflowing
// it. Every LookupPage Field that shows an id or hash must pass that flag.

/** The rendered <dd> element's class attribute for a Field with the given props/children. */
function ddClass(props: { label: string; breakAll?: boolean }, children: string = 'plain prose'): string {
  const html = renderToString(createElement(Field, props as Parameters<typeof Field>[0], children))
  const m = html.match(/<dd class="([^"]*)"/)
  if (m === null) throw new Error(`no <dd class="..."> in ${html}`)
  return m[1]
}

describe('Field: wraps at word boundaries by default, break-all only when asked (09 D-55)', () => {
  it('plain prose, no breakAll prop: <dd> is break-words, not break-all', () => {
    expect(ddClass({ label: 'x' })).toBe('break-words')
  })

  it('breakAll: <dd> is break-all, not break-words', () => {
    expect(ddClass({ label: 'x', breakAll: true })).toBe('break-all')
  })

  it('breakAll explicitly false behaves the same as the default', () => {
    expect(ddClass({ label: 'x', breakAll: false })).toBe('break-words')
  })
})

/** Every `<Field label="X" ...>` opening tag in `source`, up to its closing `>` (not self-closing:
 * Field always takes children), the same reading test/vocabulary.test.ts gives Field labels. */
function fieldTags(source: string, label: string): string[] {
  const re = new RegExp(`<Field label="${label}"[^>]*>`, 'g')
  return [...source.matchAll(re)].map((m) => m[0])
}

describe('Look up: every id/hash Field passes breakAll (09 D-55, 06 §Vocabulary)', () => {
  it.each(['Profile key', 'Visitor ID', 'User ID', 'Device ID', 'Device IDs'])('%s', (label) => {
    const tags = fieldTags(lookupSource, label)
    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) expect(tag).toContain('breakAll')
  })
})
