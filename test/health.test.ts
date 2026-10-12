import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { TODAY } from '../shared/config'

// Harness smoke test: the Worker runs in workerd, D1 answers, and TODAY is the fixed date (02 §Time).
describe('GET /health', () => {
  it('reports the database and the fixed TODAY', async () => {
    const res = await SELF.fetch('http://cdp.test/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, db: true, today: TODAY })
  })

  it('TODAY is 2026-09-28, the date the brief says to treat as today', () => {
    expect(TODAY).toBe('2026-09-28')
  })
})
