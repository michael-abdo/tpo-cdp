// Gated future features (09 D-80): one entry per visible control, named by the controls in
// 22-pages/00-plan.md §1 and detailed per page in 22-pages/overview.md, lookup.md, segments.md,
// insights.md, login.md. One home for every label and note (D-72): a page never retypes either; it
// reads this file through the shared `<Gated>`/`useGated` wiring (src/components.tsx), which is the
// only place the revealed sentence is built or shown.
//
// `note` is the WHOLE sentence a page reveals under the control once it is activated (D-72's "the
// note says what it will do", already spelled out per-feature in the design docs), so a page or a
// test can compare it by equality with no string-building logic to duplicate. `label` is the
// feature's plain name (used for README and tests, and in the rare case a control's own visible
// text differs from it, such as Look up's "Details" toggle for `profile_revenue`). `group` marks
// the five Segments "More filters" flags, which README lists once, under one line, per D-80 "one
// flag per feature, five parts" (segments.md §4 Q4).
//
// Ungating a feature is: find its entry here, set `comingSoon: false`, and follow its page spec's
// "Ungating checklist". Nothing else in this file changes at ungate time.

export type FeaturePage = 'overview' | 'lookup' | 'segments' | 'insights' | 'login'

export interface Feature {
  readonly id: string
  readonly page: FeaturePage
  /** The feature's plain name (22-pages §1's own words). */
  readonly label: string
  /** The whole sentence a page shows once the control is activated. */
  readonly note: string
  /** Segments' five parked filters share one README line, each ungating alone (D-80, segments.md §4 Q4). */
  readonly group?: 'more_filters'
  readonly comingSoon: true
}

export const FEATURES = {
  csv_upload: {
    id: 'csv_upload',
    page: 'overview',
    label: 'Upload a new file',
    note: 'Upload a new file — coming soon. Re-import rules for updates and unsubscribes come first.',
    comingSoon: true,
  },
  daily_sync: {
    id: 'daily_sync',
    page: 'overview',
    label: 'Automatic daily sync',
    note: 'Automatic daily sync — coming soon. It needs the upload rules first.',
    comingSoon: true,
  },
  definition_settings: {
    id: 'definition_settings',
    page: 'overview',
    label: 'Settings for definitions',
    note: 'Settings for definitions — coming soon. A change recomputes every stored score, so it must be reversible.',
    comingSoon: true,
  },
  profile_revenue: {
    id: 'profile_revenue',
    page: 'lookup',
    label: 'App revenue',
    note: 'Revenue on the profile — coming soon: app trial → paid, from Stripe.',
    comingSoon: true,
  },
  delete_person: {
    id: 'delete_person',
    page: 'lookup',
    label: 'Delete this person',
    note: 'Delete this person — coming soon: handles a deletion request end to end, with an audit record.',
    comingSoon: true,
  },
  send_to_beehiiv: {
    id: 'send_to_beehiiv',
    page: 'segments',
    label: 'Send to beehiiv',
    note: 'Send to beehiiv — coming soon. It needs a beehiiv API key that can write.',
    comingSoon: true,
  },
  filter_signed_up_between: {
    id: 'filter_signed_up_between',
    page: 'segments',
    label: 'Signed up between',
    note: 'Signed up between — coming soon. For now, use Signed up in the last.',
    group: 'more_filters',
    comingSoon: true,
  },
  filter_opened_within_days: {
    id: 'filter_opened_within_days',
    page: 'segments',
    label: 'Opened an email in the last',
    note: 'Opened an email in the last — coming soon.',
    group: 'more_filters',
    comingSoon: true,
  },
  filter_site_visits_gte: {
    id: 'filter_site_visits_gte',
    page: 'segments',
    label: 'Visited the site at least',
    note: 'Visited the site at least — coming soon.',
    group: 'more_filters',
    comingSoon: true,
  },
  filter_going_cold_risk: {
    id: 'filter_going_cold_risk',
    page: 'segments',
    label: 'At risk of going cold',
    note: 'At risk of going cold — coming soon. It needs an agreed definition first.',
    group: 'more_filters',
    comingSoon: true,
  },
  filter_email_domain: {
    id: 'filter_email_domain',
    page: 'segments',
    label: 'Email domain',
    note: 'Email domain — coming soon. It needs a privacy review first.',
    group: 'more_filters',
    comingSoon: true,
  },
  schedules_and_digests: {
    id: 'schedules_and_digests',
    page: 'insights',
    label: 'Schedules and digests',
    note: 'Schedules and digests — coming soon: email or Slack tiles on a schedule; alert when a number crosses a line.',
    comingSoon: true,
  },
  follow_up_questions: {
    id: 'follow_up_questions',
    page: 'insights',
    label: 'Follow-up questions',
    note: 'Follow-up questions — coming soon: ask "and last month?" without starting over.',
    comingSoon: true,
  },
  // Shared by /login's button and the top bar's "Your account" (login.md §2): one flag, one
  // canonical note. The top bar adds one extra true fact after it, written once in src/App.tsx
  // (TOPBAR_SSO_EXTRA), never copied back in here (login.md §2.2's own "written once in code").
  work_sign_in: {
    id: 'work_sign_in',
    page: 'login',
    label: 'Your own sign-in',
    note: 'Your own sign-in — coming soon.',
    comingSoon: true,
  },
} as const satisfies Record<string, Feature>

export type FeatureId = keyof typeof FEATURES

/** Every flag for one page, in the order declared above. */
export function featuresOn(page: FeaturePage): Feature[] {
  return Object.values(FEATURES).filter((f) => f.page === page)
}
