import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../shared/features'
import { Profile } from '../../src/pages/LookupPage'
import type { Lookup } from '../../src/types'
import { hasDisabledAttribute } from '../helpers/gated-assertions'

// Look up's gated future features (09 D-80, 22-pages/lookup.md §4): App revenue (a fourth column)
// and Delete this person (a quiet row at the end). T-FEAT-LK-1..4.

const PROFILE: Lookup = {
  profile: {
    pkey: 'pk_x',
    kind: 'subscriber',
    email: 'joy.hall830@protonmail.com',
    engagement_score: 65,
    cold_since: null,
    has_app: true,
    app_after_signup: true,
  },
  newsletter: {
    signup_date: '2026-09-02',
    status: 'active',
    source: 'instagram',
    last_open_date: '2026-09-22',
    merged_count: 1,
  },
  web: null,
  app: null,
}

function rendered(): string {
  return renderToString(createElement(MemoryRouter, null, createElement(Profile, { data: PROFILE }))).replaceAll('<!-- -->', '')
}

describe('Look up: App revenue (profile_revenue) and Delete this person (delete_person)', () => {
  it('T-FEAT-LK-1: both controls render aria-disabled="true", never disabled, with a describedby that resolves', () => {
    const html = rendered()
    expect(html.match(/aria-disabled="true"/g)?.length).toBe(2)
    expect(hasDisabledAttribute(html)).toBe(false)
    for (const m of html.matchAll(/aria-describedby="([^"]+)"/g)) expect(html).toContain(`id="${m[1]}"`)
  })

  it('T-FEAT-LK-2: both read their note from shared/features.ts, not a retyped copy', () => {
    const html = rendered()
    expect(html).toContain(FEATURES.profile_revenue.note)
    expect(html).toContain(FEATURES.delete_person.note)
  })

  it('T-FEAT-LK-2b: App revenue\'s column title and toggle text both come from shared/features.ts', () => {
    const html = rendered()
    expect(html).toContain(FEATURES.profile_revenue.label)
    expect(html).toContain(FEATURES.profile_revenue.controls![0])
  })

  it('T-FEAT-LK-3: the gated revenue column renders no digits and no currency sign, in its visible text', () => {
    const html = rendered()
    const start = html.indexOf('App revenue</h3>')
    const end = html.indexOf('</section>', start)
    // Strip every tag (and its attributes) to compare only the text a reader sees — a Tailwind
    // class such as "gap-1" or "py-0.5" is not a digit on screen.
    const text = html
      .slice(start, end)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&quot;/g, '"')
    expect(text).not.toMatch(/[0-9$]/)
  })

  it('App revenue is the fourth column; its toggle is a real button, never a <details> (it cannot open)', () => {
    const html = rendered()
    const start = html.indexOf('App revenue</h3>')
    const end = html.indexOf('</section>', start)
    expect(html.slice(start, end)).not.toContain('<details')
    expect(html.slice(start, end)).toContain('<button')
  })

  it('Delete this person is muted, never red, and is not a destructive-red button', () => {
    const html = rendered()
    expect(html).toContain('Delete this person')
    expect(html).not.toContain('border-danger-line')
    expect(html).not.toContain('text-danger')
  })

  it('shows exactly one "Coming soon" chip per gated control (two total)', () => {
    const html = rendered()
    expect((html.match(/Coming soon/g) ?? []).length).toBe(2)
  })
})
