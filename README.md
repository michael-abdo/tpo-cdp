# TPO Mini CDP

A mini customer data platform built for The Pour Over's Full-Stack Developer assessment: three subscriber data sources in one place, a live webhook for app events, segments, and an AI assistant that never sees an email.

## What it is

One Cloudflare Worker serves a React/Vite SPA from static assets and a Hono API, with Cloudflare D1 (SQLite) as the only data store. The three CSVs are converted by `scripts/csv2sql` into literal-value seed SQL that `wrangler d1 execute` loads after the schema migrations, normalizing emails once at ingest and writing merge/quarantine counts to `import_runs`. Live app events arrive at `POST /webhooks/app`, are verified by HMAC, inserted idempotently by `event_id`, and resolved to profiles at read time, so lookup and segments see them immediately. The AI assistant is a gated tool loop: Claude only ever receives PII-free views and tool results, subjects are referenced by pseudonymous keys, and emails are re-attached server-side after the model answers. Every model request is scanned before it leaves and written to `ai_audit`, which the UI shows.

Code layout: `worker/` (the Hono API: `auth/`, `webhooks/`, `identity/`, `lookup/`, `ingest/`, `segments/`, `insights/`, `routes/`, `assistant/`), `src/` (the React screens), `shared/` (code both sides use: `TODAY`, normalization, definitions, pseudonyms, the PII column list, the D-58 SQL-sign check), `migrations/`, `scripts/`, `test/`, `data/` (the three CSVs, never edited).

## Live app and how to sign in

- App: **https://tpo-cdp.michaelabdo-mail.workers.dev**
- Webhook: `POST https://tpo-cdp.michaelabdo-mail.workers.dev/webhooks/app` (headers and signing examples under [Webhook](#webhook))

Open the app and sign in on its login page with the site password. The password and the webhook signing secret come in the submission email; neither is in this repo. A session lasts 12 hours; "Log out" ends it sooner. More than ten sign-in attempts a minute from one address get a "wait a minute" message.

## Run locally

Needs Node 20 or newer and npm. No Cloudflare account: `wrangler` runs workerd and a local D1 file under `.wrangler/`.

```bash
git clone https://github.com/michael-abdo/tpo-cdp && cd tpo-cdp
npm install --legacy-peer-deps      # the flag installs package-lock.json exactly as committed (why: docs/ai-log.md 2026-10-12)
cp .dev.vars.example .dev.vars      # then give all five names a value: any strings work locally (see below)
npm run db:migrate:local            # the three migrations into the local D1
npm run db:seed:local               # data/*.csv → seed/*.sql → local D1; prints the counts and every quarantined line
npm test                            # 26 files, 519 tests in workerd against a local D1; no network
npm run dev                         # http://localhost:5173; sign in with the SITE_PASSWORD you put in .dev.vars
```

`npm run dev` keeps running; stop it with Ctrl-C. `npm test` does not need the dev server or the seed. A plain `npm install` also works today (checked with npm 10.9 and 11.6), but npm 11 then adds `"peer": true` lines to the lockfile.

About `.dev.vars`:

- `SITE_PASSWORD`, `SESSION_SECRET`, `WEBHOOK_SECRET`, `PII_KEY_SECRET`: any non-empty strings. The first request fails with a message naming any one that is missing.
- `ANTHROPIC_API_KEY`: a real key only if you want the assistant to answer. For `npm test` any non-empty string works; the tests never call the network, but 20 tests in 3 files that go through the assistant route fail when it is empty (see [Known gaps](#known-gaps)).

For the assistant, also write its four tool rows into the local D1 once, after the seed:

```bash
npm run tools:seed -- --local       # segment, aggregate, query_sql, pages_new_subscribers_hit_first
```

What you see without them: with no tool rows `/assistant` answers 500 `no_tools` naming this command; with an empty key, 503 `assistant_unavailable` pointing to the live app; with a key that is not real, 502 `model_error`. The failed call still shows up on the AI audit log page. Everything else works without a key.

Send an app event to the local server (signed with `WEBHOOK_SECRET` from `.dev.vars`, which the script never prints):

```bash
npm run webhook:send -- --event read_story --user u_2b6447a3   # 202, resolves to julia.evans230
npm run webhook:send -- --event read_story --again             # 200 {"accepted":true,"duplicate":true}
```

Then "App events" (`/events`) lists it and "Find a reader" (`/lookup`) shows it in her app timeline, with no restart.

The session cookie is `Secure`. Chrome and Firefox accept it on `http://localhost`; another browser that refuses it there will not stay signed in locally, and the live app is the fallback.

## Ask the brief's three questions

Open "Ask a question" (`/assistant`) on the live app, or locally with a real key and the tool rows. The brief's three questions are buttons under the box; a click asks it at once. Or type any question and press Ask. One question per request: each answer starts fresh.

| Question | What comes back | Check it against |
|---|---|---|
| how many Instagram signups went cold last month? | an answer: active Instagram subscribers whose `cold_since` falls in 2026-08-01..31, from the `aggregate` tool | 46 (66 if you ask to include unsubscribed) |
| build me a list of our most engaged readers | a segment: active readers in stored `engagement_score` order, highest first, with "Open in builder" and "Export CSV" | its count equals the same filters in "Build a list" |
| which pages do new subscribers hit first? | a table: for subscribers who signed up 2026-08-29..2026-09-28, the first page of their first site visit, counted by page, from the `pages_new_subscribers_hit_first` tool row | a blank first page counts new subscribers with no tracked visit |

Under "How this answer was worked out", each answer lists the time period, filters and definitions it used, when it used any. "See exactly what the AI saw for this answer" opens the trace on "AI audit log" (`/audit`): every model request and tool call as stored. Search it for `@` and it finds nothing. On "Growth", every number has an "Explain this" link that fills in a question here and waits for Ask.

## How each requirement is met

Screens are the menu names, with paths. Test IDs are in the `describe` names under `test/`.

| Brief | Where to see it | How | Tests |
|---|---|---|---|
| R1 Pulls it together: load the three files, link visits and app accounts by email, dedupe | Overview (`/`): the four headline numbers and "How the data was combined" (rows in, kept, merged, set aside, and why) | `scripts/csv2sql.ts` builds the seed with `worker/ingest/` and `shared/normalize.ts`; rules under [Data rules](#data-rules-and-known-edge-cases) | T-ING-1..6, T-NORM-1..3 |
| R2 Finds anyone | Find a reader (`/lookup`): type an email or app `u_` id and press Find, or pick from the matches listed as you type; a near miss offers "Did you mean …?" links; Find also takes a `pk_` key, device `d_` id or visitor `v_` id (under "More ways to find a reader"); one view with newsletter, site visits (pre-signup ones tagged "Before signing up") and app activity, and "No website history" when there is none | `GET /api/lookup` (exact email, `u_`, `pk_`, `d_` or `v_`), `GET /api/lookup/search` (3+ characters, up to 20 matches; with none, up to 5 `did_you_mean` within 2 edits) | T-API-1, T-API-3, T-API-4 |
| R3 Builds a segment | Build a list (`/segments`): the button "haven't opened in 30 days (the brief's example)" gives 177 readers and "55 unsubscribed readers not shown."; preview and Export CSV | `worker/segments/compile.ts` turns the filters into bound SQL; the export carries a `status` column | T-SEG-1..3 |
| R4 Never sleeps | `POST /webhooks/app`; App events (`/events`, the last 20, newest first); Find a reader shows new events at once | header HMAC, `event_id` idempotency, identity resolved at read time ([Webhook](#webhook)) | T-WH-1..8, T-WH-7b, T-WH-9a, T-WH-9b, T-WH-10..12 |
| R5 Talks back, never sees PII, shows how | Ask a question (`/assistant`); AI audit log (`/audit`) | Gate 1 → tools loaded from `assistant_tools` rows → pure request builder → PII scanner → Claude → Gate 2/3 on tool calls → scanned output → emails re-attached for the UI only; every step written to `ai_audit` ([PII design](#pii-design)) | T-AI-1..5, T-AI-8, T-PII-1..4, T-GATE-1..2, `test/audit.test.ts` |
| R6 Surprise us | Growth (`/growth`): "Newsletter subscribers who then got the app" (by signup source, counting only app accounts created after the signup) and "Website visitors who subscribed" (by first page); then "Readers at risk of going cold" (`going_cold_risk`, active subscribers by signup source) and "Gaps in the data" (missing or unrecognised sources and campaign sources, app users not on the list, and the share of rows set aside while loading, which links to Overview); "Explain this" on every number the assistant can see | `worker/insights/`, over the views `v_profiles`, `v_funnel` and `v_web_events`, plus `import_runs`/`quarantine` | T-INS-1..3 |
| Password on the UI | the login page | signed `HttpOnly`, `Secure`, `SameSite=Strict` cookie; constant-time compare, failure delay, rate limit | T-AUTH-1..2 |
| Webhook protected as in production | — | HMAC-SHA256 over header timestamp + raw bytes, 300 s window, 64 KB cap, 200-character property cap, 300 requests a minute | T-WH-11, T-WH-12 |
| "Today" is 2026-09-28 | every date on every screen | `TODAY` in `shared/config.ts`; definitions in `shared/derive.ts` | T-DER-1..3 |

## Deploy

Live: **https://tpo-cdp.michaelabdo-mail.workers.dev** (behind the site password, which comes with the submission).

Enable Workers Paid (Workers & Pages → Plans) before seeding: one seed writes about 55,000 D1 rows, and the free plan caps writes at 100,000 rows a day.

```bash
npx wrangler login                                   # once
npx wrangler d1 create cdp                           # put the printed database_id in wrangler.jsonc
for NAME in SITE_PASSWORD SESSION_SECRET WEBHOOK_SECRET PII_KEY_SECRET ANTHROPIC_API_KEY; do
  grep "^$NAME=" .dev.vars | cut -d= -f2- | npx wrangler secret put $NAME   # value piped, never echoed
done
npm run db:migrate:remote
npm run db:seed:remote                               # type "cdp" at the prompt; refuses a database that already holds seed rows
npm run tools:seed -- --remote                       # type "cdp"; inserts missing assistant_tools rows, never overwrites one
npm run deploy                                       # build + wrangler deploy
```

The seed derives every profile key from `PII_KEY_SECRET` in `.dev.vars`, so the remote secret must be the same value (the loop above pipes it). `ANTHROPIC_API_KEY` is checked on the first assistant call, the other four on the first request.

Re-seed from scratch: `npm run db:reset:remote` (type `cdp`), then `npm run tools:seed -- --remote` again. The reset drops every table and view, re-applies the migrations and seeds again, so it also wipes webhook events, tool rows and audit rows. The hosted UI has no destructive action.

Rotate the webhook secret: `npx wrangler secret put WEBHOOK_SECRET`. It applies at once, with no redeploy.

Verify (after deploying this build):

```bash
URL=https://tpo-cdp.michaelabdo-mail.workers.dev
curl $URL/health                                     # {"ok":true,"db":true,"today":"2026-09-28"}
# POST /api/login {"password": …} with Content-Type: application/json → 204 + cookie; then, with the cookie:
#   GET  /api/lookup?q=joy.hall830@protonmail.com   → 200, her pkey, app user u_ceed5f12, 9 web views
#   GET  /api/lookup/search?q=joy.hall             → 200, 3 matches; ?q=hall → 20 and truncated; ?q=jo → 400 query_too_short
#   GET  /api/lookup/search?q=joy.hal830@protonmail.com → 200, no matches, did_you_mean joy.hall830@protonmail.com (distance 1)
#   POST /api/segments/preview {"filters":{"source":["instagram"],"status":["active"],"days_since_open_gte":30,"include_never_opened":true}}
#        → count 177, hidden_unsubscribed 55
```

Live webhook check (the Wednesday checkpoint). First, before any event, note the `{"filters":{"source":["instagram"],"has_app":true},"limit":1000}` preview: count 245, and julia.evans230 has `engagement_score` 28. Then:

```bash
# run these two back to back: --again re-sends the body in .wrangler/send-webhook-last.json, which any webhook:send in between (even to localhost) overwrites
npm run webhook:send -- --url $URL --event read_story --user u_2b6447a3   # expect 202, resolves to julia.evans230
npm run webhook:send -- --url $URL --event read_story --again             # expect 200 {"accepted":true,"duplicate":true}
# with the cookie:
#   GET  /api/lookup?q=u_2b6447a3        → the read_story event in julia.evans230's app timeline
#   GET  /api/events/recent              → the event listed, resolved to her profile
#   POST /api/segments/preview {"filters":{"source":["instagram"],"has_app":true},"limit":1000}
#        → julia's engagement_score in the rows rises above 28 with no re-import (what T-WH-10 pins); the count stays 245, because no filter reads webhook data (09 D-53)
```

`webhook:send --url` signs with the `WEBHOOK_SECRET` in your `.dev.vars`, so for the live app that file must hold the live secret.

Observed live on 2026-10-13 after deploying the webhook build (version a4dc6b0c): baseline count 245, julia.evans230 score 28 → `webhook:send --event read_story --user u_2b6447a3` 202 (resolved to her pkey) → `--again` 200 duplicate → lookup shows the event in her app timeline (attached_via direct) → `/api/events/recent` lists it first → preview count 245, her score 31.

## Data

The three CSVs in `data/` are the synthetic files provided with the brief ("No real subscriber data"); they are committed so the seed is reproducible.

## Data rules and known edge cases

`npm run db:seed:local` runs `scripts/csv2sql.ts`, which turns `data/*.csv` into `seed/*.sql` and loads it with `wrangler d1 execute`. The script checks every file's header before it builds anything, prints per-file counts and every quarantine reason, and stops with a non-zero exit on any error. The counts it writes to `import_runs` are the import report on Overview.

**Normalization** (`shared/normalize.ts`, the only implementation)

- Email: `trim()` then lowercase, nothing else. No plus-stripping and no Gmail dot removal. The result must match `^[^@\s]+@[^@\s]+\.[^@\s]+$`.
- Source and UTM: trim, lowercase, `twitter → x`. Blank becomes `NULL`. A value outside `instagram facebook referral google direct podcast x` is kept lowercased, so an unexpected source shows up in the data instead of disappearing.
- Every table stores `email_norm`, computed once at ingest, and joins use it. SQL and the browser never normalize.
- CSV timestamps have no zone and are treated as UTC. Web event times are stored as `YYYY-MM-DDTHH:MM:SSZ`.

**Quarantine** (never drop a row)

A row that cannot become a record goes to the `quarantine` table with one reason and its raw text, and is not counted:

- `blank_row`: every field is empty.
- `invalid_email`: the email fails the pattern above.
- `missing_field`: a required column is empty.
- `bad_date`: subscriber and app dates must be `YYYY-MM-DD`, and web timestamps must be `YYYY-MM-DD HH:MM:SS`. These are the CSVs' own formats, and nothing looser is accepted.

A missing header column stops the seed and names the file and the column. A value that has no rule stops the seed with its file line instead of being guessed: an unknown status, a repeated `user_id`, an email on a web row other than `/subscribe`, or two different emails for one visitor.

**Dedupe** (subscribers)

Identity is the normalized email. When rows merge:

- `signup_date` is the earliest.
- `last_open_date` is the latest non-empty one.
- `status` is `unsubscribed` if any row says so.
- `source` comes from the earliest-signup row.
- `email_raw` is the first spelling seen.
- `merged_count` records how many rows were collapsed.

No duplicate pair in the data disagrees on any field, so these rules are covered by tests but never change a value on this dataset.

**Linking**

1. App to subscriber: `app_users.email_norm = subscribers.email_norm`. An app user with no matching subscriber gets an `app_only` profile.
2. Web to subscriber: the email on a `/subscribe` row matches a subscriber. That visitor's whole history, before and after signup, is attributed to the profile, which is how "which pages do new subscribers hit first?" can be answered.
3. Visitors without a `/subscribe` email get no profile. They stay in the funnel view.
4. A webhook `user_id` that no app user has creates an app user with no email and an `unknown_user_stub` profile when it arrives. It is never dropped.
5. Anonymous app events (no `user_id`) are resolved when they are read, not when they are stored: the device's most recent user by event time, then that user's email, then the profile.
6. App account direction: an app account counts as converted from the newsletter only if it was created on a later day than the signup.

Each subscriber and each `app_only` email gets one profile with a keyed pseudonymous `pkey`. `created_at` is the signup date for a subscriber and the app account date for an app-only profile. `cold_since` and `engagement_score` are computed by `shared/derive.ts` when they are written, and stored. At seed time a profile has no app events yet. A visitor's first page, first UTM source and first-seen time all come from its earliest event, and the first UTM source is empty when that event had none.

**Known edge cases, not handled**

- Plus-addressing and Gmail dot-aliases. There are none in the data.
- One person with two emails.
- One browser or visitor shared by two people.
- An app user who changes email.
- A device used by several users. All of its anonymous events attach to the most recent user.
- An unknown `user_id` that later appears in `app_users` with an email. The stub profile and the email profile stay separate.
- A `/subscribe` email that is not in `subscribers.csv`. There are none in the data. It would get no profile, since no `web_only` kind exists, and the seed prints how many there are.

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

`POST /webhooks/app` takes one app event per request, in exactly the brief's shape:

```json
{"event_id":"evt_9f3a1c","event":"read_story","user_id":"u_2b6447a3","device_id":"d_4b21e8","timestamp":"2026-09-28T14:22:05Z","properties":{"story":"supreme-court-ruling-explained"}}
```

`event` is one of `app_open`, `read_story`, `link_click`, `login`. `user_id` may be `null` or absent. `timestamp` is the event time: it orders the timeline, may be hours old, and is never used for auth. The body may be at most 64 KB, and any string inside `properties` at most 200 characters.

**Auth: two headers, no cookie.**

| Header | Value |
|---|---|
| `X-Webhook-Timestamp` | unix seconds when this request was sent |
| `X-Webhook-Signature` | `v1=` + hex HMAC-SHA256(`WEBHOOK_SECRET`, `<X-Webhook-Timestamp>.<raw body bytes>`) |

The server checks the signature on the raw bytes before it parses any JSON, with a constant-time compare, and refuses a header timestamp more than 300 seconds from its clock.

**Retries must re-sign with a fresh header timestamp**, as Stripe and others do. A request captured more than 5 minutes ago is refused as stale by design, while the body it carries can be any age. Re-sending an `event_id` that is already stored is safe: the answer is `200 {"accepted":true,"duplicate":true}` and the first write wins.

| Code | When |
|---|---|
| 202 | stored; the body names the user and profile key the event resolves to, or `null` |
| 200 | `event_id` already stored (duplicate) |
| 400 `invalid_event` | schema failure; `details` names each field |
| 401 `bad_signature` · `stale_timestamp` · `missing_headers` | auth failure; the reason is logged server-side |
| 413 · 415 · 429 | body over 64 KB · not `application/json` · over 300 requests a minute |

**Signing examples.** Each sends the brief's sample event. Set `URL` (e.g. `http://localhost:5173`) and `WEBHOOK_SECRET` in the environment first.

curl + openssl:

```bash
BODY='{"event_id":"evt_9f3a1c","event":"read_story","user_id":"u_2b6447a3","device_id":"d_4b21e8","timestamp":"2026-09-28T14:22:05Z","properties":{"story":"supreme-court-ruling-explained"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')
curl -sS -X POST "$URL/webhooks/app" \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Timestamp: $TS" \
  -H "X-Webhook-Signature: v1=$SIG" \
  --data-binary "$BODY"
```

Node 20+ (save as `sign.mjs`, run `node sign.mjs`):

```js
import { createHmac } from 'node:crypto'

const body = JSON.stringify({
  event_id: 'evt_9f3a1c', event: 'read_story', user_id: 'u_2b6447a3', device_id: 'd_4b21e8',
  timestamp: '2026-09-28T14:22:05Z', properties: { story: 'supreme-court-ruling-explained' },
})
const ts = String(Math.floor(Date.now() / 1000))
const sig = 'v1=' + createHmac('sha256', process.env.WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex')
const res = await fetch(`${process.env.URL}/webhooks/app`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Webhook-Timestamp': ts, 'X-Webhook-Signature': sig },
  body, // sign and send the same bytes
})
console.log(res.status, await res.text())
```

Python 3 (standard library only):

```python
import hashlib, hmac, json, os, time, urllib.error, urllib.request

body = json.dumps({
    "event_id": "evt_9f3a1c", "event": "read_story", "user_id": "u_2b6447a3", "device_id": "d_4b21e8",
    "timestamp": "2026-09-28T14:22:05Z", "properties": {"story": "supreme-court-ruling-explained"},
}, separators=(",", ":")).encode()
ts = str(int(time.time()))
sig = "v1=" + hmac.new(os.environ["WEBHOOK_SECRET"].encode(), ts.encode() + b"." + body, hashlib.sha256).hexdigest()
req = urllib.request.Request(os.environ["URL"] + "/webhooks/app", data=body, method="POST", headers={
    "Content-Type": "application/json", "X-Webhook-Timestamp": ts, "X-Webhook-Signature": sig})
try:
    with urllib.request.urlopen(req) as res:
        print(res.status, res.read().decode())
except urllib.error.HTTPError as err:  # 4xx/5xx arrive here
    print(err.code, err.read().decode())
```

**From this repo:** `npm run webhook:send` (`scripts/send-webhook.ts`) signs with `WEBHOOK_SECRET` from `.dev.vars` (never printed), POSTs, and prints the status and the response body.

```bash
npm run webhook:send -- --event app_open                                # 202: anonymous, on a new device
npm run webhook:send -- --again                                         # 200 duplicate: same event_id, re-signed
npm run webhook:send -- --event app_open --again                        # the same re-send, as 11 §Verify writes it; --event must match the last event
npm run webhook:send -- --event login --user u_2b6447a3 --same-device   # 202: the device's earlier event now resolves to julia.evans230
npm run webhook:send -- --event app_open --url https://tpo-cdp.michaelabdo-mail.workers.dev
```

Flags: `--event`, `--user` (absent = anonymous), `--device` or `--same-device` (default: a new device), `--again`, `--url` (default `http://localhost:5173`). New events are timestamped TODAY (`shared/config.ts`) at the current UTC time of day.

**Identity at read time.** An event with a `user_id` belongs to that user. An anonymous event belongs to its device's most recent user by event time (`device_identity`, updated by every identified event), so a `login` attaches the device's anonymous events whether it arrives before or after them, with no replay; "Find a reader" tags them "Linked by login" and "App events" tags them "Linked after login". A device shared by several users gives all its anonymous events to the most recent one, the documented miss. `/events` lists the last 20 events, newest first, with the profile each one resolves to.

## PII design

The only PII in the data is the email; names appear only inside email local parts. The brief also says "anything identifying", so raw `user_id`, `device_id` and `visitor_id`, the raw email spelling, quarantined raw rows and the raw `properties` JSON are kept from the model too. That column list is `PII_COLUMNS` in `shared/pii.ts`.

**Keep it out, refer by pseudonym, re-attach after.**

```
teammate ─▶ Worker ─▶ Gate 1 (emails in the question → [email]) ─▶ buildModelRequest() ─▶ PII scanner ─▶ Claude
    ▲                                                                                       │ tool_use
    │                                            Gate 2/3 ─▶ tool executor ─▶ D1, PII-free views only
    │                                                           PII scanner on each result ─▶ back to Claude
    │                                                                                       │ final answer (pk_ keys)
    └── UI JSON (emails) ◀── rehydrate.ts: pk_ → email ◀── PII scanner on the output ◀──────┘
```

- **Pseudonymous key** (`shared/pseudonym.ts`): `pk_` + the first 16 hex characters of HMAC-SHA256(`PII_KEY_SECRET`, `email_norm`). A webhook stub hashes `user:` + its id, and `visitor_hash` hashes `visitor:` + the visitor id. Keyed, so it cannot be reversed without the Worker secret.
- **What the model receives** (`worker/assistant/build-request.ts`, a pure function and the only request builder): a fixed system prompt with the view column names and types, the definitions from `shared/derive.ts` and `TODAY`; the question after Gate 1; the enabled `assistant_tools` rows (name, description, input schema); and this request's tool results. Tools read only the views `v_profiles`, `v_web_events`, `v_app_events`, `v_funnel` and `v_source_app_conversion` (`migrations/0002_views.sql`), and no view selects a column in `PII_COLUMNS`. App events reach the model as event type, time and the `story` / `link` slug, never the raw `properties`.
- **Can an email, a name or a raw subscriber row reach a model request or response? No.** The views hold no PII column; the scanner checks every request, every tool result and every model output; and T-PII-1..4 test it.
- **Scanner** (`worker/assistant/gates/pii-guard.ts`, `assertNoPII`): the serialized payload is checked against every `email_norm` in the database (loaded per request), a case-insensitive email pattern and raw `u_` / `d_` / `v_` id patterns. A hit stops the request with 500 `blocked_pii` and a `blocked` audit row. It never redacts and retries.
- **Re-attachment** (`worker/assistant/rehydrate.ts`): after the model has finished and its output passed the scanner, the server swaps each `pk_` key for its email, only in the HTTP response to the signed-in UI. Nothing re-hydrated is written to `ai_audit` or sent back to the model.
- **Proof** (R5.5): "AI audit log" (`/audit`) shows, for every question, each stored model request and response, tool call and SQL exactly as stored. The stored question is the redacted one. Searching a trace for `@` finds nothing.

The UI behind the login shows emails everywhere; the boundary is around the model, not the teammate.

## Assumptions

Calls I made where the brief left room, each with the decision-log number it has in the design docs.

- **Today and live events (D-01).** `TODAY = 2026-09-28` (`shared/config.ts`) drives every date rule. Live webhook events arrive in October; they are stored as sent, never rejected, and count as 0 days old in recency math. `webhook:send` stamps new events TODAY at the current UTC time of day.
- **Stack (D-02).** Cloudflare Workers with static assets (not Pages) + D1 + Hono + React/Vite on workers.dev, because TPO's stack lists Cloudflare and it is one deploy that also runs locally. Workers Paid, for the assistant loop's CPU and subrequest budget and the seed's row writes.
- **Model (D-03).** Claude Opus 5.5 (`claude-opus-5-5`), called directly at Anthropic's URL. Cloudflare AI Gateway would add an independent log; it is not set up, and `ai_audit` is the proof.
- **Login (D-05).** A login page and a signed session cookie instead of browser basic auth: the same strength, and it demos better.
- **Webhook auth in headers only (D-06).** HMAC over the header timestamp and the raw body, so the body stays exactly the brief's shape and an old event time never fails auth.
- **Retries re-sign (D-37).** A retry must carry a fresh header timestamp; the event inside may be any age. A request captured more than 5 minutes ago is stale by design.
- **Lenient event times (D-38).** A webhook `timestamp` may end in `Z`, carry an offset, or carry no zone (read as UTC); it is stored normalized.
- **Over-long property strings are refused (D-22).** 400, not cut short: it fails loud and bounds what could reach the model.
- **Unsubscribed are hidden by default, never silently (D-07).** Segments, exports and assistant answers leave them out unless the status filter says otherwise, and the UI says how many were left out. An export follows its segment's status filter and always has a `status` column, so a list that includes unsubscribed readers cannot pass for an email list.
- **Hidden-unsubscribed count (D-51).** The number shown is the unsubscribed rows that match every other filter (55 for the brief's preset), so including them raises the count by exactly that number (177 → 232).
- **Email identity (D-26).** Trim and lowercase only, and `twitter` = `x`. Case folding is what makes all 1,400 `/subscribe` emails match (1,190 match raw); folding plus-addresses or Gmail dots would be a guess.
- **Merge precedence (D-27).** Fixed rules for duplicate subscriber rows ([Dedupe](#data-rules-and-known-edge-cases)), tested even though no duplicate pair in the data disagrees.
- **2,900 subscribers, not 2,902 (D-28).** A hand count of 2,995 rows minus 8 blank rows and 85 duplicates gives 2,902. Two more rows (`not-an-email`, `@gmail.com`) fail the email pattern, so they are quarantined, not counted. Overview shows each set-aside row and why.
- **Web visits link for the whole history (D-08).** The brief links a visit to a subscriber by the email on `/subscribe`; this extends it to that visitor's every visit, before and after signup. Without it "which pages do new subscribers hit first?" has no answer.
- **Nothing is dropped (D-15).** Anonymous visitors stay in the funnel. A `user_id` never seen gets a stub profile on arrival. An app account counts as coming from the newsletter only if it was created on a later day than the signup.
- **CSV times are UTC (D-16).** The CSVs carry no zone; the webhook samples use `Z`.
- **Fixed definitions (D-10, D-14, D-36).** `cold`, `cold_since`, `went_cold_in`, "last month", the 0–100 `engagement_score` and `new_subscriber` (signed up in the last 30 days) are written once in `shared/derive.ts` and listed under [Definitions](#definitions).
- **The brief's filter and "cold" differ, and both are labelled (D-30).** "No open in 30 days, never-openers included" gives 177 Instagram actives; `cold` (never-openers count only 30 days after signup) gives 147. The segment preset uses the brief's filter; the assistant uses `cold` for "went cold" questions and says so.
- **"Shows up in segments" (D-53).** A new event changes the stored `engagement_score` of the rows it touches at once, with no re-import. It cannot change a segment count, because no filter reads webhook data ([Known gaps](#known-gaps)).
- **Ids kept from the model too (D-17).** Raw `user_id`, `device_id` and `visitor_id` count as identifying. Stricter than required, and it costs nothing.
- **Device stitching (D-18, D-43).** An anonymous event belongs to its device's most recent user by event time, and an out-of-order older event never moves that mapping back. A device shared by several people is the stated miss.
- **Tools are data (D-41).** Every assistant tool is a row in `assistant_tools`, validated when it loads; a bad enabled row fails loud with `tool_config_error`. A Growth teammate can add a question type as a `query` row (an SQL template over the PII-free views plus an input schema) with no deploy; `pages_new_subscribers_hit_first` is the live example.
- **The gateway is ported, not invented (D-24).** The assistant's Gate 1/2/3, tools-in-the-database, 5-round loop and audit table mirror the AI gateway of my consulting platform (Palisade), ported by hand to Workers. Left behind on purpose: a public chat route, a canned 200 on a Gate 1 block, silent SQL retries, fire-and-forget audit, the raw prompt in the audit, webhook parse-before-verify and read-then-insert dedupe, a committed magic-link token, `today = new Date()`, a lax cookie with no login limit, an in-memory rate limiter, missing server-side input-schema checks, column checks that were advertised but absent, and an OpenAI fallback.
- **Partial lookup (D-52).** "Find a reader" lists up to 20 profiles whose normalized email contains the typed text or whose app `user_id` starts with it.
- **Fuzzy lookup (D-59).** When that list is empty and the typed text has 5 or more characters, the Worker offers up to 5 "Did you mean …?" addresses within Damerau–Levenshtein distance 2 of the whole email or its local part (`worker/lookup/fuzzy.ts`), nearest first, then alphabetical. It scans every stored email per such search; no index or SQL extension.
- **UI for non-technical staff (D-55).** Plain words first, at most two levels of detail, technical detail behind a labelled toggle, WCAG 2.2 AA as the target.
- **Reset is CLI-only (D-13).** Re-seeding needs the database name typed at a prompt; the hosted UI has no destructive action, so a reviewer cannot wipe the demo.
- **The CSVs are committed (D-32).** They are the brief's synthetic files ("No real subscriber data"), so the seed is reproducible.
- **Reviewers get the webhook secret by email (D-19).** They must be able to send events; it is rotated after the review.

## Tests

`npm test` runs every file in `test/` inside workerd, against a local D1 with the real migrations applied (`test/setup.ts`). Tests that need data seed it from the real CSVs (`test/helpers/seed.ts`). No network: the model transport is a function the assistant tests pass in, returning Messages-API-shaped responses written in the test file. At this commit: 26 files, 519 tests.

| IDs | File | What they pin |
|---|---|---|
| T-NORM-1..3 | `normalize.test.ts` | the one email/source normalizer, and no second implementation anywhere |
| T-DER-1..3 | `derive.test.ts` | `TODAY`, cold dates, windows and the engagement score |
| T-ING-1..6 | `ingest-core.test.ts`, `ingest-seed.test.ts`, `lookup.test.ts` | seed counts, quarantine, dedupe and precedence, web and app linking |
| T-API-1, T-API-3, T-API-4 | `lookup.test.ts`, `lookup-search.test.ts` | exact lookup by email, `u_`, `pk_`, `d_` and `v_`; partial lookup; "did you mean" suggestions and the distance helper |
| T-SEG-1..3 | `segments.test.ts` | 177, 55 hidden, export columns and status rule |
| T-WH-1..8, T-WH-7b, T-WH-11..12 | `webhook.test.ts` | shape, events, null users, resolution, unknown users, order, duplicates, auth, caps |
| T-WH-9a, T-WH-9b | `stitching.test.ts` | login stitching in both arrival orders |
| T-WH-10 | `events.test.ts` | an event moves the stored score in a segment preview with no re-import |
| T-AUTH-1..2 | `auth.test.ts` | login, cookie, fail-closed secrets, no secret in any error or audit row |
| T-PII-1..4 | `pii.test.ts`, `schema.test.ts`, `gate1.test.ts`, `assistant.test.ts` | no email or raw id in any request, view or audit row; blocking |
| T-GATE-1..2, T-AI-2 | `gate1.test.ts`, `gate2.test.ts` | Gate 1 patterns and redaction; Gate 2/3 read-only SQL over views only |
| T-AI-1, T-AI-8 | `tools.test.ts` | tool rows load or fail loud; `query` rows bind in order |
| T-AI-3..5 | `assistant.test.ts` | typed results, audit rows per trace, no SQL in answer text |
| T-INS-1..3 | `insights.test.ts` | the four Growth panels; `going_cold_risk` checked row by row on the seeded subscribers |
| — | `audit.test.ts`, `health.test.ts`, `overview.test.ts`, `pseudonym.test.ts` | the audit API and /audit's words for blocked steps, the D-58 screen of `filters_applied`, `/health`, Overview numbers, key derivation |
| — | `ui/assistant-result.test.ts` | "Ask a question" rendered: no model-written SQL in `filters_applied` reaches the page (typed by `tsconfig.ui-test.json`, DOM and JSX) |
| — | `ui/audit-step.test.ts` | /audit rendered: a Gate 2 or Gate 3 block shows its own sentence in words, not the generic one |

## Known gaps

- **A webhook event cannot change a segment count.** The plan first said "a segment count changes after an event" (08 T-WH-10, the 16 Wednesday checkpoint); 09 D-53 reworded both to what the design actually does. No segment filter reads anything a webhook writes: `status`, `source` and `last_open_date` come from `subscribers.csv`, and `has_app` needs an `app_users` row with an email, while a webhook only creates `app_users` rows with no email (stub users). What an event does change in a segment is the stored `engagement_score` of its rows (09 D-46), with no re-import. T-WH-10 pins that score rise, not a count change.
- **An assistant answer that mentions SQL loses its prose (08 T-AI-5, 09 D-58).** `worker/assistant/respond.ts` does not cut SQL out of the model's text; with the check in `shared/sql-sign.ts`, it discards the whole text when it holds a fence whose tag starts with `sql` (```` ```sql ````, ```` ```sqlite ````, `~~~sql`), a line whose first word is `SELECT`, or the word `select` followed anywhere later by the word `from` (any case, across lines). The check reads several copies of the text and discards if any one matches: D-58 as written (only its six zero-width and soft-hyphen characters deleted, every other invisible Unicode format character kept as a separator), raw and NFKC-folded; and two NFKC-folded copies with every format character deleted or turned into a space. The first copy makes the check a true superset of D-58; the others mean an invisible character can neither split a keyword nor glue it to the next word. A word ends at a letter or digit, not at `_`, so `_select_ … _from_` and `select_email from` count. A line-start `SELECT` may follow any non-letter prefix (indentation, `>`, backticks, list markers, `*`). The teammate then sees a server sentence built from the typed result ("177 readers match.", "Here is the table you asked for.", or a pointer to Technical details); the table and segment are unchanged. There is no English exemption, so ordinary prose such as "select a segment from the builder" is replaced too. Every discard is logged and written to `ai_audit` as a `blocked` row naming D-58. Residuals D-58 does not cover, so they pass: SQL that is not a SELECT (`DELETE FROM users`, `UPDATE …`) outside a ```` ```sql ```` fence or inside a fence with another tag (```` ```postgresql ````); a SELECT with no `from` after it that does not start a line ("Run SELECT 1;", `<code>SELECT 1</code>`); keywords written in look-alike letters from other scripts (Cyrillic `ѕеlесt`), which NFKC does not fold. The model's `filters_applied` is not screened by the server, which D-58 does not ask for; "Ask a question" runs the same check (`shared/sql-sign.ts`) over every key and string in it and over its JSON before showing it, and on any sign hides it whole, under "How this answer was worked out" and in Technical details, with a sentence saying why (`src/filters-applied.ts`). The residuals above pass there too. The false positive reaches further there: nearly every `filters_applied` has `window_from` and `window_to` keys, and `_` does not end a word, so a key or value holding the word `select` before them hides the whole block. The API response and the stored model output on "AI audit log" (Technical details, exactly as stored) still carry it as the model wrote it. The PII scanner covers it, as part of the whole model output.
- **`query_sql` keeps unsubscribed readers out only by asking (02 §Defaults).** The `segment` and `aggregate` tools apply the active-only default in code (`status` defaults to `["active"]`), and the `pages_new_subscribers_hit_first` row keeps it in its own SQL template unless `include_unsubscribed` is true. `query_sql` runs the SELECT the model wrote, and its default lives only in its tool description ("Exclude unsubscribed profiles (status = 'active') unless the teammate asks for them", `scripts/tool-seeds.ts`). Gate 2 and Gate 3 check what a query reads and that it only reads, not its filters, so a query with no `status = 'active'` counts unsubscribed readers too. The SQL that ran is on "AI audit log" for every call.
- **`npm test` needs a non-empty `ANTHROPIC_API_KEY`.** 20 tests in 3 files (`assistant`, `audit`, `gate2`) call `POST /api/assistant` with a test transport, but the route first refuses an empty key with 503, so those tests fail when `.dev.vars` leaves the key blank. Any string works; no test calls Anthropic.
- **Built later or not at all:** multi-turn conversation (one question per request), streamed answers, a test-event panel in the UI (events are sent from the terminal), Cloudflare AI Gateway, CI (the pre-deploy gate is `npm run typecheck && npm test` by hand), a generator for the [Definitions](#definitions) table (copied by hand from `shared/derive.ts` doc strings), a `test:pii` script, the shared-device regression test T-WH-9c, the numeral-provenance check T-AI-6, and an automated run of the three brief questions against the real model (T-AI-7 is a manual check before the Loom).
- **`git grep mock` hits are test plumbing, not mocks of our code:** `vi.spyOn(console, …).mockImplementation(() => {})` silences log lines a test expects, and `warn.mock.calls` reads them back. The model transport the assistant tests pass in is described under [Tests](#tests). There are no TODOs.

## Known security gaps

1. **One shared UI password** for all reviewers; no per-user identity or MFA. Production: Cloudflare Access or SSO with a per-user audit.
2. **The webhook secret goes out by email**, and it is one shared key. Production: a key per client in a secrets manager, a key id in the header, scheduled rotation.
3. **Rate limiting is approximate and keyed only by IP or session.** The Workers Rate Limiting binding is eventually consistent; the assistant's 100 questions an hour per session is counted from `ai_audit` rows, so two requests racing at the 100th can both pass; locally every client shares one login-limit key. Production: WAF rules on a custom domain and per-device quotas.

Also: no Content Security Policy beyond the defaults; no retention policy on `ai_audit`; no handling of deletion or unsubscribe requests; small aggregates are not k-anonymized, so a count of 1 can point at one person.

The other concern I would address next: **prompt injection through event data.** A compromised app client can send `properties.story = "ignore prior instructions and …"`; that string is stored and can reach the model as a tool result. Shipped: the webhook's caps and refusals, tool results framed as untrusted data, read-only tools and the output scan. Next: an allowlist per field (a `story` must match the published slug list), DLP scanning in AI Gateway, and an alert on the rate of refused payloads.

## AI usage

Built in Claude Code throughout. [`docs/ai-log.md`](docs/ai-log.md) records, by date, where the AI was wrong: what was asked, what it got wrong, how it was caught (a failing test, the typecheck, a review, a live run) and the fix. Commits are small and never squashed, and their bodies name the design sections they implement, so `git log` shows what was built when. `CLAUDE.md` holds the working rules the AI followed.

## Next

Push segments to beehiiv; a nightly beehiiv and GA4 sync so the CSVs stop being the source; an app-revenue join against Stripe, so the Growth team can follow subscriber → trial → paid; per-user auth through Cloudflare Access; a retention policy for `ai_audit` and handling for deletion requests.
