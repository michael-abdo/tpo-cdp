// /growth (06 §/growth, R6): two panels from GET /api/insights/source-app-conversion and
// GET /api/insights/funnel (04). Every number is the API's; nothing is computed here but the
// percent text and the bar length of a rate. Every number has an "Explain this" link that opens
// /assistant with the API's `explain` question filled in (09 D-39); the assistant reads it from
// its PREFILL_PARAM query parameter and waits for Ask, so no model call happens until the reader wants one.
// Disclosure (06 §UI principles 2): level 1 = the panel's headline sentence and its top rows;
// level 2 = "Show the other …" rows and "How this is counted" (the definitions from DEFINITIONS,
// 02 §Derived); level 3 = Technical details (endpoint, view and column names, raw values).
// Bars (06 §UI principles 7): one colour on a 0–100% scale shared by every row of a panel; the
// bar is hidden from screen readers and the percent and counts are always visible as text, so no
// meaning is carried by colour or length alone.

import { Link } from 'react-router'
import { DEFINITIONS } from '../../shared/derive'
import {
  type Column,
  Disclosure,
  EmptyState,
  ErrorLine,
  Loading,
  PageHeader,
  ResponsiveTable,
  Section,
  TechnicalDetails,
} from '../components'
import { DEFINITION_LABEL, sourceLabel } from '../labels'
import { PREFILL_PARAM } from './AssistantPage'
import type { Funnel, SourceAppConversion } from '../types'
import { useGet } from '../useGet'

/** Rows shown at level 1; the rest sit behind "Show the other …" (principle 2). */
const TOP_ROWS = 5

const n = (value: number) => value.toLocaleString('en-US')

function percent(rate: number | null): string {
  if (rate === null) return 'No data'
  return `${(rate * 100).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

/** The path of a page in words where it has a plain name. */
function pageLabel(page: string): string {
  return page === '/' ? 'Home page (/)' : page
}

/** Opens /assistant with the question filled in. The hidden suffix tells screen readers which number it explains. */
function ExplainLink({ question, about }: { question: string; about: string }) {
  return (
    <Link
      to={`/assistant?${new URLSearchParams({ [PREFILL_PARAM]: question })}`}
      className="inline-flex min-h-6 items-center text-sm whitespace-nowrap text-blue-700 underline underline-offset-2 hover:text-blue-900"
    >
      Explain this<span className="sr-only">: {about}</span>
    </Link>
  )
}

/** A rate as a thin bar plus its percent in text; the bar is decoration for sighted readers. */
function ShareBar({ rate }: { rate: number | null }) {
  const width = rate === null ? 0 : Math.max(0, Math.min(1, rate)) * 100
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="block h-3 w-24 shrink-0 bg-gray-100 sm:w-40">
        <span className="block h-3 rounded-r bg-blue-600" style={{ width: `${width}%` }} />
      </span>
      <span className="tabular-nums text-gray-900">{percent(rate)}</span>
    </span>
  )
}

interface ShareRow {
  key: string
  label: string
  rate: number | null
  /** "140 of 899 subscribers" */
  count: string
  explain: string
}

function ShareTable({ caption, groupHeader, rows }: { caption: string; groupHeader: string; rows: ShareRow[] }) {
  const columns: Column<ShareRow>[] = [
    { header: groupHeader, cell: (r) => <span className="break-words">{r.label}</span> },
    { header: 'Share', cell: (r) => <ShareBar rate={r.rate} /> },
    { header: 'How many', cell: (r) => <span className="tabular-nums">{r.count}</span> },
    { header: 'Ask the assistant', cell: (r) => <ExplainLink question={r.explain} about={`${r.label}, ${r.count}`} /> },
  ]
  return <ResponsiveTable caption={caption} columns={columns} rows={rows} rowKey={(r) => r.key} />
}

/** The top rows, then the rest behind one labelled toggle. */
function TopRows({ caption, groupHeader, rows, rest }: { caption: string; groupHeader: string; rows: ShareRow[]; rest: string }) {
  const top = rows.slice(0, TOP_ROWS)
  const others = rows.slice(TOP_ROWS)
  return (
    <div className="space-y-2">
      <ShareTable caption={caption} groupHeader={groupHeader} rows={top} />
      {others.length > 0 && (
        <Disclosure label={`Show the other ${n(others.length)} ${rest}`}>
          <ShareTable caption={`${caption}, continued`} groupHeader={groupHeader} rows={others} />
        </Disclosure>
      )}
    </div>
  )
}

/** Loading, error and the panel's own empty check share one shape per panel. */
function PanelState({ state }: { state: { status: 'loading' } | { status: 'error'; message: string } }) {
  if (state.status === 'loading') return <Loading label="Loading the numbers…" />
  return <ErrorLine message={state.message} next="Refresh the page to try again." />
}

function NothingLoaded({ what }: { what: string }) {
  return (
    <EmptyState>
      <p className="font-medium text-gray-900">No {what} yet.</p>
      <p>
        This panel fills in once the three files are loaded. The{' '}
        <Link to="/" className="text-blue-700 underline underline-offset-2 hover:text-blue-900">
          Overview
        </Link>{' '}
        shows what has been loaded.
      </p>
    </EmptyState>
  )
}

function SourceAppPanel() {
  const state = useGet<SourceAppConversion>('/api/insights/source-app-conversion')
  const title = 'Newsletter subscribers who then got the app'
  if (state === null || state.status !== 'ok') {
    return <Section title={title}>{state !== null && <PanelState state={state} />}</Section>
  }
  const d = state.data
  if (d.total.subscribers === 0) {
    return (
      <Section title={title}>
        <NothingLoaded what="subscribers" />
      </Section>
    )
  }
  const rows: ShareRow[] = d.by_source.map((r) => ({
    key: r.source ?? 'none',
    label: sourceLabel(r.source),
    rate: r.rate,
    count: `${n(r.with_app_after_signup)} of ${n(r.subscribers)} subscribers`,
    explain: r.explain,
  }))
  return (
    <Section
      title={title}
      summary="By where they signed up: the share who created an app account after joining the newsletter."
    >
      <p className="text-gray-900">
        <span className="font-semibold tabular-nums">{n(d.total.with_app_after_signup)}</span> of{' '}
        <span className="tabular-nums">{n(d.total.subscribers)}</span> subscribers ({percent(d.total.rate)}) created an app
        account after signing up.{' '}
        <ExplainLink question={d.total.explain} about="all subscribers who got the app after signing up" />
      </p>
      <TopRows caption="Subscribers who got the app, by signup source" groupHeader="Signed up from" rows={rows} rest="sources" />
      <Disclosure label="How this is counted">
        <p className="text-sm text-gray-700">
          Of the {n(d.total.with_app)} subscribers with an app account, {n(d.total.with_app_after_signup)} created it after
          their signup day. The others already had the app, or got it on the same day, so the newsletter did not lead them
          to it and they are not counted. Unsubscribed readers are included, so the whole list is counted.
        </p>
        <dl className="space-y-2 text-sm">
          {d.definitions_used.map((key) => (
            <div key={key}>
              <dt className="font-medium text-gray-900">{DEFINITION_LABEL[key]}</dt>
              <dd className="text-gray-700">{DEFINITIONS[key].doc}</dd>
            </div>
          ))}
        </dl>
        <TechnicalDetails>
          <p>
            Endpoint: <code className="font-mono">GET /api/insights/source-app-conversion</code> · relation{' '}
            <code className="font-mono">v_profiles</code> where <code className="font-mono">kind = &apos;subscriber&apos;</code>
          </p>
          {d.definitions_used.map((key) => (
            <p key={key}>
              <span className="font-mono">{DEFINITIONS[key].name}</span>: <span className="font-mono">{DEFINITIONS[key].formula}</span>
            </p>
          ))}
          <p className="font-mono break-all">
            source · subscribers · with_app · with_app_after_signup · rate:{' '}
            {d.by_source.map((r) => `${r.source ?? 'null'} ${r.subscribers} ${r.with_app} ${r.with_app_after_signup} ${r.rate ?? 'null'}`).join('; ')}
          </p>
        </TechnicalDetails>
      </Disclosure>
    </Section>
  )
}

function FunnelPanel() {
  const state = useGet<Funnel>('/api/insights/funnel')
  const title = 'Website visitors who subscribed'
  if (state === null || state.status !== 'ok') {
    return <Section title={title}>{state !== null && <PanelState state={state} />}</Section>
  }
  const d = state.data
  if (d.total.visitors === 0) {
    return (
      <Section title={title}>
        <NothingLoaded what="website visits" />
      </Section>
    )
  }
  const count = (r: { subscribed: number; visitors: number }) => `${n(r.subscribed)} of ${n(r.visitors)} visitors`
  const pages: ShareRow[] = d.by_first_page.map((r) => ({
    key: r.first_page,
    label: pageLabel(r.first_page),
    rate: r.rate,
    count: count(r),
    explain: r.explain,
  }))
  const utms: ShareRow[] = d.by_first_utm.map((r) => ({
    key: r.first_utm_source ?? 'none',
    label: r.first_utm_source === null ? 'No campaign source' : sourceLabel(r.first_utm_source),
    rate: r.rate,
    count: count(r),
    explain: r.explain,
  }))
  return (
    <Section title={title} summary="Where visitors first arrived on the website, and the share who went on to subscribe.">
      <p className="text-gray-900">
        <span className="font-semibold tabular-nums">{n(d.total.subscribed)}</span> of{' '}
        <span className="tabular-nums">{n(d.total.visitors)}</span> website visitors ({percent(d.total.rate)}) subscribed to the
        newsletter. <ExplainLink question={d.total.explain} about="all website visitors who subscribed" />
      </p>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-900">By the first page they saw (most visitors first)</h3>
        <TopRows caption="Visitors who subscribed, by first page" groupHeader="First page" rows={pages} rest="pages" />
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-900">By the campaign that brought them on their first visit (most visitors first)</h3>
        <TopRows caption="Visitors who subscribed, by campaign source" groupHeader="Campaign source" rows={utms} rest="campaign sources" />
      </div>
      <Disclosure label="How this is counted">
        <p className="text-sm text-gray-700">
          A visitor&apos;s first page and campaign source both come from their earliest visit. A visitor counts as subscribed
          when they signed up on the website with an email that is on the newsletter list. Visitors who never subscribed are
          counted too, so each share is out of everyone who visited.
        </p>
        <TechnicalDetails>
          <p>
            Endpoint: <code className="font-mono">GET /api/insights/funnel</code> · relation <code className="font-mono">v_funnel</code>{' '}
            (first_page, first_utm_source, visitors, subscribed)
          </p>
          <p className="font-mono break-all">
            first_page · visitors · subscribed · rate:{' '}
            {d.by_first_page.map((r) => `${r.first_page} ${r.visitors} ${r.subscribed} ${r.rate ?? 'null'}`).join('; ')}
          </p>
          <p className="font-mono break-all">
            first_utm_source · visitors · subscribed · rate:{' '}
            {d.by_first_utm.map((r) => `${r.first_utm_source ?? 'null'} ${r.visitors} ${r.subscribed} ${r.rate ?? 'null'}`).join('; ')}
          </p>
        </TechnicalDetails>
      </Disclosure>
    </Section>
  )
}

export default function GrowthPage() {
  return (
    <>
      <PageHeader
        title="Growth"
        purpose="Which signup sources lead readers to the app, and which website pages turn visitors into subscribers. Each number's “Explain this” asks the assistant about it."
      />
      <SourceAppPanel />
      <FunnelPanel />
    </>
  )
}
