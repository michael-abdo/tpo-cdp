// Gated future features (09 D-80): one entry per visible control, named by the controls in
// 22-pages/00-plan.md §1 and detailed per page in 22-pages/overview.md, lookup.md, segments.md,
// insights.md, login.md. One home for every label and note (D-72): a page never retypes either; it
// reads this file through the shared `<Gated>`/`useGated` wiring (src/components.tsx), which is the
// only place the revealed sentence is built or shown.
//
// `note` is the WHOLE sentence a page reveals under the control once it is activated (D-72's "the
// note says what it will do", already spelled out per-feature in the design docs), so a page or a
// test can compare it by equality with no string-building logic to duplicate. `label` is the
// feature's plain name (used for docs/notes.md and tests, and in the rare case a control's own visible
// text differs from it, such as Look up's "Details" toggle for `profile_revenue`). `group` marks
// the five Segments "More filters" flags, which docs/notes.md lists once, under one line, per D-80 "one
// flag per feature, five parts" (segments.md §4 Q4).
//
// Every entry here is gated, so `comingSoon` is typed as the literal `true`: nothing reads a
// `false`, and the type refuses one. Ungating a feature is: follow its page spec's "Ungating
// checklist", which swaps the gated control for the real one, then delete its entry here.

export type FeaturePage = 'overview' | 'lookup' | 'segments' | 'insights' | 'login'

export interface Feature {
  readonly id: string
  readonly page: FeaturePage
  /** The feature's plain name (22-pages §1's own words); used for docs/notes.md and tests. */
  readonly label: string
  /** The whole sentence a page shows once the control is activated. States what the feature will
   * do (D-72's "the note says what it will do"); never repeats "coming soon" (the chip's own
   * words) and never starts with this entry's own `label` or a `controls` entry. */
  readonly note: string
  /** Segments' five parked filters share one docs/notes.md line, each ungating alone (D-80, segments.md §4 Q4). */
  readonly group?: 'more_filters'
  /**
   * The exact visible text of each rendered control sharing this one flag, in placement order,
   * for the rare cases where a control's own on-screen words are not simply `label` (D-72 "one
   * home for every label and note": a page must render these, never retype them). Omit when the
   * single rendered control's text is `label` itself.
   */
  readonly controls?: readonly string[]
  /** Always `true`: an entry exists only while its feature is gated (see the header). */
  readonly comingSoon: true
}

// Written once, read twice (T-UI-ONE/09 D-72): csv_upload's first control's own text is this
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
  // D7 (00-plan.md §3): a deletion under one shared password cannot be attributed to a person, so
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
  // Shared by /login's button and the top bar's "Your account" (login.md §2): one flag, one
  // canonical note, read as-is by both placements (src/App.tsx's AccountButton never appends
  // anything after it — D-72, one home for the shared-team-password fact).
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
