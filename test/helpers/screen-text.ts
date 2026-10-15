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
 * under `src/` (the Segments page included since the D-69 merge), the glossary, the source registry, the metric definitions (shared/derive.ts DEFINITIONS:
 * the system prompt renders its Definitions section from them at runtime, and the UI footers and
 * Look up show them) and the server-written sentences (dedupe suggestions, assistant fallback
 * sentences, the system prompt, the Insights board's and pin dialog's sentences, and the built-in
 * Insights tiles' "Explain this" questions).
 */
export const VOCABULARY_SCAN = {
  dirs: ['src'],
  skip: [] as string[],
  files: [
    'shared/glossary.ts',
    'shared/sources.ts',
    'shared/derive.ts',
    'shared/features.ts',
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
    'src/labels.ts',
    'src/events-poll.ts',
    'src/filters-applied.ts',
    'shared/glossary.ts',
    'shared/insight-messages.ts',
    'shared/features.ts',
    'worker/dedupe/score.ts',
  ],
} as const

/**
 * The ONE_PLACE_SCAN files a page's own text is unioned with when it imports them (T-UI-ONE "per
 * screen"): shared UI components and sentence constants, whose literal text a page could retype.
 * GLOSSARY/DEFINITIONS (shared/glossary.ts) and the other data modules are left out on purpose:
 * their own source holds each entry's text once no matter how many pages read it, so merging them
 * in would over-count a page that reads one entry exactly once; `screenFacts`'s `resolve` already
 * credits that page with it, precisely once per property access (09 D-72).
 * `src/events-poll.ts`/`filters-applied.ts` are the opposite case (09
 * D-72): a page reads their sentences (`FILTERS_HIDDEN_MESSAGE`, the text `eventsAnnouncement`
 * builds inline) through a return value, never a `MODULE.CONST` property access `resolve` could
 * credit, so without merging them in, a page could retype one of their sentences with nothing to
 * catch it.
 * `src/labels.ts` is scanned (ONE_PLACE_SCAN.files) but left out of the merge, like GLOSSARY and
 * DEFINITIONS: its whole purpose is one word per field, read the same way by every screen that
 * shows that field ("/segments and /insights read the same maps", its own header comment), so
 * /segments showing the same heading /insights' DEFINITION_LABEL already names is by design, not a
 * second home for it.
 */
const MERGEABLE_SCREEN_FILES = new Set([
  'src/App.tsx',
  'src/components.tsx',
  'src/needs-review.ts',
  'src/block-reason.ts',
  'src/events-poll.ts',
  'src/filters-applied.ts',
])

export interface ScreenTexts {
  overview: string[]
  fixtures: Record<ScanFixture, string[]>
  /** Repo-relative path → that file's screen text, for each file VOCABULARY_SCAN names. */
  vocabulary: Record<string, string[]>
  /** Repo-relative path → that screen's facts (T-UI-ONE), for each file ONE_PLACE_SCAN names. */
  onePlace: Record<string, ScreenFacts>
  /** Each ONE_PLACE_FIXTURES snippet's facts, so the test proves the scan sees what the rules need. */
  onePlaceFixtures: Record<OnePlaceFixture, ScreenFacts>
  /** The merged facts of a synthetic page importing a synthetic shared component: proves
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
  /** Every other element's direct children, joined into one run, with the identifiers any
   * non-literal child reads: catches a plain hint (not a button, link or summary) that repeats a
   * placeholder's example, by identifier or by value (09 D-72). */
  elements: { text: string; identifiers: string[] }[]
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
  // A page literal equal to a glossary entry's text it already shows by property access.
  flag_glossary_literal_match:
    '<div><p>{GLOSSARY.possible_duplicates.text}</p><p>Two subscribers with different emails whose names match, for a person to judge.</p></div>',
  // A footer row rendering a DEFINITIONS doc next to a hint holding the same sentence.
  flag_definitions_doc_matches_hint:
    "<div><p>{DEFINITIONS.no_open_in_days.doc}</p><p>The brief's segment filter: at least N days since the last open, with a toggle that also includes everyone who never opened, whatever their signup date.</p></div>",
  // The old Segments footer shape: a file-level array of DEFINITIONS entries, read through a
  // destructured `.map`, so `def.doc` never appears as a direct `DEFINITIONS.key.doc` access.
  flag_footer_definitions_map:
    "const FOOTER_DEFINITIONS = [{ label: \"Haven't opened in N days\", def: DEFINITIONS.no_open_in_days }]\n" +
    'const x = <>{FOOTER_DEFINITIONS.map(({ label, def }) => (<p key={def.name}>{def.doc}</p>))}</>\n' +
    "const y = <p>The brief's segment filter: at least N days since the last open, with a toggle that also includes everyone who never opened, whatever their signup date.</p>",
  // An InfoTip's `term` names a glossary entry whose text a visible line already spells out.
  flag_infotip_term_matches_text:
    '<div><InfoTip term="ok" /><p>The last sync went through and nothing from this source needs a person.</p></div>',
  flag_sentence_twice:
    '<div><p>Type part of the email to see matches.</p><p className="mt-2">Type part of the email to see matches.</p></div>',
  flag_sentence_in_literal_and_jsx:
    "const HINT = 'Type part of the email to see matches.'\nconst x = <p>{HINT}</p>\nconst y = <p>Type part of the email to see matches.</p>",
  // One sentence split across JsxText and a `{' '}` the way Prettier wraps a long line, repeated
  // verbatim, unwrapped, elsewhere on the same screen.
  flag_sentence_wrapped_and_plain:
    "<div><p>Events show here as soon as the{' '}\n      app sends them.</p><p>Events show here as soon as the app sends them.</p></div>",
  // "Try an example" through a named handler, one hop from its definition to EXAMPLE.
  flag_example_named_handler:
    "const tryExample = () => go(EXAMPLE)\nconst x = <input placeholder={`e.g. ${EXAMPLE}`} />\nconst y = <Button onClick={tryExample}>Try an example</Button>",
  // "Try an example" through a link's `to`, never a handler or a child.
  flag_example_link_to:
    'const x = <input placeholder={`e.g. ${EXAMPLE}`} />\nconst y = <Link to={`/lookup?q=${EXAMPLE}`}>See an example profile</Link>',
  // A hint beside the placeholder shows the example value again, through neither an action nor the
  // placeholder itself.
  flag_example_shown_in_hint:
    '<form><input placeholder={`e.g. ${EXAMPLE}`} /><p>For example: {EXAMPLE}</p></form>',
  pass_classes_twice:
    "const link = 'inline-flex min-h-6 items-center gap-1 rounded-md text-sm'\nconst x = <a className=\"inline-flex min-h-6 items-center gap-1 rounded-md text-sm\">Back</a>",
  pass_short_twice: '<div><p>Try again.</p><p>Try again.</p></div>',
  pass_hoisted:
    "const RETRY = 'Refresh the page to try again.'\nconst x = <ErrorLine next={RETRY} />\nconst y = <ErrorLine next={RETRY} />",
  pass_hint_placeholder: '<form><input placeholder="Search" /><button type="submit">Search</button></form>',
  // An icon beside a sentence is not a second text-bearing child: no new duplicate (regression
  // guard for the wrapped-sentence join, which must not double-count a plain single-sentence paragraph).
  pass_icon_beside_sentence: '<p>Full sentence here with five or more plain words.<Icon /></p>',
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
 * on screen, not just the words around the substitution (09 D-72).
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

/**
 * One JSX element's direct children, joined into a single text run the way the browser would
 * render them: `JsxText` verbatim, a literal (`{' '}`, a template with no substitution) verbatim,
 * and any other child (a dynamic expression, a nested element) as one fixed token plus the
 * identifiers it reads, so a sentence Prettier wrapped across `{' '}` reads as the same run as its
 * unwrapped copy, without merging text across an unrelated child (09 D-72). Whitespace
 * (including a source line break around that `{' '}`, which is JSX formatting, not a paragraph
 * break) is collapsed to a single space before the run is compared, so the wrapped copy normalizes
 * exactly like its unwrapped twin. A dynamic child's identifier is tracked, never resolved to its
 * file-level value here: `{NO_MATCH}` reading as literal words would double-count every constant
 * used once as children text against the one occurrence its own `const` declaration already holds
 * (09 D-72, the same "one constant, however many times it's read" rule `pass_hoisted` states); the
 * one case that needs the value — a hint repeating a placeholder's own example — the identifier
 * match already covers (`exampleShownTwice` in test/one-place.test.ts).
 */
function joinedElementChildren(ts: typeof TS, children: readonly TS.JsxChild[]): { text: string; identifiers: string[] } {
  const OPAQUE = ' \u0000 '
  const parts: string[] = []
  const identifiers: string[] = []
  for (const child of children) {
    if (ts.isJsxText(child)) {
      parts.push(child.text)
    } else if (ts.isJsxExpression(child) && child.expression !== undefined) {
      const expr = child.expression
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        parts.push(expr.text)
      } else {
        parts.push(OPAQUE)
        // Stops at a nested element/fragment (identifiersInExpr): that child is its own screen
        // text, visited and resolved on its own; its attributes are not this run's words (found
        // via a conditional `next={cond ? KEEPS_TRYING : …}` prop on a sibling self-closing
        // element, whose own identifiers must not double-resolve into this one).
        identifiers.push(...identifiersInExpr(ts, expr))
      }
    } else {
      parts.push(OPAQUE)
    }
  }
  return { text: parts.join('').replace(/[ \t\r\n]+/g, ' '), identifiers: [...new Set(identifiers)] }
}

/** Every Identifier's name under `node`, stopping at a nested JSX element, self-closing element or
 * fragment (its own screen text, read separately): used only to keep `joinedElementChildren`'s
 * identifier read scoped to the run it is actually joining (09 D-72). */
function identifiersInExpr(ts: typeof TS, node: TS.Node): string[] {
  const out: string[] = []
  const visit = (n: TS.Node): void => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) return
    if (ts.isIdentifier(n)) out.push(n.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
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

/** Attributes that carry a destination, read the same way a handler is (09 D-72): a `<Link
 * to={...}>` or `<a href={...}>` can show the same example a handler would go to. */
const LINK_ATTRIBUTES = new Set(['to', 'href'])

/**
 * File-level `const NAME = (...) => body` / `function NAME(...) { body }` → every identifier in
 * `body`. Resolves a handler identifier one hop (09 D-72): `onClick={tryExample}` where
 * `const tryExample = () => go(EXAMPLE)` reads as `['go', 'EXAMPLE']`, the same as writing the
 * arrow inline. Only one hop: a name `body` itself calls is not chased into its own definition.
 */
function fileFunctionIdentifiers(ts: typeof TS, file: TS.SourceFile): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const stmt of file.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined && stmt.body !== undefined) {
      out[stmt.name.text] = identifiersIn(ts, stmt.body)
      continue
    }
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue
      const init = decl.initializer
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) out[decl.name.text] = identifiersIn(ts, init.body)
    }
  }
  return out
}

/** `{root, key}` for a bare `ROOT.KEY` property access whose `ROOT` is one `resolveRoots` names. */
interface ArrayEntryRef {
  root: string
  key: string
}

/** One array element: '' → the element itself is a bare `ROOT.KEY`; a property name → that
 * property's `ROOT.KEY` initializer, for an object-literal element such as `{ label, def }`. */
type ArrayElementRefs = Record<string, ArrayEntryRef>

/**
 * File-level `const NAME = [ ROOT.KEY, ... ]` or `const NAME = [ { prop: ROOT.KEY, ... }, ... ]`,
 * for `ROOT` in `resolveRoots` (GLOSSARY/DEFINITIONS): resolves the old Segments footer shape,
 * `FOOTER_DEFINITIONS = [{ label: '…', def: DEFINITIONS.x }, …]`, read through `.map` (09 D-72).
 */
function fileArrayConsts(ts: typeof TS, file: TS.SourceFile, resolveRoots: ReadonlySet<string>): Record<string, ArrayElementRefs[]> {
  const asRef = (e: TS.Expression): ArrayEntryRef | null =>
    ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && resolveRoots.has(e.expression.text)
      ? { root: e.expression.text, key: e.name.text }
      : null
  const out: Record<string, ArrayElementRefs[]> = {}
  for (const stmt of file.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined || !ts.isArrayLiteralExpression(decl.initializer)) continue
      const elements: ArrayElementRefs[] = []
      for (const el of decl.initializer.elements) {
        const bare = asRef(el)
        if (bare !== null) {
          elements.push({ '': bare })
          continue
        }
        if (!ts.isObjectLiteralExpression(el)) continue
        const refs: ArrayElementRefs = {}
        for (const p of el.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue
          const ref = asRef(p.initializer)
          if (ref !== null) refs[p.name.text] = ref
        }
        elements.push(refs)
      }
      if (elements.length > 0) out[decl.name.text] = elements
    }
  }
  return out
}

/** Every `localName.prop` property access under `node` read as text, `prop`s in source order,
 * duplicates removed. Skips a property read inside a structural attribute (`key`, `id`, …,
 * NON_TEXT_ATTRIBUTES): `key={def.name}` names a React key, not a line this screen shows, so it
 * must not credit `def.name`'s text just because a sibling `.map` call also reads `def.name` to
 * render it (found reviewing the restored Segments footer, which keys both its disclosure and its
 * Technical details `.map` off `def.name`). */
function propsReadFrom(ts: typeof TS, file: TS.SourceFile, node: TS.Node, localName: string): string[] {
  const out: string[] = []
  const visit = (n: TS.Node): void => {
    if (ts.isJsxAttribute(n) && NON_TEXT_ATTRIBUTES.has(n.name.getText(file))) return
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === localName) out.push(n.name.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return [...new Set(out)]
}

/**
 * File-level `const NAME = '<literal>'` (or a no-substitution template) and aliases of one
 * (`const OTHER = NAME`), resolved through a short chain of aliases. Only top-level declarations
 * count as "file-level" (09 D-72): `screenFacts` uses this so a placeholder's or an
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
 * `GLOSSARY.key.prop` / `DEFINITIONS.key.prop` property access to the same text (09 D-72).
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

/** Tags whose `term` attribute names a glossary/DEFINITIONS key the component explains itself
 * (`InfoTip`, and the local components that wrap one: `Chip`, `Metric`) (09 D-72). */
const TIP_TAGS = new Set(['InfoTip', 'Chip', 'Metric'])

/**
 * The facts T-UI-ONE reads from one screen file: its readable text (JSX text, string literals and
 * template chunks, skipping module specifiers and NON_TEXT_ATTRIBUTES, plus the text of any
 * `GLOSSARY.key.prop` / `DEFINITIONS.key.prop` property access, any `term="key"` on an InfoTip/Chip/
 * Metric, and any DEFINITIONS/GLOSSARY entry reached through a file-level array read by `.map`
 * `resolve` can read), every placeholder, every button, link or summary with what it says and the
 * identifiers its children AND its handler, `to` or `href` attributes show (one hop through a named
 * handler's own body) (09 D-72), and every other element's children, joined into
 * one run.
 */
export function screenFacts(ts: typeof TS, fileName: string, code: string, resolve: ConstObjectTexts = {}): ScreenFacts {
  const file = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const consts = fileConsts(ts, file)
  const functionIdentifiers = fileFunctionIdentifiers(ts, file)
  const arrayConsts = fileArrayConsts(ts, file, new Set(Object.keys(resolve)))
  const facts: ScreenFacts = { texts: [], placeholders: [], actions: [], elements: [] }
  const visit = (node: TS.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
      const root = node.expression.expression.text
      const key = node.expression.name.text
      const prop = node.name.text
      const text = resolve[root]?.[key]?.[prop]
      if (text !== undefined) facts.texts.push(text)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'map' &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const elements = arrayConsts[node.expression.expression.text]
      const callback = node.arguments[0]
      if (elements !== undefined && callback !== undefined && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const param = callback.parameters[0]?.name
        const resolveProps = (elementProp: string, localName: string) => {
          for (const prop of propsReadFrom(ts, file, callback.body, localName))
            for (const el of elements) {
              const ref = el[elementProp]
              const text = ref === undefined ? undefined : resolve[ref.root]?.[ref.key]?.[prop]
              if (text !== undefined) facts.texts.push(text)
            }
        }
        if (param !== undefined && ts.isIdentifier(param)) resolveProps('', param.text)
        else if (param !== undefined && ts.isObjectBindingPattern(param))
          for (const be of param.elements)
            if (ts.isBindingElement(be) && ts.isIdentifier(be.name))
              resolveProps(be.propertyName !== undefined && ts.isIdentifier(be.propertyName) ? be.propertyName.text : be.name.text, be.name.text)
      }
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(file)
      const owner = node.parent.parent
      const ownerTag = ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner) ? owner.tagName.getText(file) : null
      if (name === 'term' && ownerTag !== null && TIP_TAGS.has(ownerTag) && node.initializer !== undefined && ts.isStringLiteral(node.initializer)) {
        const key = node.initializer.text
        const text = resolve.GLOSSARY?.[key]?.text ?? resolve.DEFINITIONS?.[key]?.doc
        if (text !== undefined) facts.texts.push(text)
      }
      if (NON_TEXT_ATTRIBUTES.has(name)) return
      if (name === 'placeholder' && node.initializer !== undefined)
        facts.placeholders.push(textAndIdentifiers(ts, node.initializer, consts))
    }
    const tag = ts.isJsxElement(node) ? node.openingElement.tagName.getText(file) : null
    if (tag !== null && ACTION_TAGS.has(tag) && ts.isJsxElement(node)) {
      const parts = node.children.map((child) => textAndIdentifiers(ts, child, consts))
      const attrIdentifiers = node.openingElement.attributes.properties.flatMap((attr) => {
        if (!ts.isJsxAttribute(attr) || attr.initializer === undefined) return []
        const name = attr.name.getText(file)
        if (!HANDLER_ATTRIBUTE.test(name) && !LINK_ATTRIBUTES.has(name)) return []
        const direct = identifiersIn(ts, attr.initializer)
        return [...direct, ...direct.flatMap((id) => functionIdentifiers[id] ?? [])]
      })
      facts.actions.push({
        text: parts.map((p) => p.text).join(''),
        identifiers: [...new Set([...parts.flatMap((p) => p.identifiers), ...attrIdentifiers])],
      })
      // A button or link's own JsxText is still screen text (09 D-72): only its direct JsxText
      // children, the same text the generic walk used to read before an action's children were
      // tracked separately — never a literal nested inside an expression (e.g. a `??` fallback),
      // which the generic StringLiteral read below already counts once on its own.
      for (const child of node.children) if (ts.isJsxText(child) && child.text.trim() !== '') facts.texts.push(child.text)
    } else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      // The element's own children, joined into one run (09 D-72): this is the only place a
      // JsxText child's words are read, so a sentence Prettier wraps across a `{' '}` is compared
      // as one run, never as fragments that happen to dodge the duplicate check.
      const joined = joinedElementChildren(ts, node.children)
      if (joined.text.trim() !== '' || joined.identifiers.length > 0) facts.elements.push({ text: joined.text, identifiers: joined.identifiers })
      if (joined.text.trim() !== '') facts.texts.push(joined.text)
    }
    if (ts.isStringLiteral(node)) {
      const parent = node.parent
      const specifier =
        (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node
      const jsxChild = ts.isJsxExpression(parent) && (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))
      if (!specifier && !jsxChild) facts.texts.push(node.text)
    } else if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const parent = node.parent
      const jsxChild =
        ts.isJsxExpression(parent) && (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))
      if (!jsxChild) facts.texts.push(node.text)
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
 * is also that page's sentence if the page repeats it (09 D-72, T-UI-ONE "per screen").
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
 * T-UI-ONE compares what one screen shows, not one file's text in isolation (09 D-72): a strictly
 * per-file scan would pass a sentence in `src/components.tsx` repeated on a page.
 * `mergeableFiles` excludes GLOSSARY/DEFINITIONS and other data-only modules: their own
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
 * `mergedOnePlaceFacts` catches a sentence the component already shows, repeated on the page:
 * the fixture mechanism above runs one file at a time, so this is exercised separately.
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
