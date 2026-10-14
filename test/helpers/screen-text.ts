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
 * sentences, the system prompt, and the Growth panels' "Explain this" questions).
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
  ],
} as const

export interface ScreenTexts {
  overview: string[]
  fixtures: Record<ScanFixture, string[]>
  /** Repo-relative path → that file's screen text, for each file VOCABULARY_SCAN names. */
  vocabulary: Record<string, string[]>
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

/**
 * Runs in Node (vitest.config.ts): the Overview's screen text, each fixture's, and each vocabulary
 * file's (`vocabularyCode`: repo-relative path → source, read by the config from VOCABULARY_SCAN).
 */
export async function screenTextBinding(
  overviewCode: string,
  vocabularyCode: Record<string, string>,
): Promise<ScreenTexts> {
  const ts = (await import('typescript')).default
  const fixtures = Object.fromEntries(
    Object.entries(SCAN_FIXTURES).map(([key, code]) => [key, screenTexts(ts, `${key}.tsx`, code)]),
  ) as Record<ScanFixture, string[]>
  const vocabulary = Object.fromEntries(
    Object.entries(vocabularyCode).map(([path, code]) => [path, screenTexts(ts, path, code)]),
  )
  return { overview: screenTexts(ts, 'OverviewPage.tsx', overviewCode), fixtures, vocabulary }
}
