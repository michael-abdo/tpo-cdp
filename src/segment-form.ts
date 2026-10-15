// The /segments form as data: the form's state, the
// two conversions between it and the API's filters (toFilters, toForm), and the server's 400
// problems turned into plain words for the field they name (filterProblems). Pure: no React, no
// fetch, no storage, so test/ui/segment-form.test.ts checks every filter key without a browser.
// The browser never normalizes or range-checks a value: a number box is sent
// as typed and the server's `invalid_filters` details say what is wrong. The limits in those
// sentences are read from the server's own words, so the page never writes a second copy of them
// (their one home is shared/segment-filters.ts).

import type { AppEventName } from '../shared/app-events'
import { FILTER_KEYS, type FilterKey, type SegmentFilters } from '../shared/segment-filters'
import { SUBSCRIBER_STATUSES, type SubscriberStatus } from '../worker/ingest/quarantine'
import { monthLabel } from './labels'

/** The form's state: strings and flags as the inputs hold them, turned into API filters on submit. */
export interface Form {
  /** One status, or 'all' for every status. */
  status: SubscriberStatus | 'all'
  sources: string[]
  /** Blank = no recency filter. */
  days: string
  includeNeverOpened: boolean
  hasApp: 'any' | 'yes' | 'no'
  // More filters: blank = not set.
  signedUpDays: string
  /** '', 'any' or a `YYYY-MM` month. */
  wentCold: string
  engagementFrom: string
  engagementTo: string
  siteDays: string
  sitePage: string
  appDays: string
  appEvent: AppEventName | ''
}

export type FormField = keyof Form

export const DEFAULT_FORM: Form = {
  status: 'active',
  sources: [],
  days: '',
  includeNeverOpened: false,
  hasApp: 'any',
  signedUpDays: '',
  wentCold: '',
  engagementFrom: '',
  engagementTo: '',
  siteDays: '',
  sitePage: '',
  appDays: '',
  appEvent: '',
}

/** The form field that holds each filter key: typed over every FilterKey, so a new key needs a box. */
export const FIELD_OF: { readonly [K in FilterKey]: FormField } = {
  status: 'status',
  source: 'sources',
  days_since_open_gte: 'days',
  include_never_opened: 'includeNeverOpened',
  went_cold: 'wentCold',
  signed_up_within_days: 'signedUpDays',
  engagement_gte: 'engagementFrom',
  engagement_lte: 'engagementTo',
  has_app: 'hasApp',
  site_visit_within_days: 'siteDays',
  site_visit_page: 'sitePage',
  app_active_within_days: 'appDays',
  app_event: 'appEvent',
}

/** Each field's label as the page shows it: the one home of these words on /segments. */
export const FIELD_LABEL: { readonly [F in FormField]: string } = {
  status: 'Status',
  sources: 'Acquisition source',
  days: "Haven't opened an email in at least",
  includeNeverOpened: 'Also include people who never opened',
  hasApp: 'App account',
  signedUpDays: 'Signed up in the last',
  wentCold: 'Went cold',
  engagementFrom: 'Engagement from',
  engagementTo: 'Engagement to',
  siteDays: 'Visited the site in the last',
  sitePage: 'Page',
  appDays: 'Used the app in the last',
  appEvent: 'Event',
}

/** The input id of each field on the page, so a problem can sit next to its box (aria-describedby). */
export const FIELD_ID: { readonly [F in FormField]: string } = {
  status: 'status',
  sources: 'sources',
  days: 'days',
  includeNeverOpened: 'include-never-opened',
  hasApp: 'has-app',
  signedUpDays: 'signed-up-days',
  wentCold: 'went-cold',
  engagementFrom: 'engagement-from',
  engagementTo: 'engagement-to',
  siteDays: 'site-days',
  sitePage: 'site-page',
  appDays: 'app-days',
  appEvent: 'app-event',
}

/** The number boxes counted in days ("… in the last N days"), whose problems say "days". */
const DAY_FIELDS: readonly FormField[] = ['days', 'signedUpDays', 'siteDays', 'appDays']

const text = (n: number | undefined) => (n === undefined ? '' : String(n))

/** API filters as the form holds them; toFilters(toForm(f)) previews the same subscribers as f. */
export function toForm(f: SegmentFilters): Form {
  return {
    status: f.status.length === 1 ? f.status[0] : 'all',
    sources: f.source ?? [],
    days: text(f.days_since_open_gte),
    includeNeverOpened: f.days_since_open_gte !== undefined && f.include_never_opened,
    hasApp: f.has_app === null || f.has_app === undefined ? 'any' : f.has_app ? 'yes' : 'no',
    signedUpDays: text(f.signed_up_within_days),
    wentCold: f.went_cold ?? '',
    engagementFrom: text(f.engagement_gte),
    engagementTo: text(f.engagement_lte),
    siteDays: text(f.site_visit_within_days),
    sitePage: f.site_visit_page ?? '',
    appDays: text(f.app_active_within_days),
    appEvent: f.app_event ?? '',
  }
}

/** A number box as sent: blank = absent; anything else is sent as typed, so the server's 400 shows. */
function num(value: string): number | undefined {
  const v = value.trim()
  return v === '' ? undefined : Number(v)
}

/** The API's filters object; only set keys are sent, so an empty More filters adds nothing. */
export function toFilters(form: Form): SegmentFilters {
  const days = num(form.days)
  const more: Partial<SegmentFilters> = {
    signed_up_within_days: num(form.signedUpDays),
    went_cold: form.wentCold === '' ? undefined : form.wentCold,
    engagement_gte: num(form.engagementFrom),
    engagement_lte: num(form.engagementTo),
    site_visit_within_days: num(form.siteDays),
    site_visit_page: form.sitePage === '' ? undefined : form.sitePage,
    app_active_within_days: num(form.appDays),
    app_event: form.appEvent === '' ? undefined : form.appEvent,
  }
  return {
    status: form.status === 'all' ? [...SUBSCRIBER_STATUSES] : [form.status],
    ...(form.sources.length === 0 ? {} : { source: form.sources }),
    ...(days === undefined ? {} : { days_since_open_gte: days }),
    include_never_opened: days !== undefined && form.includeNeverOpened,
    has_app: form.hasApp === 'any' ? null : form.hasApp === 'yes',
    ...Object.fromEntries(Object.entries(more).filter(([, v]) => v !== undefined)),
  }
}

/** How many of the five More filters are set: engagement, signed up, went cold, site visits, app activity. */
export function moreFiltersOn(f: Form): number {
  return [
    f.engagementFrom.trim() !== '' || f.engagementTo.trim() !== '',
    f.signedUpDays.trim() !== '',
    f.wentCold !== '',
    f.siteDays.trim() !== '' || f.sitePage !== '',
    f.appDays.trim() !== '' || f.appEvent !== '',
  ].filter(Boolean).length
}

/** One problem from a rejected preview: the field it names (null when it names none) and plain words. */
export interface FilterProblem {
  field: FormField | null
  message: string
}

const n = (value: string) => Number(value).toLocaleString('en-US')
const isFilterKey = (k: string): k is FilterKey => (FILTER_KEYS as readonly string[]).includes(k)

/**
 * The plain words for one problem line of a 400 `invalid_filters` (worker/segments/compile.ts
 * parseFilters writes them `<key> must …`). A line this page cannot read stays as the server
 * wrote it, with no field, so nothing the server said is lost.
 */
function problem(line: string): FilterProblem {
  const order = /^engagement_gte must not be greater than engagement_lte$/.exec(line)
  if (order !== null) {
    return {
      field: 'engagementFrom',
      message: 'Engagement: “from” must not be higher than “to”.',
    }
  }
  const head = /^(\w+) must (.*)$/.exec(line)
  if (head === null || !isFilterKey(head[1])) return { field: null, message: line }
  const field = FIELD_OF[head[1]]
  const label = FIELD_LABEL[field]
  const rule = head[2]
  const unit = DAY_FIELDS.includes(field) ? ' of days' : ''
  const range = /^be a whole number from (\d+) to (\d+)$/.exec(rule)
  if (range !== null)
    return { field, message: `${label}: enter a whole number${unit} from ${n(range[1])} to ${n(range[2])}.` }
  const atLeast = /^be a whole number of at least (\d+)$/.exec(rule)
  if (atLeast !== null)
    return { field, message: `${label}: enter a whole number${unit}, ${n(atLeast[1])} or more.` }
  const month = /^not be a month after (\d{4}-\d{2})$/.exec(rule)
  if (month !== null)
    return { field, message: `${label}: choose ${monthLabel(month[1])} or an earlier month.` }
  return { field, message: `${label}: this value can't be used. Choose one from the list.` }
}

/**
 * The problems of a rejected preview, in the order the server listed them. `details` is the
 * error envelope's list as received; anything that is not a string is skipped (fail safe: an
 * unexpected shape shows the envelope's message alone).
 */
export function filterProblems(details: readonly unknown[]): FilterProblem[] {
  return details.filter((d): d is string => typeof d === 'string').map(problem)
}

/** Each field's problems as one sentence, for the line under its box; a field with none is absent. */
export function fieldMessages(problems: readonly FilterProblem[]): Partial<Record<FormField, string>> {
  const out: Partial<Record<FormField, string>> = {}
  for (const p of problems)
    if (p.field !== null)
      out[p.field] = out[p.field] === undefined ? p.message : `${out[p.field]} ${p.message}`
  return out
}
