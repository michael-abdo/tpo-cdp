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
  interpolated_file_count: '<p>Read {n(sources.length)} files from the Newsletter list</p>',
  interpolated_unit: '<span>{x} subscribers</span>',
  unit_after_element: '<p><b>{n}</b> page views</p>',
  template_file_count: 'const line = `${n} files loaded`',
  ternary_file_word: "const word = count === 1 ? 'file' : 'files'",
  attribute_name: '<ul aria-label="Website visits: syncs" />',
  comment_only: '// The Newsletter list loads 3 files.\nconst x = <p>{n} rows</p>',
} as const

export type ScanFixture = keyof typeof SCAN_FIXTURES

export interface ScreenTexts {
  overview: string[]
  fixtures: Record<ScanFixture, string[]>
}

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

/** Runs in Node (vitest.config.ts): the Overview's screen text plus each fixture's. */
export async function screenTextBinding(overviewCode: string): Promise<ScreenTexts> {
  const ts = (await import('typescript')).default
  const fixtures = Object.fromEntries(
    Object.entries(SCAN_FIXTURES).map(([key, code]) => [key, screenTexts(ts, `${key}.tsx`, code)]),
  ) as Record<ScanFixture, string[]>
  return { overview: screenTexts(ts, 'OverviewPage.tsx', overviewCode), fixtures }
}
