import { readFile } from 'node:fs/promises'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { screenTextBinding } from './test/helpers/screen-text.ts'

// Tests run inside workerd against an isolated local D1 per test file, with the real
// migrations applied in test/setup.ts (08). No mocks of our own code.
// SCREEN_TEXTS: the Overview's screen text read from the TypeScript AST here in Node, because the
// compiler cannot load inside workerd (test/helpers/screen-text.ts; 08 T-SRC-2).
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')
  const screenTexts = await screenTextBinding(await readFile('./src/pages/OverviewPage.tsx', 'utf8'))
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
