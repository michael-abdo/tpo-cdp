import { useEffect, useState } from 'react'
import { errorMessage, getJson } from './api'

export type GetState<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; data: T }

/**
 * GETs `path` whenever it changes (null = nothing to fetch, returns null). The settled result is
 * kept with the path it answers, so until the current path's answer arrives the state is
 * 'loading' and a stale response never shows.
 */
export function useGet<T>(path: string | null): GetState<T> | null {
  const [settled, setSettled] = useState<{ path: string; state: GetState<T> } | null>(null)
  useEffect(() => {
    if (path === null) return
    let current = true
    getJson<T>(path).then(
      (data) => current && setSettled({ path, state: { status: 'ok', data } }),
      (err: unknown) => current && setSettled({ path, state: { status: 'error', message: errorMessage(err) } }),
    )
    return () => {
      current = false
    }
  }, [path])
  if (path === null) return null
  if (settled === null || settled.path !== path) return { status: 'loading' }
  return settled.state
}
