// Routes for the screens built so far (06 §Navigation): /login, / (Overview), /lookup, /segments, /events,
// /assistant, /growth and /audit (with /audit/:traceId for one trace).
// Every page except /login sits under the top bar; the session itself is checked by the API,
// whose 401 sends the browser back to /login (src/api.ts).
// Shell a11y (06 §UI principles 7): "Skip to content" link, aria-current on the nav, focus moves to
// the new page's <h1> on navigation, and document.title follows the route.

import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router'
import { TODAY } from '../shared/config'
import { humanDate } from './format'
import { errorMessage, request, setUnauthorizedHandler } from './api'
import { ErrorLine, Icon, ICONS, type LucideIcon } from './components'
import { effectiveTheme, setTheme, type Theme } from './theme'
import AssistantPage from './pages/AssistantPage'
import AuditPage from './pages/AuditPage'
import EventsPage from './pages/EventsPage'
import GrowthPage from './pages/GrowthPage'
import LoginPage from './pages/LoginPage'
import LookupPage from './pages/LookupPage'
import OverviewPage from './pages/OverviewPage'
import SegmentsPage from './pages/SegmentsPage'

/** Nav labels say what each screen does, in plain words (principles 1, 4). */
const NAV: ReadonlyArray<{ to: string; label: string; icon: LucideIcon }> = [
  { to: '/', label: 'Overview', icon: ICONS.overview },
  { to: '/lookup', label: 'Find a reader', icon: ICONS.lookup },
  { to: '/segments', label: 'Build a list', icon: ICONS.segments },
  { to: '/events', label: 'App events', icon: ICONS.events },
  { to: '/assistant', label: 'Ask a question', icon: ICONS.assistant },
  { to: '/growth', label: 'Growth', icon: ICONS.growth },
  { to: '/audit', label: 'AI audit log', icon: ICONS.audit },
]

const APP_NAME = 'TPO Mini CDP'

function navClass({ isActive }: { isActive: boolean }): string {
  // The current page reads by weight + a soft fill, not colour alone (principle 7).
  return `inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors duration-150 ${
    isActive
      ? 'bg-accent-soft font-semibold text-accent-strong'
      : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
  }`
}

const quietButton =
  'inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink'

/** Light/dark switch (09 D-60): says the theme it switches TO, remembered per browser. */
function ThemeToggle() {
  const [theme, setLocal] = useState<Theme>(() => effectiveTheme())
  const next: Theme = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      className={quietButton}
      onClick={() => {
        setTheme(next)
        setLocal(next)
      }}
    >
      <Icon icon={next === 'dark' ? ICONS.themeDark : ICONS.themeLight} />
      {next === 'dark' ? 'Dark theme' : 'Light theme'}
    </button>
  )
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
      <Icon icon={item.icon} />
      {item.label}
    </NavLink>
  ))
  const logoutButton = (
    <button type="button" onClick={logout} className={quietButton}>
      <Icon icon={ICONS.logout} />
      Log out
    </button>
  )

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2.5 sm:px-6">
        <Link to="/" className="inline-flex min-h-9 items-center gap-2 rounded-lg py-1 text-ink sm:mr-2">
          <span
            aria-hidden="true"
            className="hidden size-7 items-center justify-center rounded-lg bg-accent sm:inline-flex font-display text-sm font-semibold text-on-accent"
          >
            T
          </span>
          <span className="font-display text-base font-medium whitespace-nowrap sm:text-lg">{APP_NAME}</span>
        </Link>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs whitespace-nowrap text-gray-700">
          <Icon icon={ICONS.today} className="hidden size-3.5 sm:block" />
          Today: {humanDate(TODAY)}
        </span>
        <span className="hidden lg:inline-flex">
          <ThemeToggle />
        </span>
        <span className="hidden lg:inline-flex">{logoutButton}</span>
        <button
          ref={menuButton}
          type="button"
          aria-expanded={menuOpen}
          aria-controls="phone-menu"
          onClick={() => setMenuFor(menuOpen ? null : pathname)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-sm text-ink sm:hidden"
        >
          <Icon icon={ICONS.menu} />
          Menu
        </button>
      </div>
      <div className="mx-auto hidden max-w-6xl items-center gap-2 px-4 pb-2 sm:flex sm:px-6">
        <nav aria-label="Main" className="flex flex-wrap gap-1">
          {links}
        </nav>
        <span className="ml-auto inline-flex gap-1 lg:hidden">
          <ThemeToggle />
          {logoutButton}
        </span>
      </div>
      {menuOpen && (
        <div
          id="phone-menu"
          className="border-t border-line px-4 py-3 sm:hidden"
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
          <div className="mt-2 flex gap-1 border-t border-line pt-2">
            <ThemeToggle />
            {logoutButton}
          </div>
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
    const page = NAV.find(
      (item) => item.to === pathname || (item.to !== '/' && pathname.startsWith(`${item.to}/`)),
    )
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
    <div className="min-h-dvh bg-page text-ink">
      <a
        href="#main"
        className="sr-only z-30 rounded-lg bg-accent px-3 py-2 text-sm text-on-accent focus:not-sr-only focus:absolute focus:px-3 focus:py-2 focus:top-2 focus:left-2 focus:z-30"
      >
        Skip to content
      </a>
      <TopBar />
      <main
        id="main"
        ref={main}
        tabIndex={-1}
        className="mx-auto max-w-6xl px-4 py-6 focus:outline-none sm:px-6 sm:py-8"
      >
        {/* key = route, so the one page-enter stagger replays on each navigation (index.css). */}
        <div key={pathname} className="page-enter space-y-6">
          <Outlet />
        </div>
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
        <Route path="growth" element={<GrowthPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="audit/:traceId" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
