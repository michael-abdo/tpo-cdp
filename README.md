# TPO Mini CDP

A mini customer data platform built for The Pour Over's Full-Stack Developer assessment: three subscriber data sources in one place, a live webhook for app events, segments, and an AI assistant that never sees an email.

Sections are filled in as each area lands; the commit history shows when.

## Run locally

```bash
git clone https://github.com/michael-abdo/tpo-cdp && cd tpo-cdp
npm install --legacy-peer-deps      # npm 10's resolver trips on the vitest 5 peer set; see docs/ai-log.md 2026-10-12
cp .dev.vars.example .dev.vars      # fill the five secrets (any strings locally; ANTHROPIC_API_KEY optional)
npm run dev                         # http://localhost:5173
npm test
```

## Deploy

_Lands with the first deploy (Tue)._

## Architecture

One Cloudflare Worker serves a React/Vite SPA from static assets and a Hono API, with Cloudflare D1 (SQLite) as the only data store. The three CSVs are converted by `scripts/csv2sql` into literal-value seed SQL that `wrangler d1 execute` loads after the schema migrations, normalizing emails once at ingest and writing merge/quarantine counts to `import_runs`. Live app events arrive at `POST /webhooks/app`, are verified by HMAC, inserted idempotently by `event_id`, and resolved to profiles at read time, so lookup and segments see them immediately. The AI assistant is a gated tool loop: Claude only ever receives PII-free views and tool results, subjects are referenced by pseudonymous keys, and emails are re-attached server-side after the model answers. Every model request is scanned before it leaves and written to `ai_audit`, which the UI shows.

## Data

The three CSVs in `data/` are the synthetic files provided with the brief ("No real subscriber data"); they are committed so the seed is reproducible.

## Data rules and known edge cases

_Lands with ingest (Mon)._

## Definitions

_Lands with `shared/derive.ts` (Mon)._

## Webhook

_Lands with `POST /webhooks/app` (Wed)._

## PII design

_Lands with the assistant (Thu)._

## Assumptions

_Filled from the decision log as areas land._

## Tests

`npm test` runs every test in `test/` inside workerd against a local D1 with the real migrations applied.

## Known gaps

_Written at freeze (Sun)._

## Known security gaps

_Written at freeze (Sun)._

## Next

_Written at freeze (Sun)._
