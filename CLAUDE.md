# TPO Mini CDP — Development Rules

Hiring assessment for The Pour Over. **Source of truth: the assessment brief.** The design notes and the decision log are kept outside this repo; commit messages and the historical entries in docs/ai-log.md cite them by number. Their final versions became README.md (how to run it) and docs/notes.md (everything else).

This file holds HOW we work. WHAT we build lives in the design notes, one home per fact; each rule below points to its home in this repo. Read the owning note before touching an area. Never restate a spec here; point to it.

## Stack
Cloudflare Workers with static assets + D1 + Hono + React/Vite; Claude only (confirmed); the reasons are in docs/notes.md "Assumptions". The assistant gateway's shape (three gates, tools as rows, a capped tool loop, an audit table) comes from an AI gateway built before this project, rebuilt by hand for Workers and hardened. Module layout: docs/notes.md "Architecture".

## Non-negotiables (rule → home; each has a test)
- NO MOCK OR DUMMY DATA: only `data/*.csv` and real webhook events; constructed webhook payloads only in the brief's sample shape (there is no app-events CSV), and error-path test inputs only as minimal edits of real rows (never an invented email, name, source, status or date).
- TODAY and the wall-clock allow-list: `shared/config.ts`.
- One normalization implementation: `shared/normalize.ts`; every place that folds an email or a source imports it (T-NORM-3).
- Never drop a row: quarantine it (docs/notes.md "Data rules"); import is the seed step (`npm run db:seed:local`, `db:seed:remote`), not a UI upload.
- Definitions are written once and rendered everywhere: `DEFINITIONS` in `shared/derive.ts`.
- Unsubscribed default and export rule: docs/notes.md "Assumptions".
- Webhook auth is header-only over raw bytes; idempotency, ordering, stitching, stub profiles: docs/notes.md "Webhook" and "Data rules" (Linking).
- Events for demos are sent with `scripts/send-webhook.ts` through the real endpoint, or through the "Send a test event" panel on /events, which does the same: no second copy of verify or ingest.
- The model never sees an email, stored or not, in standard form or in a listed disguise (any `%XX` escape, any dash, `_`, `·`, `‧` or `。` in place of a stored address's dots, or its name part letter for letter, run together or as words with spaces between them ("joy hall 830"), `&#64;`, `&#x40;`, a full-width or small at sign, `[at]`/`(at)`/`{at}`/`<at>`, `[dot]`/`(dot)`/`{dot}`, or spelled out), a known subscriber's email local part typed on its own (disguised or not), a known subscriber's name (first + last, as found in their email: "Julia Evans"), or a raw id (`u-…`, `xu_…` included): every request and result is scanned (one normalizer). It does see a single first name or a name of someone not in the data, and per-person rows under the pseudonymous `pkey` (docs/notes.md "PII design", which this line matches). The only request builder is pure; the scanner blocks, never degrades; audit is awaited.
- Tools are data: every tool is an `assistant_tools` row; the loader validates every enabled row at load and fails loud. Never register a tool only in code.
- What is and isn't cached: per isolate, only the view schema (`worker/assistant/schema-context.ts`, changes only with a deploy) and the validated tool set (`worker/assistant/tools/tool-loader.ts`, keyed by the rows' exact contents); nothing about subscribers, so new events and tool rows show with no restart.
- Auth scope and open paths: `worker/auth/middleware.ts` (`OPEN_API_POSTS`; `/health` and `/webhooks/app` sit outside `/api/*`). SQL: bound params everywhere except Gate 3. Secrets never in code, logs, errors or audit.

## Fail fast, fail loud, fail safely
- **Fast:** `assertBindings(env)` on the first request names any missing secret (list: docs/notes.md "Deploy"); `ANTHROPIC_API_KEY` is probed on the first assistant call. The seed validates CSV headers before writing.
- **Loud:** every webhook rejection, gate block, model failure and audit-write failure is logged with its reason. No empty `catch {}`. No silent retries.
- **Safe:** remote seed/reset safeguards: `scripts/db-remote.ts` (type the database name first; seed refuses a database that already holds rows). Seed write limits: `worker/ingest/sql.ts`; runtime write limits: the webhook caps (docs/notes.md "Webhook"). Never drop tables outside a migration. No destructive actions in the hosted UI.

## How to work
- Log every AI mistake as it happens in `docs/ai-log.md` (date, ask, what was wrong, how caught, fix).
- Small, honest commits, one concern each, never squashed.
- No TODOs, stubs or mocks in product code; every fixed value (TODAY, limits, weights, bands) is one named constant in its one home, never a bare literal; unfinished → docs/notes.md "Known gaps".
- `npm test` and `npm run typecheck` before every commit (scripts: `package.json`). Reuse before creating; port the earlier gateway's modules by hand, never fork.
- The repo contains exactly four `.md` files: this one, `README.md` (how to run it), `docs/notes.md` (design, data rules, webhook, PII, tests, known gaps, how it was built), `docs/ai-log.md`. This file is committed as process evidence; the self-audit runs on the repo exactly as submitted.
- Build only what the plan's MVP scope lists; work in its day-by-day order; build parked items only if time remains.
