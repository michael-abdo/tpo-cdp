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

export interface ScreenTexts {
  overview: string[]
  fixtures: Record<ScanFixture, string[]>
  /** Repo-relative path → that file's screen text, for each file VOCABULARY_SCAN names. */
  vocabulary: Record<string, string[]>
  /** Repo-relative path → that screen's facts (T-UI-ONE), for each file ONE_PLACE_SCAN names. */
  onePlace: Record<string, ScreenFacts>
  /** Each ONE_PLACE_FIXTURES snippet's facts, so the test proves the scan sees what the rules need. */
  onePlaceFixtures: Record<OnePlaceFixture, ScreenFacts>
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

/** The literal text and the identifiers under `node`: template chunks, string literals, JSX text, names. */
function textAndIdentifiers(ts: typeof TS, node: TS.Node): { text: string; identifiers: string[] } {
  const parts: string[] = []
  const identifiers: string[] = []
  const visit = (n: TS.Node): void => {
    if (ts.isJsxText(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text)
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) parts.push(n.text)
    else if (ts.isIdentifier(n)) identifiers.push(n.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return { text: parts.join(''), identifiers }
}

/**
 * The facts T-UI-ONE reads from one screen file: its readable text (JSX text, string literals and
 * template chunks, skipping module specifiers and NON_TEXT_ATTRIBUTES), every placeholder, and
 * every button, link or summary with what it says and the identifiers it shows.
 */
export function screenFacts(ts: typeof TS, fileName: string, code: string): ScreenFacts {
  const file = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const facts: ScreenFacts = { texts: [], placeholders: [], actions: [] }
  const visit = (node: TS.Node): void => {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(file)
      if (NON_TEXT_ATTRIBUTES.has(name)) return
      if (name === 'placeholder' && node.initializer !== undefined)
        facts.placeholders.push(textAndIdentifiers(ts, node.initializer))
    }
    if (ts.isJsxElement(node) && ACTION_TAGS.has(node.openingElement.tagName.getText(file))) {
      const parts = node.children.map((child) => textAndIdentifiers(ts, child))
      facts.actions.push({
        text: parts.map((p) => p.text).join(''),
        identifiers: parts.flatMap((p) => p.identifiers),
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

/**
 * Runs in Node (vitest.config.ts): the Overview's screen text, each fixture's, each vocabulary
 * file's (`vocabularyCode`: repo-relative path → source, read by the config from VOCABULARY_SCAN)
 * and each screen file's facts (`onePlaceCode`, read from ONE_PLACE_SCAN the same way).
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
  const onePlace = Object.fromEntries(
    Object.entries(onePlaceCode).map(([path, code]) => [path, screenFacts(ts, path, code)]),
  )
  const onePlaceFixtures = Object.fromEntries(
    Object.entries(ONE_PLACE_FIXTURES).map(([key, code]) => [key, screenFacts(ts, `${key}.tsx`, code)]),
  ) as Record<OnePlaceFixture, ScreenFacts>
  return {
    overview: screenTexts(ts, 'OverviewPage.tsx', overviewCode),
    fixtures,
    vocabulary,
    onePlace,
    onePlaceFixtures,
  }
}
