// The main nav's data (06 §Nav, 09 D-71): one array, the single source both the desktop nav and the
// phone nav read (src/App.tsx TopBar), and that Shell reads (flatNavLinks) to title the document.
// Kept out of App.tsx itself (a component file, real JSX) so this plain data needs no JSX to read —
// test/ui/nav.test.ts imports it as an ordinary module, and App.tsx stays a components-only export
// (react-refresh's only-export-components rule, oxlint).

import { ICONS } from './components'
import type { LucideIcon } from './components'

/** A real page the nav can link straight to. */
export type NavLinkItem = { to: string; label: string; icon: LucideIcon }
/** A disclosure that groups several pages under one label: the data IS the dropdown. */
export type NavGroupEntry = { kind: 'group'; label: string; icon: LucideIcon; items: readonly NavLinkItem[] }
export type NavEntry = ({ kind: 'link' } & NavLinkItem) | NavGroupEntry

/**
 * Nav labels are the brief's words for each screen (06 §Vocabulary, 09 D-66, D-67; principles 1, 4);
 * "Insights" is D-64's. Single source of truth (09 D-71 requirement 4): Overview · Look up ·
 * Segments · Insights stay top-level; App events and AI audit log fold into the "Techy" group,
 * declared here and nowhere else, kept last.
 */
export const NAV: readonly NavEntry[] = [
  { kind: 'link', to: '/', label: 'Overview', icon: ICONS.overview },
  { kind: 'link', to: '/lookup', label: 'Look up', icon: ICONS.lookup },
  { kind: 'link', to: '/segments', label: 'Segments', icon: ICONS.segments },
  { kind: 'link', to: '/insights', label: 'Insights', icon: ICONS.insights },
  {
    kind: 'group',
    label: 'Techy',
    icon: ICONS.techy,
    items: [
      { to: '/events', label: 'App events', icon: ICONS.events },
      { to: '/audit', label: 'AI audit log', icon: ICONS.audit },
    ],
  },
]

/** Every real page NAV can link to, top-level or inside a group, in nav order. */
export function flatNavLinks(nav: readonly NavEntry[]): readonly NavLinkItem[] {
  return nav.flatMap((entry) => (entry.kind === 'group' ? entry.items : [entry]))
}

/** NavLink's own default (non-`end`) activeness: the path itself, or anything nested under it. */
export function underNav(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`)
}
