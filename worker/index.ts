import { Hono } from 'hono'
import { TODAY } from '../shared/config'

// Hono app mounted in front of the static assets; routes are added per 03 §Module layout.
const app = new Hono<{ Bindings: Env }>()

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

export default app
