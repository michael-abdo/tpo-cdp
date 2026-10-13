// Routes for Tuesday's screens (06 §Navigation): /login, / (Overview), /lookup, /segments.
// Every page except /login sits under the top bar; the session itself is checked by the API,
// whose 401 sends the browser back to /login (src/api.ts).

import { useEffect, useState } from 'react'
import { Navigate, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router'
import { TODAY } from '../shared/config'
import { errorMessage, request, setUnauthorizedHandler } from './api'
import LoginPage from './pages/LoginPage'
import LookupPage from './pages/LookupPage'
import OverviewPage from './pages/OverviewPage'
import SegmentsPage from './pages/SegmentsPage'

const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/lookup', label: 'Lookup' },
  { to: '/segments', label: 'Segments' },
] as const

function TopBar() {
  const navigate = useNavigate()
  const [logoutError, setLogoutError] = useState<string | null>(null)

  async function logout() {
    setLogoutError(null)
    try {
      await request('/api/logout', { method: 'POST', body: {} })
      navigate('/login', { replace: true })
    } catch (err) {
      setLogoutError(errorMessage(err))
    }
  }

  return (
    <header className="flex flex-wrap items-center gap-4 border-b border-gray-200 px-6 py-3">
      <span className="font-semibold">TPO Mini CDP</span>
      <nav className="flex gap-3 text-sm">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end
            className={({ isActive }) => (isActive ? 'font-semibold underline' : 'text-gray-600 hover:underline')}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <span className="ml-auto rounded bg-gray-100 px-2 py-1 text-xs text-gray-700">Today: {TODAY}</span>
      <button type="button" onClick={logout} className="text-sm text-gray-600 hover:underline">
        Log out
      </button>
      {logoutError !== null && <span className="w-full text-sm text-red-700">{logoutError}</span>}
    </header>
  )
}

function Shell() {
  return (
    <div className="min-h-dvh bg-white text-gray-900">
      <TopBar />
      <main className="mx-auto max-w-6xl space-y-6 p-6">
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
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
