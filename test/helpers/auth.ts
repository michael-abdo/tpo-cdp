import { env, SELF } from 'cloudflare:test'

/**
 * A fresh CF-Connecting-IP for one login, so tests that only need a cookie never share a
 * LOGIN_LIMITER budget (10/min per key, 04 §Auth; the limiter is live in the test pool).
 * Addresses come from 2001:db8::/32, the IPv6 range reserved for documentation (RFC 3849).
 */
export function documentationIp(): string {
  const [a, b] = crypto.getRandomValues(new Uint16Array(2))
  return `2001:db8::${a.toString(16)}:${b.toString(16)}`
}

// Signs in through the real POST /api/login with the SITE_PASSWORD from .dev.vars and returns
// the value for a Cookie request header ("cdp_session=…"). The password is never printed.
export async function loginCookie(clientIp: string = documentationIp()): Promise<string> {
  const password = env.SITE_PASSWORD
  if (!password) throw new Error('SITE_PASSWORD missing from .dev.vars; tests cannot sign in')
  const res = await SELF.fetch('http://cdp.test/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': clientIp },
    body: JSON.stringify({ password }),
  })
  if (res.status !== 204) throw new Error(`login helper: expected 204 from POST /api/login, got ${res.status} ${await res.text()}`)
  const match = res.headers.get('set-cookie')?.match(/^(cdp_session=[^;]+)/)
  if (!match) throw new Error('login helper: POST /api/login returned 204 without a cdp_session cookie')
  return match[1]
}
