// Routes for the screens built so far (06 §Navigation): /login, / (Overview), /lookup, /segments, /events,
// /insights and /audit (with /audit/:traceId for one trace). /assistant and /growth merged into
// /insights (09 D-64) and redirect there, keeping the query string, so ?q= still fills the Ask bar.
// Every page except /login sits under the top bar; the session itself is checked by the API,
// whose 401 sends the browser back to /login (src/api.ts).
// Shell a11y (06 §UI principles 7): "Skip to content" link, aria-current on the nav, focus moves to
// the new page's <h1> on navigation, and document.title follows the route.
// "Techy" (06 §Nav, 09 D-71): App events and AI audit log fold into one dropdown, last in the nav,
// following the WAI-ARIA disclosure-navigation pattern (NavGroupMenu below).

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router'
import { TODAY } from '../shared/config'
import { humanDate } from './format'
import { errorMessage, request, setUnauthorizedHandler } from './api'
import { ErrorLine, Icon, ICONS } from './components'
import { flatNavLinks, NAV, type NavGroupEntry, underNav } from './nav'
import { effectiveTheme, setTheme, type Theme } from './theme'
import AuditPage from './pages/AuditPage'
import EventsPage from './pages/EventsPage'
import InsightsPage from './pages/InsightsPage'
import LoginPage from './pages/LoginPage'
import LookupPage from './pages/LookupPage'
import OverviewPage from './pages/OverviewPage'
import SegmentsPage from './pages/SegmentsPage'

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

/** Gap between the panel and the viewport edge, and its width, px (06 §UI principles 9: never wider than the screen). */
const NAV_MENU_EDGE = 16
const NAV_MENU_WIDTH = 200

/**
 * "Techy" (06 §Nav, 09 D-71): a WAI-ARIA disclosure-navigation button that reveals App events and
 * AI audit log as real NavLinks. Click, Enter or Space toggles it; Esc closes it and returns focus
 * to the button; a click outside closes it; picking a link closes it; nothing traps focus (Tab
 * moves on to whatever sits after the button once the panel is open, since the panel's own links
 * sit right after it in the DOM). The button reads as current (same soft fill + weight as a NavLink,
 * navClass) whenever /events, /audit or /audit/:traceId is the route, with a visually-hidden
 * "(current section)" standing in for aria-current, which only ever names one real page (D-67's
 * comment on /audit/:traceId moves here: underNav's prefix match is what keeps "AI audit log"
 * current on a trace page). The panel is portalled to <body> and fixed-positioned, clamped inside
 * the viewport (phone width included), for the same reasons InfoTip is (components.tsx): it must
 * not be clipped by the header's own stacking or widen the page. Skipped where there is no
 * `document.body` (a server render, as test/ui/routes.test.ts renders the app without a DOM); the
 * live app always has one.
 */
function NavGroupMenu({ group }: { group: NavGroupEntry }) {
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const current = group.items.some((item) => underNav(pathname, item.to))

  useLayoutEffect(() => {
    const b = button.current
    const p = panel.current
    if (!open || b === null || p === null) return
    const r = b.getBoundingClientRect()
    const width = Math.min(NAV_MENU_WIDTH, window.innerWidth - 2 * NAV_MENU_EDGE)
    const left = Math.min(Math.max(NAV_MENU_EDGE, r.right - width), window.innerWidth - NAV_MENU_EDGE - width)
    p.style.width = `${width}px`
    p.style.left = `${left}px`
    p.style.top = `${r.bottom + 4}px`
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onPointer = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Node) || !(wrap.current?.contains(t) || panel.current?.contains(t))) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      close()
      button.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <span ref={wrap} className="inline-flex">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors duration-150 ${
          current
            ? 'bg-accent-soft font-semibold text-accent-strong'
            : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
        }`}
      >
        <Icon icon={group.icon} />
        {group.label}
        {current && <span className="sr-only"> (current section)</span>}
        <Icon
          icon={ICONS.navCaret}
          className={`size-3.5 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {typeof document !== 'undefined' &&
        document.body &&
        createPortal(
          <div
            ref={panel}
            id={id}
            hidden={!open}
            className="fixed z-30 rounded-lg border border-line-strong bg-surface p-1 shadow-soft"
          >
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} className={navClass} onClick={() => setOpen(false)}>
                    <Icon icon={item.icon} />
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </span>
  )
}

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

  // Only Overview needs `end`. Techy (09 D-71) marks itself current for /events, /audit and
  // /audit/:traceId with its own logic (NavGroupMenu's `underNav`), not a NavLink.
  const links = NAV.map((item) =>
    item.kind === 'group' ? (
      <NavGroupMenu key={item.label} group={item} />
    ) : (
      <NavLink key={item.to} to={item.to} end={item.to === '/'} className={navClass}>
        <Icon icon={item.icon} />
        {item.label}
      </NavLink>
    ),
  )
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
    const page = flatNavLinks(NAV).find((item) => underNav(pathname, item.to))
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

/** An old path's link lands on /insights with its query (?q=) intact (09 D-64). */
function ToInsights() {
  const { search } = useLocation()
  return <Navigate to={`/insights${search}`} replace />
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
        <Route path="insights" element={<InsightsPage />} />
        <Route path="assistant" element={<ToInsights />} />
        <Route path="growth" element={<ToInsights />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="audit/:traceId" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
