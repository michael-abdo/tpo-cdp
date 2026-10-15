/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import appCsv from '../data/app_users.csv?raw'
import subscribersCsv from '../data/subscribers.csv?raw'
import webCsv from '../data/web_events.csv?raw'
import * as normalize from '../shared/normalize'
import { CANONICAL_SOURCES, canonicalSource, normalizeEmail, normalizeQueryFragment } from '../shared/normalize'
import normalizeSource from '../shared/normalize.ts?raw'
import { parseCsv } from '../worker/ingest/csv'

// The one email and source normalizer: T-NORM-1..3, and the one email fold: T-HARD-8.

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

  it('pins each clause of the email regex', () => {
    // Regex-clause fixtures, not business data: these strings are never presented as real
    // emails and none can pass the regex. Each one fails a weakened pattern:
    expect(normalizeEmail('a@b')).toBeNull() // dropping the required `\.` before the TLD
    expect(normalizeEmail('a@b@c.com')).toBeNull() // allowing `@` in the local part or the domain before the dot
    expect(normalizeEmail('a b@c.com')).toBeNull() // allowing whitespace inside the local part
    expect(normalizeEmail('a@b c.com')).toBeNull() // allowing whitespace in the domain before the dot
    expect(normalizeEmail('a@b.c d')).toBeNull() // dropping the `$` anchor, or allowing whitespace in the TLD
    expect(normalizeEmail('a@b.c@d')).toBeNull() // dropping the `$` anchor, or allowing `@` in the TLD
    expect(normalizeEmail('a@b.')).toBeNull() // allowing an empty TLD (`*` for `+` after the dot)
    expect(normalizeEmail('a@.com')).toBeNull() // allowing an empty domain before the dot (`*` for `+` after the @)
  })

  it('changes nothing but case: plus tags and dots stay', () => {
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
    expect(Object.keys(migrations)).toContain('../migrations/0001_core.sql')
    expect(Object.keys(migrations)).toContain('../migrations/0002_views.sql')
  })

  // Every file outside shared/normalize.ts that lowercases anything, and what it lowercases
  // (T-HARD-8). None is an email; a new caller fails until it is read and listed here, so an
  // email folded under another name (`q`, `raw`, `addr`) cannot slip past a word match.
  const LOWERCASES_NO_EMAIL: Record<string, string> = {
    '../worker/assistant/gates/gate2-tool-authorizer.ts': 'SQL tokens and view/column names of model SQL',
    '../worker/auth/middleware.ts': 'the Content-Type media type',
    '../worker/webhooks/verify.ts': 'the hex digits of the webhook signature',
    '../src/pages/AuditPage.tsx': 'the audit search text and the text it highlights',
    '../src/insights/board.tsx': 'time period preset labels and the tile title compared with them',
    '../src/insights/charts.tsx': 'a chart kind label inside a sentence',
    '../src/insights/pin-dialog.tsx': 'a time period preset label',
    '../worker/insights/board.ts': 'pk_ key hex digits, hex runs in result text, SQL column names, a preset label',
    '../worker/insights/going-cold.ts': 'the first letter of a definition sentence',
    '../worker/insights/pin-grammar.ts': 'SQL column, function and alias names of a pinned query_sql SQL (09 D-64b)',
    '../worker/ingest/web.ts': 'the /subscribe page path, for case-insensitive linking (09 D-78)',
  }
  const LOWERCASE_CALL = /\.(?:toLowerCase|toLocaleLowerCase)\s*\(/

  it('no file outside shared/normalize.ts lowercases an email', () => {
    const offenders: string[] = []
    for (const [path, text] of Object.entries(sources)) {
      if (path.endsWith('/shared/normalize.ts')) continue
      text.split('\n').forEach((line, i) => {
        if (!LOWERCASE_CALL.test(line)) return
        // Outside the listed files any lowercasing fails; inside them, a line naming an email does.
        if (!(path in LOWERCASES_NO_EMAIL) || /e-?mail|addr|fragment/i.test(line)) {
          offenders.push(`${path}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('every file listed as lowercasing no email still lowercases (the list holds no stale entry)', () => {
    for (const path of Object.keys(LOWERCASES_NO_EMAIL)) {
      expect(sources[path], path).toBeDefined()
      expect(LOWERCASE_CALL.test(sources[path]), path).toBe(true)
    }
  })

  /** Source text with its comments removed, so a comment may name LOWER( and code may not. */
  function withoutComments(text: string): string {
    return text.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/(^|\s)\/\/.*$/gm, '$1')
  }

  it('no SQL string in worker/, scripts/ or shared/ folds case with LOWER(', () => {
    const offenders: string[] = []
    for (const [path, text] of Object.entries(sources)) {
      if (path.startsWith('../src/')) continue
      withoutComments(text)
        .split('\n')
        .forEach((line) => {
          if (/\bLOWER\s*\(/i.test(line)) offenders.push(`${path}: ${line.trim()}`)
        })
    }
    expect(offenders).toEqual([])
  })

  it('the LOWER( scan reads code and SQL strings, not comments', () => {
    const sql = "const q = db.prepare('SELECT pkey FROM profiles WHERE LOWER(email_norm) = ?')"
    expect(/\bLOWER\s*\(/i.test(withoutComments(sql))).toBe(true)
    expect(/\bLOWER\s*\(/i.test(withoutComments('const SQL = `\n  WHERE lower( email_norm) = ?`'))).toBe(true)
    expect(/\bLOWER\s*\(/i.test(withoutComments('// SQL never folds with LOWER(\n/**\n * nor LOWER( here\n */'))).toBe(false)
    expect(withoutComments("fetch('http://cdp.test/api') // a note")).toBe("fetch('http://cdp.test/api') ")
  })

  it('no migration normalizes in SQL with LOWER(', () => {
    const offenders = Object.entries(migrations)
      .filter(([, sql]) => /\bLOWER\s*\(/i.test(sql))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})

describe('T-HARD-8 one email fold', () => {
  it('normalizeEmail and normalizeQueryFragment both call the one private fold; nothing else in the file folds an email', () => {
    expect(normalizeSource).toMatch(/\nfunction foldEmail\(raw: string\): string \{\n  return raw\.trim\(\)\.toLowerCase\(\)\n\}/)
    expect(Object.keys(normalize)).not.toContain('foldEmail')
    const body = (name: string) => {
      const start = normalizeSource.indexOf(`export function ${name}(`)
      return normalizeSource.slice(start, normalizeSource.indexOf('\n}\n', start))
    }
    expect(body('normalizeEmail')).toContain('foldEmail(raw)')
    expect(body('normalizeQueryFragment')).toContain('foldEmail(raw)')
    for (const name of ['normalizeEmail', 'normalizeQueryFragment']) expect(body(name)).not.toMatch(/toLowerCase|trim\(/)
  })

  it('every real email spelling folds the same as an address and as a query fragment', () => {
    const spellings: string[] = []
    for (const [csv, column] of [
      [subscribersCsv, 'email'],
      [appCsv, 'email'],
      [webCsv, 'email'],
    ] as const) {
      const parsed = parseCsv(csv)
      const col = parsed.header.indexOf(column)
      for (const row of parsed.rows) if (row[col].trim() !== '') spellings.push(row[col])
    }
    // 2,995 − 8 blank subscriber rows, 930 app accounts, the 1,400 visitors' /subscribe emails and more.
    expect(spellings.length).toBeGreaterThan(5000)
    // Raw spellings with case or whitespace are among them, so the fold is exercised, not just identity.
    expect(spellings.some((e) => normalizeEmail(e) !== e)).toBe(true)
    for (const raw of spellings) {
      const email = normalizeEmail(raw)
      if (email !== null) expect(normalizeQueryFragment(raw), raw).toBe(email)
    }
  })
})
