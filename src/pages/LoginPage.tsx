// /login (06 §/login, D2): one password field. A wrong password shows "Wrong password" and
// nothing else; a 429 shows the rate-limit message from the 04 envelope.

import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError, errorMessage, request } from '../api'
import { ErrorLine } from '../components'

export default function LoginPage() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await request('/api/login', { method: 'POST', body: { password } })
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Wrong password' : errorMessage(err))
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-white p-6 text-gray-900">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded border border-gray-200 p-6">
        <h1 className="text-lg font-semibold">TPO Mini CDP</h1>
        <label className="block space-y-1 text-sm">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2"
          />
        </label>
        {error !== null && <ErrorLine message={error} />}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
