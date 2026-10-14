// /login (06 §/login, D2): one password field. A wrong password shows "Wrong password" and
// nothing else, plus a neutral rate-limit notice; a 429 shows the rate-limit message from the 04
// envelope. The error is tied to the field (aria-invalid + aria-describedby) and "Signing in…"
// is announced (06 §UI principles 7).

import { type FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError, errorMessage, request } from '../api'
import { LockKeyhole } from 'lucide-react'
import { Announcer, Button, ComingSoonTag, ErrorLine, GatedNote, ICONS, Icon } from '../components'
import { useGated } from '../use-gated'

const ERROR_ID = 'login-error'
const NOTICE_ID = 'login-limit'

export default function LoginPage() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sso = useGated('work_sign_in')

  useEffect(() => {
    document.title = 'Sign in · TPO Mini CDP'
  }, [])

  // The neutral limit notice follows a plain miss; a 429's own message already says it (principle 5).
  const missed = error === 'Wrong password'

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
    <main className="flex min-h-dvh items-center justify-center bg-page p-4 text-ink sm:p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-line bg-surface p-6 shadow-soft sm:p-8"
      >
        <div className="space-y-2">
          <span className="inline-flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Icon icon={LockKeyhole} className="size-5" />
          </span>
          <h1 className="font-display text-2xl font-medium">Sign in to TPO Mini CDP</h1>
          <p className="text-sm text-ink-muted">Use the team password.</p>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error !== null ? true : undefined}
            aria-describedby={error === null ? undefined : missed ? `${ERROR_ID} ${NOTICE_ID}` : ERROR_ID}
            className={`w-full rounded-lg border bg-surface px-3 py-2 text-ink ${error !== null ? 'border-red-400' : 'border-line-strong'}`}
          />
        </label>
        {error !== null && (
          <div className="space-y-1">
            <ErrorLine id={ERROR_ID} message={error} />
            {missed && (
              <p id={NOTICE_ID} className="text-xs text-gray-600">
                After several misses in a row, sign-in pauses for a minute.
              </p>
            )}
          </div>
        )}
        <Button type="submit" variant="primary" disabled={busy} className="w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <Announcer message={busy ? 'Signing in…' : ''} />

        {/* Gated (09 D-80, 22-pages/login.md §2.1): below the real path, never above it. */}
        <div aria-hidden="true" className="flex items-center gap-2 text-xs text-ink-muted">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>
        <div className="space-y-1">
          <button
            type="button"
            {...sso.bind}
            onClick={sso.activate}
            className="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-surface-2 px-3.5 py-1.5 text-sm font-medium text-ink-muted"
          >
            <Icon icon={ICONS.workSignIn} />
            Sign in with your work account
          </button>
          <ComingSoonTag />
          <GatedNote id={sso.noteId} activated={sso.activated} text={sso.feature.note} />
        </div>
      </form>
    </main>
  )
}
