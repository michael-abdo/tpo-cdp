/// <reference types="vite/client" />
import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import headersFile from '../public/_headers?raw'
import { HOSTED_URL } from '../shared/config'
import { CONTENT_SECURITY_POLICY, HOSTED_HOST, SECURITY_HEADERS, WORKER_CACHE_CONTROL } from '../worker/http-hardening'
import { METHOD_NOT_ALLOWED_MESSAGE } from '../worker/routes/webhook'
import { documentationIp, loginCookie } from './helpers/auth'
import { seedDatabase } from './helpers/seed'
import { eventIdPool, signedRequest } from './helpers/webhook'

// Production hardening seen from outside: the security headers and no-store on every Worker
// response, the same security headers for the static SPA (public/_headers), 405 on a non-POST to
// the webhook URL, and https only for the deployed host. Real requests through the real Worker
// (SELF); the brief's sample event for the webhook.

const BRIEF_SAMPLE_FIELDS = { event: 'read_story', user_id: 'u_2b6447a3', device_id: 'd_4b21e8', timestamp: '2026-09-28T14:22:05Z' }
const nextEventId = eventIdPool()

let cookie: string

beforeAll(async () => {
  await seedDatabase()
  cookie = await loginCookie()
})

function expectHardened(res: Response, label: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), `${label}: ${name}`).toBe(value)
  expect(res.headers.get('cache-control'), `${label}: cache-control`).toBe(WORKER_CACHE_CONTROL)
}

describe('every Worker response carries the security headers and Cache-Control: no-store', () => {
  it('the CSP is the strict one the SPA was checked against', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    )
    expect(SECURITY_HEADERS).toMatchObject({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' })
    expect(SECURITY_HEADERS['Strict-Transport-Security']).toMatch(/^max-age=31536000; includeSubDomains$/)
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('same-origin')
  })

  it('/api/* answers, signed in or not, success or error, and /health', async () => {
    const cases: [string, Promise<Response>, number][] = [
      ['GET /api/overview signed in', SELF.fetch('http://cdp.test/api/overview', { headers: { cookie } }), 200],
      ['GET /api/overview signed out', SELF.fetch('http://cdp.test/api/overview'), 401],
      ['GET /api/no-such-route', SELF.fetch('http://cdp.test/api/no-such-route', { headers: { cookie } }), 404],
      [
        'POST /api/segments/preview',
        SELF.fetch('http://cdp.test/api/segments/preview', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ filters: {}, limit: 1 }),
        }),
        200,
      ],
      ['POST /api/segments/preview, wrong content type', SELF.fetch('http://cdp.test/api/segments/preview', { method: 'POST', headers: { cookie } }), 415],
      ['GET /health', SELF.fetch('http://cdp.test/health'), 200],
    ]
    for (const [label, pending, status] of cases) {
      const res = await pending
      expect(res.status, label).toBe(status)
      expectHardened(res, label)
    }
  })

  it('the export file is no-store too: it is a list of emails', async () => {
    const res = await SELF.fetch('http://cdp.test/api/segments/export.csv', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'cf-connecting-ip': documentationIp() },
      body: JSON.stringify({ filters: { engagement_gte: 90 } }),
    })
    expect(res.status).toBe(200)
    expectHardened(res, 'export.csv')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="segment.csv"')
  })
})

/** The `_headers` rules as { path: { header: value } }, read the way Workers Static Assets reads them. */
function parseHeadersFile(text: string): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {}
  let path: string | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('/')) {
      path = line
      rules[path] = {}
      continue
    }
    if (path === null) throw new Error('_headers: a header line before any path')
    const at = line.indexOf(':')
    rules[path]![line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return rules
}

describe('public/_headers gives the static SPA the same security headers', () => {
  it('every path gets exactly SECURITY_HEADERS, and /assets/* a year of immutable cache', () => {
    const rules = parseHeadersFile(headersFile)
    expect(Object.keys(rules)).toEqual(['/*', '/assets/*'])
    expect(rules['/*']).toEqual(SECURITY_HEADERS)
    expect(rules['/assets/*']).toEqual({ 'Cache-Control': 'public, max-age=31536000, immutable' })
  })
})

describe('/webhooks/app answers a non-POST with 405 and Allow: POST', () => {
  it('GET, HEAD, PUT and DELETE are 405 with a one-line hint, not the generic 404', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      const res = await SELF.fetch('http://cdp.test/webhooks/app', { method, headers: { 'cf-connecting-ip': documentationIp() } })
      expect(res.status, method).toBe(405)
      expect(res.headers.get('allow'), method).toBe('POST')
      expectHardened(res, method)
      if (method !== 'HEAD') expect(await res.json(), method).toEqual({ error: 'method_not_allowed', message: METHOD_NOT_ALLOWED_MESSAGE })
    }
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    // Any other path under /webhooks is still the generic 404.
    expect((await SELF.fetch('http://cdp.test/webhooks/other')).status).toBe(404)
  })

  it('a signed POST is still accepted, and carries the headers too', async () => {
    const body = JSON.stringify({ event_id: nextEventId(), ...BRIEF_SAMPLE_FIELDS })
    const res = await (await signedRequest(body)).send()
    expect(res.status).toBe(202)
    expectHardened(res, 'webhook 202')
  })
})

describe('plain http to the deployed host goes to https; other hosts are left alone', () => {
  it('a GET or HEAD is redirected with 301 to the same path on https', async () => {
    expect(HOSTED_HOST).toBe(new URL(HOSTED_URL).host)
    for (const method of ['GET', 'HEAD']) {
      const res = await SELF.fetch(`http://${HOSTED_HOST}/health?probe=1`, { method, redirect: 'manual' })
      expect(res.status, method).toBe(301)
      expect(res.headers.get('location'), method).toBe(`https://${HOSTED_HOST}/health?probe=1`)
      expectHardened(res, method)
    }
  })

  it('a POST is refused with 403 https_required before it is read: no login, no stored event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const login = await SELF.fetch(`http://${HOSTED_HOST}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': documentationIp() },
      body: JSON.stringify({ password: env.SITE_PASSWORD }),
    })
    expect(login.status).toBe(403)
    expect(login.headers.get('set-cookie')).toBeNull()
    expect(await login.json()).toMatchObject({ error: 'https_required' })

    const eventId = nextEventId()
    const send = await SELF.fetch(`http://${HOSTED_HOST}/webhooks/app`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: eventId, ...BRIEF_SAMPLE_FIELDS }),
    })
    expect(send.status).toBe(403)
    expectHardened(send, 'http POST')
    expect(await env.DB.prepare('SELECT count(*) AS n FROM app_events WHERE event_id = ?').bind(eventId).first<number>('n')).toBe(0)
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('"at":"https-only"')
    warn.mockRestore()
  })

  it('https to the deployed host, and http to localhost or any other host, are served as usual', async () => {
    for (const url of [`https://${HOSTED_HOST}/health`, 'http://localhost:5173/health', 'http://127.0.0.1:8787/health', 'http://cdp.test/health']) {
      const res = await SELF.fetch(url, { redirect: 'manual' })
      expect(res.status, url).toBe(200)
    }
  })
})
