/**
 * Sends one signed app event to POST /webhooks/app (11 §Scripts `webhook:send`, §Verify; 04
 * §Webhook). The terminal sender for demos and checks: it goes through the real endpoint, never
 * around it (CLAUDE.md).
 *
 *   npm run webhook:send -- --event app_open                       anonymous, on a new device
 *   npm run webhook:send -- --event login --user u_2b6447a3 --same-device
 *   npm run webhook:send -- --again                                the last event, same event_id
 *   npm run webhook:send -- --event app_open --again               the same, as 11 §Verify writes it
 *   npm run webhook:send -- --event app_open --url https://…       another deployment
 *
 * Flags: --event <name> (sent as given; the server validates it, so a bad name shows its 400) ·
 * --user <u_…> (absent = anonymous, user_id null) · --device <d_…> · --same-device (the last
 * event's device) · --again (re-send the last body byte for byte, so the server answers 200
 * duplicate; an --event given with it must match the last event) · --url <base> (default http://localhost:5173, the `npm run dev` address in 11
 * §Local run). A new event gets a fresh event_id and, without --device/--same-device, a fresh
 * device_id. Its timestamp is TODAY (shared/config.ts) at the current UTC time of day: 02 §Time
 * says demo events default to TODAY, and the time of day keeps successive events in send order.
 *
 * Signing (04 §Webhook headers): X-Webhook-Timestamp = unix seconds now, X-Webhook-Signature =
 * `v1=` + hex HMAC-SHA256(WEBHOOK_SECRET, `<timestamp>.<raw body>`). --again re-signs with a fresh
 * header timestamp, as a retry must (09 D-37). WEBHOOK_SECRET is read from its one line of
 * .dev.vars and never printed. The last body is kept in .wrangler/ (gitignored) for --again and
 * --same-device. Prints the HTTP status and the response body; exits 1 on anything but 2xx.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { demoTimestamp } from '../shared/demo-timestamp'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LAST_FILE = join(ROOT, '.wrangler', 'send-webhook-last.json')
const SECRET_NAME = 'WEBHOOK_SECRET'
const DEFAULT_URL = 'http://localhost:5173'

/** WEBHOOK_SECRET from its line of .dev.vars; no other line is read into a value. */
function webhookSecret(): string {
  const path = join(ROOT, '.dev.vars')
  if (!existsSync(path))
    throw new Error(`.dev.vars does not exist; copy .dev.vars.example and set ${SECRET_NAME}`)
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*WEBHOOK_SECRET\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const value = match[1].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    if (value === '') break
    return value
  }
  throw new Error(`${SECRET_NAME} is not set in .dev.vars`)
}

/** `<prefix>` + 6 random hex characters, the length of the brief's sample ids (evt_9f3a1c, d_4b21e8). */
function freshId(prefix: string): string {
  return prefix + randomBytes(3).toString('hex')
}

interface LastEvent {
  /** The exact JSON text that was sent. */
  body: string
  device_id: string
}

function readLast(flag: string): LastEvent {
  if (!existsSync(LAST_FILE))
    throw new Error(`${flag} needs a previous send; none is recorded in ${LAST_FILE}`)
  const last = JSON.parse(readFileSync(LAST_FILE, 'utf8')) as Partial<LastEvent>
  if (typeof last.body !== 'string' || typeof last.device_id !== 'string')
    throw new Error(`${LAST_FILE} is not a recorded send; delete it and send a new event`)
  return { body: last.body, device_id: last.device_id }
}

/**
 * The last body for --again. `--event` may name the event being re-sent, as 11 §Verify writes
 * `--event app_open --again`; it must match the recorded event, because --again never changes the
 * body (a different event under the same event_id would still answer 200 duplicate and hide it).
 */
function readAgain(event: string | undefined): LastEvent {
  const last = readLast('--again')
  if (event === undefined) return last
  const recorded = (JSON.parse(last.body) as { event?: unknown }).event
  if (recorded !== event)
    throw new Error(
      `--again re-sends the last body unchanged; its event is ${JSON.stringify(recorded)}, not ${JSON.stringify(event)}`,
    )
  return last
}

function buildBody(values: {
  event?: string
  user?: string
  device?: string
  'same-device'?: boolean
}): LastEvent {
  if (values.event === undefined)
    throw new Error('--event is required (app_open, read_story, link_click or login), or use --again')
  if (values.device !== undefined && values['same-device'])
    throw new Error('use --device or --same-device, not both')
  const device_id = values['same-device']
    ? readLast('--same-device').device_id
    : (values.device ?? freshId('d_'))
  const body = JSON.stringify({
    event_id: freshId('evt_'),
    event: values.event,
    user_id: values.user ?? null,
    device_id,
    timestamp: demoTimestamp(),
  })
  return { body, device_id }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      event: { type: 'string' },
      user: { type: 'string' },
      device: { type: 'string' },
      'same-device': { type: 'boolean' },
      again: { type: 'boolean' },
      url: { type: 'string' },
    },
    strict: true,
  })
  if (values.again && (values.user ?? values.device ?? values['same-device']) !== undefined)
    throw new Error('--again re-sends the last body unchanged; it takes no --user, --device or --same-device')

  const secret = webhookSecret()
  const send = values.again ? readAgain(values.event) : buildBody(values)
  if (!values.again) {
    mkdirSync(dirname(LAST_FILE), { recursive: true })
    writeFileSync(LAST_FILE, JSON.stringify(send))
  }

  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature =
    'v1=' + createHmac('sha256', secret).update(`${timestamp}.`).update(send.body, 'utf8').digest('hex')
  const url = `${(values.url ?? DEFAULT_URL).replace(/\/+$/, '')}/webhooks/app`

  console.log(`POST ${url}`)
  console.log(`body ${send.body}`)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': signature,
    },
    body: send.body,
  })
  console.log(`status ${res.status}`)
  console.log(await res.text())
  if (!res.ok) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error(`webhook:send failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
