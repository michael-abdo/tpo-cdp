// T-VOC-1 (08, 09 D-66): every user-facing word is the brief's own, per the table in 06 §Vocabulary.
// The scan reads screen text from the TypeScript AST (JSX text, string literals, template chunks;
// comments are not nodes), handed over by vitest.config.ts as SCREEN_TEXTS.vocabulary for each file
// test/helpers/screen-text.ts VOCABULARY_SCAN names, plus the README as written, plus the system
// prompt as rendered (its Definitions section comes from shared/derive.ts at runtime; its view list
// from the migrated local D1's v_* views, no seed rows). No network.

import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
import componentsSource from '../src/components.tsx?raw'
import navSource from '../src/nav.ts?raw'
import eventsSource from '../src/pages/EventsPage.tsx?raw'
import lookupSource from '../src/pages/LookupPage.tsx?raw'
import overviewSource from '../src/pages/OverviewPage.tsx?raw'
import { discoverViewSchemas } from '../worker/assistant/schema-context'
import { renderSystemPrompt } from '../worker/assistant/system-prompt'
import { DEFINITIONS } from '../shared/derive'
import { GLOSSARY } from '../shared/glossary'
import { SOURCES } from '../shared/sources'
import { COLUMN_LABEL, FILTER_LABEL } from '../src/labels'
import { FILES } from '../src/needs-review'
import { VOCABULARY_SCAN } from './helpers/screen-text'
import { navArrayText, retiredIn } from './helpers/vocabulary'

function offences(files: Record<string, readonly string[]>): string[] {
  const out: string[] = []
  for (const [path, texts] of Object.entries(files))
    for (const text of texts)
      for (const name of retiredIn(text)) out.push(`${path}: ${name} in "${text.trim()}"`)
  return out
}

/** The labels a `<Field label="…">` or `<Column title="…">` names in a page's source. */
const attributeValues = (code: string, tag: string, attribute: string) =>
  [...code.matchAll(new RegExp(`<${tag}\\s+${attribute}="([^"]+)"`, 'g'))].map((m) => m[1])

describe('T-VOC-1 the brief\'s words everywhere (09 D-66, 06 §Vocabulary)', () => {
  it('scans every file it names: all of src/ (the Segments page too), the glossary, the registry, the definitions and the server sentences', () => {
    const scanned = Object.keys(env.SCREEN_TEXTS.vocabulary)
    for (const file of VOCABULARY_SCAN.files) expect(scanned).toContain(file)
    // Pinned on their own (not only via VOCABULARY_SCAN, which this would check against itself):
    // the definitions and the server sentences 08 T-VOC-1 names.
    for (const file of [
      'shared/derive.ts',
      'shared/glossary.ts',
      'shared/sources.ts',
      'worker/dedupe/score.ts',
      'worker/assistant/respond.ts',
      'worker/assistant/system-prompt.ts',
    ])
      expect(scanned).toContain(file)
    for (const page of ['src/App.tsx', 'src/pages/OverviewPage.tsx', 'src/pages/LookupPage.tsx', 'src/pages/SegmentsPage.tsx', 'src/labels.ts', 'src/segment-form.ts', 'src/previous-searches.ts'])
      expect(scanned).toContain(page)
    expect(VOCABULARY_SCAN.skip).toEqual([])
    expect(scanned.filter((p) => p.startsWith('src/')).length).toBeGreaterThan(15)
  })

  it('the guard flags each retired term and lets the brief\'s question and "screen reader" through', () => {
    expect(retiredIn('Find a reader')).toEqual(['reader(s)', 'Find a reader'])
    expect(retiredIn('Built a list of readers')).toEqual(['reader(s)', 'Build a list'])
    expect(retiredIn('App users whose email is not on the newsletter list')).toEqual([
      'Newsletter list',
      'App users',
    ])
    expect(retiredIn('build me a list of our most engaged readers')).toEqual([])
    expect(retiredIn('"Build me a list of our most engaged readers"')).toEqual([])
    expect(retiredIn('Most engaged readers this week')).toEqual(['reader(s)'])
    expect(retiredIn('The most engaged readers come first.')).toEqual(['reader(s)'])
    expect(retiredIn('so screen readers hear each change')).toEqual([])
    expect(retiredIn('app_users.csv')).toEqual([])
  })

  it('no user-facing string in the scanned code holds a retired term', () => {
    const texts = env.SCREEN_TEXTS.vocabulary
    expect(Object.values(texts).flat().length).toBeGreaterThan(500)
    expect(offences(texts)).toEqual([])
  })

  it('the system prompt the model reads, Definitions section included, holds no retired term', async () => {
    const prompt = renderSystemPrompt(await discoverViewSchemas(env.DB))
    // The Definitions section is built at runtime from shared/derive.ts, so the source scan of
    // system-prompt.ts alone never sees it; read the rendered text as the model does.
    for (const def of Object.values(DEFINITIONS)) expect(prompt).toContain(def.doc)
    expect(offences({ 'renderSystemPrompt()': prompt.split('\n') })).toEqual([])
  })

  it("no README line holds a retired term outside the brief's own question", () => {
    expect(offences({ 'README.md': readme.split('\n') })).toEqual([])
  })

  it('nav labels are the 06 words (D-67, D-71): Look up, Segments and Insights in place of AI assistant and Growth (D-64); App events and AI audit log fold into "Techy", last', () => {
    const nav = navArrayText(navSource)
    // Every label in document order: the four top-level pages, then Techy, then its two children.
    expect([...nav.matchAll(/label: '([^']+)'/g)].map((m) => m[1])).toEqual([
      'Overview',
      'Look up',
      'Segments',
      'Insights',
      'Techy',
      'App events',
      'AI audit log',
    ])
    // Only a top-level entry carries `kind:`; App events and AI audit log sit inside Techy's `items`
    // array, which has none, so this also proves they are not top-level (test/ui/nav.test.ts checks
    // the same invariant against the live NAV array, which this file cannot import: src/App.tsx has
    // real JSX, which tsconfig.worker.json, this file's project, does not parse).
    const topLevel = [...nav.matchAll(/kind: '(link|group)',\s*(?:to: '[^']*',\s*)?label: '([^']+)'/g)].map(
      (m) => ({
        kind: m[1],
        label: m[2],
      }),
    )
    expect(topLevel).toEqual([
      { kind: 'link', label: 'Overview' },
      { kind: 'link', label: 'Look up' },
      { kind: 'link', label: 'Segments' },
      { kind: 'link', label: 'Insights' },
      { kind: 'group', label: 'Techy' },
    ])
  })

  it("Look up: title, purpose and the three column titles are the brief's", () => {
    expect(lookupSource).toContain('title="Look up a subscriber"')
    expect(lookupSource).toContain(
      "'Finds anyone: newsletter info, site visits and app activity in one view.'",
    )
    expect(new Set(attributeValues(lookupSource, 'Column', 'title'))).toEqual(
      new Set(['Newsletter info', 'Site visits', 'App activity']),
    )
    // Field labels a person reads on the profile (06 §Vocabulary subscriber, web and app fields).
    const fields = new Set(attributeValues(lookupSource, 'Field', 'label'))
    for (const label of [
      'Status',
      'Acquisition source',
      'Signup date',
      'Last open date',
      'Visitor ID',
      'First UTM source',
      'User ID',
      'Created date',
    ])
      expect(fields).toContain(label)
  })

  it("source names and units are the brief's: beehiiv, Website, App accounts, App events", () => {
    expect(SOURCES.map((s) => s.name)).toEqual(['beehiiv', 'Website', 'App accounts', 'App events'])
    expect(SOURCES.map((s) => s.unit[1])).toEqual(['subscribers', 'website visits', 'app accounts', 'events'])
    expect(SOURCES.map((s) => s.unit[0])).toEqual(['subscriber', 'website visit', 'app account', 'event'])
  })

  it('headline tiles read Subscribers · Active subscribers · App accounts · App events', () => {
    const tiles = [
      GLOSSARY.subscribers_signed_up,
      GLOSSARY.subscribers_active,
      GLOSSARY.app_accounts,
      GLOSSARY.events_received,
    ]
    expect(tiles.map((t) => t.term)).toEqual([
      'Subscribers',
      'Active subscribers',
      'App accounts',
      'App events',
    ])
    // The Overview shows exactly these entries, in this order, labelled by the glossary term.
    const headline = overviewSource.slice(
      overviewSource.indexOf('const HEADLINE'),
      overviewSource.indexOf(']\n', overviewSource.indexOf('const HEADLINE')),
    )
    expect([...headline.matchAll(/term: '([^']+)'/g)].map((m) => m[1])).toEqual([
      'subscribers_signed_up',
      'subscribers_active',
      'app_accounts',
      'events_received',
    ])
    expect(overviewSource).toContain('label={GLOSSARY[h.term].term} term={h.term}')
    // merged = "deduped" (06 §Vocabulary dedupe + link).
    expect(GLOSSARY.merged.term).toBe('Deduped')
  })

  it('field labels equal the 06 table: subscriber, web and app fields', () => {
    const shown = (file: keyof typeof FILES) => FILES[file].columns.map((c) => c.label)
    expect(shown('subscribers')).toEqual(['Email', 'Signup date', 'Status', 'Acquisition source'])
    expect(shown('web_events')).toEqual(['Visitor ID', 'Page', 'Timestamp', 'UTM source', 'Email'])
    expect(shown('app_users')).toEqual(['User ID', 'Email', 'Created date'])
    expect({
      email: COLUMN_LABEL.email,
      signup_date: COLUMN_LABEL.signup_date,
      status: COLUMN_LABEL.status,
      source: COLUMN_LABEL.source,
      last_open_date: COLUMN_LABEL.last_open_date,
      utm_source: COLUMN_LABEL.utm_source,
    }).toEqual({
      email: 'Email',
      signup_date: 'Signup date',
      status: 'Status',
      source: 'Acquisition source',
      last_open_date: 'Last open date',
      utm_source: 'UTM source',
    })
    expect(FILTER_LABEL.source).toBe('Acquisition source')
  })

  it("the app's event names show as the brief writes them, each with a plain gloss", () => {
    for (const event of ['app_open', 'read_story', 'link_click', 'login'] as const) {
      expect(GLOSSARY[event].term).toBe(event)
      expect(GLOSSARY[event].text.length).toBeGreaterThan(10)
    }
    // Both pages that list events render the name through EventName (name + its gloss InfoTip).
    expect(eventsSource).toContain('<EventName event={e.event} />')
    expect(lookupSource).toContain('<EventName event={e.event} />')
    // EventName itself shows the gloss (InfoTip portals to document.body, so it is not server-rendered here).
    const eventName = componentsSource.slice(componentsSource.indexOf('export function EventName'))
    expect(eventName.slice(0, eventName.indexOf('\n}\n'))).toContain('<InfoTip term={event} />')
  })
})
