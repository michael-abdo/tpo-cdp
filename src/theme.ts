// Light/dark theme choice (09 D-60). With no saved choice the OS preference rules (index.css
// prefers-color-scheme); a saved choice sets <html data-theme>. Storage can throw (private mode,
// blocked site data), so every read and write is guarded and the page works without it.

export type Theme = 'light' | 'dark'
const KEY = 'tpo-cdp-theme'

export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

export function effectiveTheme(): Theme {
  const set = document.documentElement.dataset.theme
  if (set === 'light' || set === 'dark') return set
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyStoredTheme(): void {
  const t = storedTheme()
  if (t) document.documentElement.dataset.theme = t
}

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t
  try {
    localStorage.setItem(KEY, t)
  } catch {
    // not remembered; still applied for this visit
  }
}
