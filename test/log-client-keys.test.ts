import { SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loginCookie } from './helpers/auth'

// A field name a client sends is client text and may spell an email. A 400 for an unknown field
// may name it back to that client, but the server log must not hold it.
const EMAIL_KEY = 'joy.hall830@protonmail.com'

async function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`http://cdp.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await loginCookie() },
    body: JSON.stringify(body),
  })
}

describe('an unknown field name never reaches the server log', () => {
  afterEach(() => vi.restoreAllMocks())

  for (const [path, body] of [
    ['/api/assistant', { question: 'hi', [EMAIL_KEY]: 1 }],
    ['/api/duplicates/x/review', { verdict: 'same', [EMAIL_KEY]: 1 }],
    ['/api/events/test', { user_id: 'u_2b6447a3', event: 'app_open', [EMAIL_KEY]: 1 }],
    ['/api/events/test', { resend: 'evt_x', [EMAIL_KEY]: 1 }],
  ] as const) {
    it(`${path} ${Object.keys(body)[0]}: 400, and no log line holds the key`, async () => {
      const logged: string[] = []
      for (const level of ['log', 'info', 'warn', 'error'] as const)
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
      const res = await post(path, body)
      expect(res.status).toBe(400)
      expect(logged.length).toBeGreaterThan(0)
      expect(logged.filter((line) => line.includes('joy.hall830'))).toEqual([])
    })
  }
})
