import { env, SELF } from 'cloudflare:test'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { constantTimeStringEq, timingSafeEqual } from '../worker/auth/constant-time'
import { loginRoutes } from '../worker/auth/login'
import { requireSession } from '../worker/auth/middleware'
import { nowSeconds, SESSION_TTL_SECONDS, signSession, verifySession } from '../worker/auth/session'
import { type AppEnv, assertBindings } from '../worker/env'
import app, { onError } from '../worker/index'
import { documentationIp, loginCookie } from './helpers/auth'

// T-AUTH-1, T-AUTH-2: login, sessions and the error envelope. Secrets come from .dev.vars and are
// never printed: assertions compare against them with includes/equality, so a failure reports
// "expected true to be false", not the value. Constructed inputs, and why each is allowed:
// - wrong passwords are the real SITE_PASSWORD with one character changed or appended;
// - expired and tampered cookies are produced by the real signSession with the real secret;
// - the wrong-key cookie is signed by the real signSession with the real SESSION_SECRET with its
//   last character changed (same length, different key);
// - misconfigured deploys are the real env with bindings removed;
// - every login sends CF-Connecting-IP from 2001:db8::/32 (RFC 3849, reserved for documentation):
//   a fresh one per request, or one fixed per test in the rate-limit test, so tests never share a
//   LOGIN_LIMITER budget; data/*.csv contains no IP addresses;
// - no protected product route exists yet, so requireSession is mounted on a test-local app with a
//   probe route that echoes the session subject.

const BASE = 'http://cdp.test'
const JSON_HEADERS = { 'content-type': 'application/json' }

function realSecret(name: 'SITE_PASSWORD' | 'SESSION_SECRET' | 'WEBHOOK_SECRET' | 'PII_KEY_SECRET'): string {
  const value = env[name]
  if (!value) throw new Error(`${name} missing from .dev.vars; the test cannot run`)
  return value
}

/** Every secret value present in env, for the no-leak assertions. */
function secretValues(): string[] {
  const values = [realSecret('SITE_PASSWORD'), realSecret('SESSION_SECRET'), realSecret('WEBHOOK_SECRET'), realSecret('PII_KEY_SECRET')]
  if (env.ANTHROPIC_API_KEY) values.push(env.ANTHROPIC_API_KEY)
  return values
}

/** True when text contains any length-n run of characters from secret (the whole secret if shorter). */
function containsFragment(text: string, secret: string, n: number): boolean {
  const width = Math.min(n, secret.length)
  for (let i = 0; i + width <= secret.length; i++) {
    if (text.includes(secret.slice(i, i + width))) return true
  }
  return false
}

/** The real env with some bindings removed, as a misconfigured deploy would see it. */
function envWithout(...names: (keyof Env)[]): Env {
  const copy: Partial<Env> = { ...env }
  for (const name of names) delete copy[name]
  return copy as Env
}

/** The real password with its last character replaced: same length, wrong value. */
function wrongPasswordSameLength(): string {
  const password = realSecret('SITE_PASSWORD')
  const last = password.at(-1) === 'a' ? 'b' : 'a'
  return password.slice(0, -1) + last
}

function postLogin(password: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'cf-connecting-ip': documentationIp(), ...headers },
    body: JSON.stringify({ password }),
  })
}

/** requireSession on a test-local app, rendered by the production onError. */
function probeApp(): Hono<AppEnv> {
  const probe = new Hono<AppEnv>()
  probe.use('/api/*', requireSession)
  probe.get('/api/probe', (c) => c.json({ sub: c.get('session').sub }))
  probe.post('/api/probe', (c) => c.json({ sub: c.get('session').sub, method: 'POST' }))
  probe.onError(onError)
  return probe
}

function cookieValue(cookie: string): string {
  return cookie.slice('cdp_session='.length)
}

/** Unpadded base64url, written here independently of worker/auth/session.ts so the wire format is pinned. */
function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** The real secret with its last character replaced: a different key of the same length. */
function otherSecretSameLength(secret: string): string {
  return secret.slice(0, -1) + (secret.at(-1) === 'a' ? 'b' : 'a')
}

/**
 * miniflare's rate limiter counts in windows aligned to the wall clock (epoch = floor(now / 60 s))
 * and clears every bucket when the window rolls over. A burst that straddles a minute boundary
 * would restart the count and get 401 where 429 is due, so wait for the next window when less
 * than needMs of the current one is left.
 */
async function awaitLimiterWindow(needMs: number): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000)
  if (left < needMs) await new Promise((resolve) => setTimeout(resolve, left + 250))
}

describe('T-AUTH-1 login, session cookie and fail-closed', () => {
  it('a wrong password is 401 after the 100 ms delay, same length or not', async () => {
    for (const password of [wrongPasswordSameLength(), `${realSecret('SITE_PASSWORD')}${realSecret('SITE_PASSWORD').at(-1)}`]) {
      const started = Date.now()
      const res = await postLogin(password)
      const elapsed = Date.now() - started
      expect(res.status).toBe(401)
      expect(res.headers.get('set-cookie')).toBeNull()
      const body = (await res.json()) as Record<string, unknown>
      expect(body.error).toBe('unauthorized')
      expect(typeof body.message).toBe('string')
      expect(elapsed).toBeGreaterThanOrEqual(100)
    }
  })

  it('the right password is 204 with a signed 12 h cookie carrying every attribute', async () => {
    const before = nowSeconds()
    const res = await postLogin(realSecret('SITE_PASSWORD'))
    expect(res.status).toBe(204)
    const header = res.headers.get('set-cookie') ?? ''
    expect(header).toMatch(/^cdp_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/)
    const attributes = header.split(';').slice(1).map((a) => a.trim())
    expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']))

    const value = header.split(';')[0].slice('cdp_session='.length)
    const session = await verifySession(realSecret('SESSION_SECRET'), value)
    expect(session).not.toBeNull()
    expect(session?.sub).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(session?.exp).toBeGreaterThanOrEqual(before + SESSION_TTL_SECONDS)
    expect(session?.exp).toBeLessThanOrEqual(nowSeconds() + SESSION_TTL_SECONDS)
  })

  it('each login gets a fresh random subject', async () => {
    const a = await verifySession(realSecret('SESSION_SECRET'), cookieValue(await loginCookie()))
    const b = await verifySession(realSecret('SESSION_SECRET'), cookieValue(await loginCookie()))
    expect(a?.sub).not.toBe(b?.sub)
  })

  it('the login cookie passes requireSession; no cookie is 401 unauthorized', async () => {
    const cookie = await loginCookie()
    const ok = await probeApp().fetch(new Request(`${BASE}/api/probe`, { headers: { cookie } }), env)
    expect(ok.status).toBe(200)
    const session = await verifySession(realSecret('SESSION_SECRET'), cookieValue(cookie))
    expect(await ok.json()).toEqual({ sub: session?.sub })

    const anonymous = await probeApp().fetch(new Request(`${BASE}/api/probe`), env)
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toEqual({ error: 'unauthorized', message: 'Sign in to continue.' })
  })

  it('the production app guards every /api/* path but the open ones', async () => {
    const anonymous = await SELF.fetch(`${BASE}/api/overview`)
    expect(anonymous.status).toBe(401)
    expect(((await anonymous.json()) as { error: string }).error).toBe('unauthorized')

    // Past the guard, the route answers, and a path with no endpoint is a 404 envelope, not a 401.
    const cookie = await loginCookie()
    expect((await SELF.fetch(`${BASE}/api/overview`, { headers: { cookie } })).status).toBe(200)
    const signedIn = await SELF.fetch(`${BASE}/api/overview/missing`, { headers: { cookie } })
    expect(signedIn.status).toBe(404)
    expect(((await signedIn.json()) as { error: string }).error).toBe('not_found')
    expect((await SELF.fetch(`${BASE}/api/overview/missing`)).status).toBe(401)

    expect((await SELF.fetch(`${BASE}/health`)).status).toBe(200)
  })

  it('the guard covers POSTs too: only POST /api/login and POST /api/logout are open', async () => {
    // A signed-out JSON POST to a protected path is 401, never 404 (the mutant that opened every
    // POST would let future segment exports and assistant calls through without a session).
    const anonymous = await SELF.fetch(`${BASE}/api/overview`, { method: 'POST', headers: JSON_HEADERS, body: '{}' })
    expect(anonymous.status).toBe(401)
    expect(((await anonymous.json()) as { error: string }).error).toBe('unauthorized')

    const cookie = await loginCookie()
    const signedIn = await SELF.fetch(`${BASE}/api/overview`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: '{}' })
    expect(signedIn.status).toBe(404)
    expect(((await signedIn.json()) as { error: string }).error).toBe('not_found')

    // The open set is POST-only: an anonymous GET to /api/login is guarded like any other path.
    expect((await SELF.fetch(`${BASE}/api/login`)).status).toBe(401)

    // Same on the test-local app, where a POST route actually exists past the guard.
    const probeAnonymous = await probeApp().fetch(new Request(`${BASE}/api/probe`, { method: 'POST', headers: JSON_HEADERS, body: '{}' }), env)
    expect(probeAnonymous.status).toBe(401)
    const probeSignedIn = await probeApp().fetch(new Request(`${BASE}/api/probe`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: '{}' }), env)
    expect(probeSignedIn.status).toBe(200)
    expect(((await probeSignedIn.json()) as { method: string }).method).toBe('POST')
  })

  it('the cookie signature is HMAC-SHA256 keyed by SESSION_SECRET over the payload part', async () => {
    const value = cookieValue(await loginCookie())
    const [payload, signature] = value.split('.')
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(realSecret('SESSION_SECRET')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
    expect(signature === base64Url(expected)).toBe(true)
    const decoded = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))) as Record<string, unknown>
    expect(Object.keys(decoded).sort()).toEqual(['exp', 'sub'])
  })

  it('a valid-looking cookie signed with any other secret is 401', async () => {
    const forged = await signSession(otherSecretSameLength(realSecret('SESSION_SECRET')), { sub: crypto.randomUUID(), exp: nowSeconds() + SESSION_TTL_SECONDS })
    const res = await probeApp().fetch(new Request(`${BASE}/api/probe`, { headers: { cookie: `cdp_session=${forged}` } }), env)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('unauthorized')
  })

  it('an expired cookie signed with the real secret is 401', async () => {
    for (const exp of [nowSeconds() - 1, nowSeconds()]) {
      // exp equal to now is already expired (the boundary is exclusive).
      const value = await signSession(realSecret('SESSION_SECRET'), { sub: crypto.randomUUID(), exp })
      const res = await probeApp().fetch(new Request(`${BASE}/api/probe`, { headers: { cookie: `cdp_session=${value}` } }), env)
      expect(res.status).toBe(401)
    }
  })

  it('a tampered signature, a tampered payload and a malformed value are 401', async () => {
    const value = cookieValue(await loginCookie())
    const [payload, signature] = value.split('.')
    const mid = Math.floor(signature.length / 2)
    const flipped = signature.slice(0, mid) + (signature[mid] === 'A' ? 'B' : 'A') + signature.slice(mid + 1)
    const forgedPayload = btoa(JSON.stringify({ sub: crypto.randomUUID(), exp: nowSeconds() + 365 * 24 * 3600 }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
    for (const tampered of [`${payload}.${flipped}`, `${forgedPayload}.${signature}`, `${payload}.${signature.slice(0, -2)}`, payload, `${value}.x`]) {
      const res = await probeApp().fetch(new Request(`${BASE}/api/probe`, { headers: { cookie: `cdp_session=${tampered}` } }), env)
      expect(res.status).toBe(401)
    }
  })

  it('missing SESSION_SECRET is 500 server_misconfigured, never 200 or 204', async () => {
    const broken = envWithout('SESSION_SECRET')
    const login = await app.fetch(
      new Request(`${BASE}/api/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ password: realSecret('SITE_PASSWORD') }) }),
      broken,
    )
    expect(login.status).toBe(500)
    expect(login.headers.get('set-cookie')).toBeNull()
    const body = (await login.json()) as { error: string; message: string }
    expect(body.error).toBe('server_misconfigured')
    expect(body.message).toContain('SESSION_SECRET')

    // Without assertBindings in front, requireSession itself fails closed, even for a valid cookie.
    const cookie = await loginCookie()
    const probe = await probeApp().fetch(new Request(`${BASE}/api/probe`, { headers: { cookie } }), broken)
    expect(probe.status).toBe(500)
    expect(((await probe.json()) as { error: string }).error).toBe('server_misconfigured')
  })

  it('missing SITE_PASSWORD is 500 server_misconfigured, never a login', async () => {
    const res = await app.fetch(
      new Request(`${BASE}/api/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ password: realSecret('SITE_PASSWORD') }) }),
      envWithout('SITE_PASSWORD'),
    )
    expect(res.status).toBe(500)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(((await res.json()) as { message: string }).message).toContain('SITE_PASSWORD')
  })

  it('the login route fails closed by itself, without assertBindings in front', async () => {
    const bare = new Hono<AppEnv>()
    bare.route('/api', loginRoutes)
    bare.onError(onError)
    for (const missing of ['SESSION_SECRET', 'SITE_PASSWORD'] as const) {
      const res = await bare.fetch(
        new Request(`${BASE}/api/login`, { method: 'POST', headers: { ...JSON_HEADERS, 'cf-connecting-ip': documentationIp() }, body: JSON.stringify({ password: realSecret('SITE_PASSWORD') }) }),
        envWithout(missing),
      )
      expect(res.status).toBe(500)
      expect(res.headers.get('set-cookie')).toBeNull()
      expect(await res.json()).toEqual({ error: 'server_misconfigured', message: `The server is missing required configuration: ${missing}.` })
    }
  })

  it('logout is open and clears the cookie with 204', async () => {
    const res = await SELF.fetch(`${BASE}/api/logout`, { method: 'POST', headers: JSON_HEADERS, body: '{}' })
    expect(res.status).toBe(204)
    const header = res.headers.get('set-cookie') ?? ''
    expect(header).toMatch(/^cdp_session=;/)
    // The same Path and flags as the login cookie, or the browser keeps the login cookie.
    const attributes = header.split(';').slice(1).map((a) => a.trim())
    expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=0']))
  })

  it('a login POST without a JSON content type is 415, with charset is accepted', async () => {
    const password = realSecret('SITE_PASSWORD')
    const contentTypes: Record<string, string>[] = [
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      { 'content-type': 'application/jsonx' },
      {},
    ]
    for (const headers of contentTypes) {
      const res = await SELF.fetch(`${BASE}/api/login`, { method: 'POST', headers, body: JSON.stringify({ password }) })
      expect(res.status).toBe(415)
      expect(((await res.json()) as { error: string }).error).toBe('unsupported_media_type')
      expect(res.headers.get('set-cookie')).toBeNull()
    }
    const charset = await postLogin(password, { 'content-type': 'application/json; charset=utf-8' })
    expect(charset.status).toBe(204)
  })

  it('every /api/* POST needs a JSON content type: logout, and a signed-in POST to another path', async () => {
    const logout = await SELF.fetch(`${BASE}/api/logout`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
    expect(logout.status).toBe(415)
    expect(logout.headers.get('set-cookie')).toBeNull()
    // requireJson runs before requireSession (worker/index.ts), so this is 415 whether or not
    // the caller is signed in; signed in, the path would otherwise reach the 404 envelope.
    const cookie = await loginCookie()
    const other = await SELF.fetch(`${BASE}/api/overview`, { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{}' })
    expect(other.status).toBe(415)
    expect(((await other.json()) as { error: string }).error).toBe('unsupported_media_type')
  })

  it('a body without a string password is 400 invalid_body', async () => {
    const res = await SELF.fetch(`${BASE}/api/login`, { method: 'POST', headers: { ...JSON_HEADERS, 'cf-connecting-ip': documentationIp() }, body: '{}' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_body')
  })

  it('the 11th attempt from one IP within a minute is 429 rate_limited', { timeout: 20_000 }, async () => {
    // 13 requests take about 1.5 s; leave a wide margin for a loaded machine.
    await awaitLimiterWindow(8_000)
    const ip = { 'cf-connecting-ip': documentationIp() }
    const wrong = wrongPasswordSameLength()
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect((await postLogin(wrong, ip)).status).toBe(401)
    }
    const eleventh = await postLogin(wrong, ip)
    expect(eleventh.status).toBe(429)
    expect(((await eleventh.json()) as { error: string }).error).toBe('rate_limited')
    // The limit applies even to the right password, and is per IP.
    expect((await postLogin(realSecret('SITE_PASSWORD'), ip)).status).toBe(429)
    expect((await postLogin(realSecret('SITE_PASSWORD'), { 'cf-connecting-ip': documentationIp() })).status).toBe(204)
  })
})

describe('constant-time comparison without crypto.subtle.timingSafeEqual (fallback loop)', () => {
  it('the fallback loop finds a difference in any byte position', () => {
    const subtle = crypto.subtle as { timingSafeEqual?: unknown }
    const native = subtle.timingSafeEqual
    subtle.timingSafeEqual = undefined
    try {
      expect(typeof crypto.subtle.timingSafeEqual).toBe('undefined')
      const secret = new TextEncoder().encode(realSecret('SESSION_SECRET'))
      expect(timingSafeEqual(secret, secret.slice())).toBe(true)
      for (const i of [0, Math.floor(secret.length / 2), secret.length - 1]) {
        const changed = secret.slice()
        changed[i] ^= 1
        expect(timingSafeEqual(secret, changed)).toBe(false)
      }
      expect(timingSafeEqual(secret, secret.slice(1))).toBe(false)
      expect(constantTimeStringEq(realSecret('SITE_PASSWORD'), realSecret('SITE_PASSWORD'))).toBe(true)
      expect(constantTimeStringEq(wrongPasswordSameLength(), realSecret('SITE_PASSWORD'))).toBe(false)
    } finally {
      subtle.timingSafeEqual = native
    }
    expect(typeof crypto.subtle.timingSafeEqual).toBe('function')
  })
})

describe('assertBindings (fail fast)', () => {
  it('names every missing binding and secret in one error', () => {
    expect(() =>
      assertBindings(
        envWithout(
          'DB',
          'WEBHOOK_SECRET',
          'PII_KEY_SECRET',
          'SITE_PASSWORD',
          'SESSION_SECRET',
          'LOGIN_LIMITER',
          'WEBHOOK_LIMITER',
          'ASSISTANT_LIMITER',
          'EXPORT_LIMITER',
          'TEST_EVENT_LIMITER',
        ),
      ),
    ).toThrow(
      'DB, WEBHOOK_SECRET, PII_KEY_SECRET, SITE_PASSWORD, SESSION_SECRET, LOGIN_LIMITER, WEBHOOK_LIMITER, ASSISTANT_LIMITER, EXPORT_LIMITER, TEST_EVENT_LIMITER',
    )
  })

  it('runs before routing: /health with a missing TEST_EVENT_LIMITER is 500 naming it (POST /api/events/test needs it; catches TEST_EVENT_LIMITER dropped from the required list)', async () => {
    const res = await app.fetch(new Request(`${BASE}/health`), envWithout('TEST_EVENT_LIMITER'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'server_misconfigured', message: 'The server is missing required configuration: TEST_EVENT_LIMITER.' })
  })

  it('treats an empty secret as missing and does not check ANTHROPIC_API_KEY', async () => {
    expect(() => assertBindings({ ...env, WEBHOOK_SECRET: '' })).toThrow('WEBHOOK_SECRET')
    expect(() => assertBindings(envWithout('ANTHROPIC_API_KEY'))).not.toThrow()
    expect((await app.fetch(new Request(`${BASE}/health`), envWithout('ANTHROPIC_API_KEY'))).status).toBe(200)
  })

  it('boots and serves with no TOOL_APPROVAL binding (the approval queue, and its secret, are gone)', async () => {
    // TOOL_APPROVAL is not a key of Env any more (worker-configuration.d.ts no longer declares it,
    // since it comes from .dev.vars.example having no such line); envWithout can't take it as a
    // (keyof Env)[] arg, so this test deletes it from a plain copy instead. The guard stays real:
    // if TOOL_APPROVAL were ever added back to SECRET_NAMES, assertBindings would see it absent
    // here and throw, same as it does today for any other secret envWithout removes.
    const withoutToolApproval: Partial<Env> = { ...env }
    delete (withoutToolApproval as Record<string, unknown>).TOOL_APPROVAL
    expect(() => assertBindings(withoutToolApproval)).not.toThrow()
    expect((await app.fetch(new Request(`${BASE}/health`), withoutToolApproval as Env)).status).toBe(200)
  })

  it('runs before routing: /health with a missing limiter is 500 naming it', async () => {
    const res = await app.fetch(new Request(`${BASE}/health`), envWithout('WEBHOOK_LIMITER'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'server_misconfigured', message: 'The server is missing required configuration: WEBHOOK_LIMITER.' })
  })
})

describe('T-AUTH-2 error bodies carry no secrets', () => {
  it('a forced 500 and the /health body contain none of the secret values', async () => {
    const forced = await app.fetch(new Request(`${BASE}/health`), envWithout('DB'))
    expect(forced.status).toBe(500)
    const forcedText = await forced.text()
    expect(JSON.parse(forcedText).error).toBe('server_misconfigured')

    const health = await SELF.fetch(`${BASE}/health`)
    expect(health.status).toBe(200)
    const healthText = await health.text()

    for (const secret of secretValues()) {
      expect(forcedText.includes(secret)).toBe(false)
      expect(healthText.includes(secret)).toBe(false)
    }
  })

  it('a malformed login body carrying a secret is 400 and no log line contains any secret', async () => {
    // V8 JSON SyntaxError messages quote the start of the input, so logging the parse error would
    // write the submitted password to Worker logs. Every console method is replaced (not wrapped),
    // so nothing reaches the test output even if this assertion fails.
    const logged: string[] = []
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
    const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' '))))
    try {
      for (const secret of secretValues()) {
        for (const body of [secret, `{"password":${secret}}`, `{"password":"${secret}"`]) {
          const res = await app.fetch(
            new Request(`${BASE}/api/login`, { method: 'POST', headers: { ...JSON_HEADERS, 'cf-connecting-ip': documentationIp() }, body }),
            env,
          )
          expect(res.status).toBe(400)
          const text = await res.text()
          expect(JSON.parse(text).error).toBe('invalid_body')
          expect(text.includes(secret)).toBe(false)
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(logged).toContain(JSON.stringify({ at: 'login', outcome: 'invalid_body', error: 'SyntaxError' }))
    // V8 quotes only a window of about ten characters around the error for longer input, so a
    // whole-value includes() would miss the leak: check every 8-character fragment of every secret.
    for (const line of logged) {
      for (const secret of secretValues()) expect(containsFragment(line, secret, 8)).toBe(false)
    }
  })

  it('an unexpected error is a generic internal_error with no stack in the body', async () => {
    const probe = new Hono<AppEnv>()
    probe.get('/api/throws', () => {
      throw new Error('probe route failure')
    })
    probe.onError(onError)
    const res = await probe.fetch(new Request(`${BASE}/api/throws`), env)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'internal_error', message: 'Something went wrong on the server. The error has been logged.' })
    expect(text).not.toContain('probe route failure')
    expect(text).not.toContain('auth.test')
  })
})
