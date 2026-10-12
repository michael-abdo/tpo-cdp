import type { D1Migration } from '@cloudflare/vitest-plugin'

// The generated worker-configuration.d.ts declares the bindings as `Cloudflare.Env`;
// tests additionally receive the migrations injected by vitest.config.ts.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}

export {}
