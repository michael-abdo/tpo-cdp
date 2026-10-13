// POST /api/login and POST /api/logout (04 §Auth, 09 D-05).
// Origin: palisade app/api/app-auth/route.ts L30-110 (14 §3.1, §7), plus the rate limit the origin lacked.

import { Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { type AppEnv, requireSecret } from '../env'
import { constantTimeStringEq } from './constant-time'
import { ApiError } from './middleware'
import { newSession, SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from './session'

const FAILED_LOGIN_DELAY_MS = 100
const COOKIE_ATTRIBUTES = { httpOnly: true, secure: true, sameSite: 'Strict', path: '/' } as const

/** Mounted at /api by worker/index.ts. requireJson has already rejected non-JSON POSTs. */
export const loginRoutes = new Hono<AppEnv>()

loginRoutes.post('/login', async (c) => {
  // Fail closed before anything else: no password or no signing secret means no login, ever.
  const sitePassword = requireSecret(c.env, 'SITE_PASSWORD')
  const sessionSecret = requireSecret(c.env, 'SESSION_SECRET')

  // Cloudflare sets CF-Connecting-IP at the edge; local dev has no edge, so every local client shares one key.
  const clientKey = c.req.header('cf-connecting-ip') ?? 'local'
  const { success } = await c.env.LOGIN_LIMITER.limit({ key: clientKey })
  if (!success) {
    console.warn(JSON.stringify({ at: 'login', outcome: 'rate_limited' }))
    throw new ApiError(429, 'rate_limited', 'Too many sign-in attempts. Wait a minute and try again.')
  }

  // Log only the error's class name: V8's JSON SyntaxError message quotes the request body,
  // which here is a password attempt (CLAUDE.md: secrets never in logs).
  const body: unknown = await c.req.json().catch((err: unknown) => {
    console.warn(JSON.stringify({ at: 'login', outcome: 'invalid_body', error: err instanceof Error ? err.name : 'unknown' }))
    return undefined
  })
  const password = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).password : undefined
  if (typeof password !== 'string') {
    throw new ApiError(400, 'invalid_body', 'Send a JSON body of the form {"password": "…"}.')
  }

  if (!constantTimeStringEq(password, sitePassword)) {
    console.warn(JSON.stringify({ at: 'login', outcome: 'wrong_password' }))
    await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS))
    throw new ApiError(401, 'unauthorized', 'That password is not correct.')
  }

  setCookie(c, SESSION_COOKIE, await signSession(sessionSecret, newSession()), {
    ...COOKIE_ATTRIBUTES,
    maxAge: SESSION_TTL_SECONDS,
  })
  return c.body(null, 204)
})

loginRoutes.post('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, COOKIE_ATTRIBUTES)
  return c.body(null, 204)
})
