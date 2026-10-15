// The one HTTP client of the UI. Every call sends the session cookie, a 401 from a guarded
// path hands control to the registered sign-in redirect, and any other failure surfaces the
// error envelope's `message`. The browser never normalizes input: shared/normalize.ts on the
// server is the one place that folds it.

import { TODAY } from '../shared/config'
import { ApiError, toApiError } from './api-error'
import type { SegmentFilters } from './types'

export { ApiError }

/** Paths whose 401 is an answer, not an expired session (the paths open without a session). */
const OPEN_PATHS = ['/api/login', '/api/logout']

let onUnauthorized: () => void = () => window.location.assign('/login')

/** The router registers an in-app redirect to /login; until then a full page load is used. */
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

/** fetch with credentials and the JSON content type on bodies; resolves only on a 2xx. */
export async function request(
  path: string,
  init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<Response> {
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

export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  return (await request(path, { method: 'PATCH', body })).json() as Promise<T>
}

/**
 * Export CSV (POST /api/segments/export.csv) for these filters, saved as a download.
 * One home for /segments and a segment answer on /insights (the answer card).
 */
export async function downloadSegmentCsv(filters: SegmentFilters): Promise<void> {
  const res = await request('/api/segments/export.csv', { method: 'POST', body: { filters } })
  const url = URL.createObjectURL(await res.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = `segment-${TODAY}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

/** The thrown value's message for display: the envelope's message for an ApiError. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
