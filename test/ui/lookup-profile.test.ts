import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { appAfterSignup, coldSince, daysBetween, engagementScore, hasApp, lastNDays } from '../../shared/derive'
import { Profile } from '../../src/pages/LookupPage'
import type { Lookup, LookupAppAccount, LookupVisitor } from '../../src/types'
import { ingestApp } from '../../worker/ingest/app'
import { ingestSubscribers } from '../../worker/ingest/subscribers'
import { ingestWeb } from '../../worker/ingest/web'
import { JOY, SECOND_ACCOUNT, SECOND_VISITOR, sharedIdCsvs } from '../helpers/shared-ids'

// The Look up page's half of 09 D-70 item 4 (08 T-HARD-4; the API half is test/hardening-ids.test.ts):
// a profile with two app accounts and two web visitors shows how many at level 1 and each one under
// its own heading in Details and Technical details. The profile is joy.hall830 on the derived files
// of test/helpers/shared-ids.ts, shaped as GET /api/lookup returns it (04: earliest first, the
// single-object fields = the first) by the seed's own pure ingest steps. Its pkey is shown only in
// Technical details and asserted nowhere: it needs PII_KEY_SECRET, which this project cannot read,
// so it carries 04's own placeholder.

function joyProfile(): Lookup {
  const csvs = sharedIdCsvs()
  const subscriber = ingestSubscribers(csvs.subscribers).subscribers.get(JOY)
  if (subscriber === undefined) throw new Error('joy has no subscriber row')
  const web = ingestWeb(csvs.web_events)
  const linked = [...web.visitors.values()]
    .filter((v) => v.email_norm === JOY)
    .sort((a, b) => a.first_seen_ts.localeCompare(b.first_seen_ts))
  const visitors: LookupVisitor[] = linked.map((v) => ({
    visitor_id: v.visitor_id,
    first_page: v.first_page,
    first_utm_source: v.first_utm_source,
    events: web.events
      .filter((e) => e.visitor_id === v.visitor_id)
      .sort((a, b) => a.event_ts.localeCompare(b.event_ts))
      .map((e) => ({ page: e.page, event_ts: e.event_ts, utm_source: e.utm_source, pre_signup: e.event_ts < v.signup_ts! })),
  }))
  const accounts: LookupAppAccount[] = [...ingestApp(csvs.app_users).users.values()]
    .filter((u) => u.email_norm === JOY)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((u) => ({ user_id: u.user_id, created_at: u.created_at, from_csv: true, devices: [], events: [] }))
  const window = lastNDays(30)
  const visitsLast30d = visitors
    .flatMap((v) => v.events)
    .filter((e) => daysBetween(window.from, e.event_ts) >= 0 && daysBetween(e.event_ts, window.to) >= 0).length
  return {
    profile: {
      pkey: 'pk_…',
      kind: 'subscriber',
      email: JOY,
      engagement_score: engagementScore({
        last_open_date: subscriber.last_open_date,
        app_events_last_30d: 0,
        site_visits_last_30d: visitsLast30d,
      }),
      cold_since: coldSince(subscriber.last_open_date, subscriber.signup_date),
      has_app: hasApp(accounts[0].created_at),
      app_after_signup: appAfterSignup(accounts[0].created_at, subscriber.signup_date),
    },
    newsletter: {
      signup_date: subscriber.signup_date,
      status: subscriber.status,
      source: subscriber.source,
      last_open_date: subscriber.last_open_date,
      merged_count: subscriber.merged_count,
    },
    web: { ...visitors[0], visitors },
    app: { ...accounts[0], accounts },
  }
}

/** What a person reads: React's <!-- --> between adjacent text nodes removed. */
function rendered(data: Lookup): string {
  return renderToString(createElement(MemoryRouter, null, createElement(Profile, { data }))).replaceAll('<!-- -->', '')
}

describe('T-HARD-4 the Look up page shows every app account and web visitor (09 D-70 item 4)', () => {
  const data = joyProfile()

  it('starts from two of each, earliest first', () => {
    expect(data.app!.accounts.map((a) => a.user_id)).toEqual([SECOND_ACCOUNT, 'u_ceed5f12'])
    expect(data.web!.visitors.map((v) => [v.visitor_id, v.events.length])).toEqual([
      [SECOND_VISITOR, 6],
      ['v_c9e136fd6d', 9],
    ])
  })

  it('level 1 counts across both and says how many', () => {
    const html = rendered(data)
    expect(html).toContain('15 visits from 2 browsers')
    expect(html).toContain('2 app accounts, the first joined Aug 22, 2026, before signing up')
  })

  it('Details and Technical details list each one under its own heading, with its own ids', () => {
    const html = rendered(data)
    for (const part of ['Browser 1 of 2 · 6 visits', 'Browser 2 of 2 · 9 visits', 'App account 1 of 2', 'App account 2 of 2'])
      expect(html).toContain(part)
    expect(html).toContain('App account 2 of 2 · joined Sep 3, 2026')
    for (const id of [`>${SECOND_ACCOUNT}<`, '>u_ceed5f12<', `>${SECOND_VISITOR}<`, '>v_c9e136fd6d<']) expect(html).toContain(id)
  })

  it('one account and one visitor read as before: no count, no per-item headings', () => {
    // Her real profile: the one account is u_ceed5f12, created the day after her signup.
    const one: Lookup = {
      ...data,
      profile: { ...data.profile, app_after_signup: true },
      web: { ...data.web!.visitors[1], visitors: [data.web!.visitors[1]] },
      app: { ...data.app!.accounts[1], accounts: [data.app!.accounts[1]] },
    }
    const html = rendered(one)
    expect(html).toContain('Joined the app Sep 3, 2026, after signing up')
    expect(html).toContain('9 visits, 3 before signing up')
    expect(html).not.toMatch(/browsers|Browser \d|App account \d|\d app accounts/)
  })
})
