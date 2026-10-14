// Env types and the fail-fast binding check (03 §Module layout; the list is 11 §Deploy).
// Origin: palisade site-auth.ts L19-48, the fail-closed config idea (14 §7).

/** Hono environment for every route: the Worker bindings plus the verified session (04 §Auth). */
export type AppEnv = {
  Bindings: Env
  Variables: { session: { sub: string; exp: number } }
}

/** Secrets read as strings. ANTHROPIC_API_KEY is deliberately absent: it is probed lazily on the first assistant call (11 §Deploy). */
const SECRET_NAMES = ['WEBHOOK_SECRET', 'PII_KEY_SECRET', 'SITE_PASSWORD', 'SESSION_SECRET'] as const
const LIMITER_NAMES = ['LOGIN_LIMITER', 'WEBHOOK_LIMITER', 'ASSISTANT_LIMITER', 'EXPORT_LIMITER'] as const

export type SecretName = (typeof SECRET_NAMES)[number]

/** Thrown when a binding or secret is absent; carries names only, never values. Rendered as 500 server_misconfigured (04 §Error envelope). */
export class MissingBindingsError extends Error {
  readonly missing: readonly string[]
  constructor(missing: readonly string[]) {
    super(`The server is missing required configuration: ${missing.join(', ')}.`)
    this.name = 'MissingBindingsError'
    this.missing = missing
  }
}

function hasMethod(value: unknown, method: string): boolean {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[method] === 'function'
}

/**
 * Throws one error naming every missing binding or secret, so a misconfigured deploy fails on
 * its first request with the whole list instead of one name per redeploy. An empty string
 * counts as missing. Called once per request before routing (worker/index.ts).
 */
export function assertBindings(env: Partial<Env>): asserts env is Env {
  const missing: string[] = []
  if (!hasMethod(env.DB, 'prepare')) missing.push('DB')
  for (const name of SECRET_NAMES) {
    const value = env[name]
    if (typeof value !== 'string' || value.length === 0) missing.push(name)
  }
  for (const name of LIMITER_NAMES) {
    if (!hasMethod(env[name], 'limit')) missing.push(name)
  }
  if (missing.length > 0) throw new MissingBindingsError(missing)
}

/**
 * Returns one secret or throws MissingBindingsError. The auth modules read secrets through this
 * so they stay fail-closed even when mounted without assertBindings in front (04 §Auth).
 */
export function requireSecret(env: Partial<Env>, name: SecretName): string {
  const value = env[name]
  if (typeof value !== 'string' || value.length === 0) throw new MissingBindingsError([name])
  return value
}
