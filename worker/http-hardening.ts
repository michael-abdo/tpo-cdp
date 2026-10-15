// Response headers and the https rule for everything the Worker answers itself: /api/*,
// /webhooks/* and /health (wrangler.jsonc `run_worker_first`). The SPA's static files never reach
// the Worker; public/_headers gives them the same security headers, and
// test/http-hardening.test.ts keeps the two lists equal.

import type { MiddlewareHandler } from 'hono'
import { HOSTED_URL } from '../shared/config'
import { ApiError } from './auth/middleware'
import type { AppEnv } from './env'

/**
 * The Content-Security-Policy for the app. The built SPA is one module script and one stylesheet
 * from /assets, fonts bundled beside them, inline SVG icons and same-origin fetches to /api, with
 * no inline script or style tag, so it runs under this as written. `img-src data:` is for images
 * a stylesheet may inline.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

/**
 * The security headers on every response, the Worker's and the static files' alike. HSTS asks the
 * browser to use https for a year; workers.dev is under the .dev top-level domain, which browsers
 * already load over https only. `same-origin` keeps a page's URL (a Look up query can hold an
 * email) from being sent to any other site, while same-site requests keep their Origin header.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
}

/** Every Worker response is live data (a session, a segment, a health check): never stored by a browser or a proxy. */
export const WORKER_CACHE_CONTROL = 'no-store'

/** Sets SECURITY_HEADERS and `Cache-Control: no-store` on every Worker response, errors and 404s included. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next()
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value)
  c.res.headers.set('Cache-Control', WORKER_CACHE_CONTROL)
}

/** The deployed host. Plain http to it is moved to https; any other host (local dev, tests) is left alone. */
export const HOSTED_HOST = new URL(HOSTED_URL).host

/**
 * Plain http to the deployed host: a GET or HEAD is redirected (301) to the same URL on https; any
 * other method is refused with 403 `https_required` before it is read, since a redirect would send
 * a body (a password, a signed event) over plain http a second time. http://localhost and every
 * other host keep working, so `npm run dev` is unaffected.
 */
export const httpsOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = new URL(c.req.url)
  if (url.protocol === 'http:' && url.host === HOSTED_HOST) {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      url.protocol = 'https:'
      return c.redirect(url.toString(), 301)
    }
    // The method only: a path is the sender's text and could hold anything.
    console.warn(JSON.stringify({ at: 'https-only', outcome: 'refused', status: 403, method: c.req.method }))
    throw new ApiError(403, 'https_required', `This server takes requests over https only. Send it again to ${HOSTED_URL}.`)
  }
  await next()
}
