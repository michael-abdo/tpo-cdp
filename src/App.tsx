// Routes for the screens built so far (06 §Navigation): /login, / (Overview), /lookup, /segments, /events,
// /assistant and /audit (with /audit/:traceId for one trace).
// Every page except /login sits under the top bar; the session itself is checked by the API,
// whose 401 sends the browser back to /login (src/api.ts).
// Shell a11y (06 §UI principles 7): "Skip to content" link, aria-current on the nav, focus moves to
// the new page's <h1> on navigation, and document.title follows the route.

import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router'
import { TODAY } from '../shared/config'
import { humanDate } from './format'
import { errorMessage, request, setUnauthorizedHandler } from './api'
import { ErrorLine } from './components'
import AssistantPage from './pages/AssistantPage'
import AuditPage from './pages/AuditPage'
import EventsPage from './pages/EventsPage'
import LoginPage from './pages/LoginPage'
import LookupPage from './pages/LookupPage'
import OverviewPage from './pages/OverviewPage'
import SegmentsPage from './pages/SegmentsPage'

/** Nav labels say what each screen does, in plain words (principles 1, 4). */
const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/lookup', label: 'Find a reader' },
  { to: '/segments', label: 'Build a list' },
  { to: '/events', label: 'App events' },
  { to: '/assistant', label: 'Ask a question' },
  { to: '/audit', label: 'AI audit log' },
] as const

const APP_NAME = 'TPO Mini CDP'

function navClass({ isActive }: { isActive: boolean }): string {
  return `inline-flex min-h-6 items-center rounded px-2 py-1 text-sm ${
    isActive ? 'font-semibold text-gray-900 underline underline-offset-4' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
  }`
}

function TopBar() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [logoutError, setLogoutError] = useState<string | null>(null)
  // The phone menu belongs to the page it was opened on, so it closes on every navigation.
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const menuOpen = menuFor === pathname
  const menuButton = useRef<HTMLButtonElement>(null)

  async function logout() {
    setLogoutError(null)
    try {
      await request('/api/logout', { method: 'POST', body: {} })
      navigate('/login', { replace: true })
    } catch (err) {
      setLogoutError(errorMessage(err))
    }
  }

  // Only Overview needs `end`: on /audit/:traceId, "AI audit log" stays marked as the current page.
  const links = NAV.map((item) => (
    <NavLink key={item.to} to={item.to} end={item.to === '/'} className={navClass}>
      {item.label}
    </NavLink>
  ))
  const logoutButton = (
    <button
      type="button"
      onClick={logout}
      className="inline-flex min-h-6 items-center rounded px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 hover:text-gray-900"
    >
      Log out
    </button>
  )

  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2 sm:gap-4 sm:px-6">
        <Link to="/" className="mr-2 inline-flex min-h-6 items-center rounded py-1 font-semibold text-gray-900">
          {APP_NAME}
        </Link>
        <nav aria-label="Main" className="hidden flex-wrap gap-1 sm:flex">
          {links}
        </nav>
        <span className="ml-auto rounded bg-gray-100 px-2 py-1 text-xs whitespace-nowrap text-gray-700">Today: {humanDate(TODAY)}</span>
        <span className="hidden sm:inline-flex">{logoutButton}</span>
        <button
          ref={menuButton}
          type="button"
          aria-expanded={menuOpen}
          aria-controls="phone-menu"
          onClick={() => setMenuFor(menuOpen ? null : pathname)}
          className="inline-flex min-h-9 items-center gap-1 rounded border border-gray-300 px-2 py-1 text-sm text-gray-900 sm:hidden"
        >
          Menu
          <svg aria-hidden="true" viewBox="0 0 20 20" className={`size-4 transition-transform motion-reduce:transition-none ${menuOpen ? 'rotate-180' : ''}`}>
            <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {menuOpen && (
        <div
          id="phone-menu"
          className="border-t border-gray-200 px-4 py-2 sm:hidden"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setMenuFor(null)
              menuButton.current?.focus()
            }
          }}
        >
          <nav aria-label="Main" className="flex flex-col gap-1">
            {links}
          </nav>
          <div className="mt-1 border-t border-gray-100 pt-1">{logoutButton}</div>
        </div>
      )}
      {logoutError !== null && (
        <div className="mx-auto max-w-6xl px-4 pb-2 sm:px-6">
          <ErrorLine compact message={logoutError} next="Try again." />
        </div>
      )}
    </header>
  )
}

function Shell() {
  const { pathname } = useLocation()
  const main = useRef<HTMLElement>(null)
  // The path focus was last placed for: the first load (and StrictMode's re-run) moves nothing.
  const focusedFor = useRef(pathname)

  useEffect(() => {
    const page = NAV.find((item) => item.to === pathname || (item.to !== '/' && pathname.startsWith(`${item.to}/`)))
    document.title = page ? `${page.label} · ${APP_NAME}` : APP_NAME
    if (focusedFor.current === pathname) return
    focusedFor.current = pathname
    // A route change moves focus to the new page's heading, so screen readers hear where they are.
    const heading = main.current?.querySelector<HTMLElement>('h1')
    if (heading) {
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
      heading.focus()
    } else {
      main.current?.focus()
    }
  }, [pathname])

  return (
    <div className="min-h-dvh bg-white text-gray-900">
      <a
        href="#main"
        className="sr-only rounded bg-gray-900 px-3 py-2 text-sm text-white focus:not-sr-only focus:absolute focus:px-3 focus:py-2 focus:top-2 focus:left-2 focus:z-10"
      >
        Skip to content
      </a>
      <TopBar />
      <main id="main" ref={main} tabIndex={-1} className="mx-auto max-w-6xl space-y-6 px-4 py-6 focus:outline-none sm:px-6">
        <Outlet />
      </main>
    </div>
  )
}

export default function App() {
  const navigate = useNavigate()
  useEffect(() => {
    setUnauthorizedHandler(() => navigate('/login', { replace: true }))
  }, [navigate])

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Shell />}>
        <Route index element={<OverviewPage />} />
        <Route path="lookup" element={<LookupPage />} />
        <Route path="segments" element={<SegmentsPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="assistant" element={<AssistantPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="audit/:traceId" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
