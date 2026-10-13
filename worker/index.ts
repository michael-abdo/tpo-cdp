import { type Context, Hono } from 'hono'
import { TODAY } from '../shared/config'
import { loginRoutes } from './auth/login'
import { ApiError, requireJson, requireSession } from './auth/middleware'
import { type AppEnv, assertBindings, MissingBindingsError } from './env'
import { lookupRoutes } from './routes/lookup'
import { overviewRoutes } from './routes/overview'
import { segmentRoutes } from './routes/segments'

/**
 * The one renderer of the 04 §Error envelope {error, message, details?}. Bodies never carry
 * secrets, SQL values, row contents or stacks; an unexpected error's stack goes to the log as
 * one JSON line instead. Exported so test-local apps render errors exactly as production does.
 */
export function onError(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof ApiError) {
    const body = err.details === undefined ? { error: err.code, message: err.message } : { error: err.code, message: err.message, details: err.details }
    return c.json(body, err.status)
  }
  if (err instanceof MissingBindingsError) {
    console.error(JSON.stringify({ at: 'assertBindings', error: 'server_misconfigured', missing: err.missing }))
    return c.json({ error: 'server_misconfigured', message: err.message }, 500)
  }
  console.error(JSON.stringify({ at: 'unhandled', method: c.req.method, path: c.req.path, name: err.name, message: err.message, stack: err.stack }))
  return c.json({ error: 'internal_error', message: 'Something went wrong on the server. The error has been logged.' }, 500)
}

// Hono app mounted in front of the static assets; routes are added per 03 §Module layout.
const app = new Hono<AppEnv>()

// Fail fast (11 §Deploy): every request, before routing, names any missing binding or secret.
app.use('*', async (c, next) => {
  assertBindings(c.env)
  await next()
})

// 04 §Auth: JSON-only POSTs, then the session guard (open: POST /api/login, POST /api/logout).
app.use('/api/*', requireJson, requireSession)
app.route('/api', loginRoutes)
app.route('/api', overviewRoutes)
app.route('/api', lookupRoutes)
app.route('/api', segmentRoutes)

// Open path (04 §Auth). Reports whether D1 answers and which "today" the app is running with.
app.get('/health', async (c) => {
  let db = false
  try {
    const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
    db = row?.ok === 1
  } catch (err) {
    console.error(JSON.stringify({ at: 'health', error: String(err) }))
  }
  return c.json({ ok: db, db, today: TODAY }, db ? 200 : 503)
})

app.notFound((c) => c.json({ error: 'not_found', message: 'There is no endpoint at this path.' }, 404))
app.onError(onError)

export default app
