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

Live: **https://tpo-cdp.michaelabdo-mail.workers.dev** (behind the site password, which comes with the submission).

Enable Workers Paid (Workers & Pages → Plans) before seeding: one seed writes about 55,000 D1 rows, and the free plan caps writes at 100,000 rows a day.

```bash
npx wrangler login                                   # once
npx wrangler d1 create cdp                           # put the printed database_id in wrangler.jsonc
for NAME in SITE_PASSWORD SESSION_SECRET WEBHOOK_SECRET PII_KEY_SECRET; do
  grep "^$NAME=" .dev.vars | cut -d= -f2- | npx wrangler secret put $NAME   # value piped, never echoed
done
npm run db:migrate:remote
npm run db:seed:remote                               # type "cdp" at the prompt; refuses a database that already holds seed rows
npm run deploy                                       # build + wrangler deploy
```

`ANTHROPIC_API_KEY` goes up the same way with the assistant; nothing deployed so far reads it.

Re-seed from scratch: `npm run db:reset:remote` (type `cdp`). It drops every table and view, re-applies the migrations and seeds again, so it also wipes webhook events and audit rows. The hosted UI has no destructive action.

Verify:

```bash
URL=https://tpo-cdp.michaelabdo-mail.workers.dev
curl $URL/health                                     # {"ok":true,"db":true,"today":"2026-09-28"}
# POST /api/login {"password": …} → 204 + cookie; then, with the cookie:
#   GET  /api/lookup?q=joy.hall830@protonmail.com   → 200, her pkey, app user u_ceed5f12, 9 web views
#   POST /api/segments/preview, the brief's preset (active, instagram, no open in 30 days, never-opened included) → count 177
```

## Architecture

One Cloudflare Worker serves a React/Vite SPA from static assets and a Hono API, with Cloudflare D1 (SQLite) as the only data store. The three CSVs are converted by `scripts/csv2sql` into literal-value seed SQL that `wrangler d1 execute` loads after the schema migrations, normalizing emails once at ingest and writing merge/quarantine counts to `import_runs`. Live app events arrive at `POST /webhooks/app`, are verified by HMAC, inserted idempotently by `event_id`, and resolved to profiles at read time, so lookup and segments see them immediately. The AI assistant is a gated tool loop: Claude only ever receives PII-free views and tool results, subjects are referenced by pseudonymous keys, and emails are re-attached server-side after the model answers. Every model request is scanned before it leaves and written to `ai_audit`, which the UI shows.

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
npm run webhook:send -- --event login --user u_2b6447a3 --same-device   # 202: the device's earlier event now resolves to julia.evans230
npm run webhook:send -- --event app_open --url https://tpo-cdp.michaelabdo-mail.workers.dev
```

Flags: `--event`, `--user` (absent = anonymous), `--device` or `--same-device` (default: a new device), `--again`, `--url` (default `http://localhost:5173`). New events are timestamped TODAY (2026-09-28) at the current UTC time of day.

**Identity at read time.** An event with a `user_id` belongs to that user. An anonymous event belongs to its device's most recent user by event time (`device_identity`, updated by every identified event), so a `login` attaches the device's anonymous events whether it arrives before or after them, with no replay; lookup and `/events` tag them "stitched". A device shared by several users gives all its anonymous events to the most recent one, the documented miss. `/events` lists the last 20 events, newest first, with the profile each one resolves to.

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
