// The /segments form as data (06 §/segments, 09 D-69, 19-segments-spec §2): the form's state and
// the two conversions between it and the 04 filters (toFilters, toForm). Pure: no React, no fetch,
// no storage, so test/ui/segment-form.test.ts checks every filter key without a browser. The
// browser never normalizes or range-checks a value (02 §Normalization): a number box is sent as
// typed and the server's `invalid_filters` answer says what is wrong.

import type { AppEventName } from '../shared/app-events'
import type { FilterKey, SegmentFilters } from '../shared/segment-filters'
import { SUBSCRIBER_STATUSES, type SubscriberStatus } from '../worker/ingest/quarantine'

/** The form's state: strings and flags as the inputs hold them, turned into 04 filters on submit. */
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

const text = (n: number | undefined) => (n === undefined ? '' : String(n))

/** 04 filters as the form holds them; toFilters(toForm(f)) previews the same subscribers as f. */
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

/** The 04 filters object; only set keys are sent, so an empty More filters adds nothing. */
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
