// Session and content-type guards for /api/* (04 §Auth; 03 layer 1).
// Origin: palisade website/middleware.ts L21-38, L107-111 (14 §7).

import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { type AppEnv, requireSecret } from '../env'
import { SESSION_COOKIE, verifySession } from './session'

/**
 * An expected client-facing failure. worker/index.ts `onError` renders it as the 04 §Error
 * envelope; `message` is plain English and must never carry secrets, SQL values or row contents.
 */
export class ApiError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 413 | 415 | 429 | 500 | 502 | 503
  readonly code: string
  readonly details?: readonly unknown[]
  constructor(status: ApiError['status'], code: string, message: string, details?: readonly unknown[]) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** /api/* paths open without a session (04 §Auth). GET /health sits outside /api/* and is never guarded. */
const OPEN_API_POSTS = new Set(['/api/login', '/api/logout'])

/** Every /api/* POST must be JSON: with the Strict cookie this is the CSRF defence (04 §Auth). */
export const requireJson: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'POST') {
    const mediaType = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (mediaType !== 'application/json') {
      throw new ApiError(415, 'unsupported_media_type', 'Requests must be sent with Content-Type: application/json.')
    }
  }
  await next()
}

/** Rejects /api/* requests without a valid cdp_session cookie, except the open login/logout POSTs. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'POST' && OPEN_API_POSTS.has(c.req.path)) {
    await next()
    return
  }
  const secret = requireSecret(c.env, 'SESSION_SECRET')
  const session = await verifySession(secret, getCookie(c, SESSION_COOKIE))
  if (session === null) throw new ApiError(401, 'unauthorized', 'Sign in to continue.')
  c.set('session', session)
  await next()
}
