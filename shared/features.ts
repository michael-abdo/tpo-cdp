// Gated future features: each saved-for-later feature is drawn where it will live, greyed out,
// and opens a "Coming soon" pop-up with its note, so the screen shows where the product is going.
// One entry per visible control. One home for every label and note: a page never retypes either;
// it reads this file through the shared `useGated` wiring (src/use-gated.ts), and the pop-up
// (src/coming-soon-dialog.tsx) is the only place the note is shown.
//
// `note` is the WHOLE sentence the pop-up shows once the control is activated (it says what the
// feature will do), so the pop-up or a test can compare it by equality with no string-building logic to duplicate. `label` is the
// feature's plain name (used for docs/notes.md and tests, and in the rare case a control's own visible
// text differs from it, such as Look up's "Details" toggle for `profile_revenue`). `group` marks
// the five Segments "More filters" flags, which docs/notes.md lists once, under one line: one
// flag per filter, so each can ungate alone.
//
// Every entry here is gated, so `comingSoon` is typed as the literal `true`: nothing reads a
// `false`, and the type refuses one. Ungating a feature is: swap the gated control for the real
// one and wire its API, then delete its entry here.

export type FeaturePage = 'overview' | 'lookup' | 'segments' | 'insights' | 'login'

export interface Feature {
  readonly id: string
  readonly page: FeaturePage
  /** The feature's plain name; used for docs/notes.md and tests. */
  readonly label: string
  /** The whole sentence the pop-up shows once the control is activated. States what the feature
   * will do; never repeats "coming soon" (the pop-up's chip says it) and never starts with this
   * entry's own `label` or a `controls` entry. */
  readonly note: string
  /** Segments' five saved-for-later filters share one docs/notes.md line, each ungating alone. */
  readonly group?: 'more_filters'
  /**
   * The exact visible text of each rendered control sharing this one flag, in placement order,
   * for the rare cases where a control's own on-screen words are not simply `label` (one
   * home for every label and note: a page must render these, never retype them). Omit when the
   * single rendered control's text is `label` itself.
   */
  readonly controls?: readonly string[]
  /** Always `true`: an entry exists only while its feature is gated (see the header). */
  readonly comingSoon: true
}

// Written once, read twice (T-UI-ONE): csv_upload's first control's own text is this
// entry's `label`, so the identifier is reused in `controls` below rather than the literal typed
// a second time.
const UPLOAD_LABEL = 'Upload a new file'

export const FEATURES = {
  csv_upload: {
    id: 'csv_upload',
    page: 'overview',
    label: UPLOAD_LABEL,
    note: 'Load a fresh beehiiv, site or app export as a new run.',
    controls: [UPLOAD_LABEL, 'Run again'],
    comingSoon: true,
  },
  daily_sync: {
    id: 'daily_sync',
    page: 'overview',
    label: 'Automatic daily sync',
    note: 'Sync beehiiv and App accounts automatically every day, once the upload rules exist.',
    comingSoon: true,
  },
  definition_settings: {
    id: 'definition_settings',
    page: 'overview',
    label: 'Settings for definitions',
    note: 'Change how scores and windows are defined, recomputing every stored score so the change can be undone.',
    comingSoon: true,
  },
  profile_revenue: {
    id: 'profile_revenue',
    page: 'lookup',
    label: 'App revenue',
    note: 'Show this person’s revenue, from app trial through paid, pulled from Stripe.',
    controls: ['Details'],
    comingSoon: true,
  },
  // A deletion under one shared password cannot be attributed to a person, so
  // this stays gated until per-person sign-in exists — the note says so, not just that it is blocked.
  delete_person: {
    id: 'delete_person',
    page: 'lookup',
    label: 'Delete this person',
    note: 'Handle a deletion request end to end, with an audit record, once each teammate signs in as themselves.',
    comingSoon: true,
  },
  send_to_beehiiv: {
    id: 'send_to_beehiiv',
    page: 'segments',
    label: 'Send to beehiiv',
    note: 'Push this segment to beehiiv as a new list, once a beehiiv API key that can write exists.',
    comingSoon: true,
  },
  filter_signed_up_between: {
    id: 'filter_signed_up_between',
    page: 'segments',
    label: 'Signed up between',
    note: 'Match everyone who signed up between two chosen dates; use Signed up in the last for now.',
    group: 'more_filters',
    comingSoon: true,
  },
  filter_opened_within_days: {
    id: 'filter_opened_within_days',
    page: 'segments',
    label: 'Opened an email in the last',
    note: 'Match everyone who opened an email within a chosen number of days.',
    group: 'more_filters',
    comingSoon: true,
  },
  filter_site_visits_gte: {
    id: 'filter_site_visits_gte',
    page: 'segments',
    label: 'Visited the site at least',
    note: 'Match everyone with at least a chosen number of site visits.',
    group: 'more_filters',
    comingSoon: true,
  },
  filter_going_cold_risk: {
    id: 'filter_going_cold_risk',
    page: 'segments',
    label: 'At risk of going cold',
    note: 'Flag subscribers at risk of going cold, once an agreed definition exists.',
    group: 'more_filters',
    comingSoon: true,
  },
  filter_email_domain: {
    id: 'filter_email_domain',
    page: 'segments',
    label: 'Email domain',
    note: 'Match everyone whose email uses a chosen domain, once a privacy review clears it.',
    group: 'more_filters',
    comingSoon: true,
  },
  schedules_and_digests: {
    id: 'schedules_and_digests',
    page: 'insights',
    label: 'Schedules and digests',
    note: 'Send this board by email or Slack on a schedule, or alert when a number crosses a line.',
    controls: ['Send the board', 'Set an alert'],
    comingSoon: true,
  },
  follow_up_questions: {
    id: 'follow_up_questions',
    page: 'insights',
    label: 'Follow-up questions',
    note: 'Answer a follow-up question, such as "and last month?", without starting the search over.',
    // controls[0] is the field's own label (its full visible text); controls[1] is the button's
    // own visible text — just "Ask". The button also carries a hidden " a follow-up" suffix,
    // written once in src/insights/ask.tsx (never copied here), so it reads apart from the page's
    // other, unrelated "Ask" button (AskSection's own submit button) — that suffix is not this
    // entry's fact to own, since controls[0] already says the whole thing in words.
    controls: ['Ask a follow-up', 'Ask'],
    comingSoon: true,
  },
  // Shared by /login's button and the top bar's "Your account": one flag, one
  // canonical note, read as-is by both placements (src/App.tsx's AccountButton never appends
  // anything after it — one home for the shared-team-password fact).
  work_sign_in: {
    id: 'work_sign_in',
    page: 'login',
    label: 'Your own sign-in',
    note: 'Sign in with your own work account instead of the shared team password.',
    controls: ['Sign in with your work account', 'Your account'],
    comingSoon: true,
  },
} as const satisfies Record<string, Feature>

export type FeatureId = keyof typeof FEATURES

/** Every flag for one page, in the order declared above. */
export function featuresOn(page: FeaturePage): Feature[] {
  return Object.values(FEATURES).filter((f) => f.page === page)
}
