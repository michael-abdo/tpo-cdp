import { applyD1Migrations, env } from 'cloudflare:test'

// Every test file starts from the real schema (migrations/), never a hand-built one.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
