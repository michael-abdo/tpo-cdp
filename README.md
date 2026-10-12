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

Every derived value has exactly one home, `shared/derive.ts` (`DEFINITIONS`): the function, a plain-English doc string, the formula and, where a segment filter compares a stored column, the SQL fragment. Values are computed at write time and stored; SQL only compares stored columns against `TODAY = 2026-09-28`. This table is copied from those doc strings.

| Name                  | Meaning                                                                                                                                                                                                                                      | Formula                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `days_since_open`     | Whole days between the last email open and today; a date after today counts as 0 and a subscriber who never opened has no value.                                                                                                             | `max(0, TODAY − last_open_date); null if never opened`                                                                             |
| `cold_since`          | The day a subscriber becomes cold: 30 days after their last open, or 30 days after signup if they never opened.                                                                                                                              | `(last_open_date ?? signup_date) + 30 days`                                                                                        |
| `cold`                | True when the cold date has arrived: no open in 30 or more days, or never opened and signed up 30 or more days ago.                                                                                                                          | `cold_since <= TODAY`                                                                                                              |
| `went_cold_in(month)` | True when the cold date falls inside the given calendar month and is not in the future.                                                                                                                                                      | `cold_since within that calendar month and <= TODAY`                                                                               |
| no open in N days     | The brief's segment filter: at least N days since the last open, with a toggle that also includes everyone who never opened, whatever their signup date.                                                                                     | `days_since_open >= N, plus never-openers when includeNeverOpened`                                                                 |
| `new_subscriber`      | Signed up within the last 30 days including today.                                                                                                                                                                                           | `signup_date within TODAY − 30 .. TODAY`                                                                                           |
| `going_cold_risk`     | Opened an email in the last 30 days but not in the last 14, or will become cold within the next 7 days.                                                                                                                                      | `opened in the last 30 days but not in the last 14, or cold_since within the next 7 days`                                          |
| `engagement_score`    | A 0–100 score: up to 50 points for how recently the last email was opened (full at today, none at 30+ days or never), up to 25 for app events in the last 30 days (full at 10) and up to 25 for site visits in the last 30 days (full at 5). | `recency 50 × max(0, 1 − days_since_open/30) + app 25 × min(1, app_events_last_30d/10) + site 25 × min(1, site_visits_last_30d/5)` |
| `has_app`             | An app account exists with the same email as the subscriber.                                                                                                                                                                                 | `app account exists`                                                                                                               |
| `app_after_signup`    | The app account was created on a later day than the newsletter signup, so the newsletter came first.                                                                                                                                         | `app_created_at > signup_date`                                                                                                     |
| last month            | The previous calendar month relative to today, 2026-08-01 to 2026-08-31.                                                                                                                                                                     | `previous calendar month relative to TODAY = 2026-08-01..31`                                                                       |
| last N days           | The N days up to and including today.                                                                                                                                                                                                        | `TODAY − N .. TODAY`                                                                                                               |

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
