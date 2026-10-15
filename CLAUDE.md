# TPO Mini CDP — Development Rules

Hiring assessment for The Pour Over. **Source of truth: `../TPO_Developer_Assessment.pdf`** (requirement IDs: `../design/00`). Deadline and submission: `../design/13`. The design docs in `../design/` are kept outside the repo; their final versions become README or docs/notes.md sections (13; README = run it, docs/notes.md = everything else, 09 D-82).

This file holds HOW we work. WHAT we build lives in `../design/`, one home per fact — the index of homes is `00 §Document index`. Read the owning doc before touching an area. Never restate a spec here; point to it.

## Stack
Decided in 09 D-02..D-06, D-23 (Claude only, confirmed), D-24 (mirror the consulting repo's gateway; deviations listed there). Canonical module layout: 03 §Module layout. Project lives in the `CDP/` folder of the private workspace repo (see `../design/17`).

## Non-negotiables (rule → home; each has a test in 08)
- NO MOCK OR DUMMY DATA: only `data/*.csv` and real webhook events; constructed webhook payloads only as 09 D-11 allows, and error-path test inputs derived from real rows only as 09 D-47 allows (never an invented email, name, source, status or date).
- TODAY and the wall-clock allow-list: 02 §Time.
- One normalization implementation and the list of every location: 02 §Normalization.
- Never drop a row: 02 §Quarantine; import is the seed step in 11 §Seed, not a UI upload.
- Definitions are written once and rendered everywhere: 02 §Derived "One runtime source".
- Unsubscribed default and export rule: 02 §Defaults.
- Webhook auth is header-only over raw bytes; idempotency, ordering, stitching, stub profiles: 04 §Webhook, 01 §Identity resolution, 02 §Linking.
- Events for demos are sent with `scripts/send-webhook.ts` through the real endpoint (11 §Verify), or through the "Send a test event" panel on /events (09 D-73), which does the same: no second copy of verify or ingest (04).
- The model never sees an email, stored or not, in standard form or in a listed disguise (`%40`, `&#64;`, `&#x40;`, a full-width or small at sign, `[at]`/`(at)`/`{at}`/`<at>`, `[dot]`/`(dot)`/`{dot}`, or spelled out), a known subscriber's email local part typed on its own (disguised or not), or a raw id: every request and result is scanned (one normalizer, 09 D-79). It does see a name a teammate types and per-person rows under the pseudonymous `pkey` (docs/notes.md "PII design", which this line matches). The only request builder is pure; the scanner blocks, never degrades; audit is awaited: 05, enforcement layers 03 §Gateway layers.
- Tools are data (09 D-41): every tool is an `assistant_tools` row; the loader validates every enabled row at load and fails loud (03 layer 3). Never register a tool only in code.
- What is and isn't cached: 03 §No-restart guarantee.
- Auth scope and open paths: 04 §Auth. SQL: bound params everywhere except Gate 3 (03 layer 8). Secrets never in code, logs, errors or audit: 04 §Error envelope, 10.

## Fail fast, fail loud, fail safely
- **Fast:** `assertBindings(env)` on the first request names any missing secret (list: 11 §Deploy); `ANTHROPIC_API_KEY` is probed on the first assistant call. The seed validates CSV headers before writing.
- **Loud:** every webhook rejection, gate block, model failure and audit-write failure is logged with its reason (contract: the 03 §Gateway layers table and 04 error tables). No empty `catch {}`. No silent retries.
- **Safe:** remote seed/reset safeguards: 11 §Reset. Seed and runtime write limits: 11 §Seed. Never drop tables outside a migration. No destructive actions in the hosted UI (09 D-13).

## How to work (S5, A8, A9)
- Use Claude Code heavily — they ask for it — but understand every line; the Loom and the audit test comprehension.
- Log every AI mistake as it happens in `docs/ai-log.md` (date, ask, what was wrong, how caught, fix). The Loom cites only real entries.
- Small, honest commits, one concern each, never squashed.
- No TODOs, stubs or mocks in product code; every fixed value (TODAY, limits, weights, bands) is one named constant in its one home, never a bare literal; unfinished → docs/notes.md "Known gaps".
- `npm test` and `npm run typecheck` before every commit (scripts: 11 §Scripts). Reuse before creating; port origin modules by hand (03), never fork.
- The repo contains exactly four `.md` files: this one, `README.md` (how to run it), `docs/notes.md` (design, data rules, webhook, PII, tests, known gaps, how it was built), `docs/ai-log.md` (09 D-29, amended by D-82). This file is committed as process evidence; the self-audit runs on the repo exactly as submitted (09 D-29, 11 §Self-audit step).
- Build only what 16 §MVP scope lists; work in the order of 16 §Day by day; parked items only per 16 §If time remains.
