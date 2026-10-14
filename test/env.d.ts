import type { D1Migration } from '@cloudflare/vitest-plugin'
import type { ScreenTexts } from './helpers/screen-text'

// The generated worker-configuration.d.ts declares the bindings as `Cloudflare.Env`;
// tests additionally receive the migrations and the Overview's screen text injected by vitest.config.ts.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[]
      SCREEN_TEXTS: ScreenTexts
    }
  }
}

export {}
