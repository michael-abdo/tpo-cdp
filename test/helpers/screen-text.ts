import type * as TS from 'typescript'

// The text a .tsx file can put on screen, read from the TypeScript AST (08 T-SRC-2). The scan
// cannot run inside workerd: loading the `typescript` package there makes the test worker exit.
// So vitest.config.ts runs screenTextBinding() in Node at config time and hands the result to the
// tests as the SCREEN_TEXTS binding, as it already does with TEST_MIGRATIONS. This module only
// imports TypeScript's types, so a test may import SCAN_FIXTURES without loading the compiler.

/**
 * TSX snippets the T-SRC-2 scan must flag (or, for `comment_only`, must not). Each holds per-file
 * prose written the way a real page would: text next to an interpolation, which a regex over
 * `>text<` never sees. Source names and units here are the registry's own (shared/sources.ts).
 */
export const SCAN_FIXTURES = {
  interpolated_file_count: '<p>Read {n(sources.length)} files from beehiiv</p>',
  interpolated_unit: '<span>{x} subscribers</span>',
  unit_after_element: '<p><b>{n}</b> website visits</p>',
  template_file_count: 'const line = `${n} files loaded`',
  ternary_file_word: "const word = count === 1 ? 'file' : 'files'",
  attribute_name: '<ul aria-label="Website: syncs" />',
  comment_only: '// beehiiv loads 3 files.\nconst x = <p>{n} rows</p>',
} as const

export type ScanFixture = keyof typeof SCAN_FIXTURES

/**
 * Where user-facing words live, for the vocabulary guard (08 T-VOC-1, 09 D-66): every .ts/.tsx file
 * under `src/` except the Segments page (owned by the segments work, which already uses the D-66
 * words), the glossary, the source registry, the metric definitions (shared/derive.ts DEFINITIONS:
 * the system prompt renders its Definitions section from them at runtime, and the UI footers and
 * Look up show them) and the server-written sentences (dedupe suggestions, assistant fallback
 * sentences, the system prompt, the Insights board's and pin dialog's sentences, and the built-in
 * Insights tiles' "Explain this" questions).
 */
export const VOCABULARY_SCAN = {
  dirs: ['src'],
  skip: ['src/pages/SegmentsPage.tsx'],
  files: [
    'shared/glossary.ts',
    'shared/sources.ts',
    'shared/derive.ts',
    'worker/dedupe/score.ts',
    'worker/assistant/respond.ts',
    'worker/assistant/system-prompt.ts',
    'worker/insights/data-quality.ts',
    'worker/insights/funnel.ts',
    'worker/insights/going-cold.ts',
    'worker/insights/source-app.ts',
    'worker/insights/board.ts',
    'shared/insight-messages.ts',
  ],
} as const

/**
 * Where one screen's words live, for the one-place guard (08 T-UI-ONE, 09 D-72): every page, the
 * Insights pieces, the shared components and the shell, plus the modules that write whole sentences
 * a screen shows (the glossary, the board's sentences, the rows-to-fix sentences, the blocked-step
 * sentences and the dedupe suggestions). A file is one screen's text: a sentence it holds twice is
 * said twice on that screen, or lives in two places in its code.
 */
export const ONE_PLACE_SCAN = {
  dirs: ['src/pages', 'src/insights'],
  files: [
    'src/App.tsx',
    'src/components.tsx',
    'src/needs-review.ts',
    'src/block-reason.ts',
    'shared/glossary.ts',
    'shared/insight-messages.ts',
    'worker/dedupe/score.ts',
  ],
} as const

/**
 * The ONE_PLACE_SCAN files a page's own text is unioned with when it imports them (T-UI-ONE "per
 * screen"): shared UI components and sentence constants, whose literal text a page could retype.
 * GLOSSARY/DEFINITIONS (shared/glossary.ts) and the other data modules are left out on purpose:
 * their own source holds each entry's text once no matter how many pages read it, so merging them
 * in would over-count a page that reads one entry exactly once; `screenFacts`'s `resolve` already
 * credits that page with it, precisely once per property access (09 D-72, m3b/m6d vs m11).
 */
const MERGEABLE_SCREEN_FILES = new Set(['src/App.tsx', 'src/components.tsx', 'src/needs-review.ts', 'src/block-reason.ts'])

export interface ScreenTexts {
  overview: string[]
  fixtures: Record<ScanFixture, string[]>
  /** Repo-relative path → that file's screen text, for each file VOCABULARY_SCAN names. */
  vocabulary: Record<string, string[]>
  /** Repo-relative path → that screen's facts (T-UI-ONE), for each file ONE_PLACE_SCAN names. */
  onePlace: Record<string, ScreenFacts>
  /** Each ONE_PLACE_FIXTURES snippet's facts, so the test proves the scan sees what the rules need. */
  onePlaceFixtures: Record<OnePlaceFixture, ScreenFacts>
  /** The merged facts of a synthetic page importing a synthetic shared component (m11): proves
   * `mergedOnePlaceFacts` catches a sentence the component shows, repeated on the page. */
  onePlaceScreenFixture: ScreenFacts
}

/** What a .tsx file puts on screen, read for the one-place guard (T-UI-ONE). */
export interface ScreenFacts {
  /** Text a person can read: JSX text, string literals and template chunks, minus plumbing attributes. */
  texts: string[]
  /** Each `placeholder` attribute: its literal text and the identifiers its value reads. */
  placeholders: { text: string; identifiers: string[] }[]
  /** Each button, link or summary: its child text and the identifiers its children read. */
  actions: { text: string; identifiers: string[] }[]
}

/**
 * JSX attributes whose values are never read as text: classes, ids, routes, input plumbing and
 * ARIA references. Every other attribute (aria-label, label, caption, title, placeholder …) is text.
 */
const NON_TEXT_ATTRIBUTES = new Set([
  'className',
  'id',
  'key',
  'htmlFor',
  'to',
  'href',
  'src',
  'type',
  'role',
  'name',
  'autoComplete',
  'inputMode',
  'rel',
  'target',
  'style',
  'value',
  'aria-controls',
  'aria-labelledby',
  'aria-describedby',
  'aria-activedescendant',
  'aria-haspopup',
  'data-stale',
  'data-bar-label',
])

/** Elements a person presses: the second T-UI-ONE rule reads their text. */
const ACTION_TAGS = new Set(['button', 'Button', 'a', 'Link', 'NavLink', 'summary'])

/**
 * TSX snippets the T-UI-ONE rules must flag (`flag_…`) or leave alone (`pass_…`), written the way a
 * real page would: the "Try an example" button beside a placeholder that already shows the example
 * (09 D-72's own case), a sentence said twice, and the shapes that are not duplicates: a class
 * string used twice, a short label twice, one sentence held in one constant and used twice, and a
 * placeholder that is a hint in words rather than an example value.
 */
export const ONE_PLACE_FIXTURES = {
  flag_example_identifier:
    '<form><input placeholder={`e.g. ${EXAMPLE}`} /><Button icon={ICONS.next} onClick={() => go(EXAMPLE)}>Try an example: {EXAMPLE}</Button></form>',
  flag_example_literal:
    '<form><input placeholder="e.g. joy.hall830@protonmail.com" /><button type="button">Try joy.hall830@protonmail.com</button></form>',
  // The button shows no value at all, only identifying the example through its onClick handler
  // (09 D-72's own case, missed when identifiers came from an action's children only).
  flag_example_button_no_value:
    '<form><input placeholder={`e.g. ${EXAMPLE}`} /><Button onClick={() => go(EXAMPLE)}>Try an example</Button></form>',
  // The placeholder's identifier resolves to a file-level literal; the link repeats that literal
  // outright, never naming the identifier.
  flag_example_literal_in_link:
    "const EXAMPLE = 'joy.hall830@protonmail.com'\nconst x = <input placeholder={`e.g. ${EXAMPLE}`} />\nconst y = <a href=\"/lookup\">See joy.hall830@protonmail.com</a>",
  // The link shows the example through an alias of the placeholder's identifier, not the identifier
  // itself.
  flag_example_alias_in_link:
    "const EXAMPLE = 'joy.hall830@protonmail.com'\nconst DEMO = EXAMPLE\nconst x = <input placeholder={`e.g. ${EXAMPLE}`} />\nconst y = <Link to=\"/lookup\">{DEMO}</Link>",
  // A page literal equal to a glossary entry's text it already shows by property access (m3b).
  flag_glossary_literal_match:
    '<div><p>{GLOSSARY.possible_duplicates.text}</p><p>Two subscribers with different emails whose names match, for a person to judge.</p></div>',
  // A footer row rendering a DEFINITIONS doc next to a hint holding the same sentence (m6d).
  flag_definitions_doc_matches_hint:
    "<div><p>{DEFINITIONS.no_open_in_days.doc}</p><p>The brief's segment filter: at least N days since the last open, with a toggle that also includes everyone who never opened, whatever their signup date.</p></div>",
  flag_sentence_twice:
    '<div><p>Type part of the email to see matches.</p><p className="mt-2">Type part of the email to see matches.</p></div>',
  flag_sentence_in_literal_and_jsx:
    "const HINT = 'Type part of the email to see matches.'\nconst x = <p>{HINT}</p>\nconst y = <p>Type part of the email to see matches.</p>",
  pass_classes_twice:
    "const link = 'inline-flex min-h-6 items-center gap-1 rounded-md text-sm'\nconst x = <a className=\"inline-flex min-h-6 items-center gap-1 rounded-md text-sm\">Back</a>",
  pass_short_twice: '<div><p>Try again.</p><p>Try again.</p></div>',
  pass_hoisted:
    "const RETRY = 'Refresh the page to try again.'\nconst x = <ErrorLine next={RETRY} />\nconst y = <ErrorLine next={RETRY} />",
  pass_hint_placeholder: '<form><input placeholder="Search" /><button type="submit">Search</button></form>',
} as const

export type OnePlaceFixture = keyof typeof ONE_PLACE_FIXTURES

/**
 * Every JSX text run, string literal and template-literal chunk in `code`, in source order.
 * Module specifiers (import/export … from '…') name files, not screen text, and are skipped;
 * comments are not nodes, so they never appear.
 */
export function screenTexts(ts: typeof TS, fileName: string, code: string): string[] {
  const file = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: string[] = []
  const visit = (node: TS.Node): void => {
    if (ts.isJsxText(node)) {
      if (node.text.trim() !== '') out.push(node.text)
    } else if (ts.isStringLiteral(node)) {
      const parent = node.parent
      const specifier =
        (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node
      if (!specifier) out.push(node.text)
    } else if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

/**
 * The literal text and the identifiers under `node`: template chunks, string literals, JSX text,
 * names. `consts` (from `fileConsts`) resolves an identifier that is a file-level literal (or an
 * alias of one) to that literal's text too, so `` `e.g. ${EXAMPLE}` `` reads as the value it shows
 * on screen, not just the words around the substitution (09 D-72, m4b/m4c).
 */
function textAndIdentifiers(
  ts: typeof TS,
  node: TS.Node,
  consts: Readonly<Record<string, string>> = {},
): { text: string; identifiers: string[] } {
  const parts: string[] = []
  const identifiers: string[] = []
  const visit = (n: TS.Node): void => {
    if (ts.isJsxText(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text)
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) parts.push(n.text)
    else if (ts.isIdentifier(n)) {
      identifiers.push(n.text)
      if (Object.hasOwn(consts, n.text)) parts.push(consts[n.text])
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return { text: parts.join(''), identifiers }
}

/** Every Identifier's name under `node`, in source order, duplicates included. */
function identifiersIn(ts: typeof TS, node: TS.Node): string[] {
  const out: string[] = []
  const visit = (n: TS.Node): void => {
    if (ts.isIdentifier(n)) out.push(n.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

/** A JSX attribute name written as a DOM-style event handler prop (`onClick`, `onSubmit`, …). */
const HANDLER_ATTRIBUTE = /^on[A-Z]/

/**
 * File-level `const NAME = '<literal>'` (or a no-substitution template) and aliases of one
 * (`const OTHER = NAME`), resolved through a short chain of aliases. Only top-level declarations
 * count as "file-level" (09 D-72, m4b/m4c): `screenFacts` uses this so a placeholder's or an
 * action's identifier reads as the value it actually shows, not just its name.
 */
function fileConsts(ts: typeof TS, file: TS.SourceFile): Record<string, string> {
  const consts: Record<string, string> = {}
  const aliasOf: Record<string, string> = {}
  for (const stmt of file.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue
      const init = decl.initializer
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) consts[decl.name.text] = init.text
      else if (ts.isIdentifier(init)) aliasOf[decl.name.text] = init.text
    }
  }
  for (let i = 0; i < 5; i++)
    for (const [name, ref] of Object.entries(aliasOf)) if (consts[name] === undefined && consts[ref] !== undefined) consts[name] = consts[ref]
  return consts
}

/** `GLOSSARY`/`DEFINITIONS` (the root) → each entry's key → its property name → literal text
 * (templated docs, which hold a constant such as `COLD_DAYS`, are left out: nothing reads them as
 * a fixed sentence). */
export type ConstObjectTexts = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>

/**
 * Reads `export const NAME = { key: { prop: '<literal>', ... }, ... }` from its own source,
 * without executing the module (the compiler cannot load inside workerd, so nothing here may
 * depend on importing `shared/glossary.ts` or `shared/derive.ts` at runtime). Used to resolve a
 * `GLOSSARY.key.prop` / `DEFINITIONS.key.prop` property access to the same text (09 D-72, m3b/m6d).
 */
function constObjectTexts(ts: typeof TS, fileName: string, code: string, exportName: string): Record<string, Record<string, string>> {
  const file = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const result: Record<string, Record<string, string>> = {}
  const propName = (name: TS.PropertyName): string | null =>
    ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null
  const unwrap = (e: TS.Expression): TS.Expression =>
    ts.isAsExpression(e) || ts.isSatisfiesExpression(e) ? unwrap(e.expression) : e
  for (const stmt of file.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== exportName || decl.initializer === undefined) continue
      const init = unwrap(decl.initializer)
      if (!ts.isObjectLiteralExpression(init)) continue
      for (const prop of init.properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        const key = propName(prop.name)
        const value = unwrap(prop.initializer)
        if (key === null || !ts.isObjectLiteralExpression(value)) continue
        const entry: Record<string, string> = {}
        for (const p of value.properties) {
          if (!ts.isPropertyAssignment(p)) continue
          const pname = propName(p.name)
          if (pname !== null && (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer)))
            entry[pname] = p.initializer.text
        }
        result[key] = entry
      }
    }
  }
  return result
}

/** `GLOSSARY` and `DEFINITIONS`, read from their own files' source (09 D-63, D-72). */
export function glossaryAndDefinitionsTexts(ts: typeof TS, glossarySource: string, derivedSource: string): ConstObjectTexts {
  return {
    GLOSSARY: constObjectTexts(ts, 'shared/glossary.ts', glossarySource, 'GLOSSARY'),
    DEFINITIONS: constObjectTexts(ts, 'shared/derive.ts', derivedSource, 'DEFINITIONS'),
  }
}

/**
 * The facts T-UI-ONE reads from one screen file: its readable text (JSX text, string literals and
 * template chunks, skipping module specifiers and NON_TEXT_ATTRIBUTES, plus the text of any
 * `GLOSSARY.key.prop` / `DEFINITIONS.key.prop` property access `resolve` can read), every
 * placeholder, and every button, link or summary with what it says and the identifiers its
 * children AND its handler attributes (`onClick`, …) show (09 D-72, m1b).
 */
export function screenFacts(ts: typeof TS, fileName: string, code: string, resolve: ConstObjectTexts = {}): ScreenFacts {
  const file = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const consts = fileConsts(ts, file)
  const facts: ScreenFacts = { texts: [], placeholders: [], actions: [] }
  const visit = (node: TS.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
      const root = node.expression.expression.text
      const key = node.expression.name.text
      const prop = node.name.text
      const text = resolve[root]?.[key]?.[prop]
      if (text !== undefined) facts.texts.push(text)
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(file)
      if (NON_TEXT_ATTRIBUTES.has(name)) return
      if (name === 'placeholder' && node.initializer !== undefined)
        facts.placeholders.push(textAndIdentifiers(ts, node.initializer, consts))
    }
    if (ts.isJsxElement(node) && ACTION_TAGS.has(node.openingElement.tagName.getText(file))) {
      const parts = node.children.map((child) => textAndIdentifiers(ts, child, consts))
      const attrIdentifiers = node.openingElement.attributes.properties.flatMap((attr) =>
        ts.isJsxAttribute(attr) && HANDLER_ATTRIBUTE.test(attr.name.getText(file)) && attr.initializer !== undefined
          ? identifiersIn(ts, attr.initializer)
          : [],
      )
      facts.actions.push({
        text: parts.map((p) => p.text).join(''),
        identifiers: [...new Set([...parts.flatMap((p) => p.identifiers), ...attrIdentifiers])],
      })
    }
    if (ts.isJsxText(node)) {
      if (node.text.trim() !== '') facts.texts.push(node.text)
    } else if (ts.isStringLiteral(node)) {
      const parent = node.parent
      const specifier =
        (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node
      if (!specifier) facts.texts.push(node.text)
    } else if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      facts.texts.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return facts
}

/** `a/b/../../c` → `c`: POSIX-only repo-relative join (no `node:path`, so this file still loads
 * if ever reached from workerd; only `screenTextBinding`, Node-only, calls it). */
function posixJoin(dir: string, spec: string): string {
  const stack: string[] = []
  for (const part of [...dir.split('/'), ...spec.split('/')]) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

/**
 * The repo-relative paths `fileName` imports by a relative specifier, limited to `known` (paths
 * already scanned): a page imports `src/components.tsx`, so a sentence `ErrorLine` already shows
 * is also that page's sentence if the page repeats it (09 D-72, T-UI-ONE "per screen", m11).
 */
export function importedScreenPaths(ts: typeof TS, fileName: string, code: string, known: ReadonlySet<string>): string[] {
  const file = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const dir = fileName.includes('/') ? fileName.slice(0, fileName.lastIndexOf('/')) : '.'
  const out: string[] = []
  for (const stmt of file.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    if (!spec.startsWith('.')) continue
    const base = posixJoin(dir, spec)
    const found = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((p) => known.has(p))
    if (found !== undefined) out.push(found)
  }
  return out
}

/**
 * `rawFacts` with each file under one of `screenDirs` (a page, an Insights piece) unioned with the
 * `texts` of the shared UI components it imports, from `mergeableFiles` (also in `rawFacts`), so
 * T-UI-ONE compares what one screen shows, not one file's text in isolation (09 D-72, found by
 * m11: a sentence in `src/components.tsx` repeated on a page passed because the scan ran strictly
 * per file). `mergeableFiles` excludes GLOSSARY/DEFINITIONS and other data-only modules: their own
 * source holds every entry's text once regardless of how many pages read it, so merging them in
 * would over-count a page that reads one entry exactly once (`screenFacts`'s `resolve` already
 * credits that page with it, precisely once per property access). Only `texts` are unioned;
 * `placeholders`/`actions` (the example-shown-twice rule) stay per file, since that rule is about
 * one control's label next to one control, not a whole screen's prose.
 */
export function mergedOnePlaceFacts(
  ts: typeof TS,
  code: Readonly<Record<string, string>>,
  rawFacts: Readonly<Record<string, ScreenFacts>>,
  screenDirs: readonly string[],
  mergeableFiles: ReadonlySet<string>,
): Record<string, ScreenFacts> {
  const out: Record<string, ScreenFacts> = {}
  for (const [path, facts] of Object.entries(rawFacts)) {
    if (!screenDirs.some((dir) => path.startsWith(`${dir}/`))) {
      out[path] = facts
      continue
    }
    const deps = importedScreenPaths(ts, path, code[path], mergeableFiles)
    out[path] = { ...facts, texts: [...facts.texts, ...deps.flatMap((d) => rawFacts[d].texts)] }
  }
  return out
}

/**
 * A tiny synthetic two-file "screen" (a page importing a shared component) proving
 * `mergedOnePlaceFacts` catches a sentence the component already shows, repeated on the page
 * (m11): the fixture mechanism above runs one file at a time, so this is exercised separately.
 */
const SCREEN_MERGE_FIXTURE = {
  component: "export function ErrorLine() { return <p>Couldn't reach the server. Check your connection, then try again.</p> }",
  page:
    "import { ErrorLine } from '../components'\nconst x = <ErrorLine />\nconst y = <p>Couldn't reach the server. Check your connection, then try again.</p>",
} as const

/**
 * Runs in Node (vitest.config.ts): the Overview's screen text, each fixture's, each vocabulary
 * file's (`vocabularyCode`: repo-relative path → source, read by the config from VOCABULARY_SCAN)
 * and each screen file's facts (`onePlaceCode`, read from ONE_PLACE_SCAN the same way), merged per
 * screen (09 D-72), plus the GLOSSARY/DEFINITIONS-aware facts of the cross-file merge fixture.
 */
export async function screenTextBinding(
  overviewCode: string,
  vocabularyCode: Record<string, string>,
  onePlaceCode: Record<string, string>,
): Promise<ScreenTexts> {
  const ts = (await import('typescript')).default
  const fixtures = Object.fromEntries(
    Object.entries(SCAN_FIXTURES).map(([key, code]) => [key, screenTexts(ts, `${key}.tsx`, code)]),
  ) as Record<ScanFixture, string[]>
  const vocabulary = Object.fromEntries(
    Object.entries(vocabularyCode).map(([path, code]) => [path, screenTexts(ts, path, code)]),
  )
  const resolve = glossaryAndDefinitionsTexts(ts, vocabularyCode['shared/glossary.ts'] ?? '', vocabularyCode['shared/derive.ts'] ?? '')
  const rawOnePlace = Object.fromEntries(Object.entries(onePlaceCode).map(([path, code]) => [path, screenFacts(ts, path, code, resolve)]))
  const onePlace = mergedOnePlaceFacts(ts, onePlaceCode, rawOnePlace, ONE_PLACE_SCAN.dirs, MERGEABLE_SCREEN_FILES)
  const onePlaceFixtures = Object.fromEntries(
    Object.entries(ONE_PLACE_FIXTURES).map(([key, code]) => [key, screenFacts(ts, `${key}.tsx`, code, resolve)]),
  ) as Record<OnePlaceFixture, ScreenFacts>
  const screenFixtureCode = { 'fixture/components.tsx': SCREEN_MERGE_FIXTURE.component, 'fixture/pages/Page.tsx': SCREEN_MERGE_FIXTURE.page }
  const screenFixtureRaw = Object.fromEntries(Object.entries(screenFixtureCode).map(([path, code]) => [path, screenFacts(ts, path, code)]))
  const onePlaceScreenFixture = mergedOnePlaceFacts(ts, screenFixtureCode, screenFixtureRaw, ['fixture/pages'], new Set([
    'fixture/components.tsx',
  ]))['fixture/pages/Page.tsx']
  return {
    overview: screenTexts(ts, 'OverviewPage.tsx', overviewCode),
    fixtures,
    vocabulary,
    onePlace,
    onePlaceFixtures,
    onePlaceScreenFixture,
  }
}
