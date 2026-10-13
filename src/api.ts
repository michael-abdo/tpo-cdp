// The one HTTP client of the UI (04). Every call sends the session cookie, a 401 from a guarded
// path hands control to the registered sign-in redirect, and any other failure surfaces the
// 04 §Error envelope's `message`. The browser never normalizes input (02 §Normalization).

/** A failed API call: the HTTP status and the envelope's `error` code and `message`. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** Paths whose 401 is an answer, not an expired session (04 §Auth open paths). */
const OPEN_PATHS = ['/api/login', '/api/logout']

let onUnauthorized: () => void = () => window.location.assign('/login')

/** The router registers an in-app redirect to /login; until then a full page load is used. */
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

/** The envelope as an ApiError; a body that is not the envelope still fails loud with its status. */
async function toApiError(res: Response): Promise<ApiError> {
  const text = await res.text()
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body === 'object' && body !== null) {
      const { error, message } = body as Record<string, unknown>
      if (typeof error === 'string' && typeof message === 'string') return new ApiError(res.status, error, message)
    }
  } catch (err) {
    console.error('api: error response is not JSON', res.status, err)
  }
  return new ApiError(res.status, 'unexpected_response', `The server answered ${res.status} ${res.statusText} without an error message.`)
}

/** fetch with credentials and the JSON content type on bodies; resolves only on a 2xx. */
export async function request(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<Response> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (res.ok) return res
  const error = await toApiError(res)
  if (res.status === 401 && !OPEN_PATHS.includes(path)) onUnauthorized()
  throw error
}

export async function getJson<T>(path: string): Promise<T> {
  return (await request(path)).json() as Promise<T>
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  return (await request(path, { method: 'POST', body })).json() as Promise<T>
}

/** The thrown value's message for display: the envelope's message for an ApiError. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
