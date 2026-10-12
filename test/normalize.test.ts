/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { CANONICAL_SOURCES, canonicalSource, normalizeEmail } from '../shared/normalize'

// 02 §Normalization, 09 D-26, tests 08 T-NORM-1..3 (A2).

describe('T-NORM-1 normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Jane.Doe@Example.COM  ')).toBe('jane.doe@example.com')
  })

  it('returns null for values that are not an address', () => {
    expect(normalizeEmail('not-an-email')).toBeNull()
    expect(normalizeEmail('@gmail.com')).toBeNull()
    expect(normalizeEmail('')).toBeNull()
    expect(normalizeEmail('   ')).toBeNull()
  })

  it('changes nothing but case: plus tags and dots stay (D-26)', () => {
    expect(normalizeEmail('a+b@x.com')).toBe('a+b@x.com')
    expect(normalizeEmail('First.Last@gmail.com')).toBe('first.last@gmail.com')
  })
})

describe('T-NORM-2 canonicalSource', () => {
  it('folds case and maps twitter to x', () => {
    expect(canonicalSource('X')).toBe('x')
    expect(canonicalSource('twitter')).toBe('x')
    expect(canonicalSource(' Twitter ')).toBe('x')
    expect(canonicalSource('Instagram')).toBe('instagram')
  })

  it('blank is null; unknown values pass through lowercased', () => {
    expect(canonicalSource('')).toBeNull()
    expect(canonicalSource('   ')).toBeNull()
    expect(canonicalSource('Newsletter-Swap')).toBe('newsletter-swap')
  })

  it('every canonical name maps to itself', () => {
    expect(CANONICAL_SOURCES).toEqual([
      'instagram',
      'facebook',
      'referral',
      'google',
      'direct',
      'podcast',
      'x',
    ])
    for (const name of CANONICAL_SOURCES) expect(canonicalSource(name)).toBe(name)
  })
})

describe('T-NORM-3 single implementation', () => {
  // Source text of every product file, read at transform time by Vite (works in the workers pool).
  const sources = import.meta.glob<string>(
    [
      '../worker/**/*.{ts,tsx,js}',
      '../shared/**/*.{ts,tsx,js}',
      '../scripts/**/*.{ts,tsx,js}',
      '../src/**/*.{ts,tsx,js}',
    ],
    { query: '?raw', import: 'default', eager: true },
  )
  const migrations = import.meta.glob<string>('../migrations/*.sql', {
    query: '?raw',
    import: 'default',
    eager: true,
  })

  it('scans the real tree, not an empty glob', () => {
    expect(Object.keys(sources)).toContain('../shared/normalize.ts')
    expect(Object.keys(sources)).toContain('../worker/index.ts')
  })

  it('no file outside shared/normalize.ts lowercases an email', () => {
    const offenders: string[] = []
    for (const [path, text] of Object.entries(sources)) {
      if (path.endsWith('/shared/normalize.ts')) continue
      text.split('\n').forEach((line, i) => {
        if (line.includes('.toLowerCase(') && line.toLowerCase().includes('email')) {
          offenders.push(`${path}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('no migration normalizes in SQL with LOWER(', () => {
    const offenders = Object.entries(migrations)
      .filter(([, sql]) => /\bLOWER\s*\(/i.test(sql))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})
