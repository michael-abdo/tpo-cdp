import { readdir, readFile } from 'node:fs/promises'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { ONE_PLACE_SCAN, screenTextBinding, VOCABULARY_SCAN } from './test/helpers/screen-text.ts'

// Tests run inside workerd against an isolated local D1 per test file, with the real
// migrations applied in test/setup.ts. No mocks of our own code.
// SCREEN_TEXTS: the Overview's screen text read from the TypeScript AST here in Node, because the
// compiler cannot load inside workerd (test/helpers/screen-text.ts; T-SRC-2), plus the screen
// text of every file the vocabulary guard reads (VOCABULARY_SCAN; T-VOC-1) and the facts of
// every screen file the one-place guard reads (ONE_PLACE_SCAN; T-UI-ONE).
async function sourceOf(scan: {
  dirs: readonly string[]
  files: readonly string[]
  skip?: readonly string[]
}): Promise<Record<string, string>> {
  const paths: string[] = [...scan.files]
  for (const dir of scan.dirs)
    for (const entry of await readdir(dir, { recursive: true }))
      if (/\.tsx?$/.test(entry)) paths.push(`${dir}/${entry}`)
  const scanned = paths.filter((p) => !(scan.skip ?? []).includes(p)).sort()
  return Object.fromEntries(await Promise.all(scanned.map(async (p) => [p, await readFile(p, 'utf8')])))
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')
  const screenTexts = await screenTextBinding(
    await readFile('./src/pages/OverviewPage.tsx', 'utf8'),
    await sourceOf(VOCABULARY_SCAN),
    await sourceOf(ONE_PLACE_SCAN),
  )
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, SCREEN_TEXTS: screenTexts } },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
    },
  }
})
