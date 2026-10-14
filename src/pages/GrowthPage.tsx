// /growth (06 §/growth, R6): four panels from GET /api/insights/source-app-conversion,
// /funnel, /going-cold and /data-quality (04; the last two are parked items 4 and 5 of 16 §If
// time remains). Every number is the API's; nothing is computed here but the percent text and
// the bar length of a rate. Every number the assistant can reproduce has an "Explain this" link
// that opens /assistant with the API's `explain` question filled in (09 D-39); the assistant reads
// it from its PREFILL_PARAM query parameter and waits for Ask, so no model call happens until the
// reader wants one. The one exception is data quality's loading record (import_runs/quarantine),
// which no assistant view holds: it links to the Overview's import report instead of repeating
// it (06 §UI principles 5).
// Disclosure (06 §UI principles 2): level 1 = the panel's headline sentence and its top rows;
// level 2 = "Show the other …" rows and "How this is counted" (the definitions from DEFINITIONS,
// 02 §Derived); level 3 = Technical details (endpoint, view and column names, raw values).
// Bars (06 §UI principles 7): one colour on a 0–100% scale shared by every row of a panel; the
// bar is hidden from screen readers and the percent and counts are always visible as text, so no
// meaning is carried by colour or length alone.

import { Link } from 'react-router'
import { DEFINITIONS, type DefinitionKey } from '../../shared/derive'
import {
  type Column,
  Disclosure,
  EmptyState,
  ErrorLine,
  ICONS,
  Loading,
  PageHeader,
  ResponsiveTable,
  Section,
  TechnicalDetails,
} from '../components'
import { DEFINITION_LABEL, sourceLabel } from '../labels'
import { PREFILL_PARAM } from './AssistantPage'
import type { DataQuality, DataQualityCheckKey, Funnel, GoingCold, SourceAppConversion } from '../types'
import { useGet } from '../useGet'

/** Rows shown at level 1; the rest sit behind "Show the other …" (principle 2). */

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
      <span aria-hidden="true" className="block h-2 w-24 shrink-0 overflow-hidden rounded-full bg-surface-2 sm:w-40">
        <span className="block h-2 rounded-full bg-accent" style={{ width: `${width}%` }} />
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
    {
      header: 'Share',
      cell: (r) => (
        <span className="block space-y-0.5">
          <ShareBar rate={r.rate} />
          <span className="block text-xs tabular-nums text-gray-600">{r.count}</span>
        </span>
      ),
    },
    { header: 'Ask the AI assistant', hideLabel: true, cell: (r) => <ExplainLink question={r.explain} about={`${r.label}, ${r.count}`} /> },
  ]
  return <ResponsiveTable caption={caption} columns={columns} rows={rows} rowKey={(r) => r.key} />
}

/** Level 2: every row behind one labelled toggle, so level 1 shows only the headline number. */
function TopRows({ caption, groupHeader, rows, label }: { caption: string; groupHeader: string; rows: ShareRow[]; label: string }) {
  if (rows.length === 0) return null
  return (
    <Disclosure label={label}>
      <ShareTable caption={caption} groupHeader={groupHeader} rows={rows} />
    </Disclosure>
  )
}

/** Loading, error and the panel's own empty check share one shape per panel. */
function PanelState({ state }: { state: { status: 'loading' } | { status: 'error'; message: string } }) {
  if (state.status === 'loading') return <Loading label="Loading the numbers…" />
  return <ErrorLine message={state.message} next="Refresh the page to try again." />
}

function NothingLoaded({ what }: { what: string }) {
  return (
    <EmptyState icon={ICONS.growth}>
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

/** The definitions a panel uses, in words (02 §Derived; rendered from DEFINITIONS, never restated). */
function DefinitionList({ keys }: { keys: readonly DefinitionKey[] }) {
  return (
    <dl className="space-y-2 text-sm">
      {keys.map((key) => (
        <div key={key}>
          <dt className="font-medium text-gray-900">{DEFINITION_LABEL[key]}</dt>
          <dd className="text-gray-700">{DEFINITIONS[key].doc}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The same definitions' raw names and formulas, for Technical details. */
function DefinitionFormulas({ keys }: { keys: readonly DefinitionKey[] }) {
  return keys.map((key) => (
    <p key={key}>
      <span className="font-mono">{DEFINITIONS[key].name}</span>: <span className="font-mono">{DEFINITIONS[key].formula}</span>
    </p>
  ))
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
      summary="By acquisition source: the share who created an app account after joining the newsletter."
    >
      <p className="text-gray-900">
        <span className="font-display text-2xl font-semibold tabular-nums text-accent-strong">{n(d.total.with_app_after_signup)}</span> of{' '}
        <span className="tabular-nums">{n(d.total.subscribers)}</span> subscribers ({percent(d.total.rate)}) created an app
        account after signing up.{' '}
        <ExplainLink question={d.total.explain} about="all subscribers who got the app after signing up" />
      </p>
      <TopRows caption="Subscribers who got the app, by acquisition source" groupHeader="Acquisition source" rows={rows} label="Show by acquisition source" />
      <Disclosure label="How this is counted">
        <p className="text-sm text-gray-700">
          Of the {n(d.total.with_app)} subscribers with an app account, {n(d.total.with_app_after_signup)} created it after
          their signup day. The others already had the app, or got it on the same day, so the newsletter did not lead them
          to it and they are not counted. Unsubscribed ones are included, so every subscriber is counted.
        </p>
        <DefinitionList keys={d.definitions_used} />
        <TechnicalDetails>
          <p>
            Endpoint: <code className="font-mono">GET /api/insights/source-app-conversion</code> · relation{' '}
            <code className="font-mono">v_profiles</code> where <code className="font-mono">kind = &apos;subscriber&apos;</code>
          </p>
          <DefinitionFormulas keys={d.definitions_used} />
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
    label: r.first_utm_source === null ? 'No UTM source' : sourceLabel(r.first_utm_source),
    rate: r.rate,
    count: count(r),
    explain: r.explain,
  }))
  return (
    <Section title={title} summary="Where visitors first arrived on the website, and the share who went on to subscribe.">
      <p className="text-gray-900">
        <span className="font-display text-2xl font-semibold tabular-nums text-accent-strong">{n(d.total.subscribed)}</span> of{' '}
        <span className="tabular-nums">{n(d.total.visitors)}</span> website visitors ({percent(d.total.rate)}) subscribed to the
        newsletter. <ExplainLink question={d.total.explain} about="all website visitors who subscribed" />
      </p>
      <TopRows caption="Visitors who subscribed, by first page" groupHeader="First page" rows={pages} label="Show by first page" />
      <TopRows caption="Visitors who subscribed, by UTM source" groupHeader="UTM source" rows={utms} label="Show by UTM source" />
      <Disclosure label="How this is counted">
        <p className="text-sm text-gray-700">
          A visitor&apos;s first page and UTM source both come from their earliest visit. A visitor counts as subscribed
          when they signed up on the website with the email of a newsletter subscriber. Visitors who never subscribed are
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

function GoingColdPanel() {
  const state = useGet<GoingCold>('/api/insights/going-cold')
  const title = 'Subscribers at risk of going cold'
  if (state === null || state.status !== 'ok') {
    return <Section title={title}>{state !== null && <PanelState state={state} />}</Section>
  }
  const d = state.data
  if (d.total.active === 0 && d.hidden_unsubscribed.count === 0) {
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
    count: `${n(r.at_risk)} of ${n(r.active)} active subscribers`,
    explain: r.explain,
  }))
  const hidden = d.hidden_unsubscribed.count
  return (
    <Section title={title} summary="Active subscribers who are slipping away, by acquisition source. A note to them now may keep them reading.">
      <p className="text-gray-900">
        <span className="font-display text-2xl font-semibold tabular-nums text-accent-strong">{n(d.total.at_risk)}</span> of{' '}
        <span className="tabular-nums">{n(d.total.active)}</span> active subscribers ({percent(d.total.rate)}) are at risk of
        going cold. <ExplainLink question={d.total.explain} about="all active subscribers at risk of going cold" />
      </p>
      <TopRows caption="Active subscribers at risk of going cold, by acquisition source" groupHeader="Acquisition source" rows={rows} label="Show by acquisition source" />
      <Disclosure label="How this is counted">
        <p className="text-sm text-gray-700">
          Each share is out of the source&apos;s active subscribers. Unsubscribed ones are left out, as in every segment, and
          counted only in the line below.
        </p>
        <p className="text-sm text-gray-700">
          {n(hidden)} unsubscribed {hidden === 1 ? 'subscriber' : 'subscribers'} at risk {hidden === 1 ? 'is' : 'are'} not shown.{' '}
          <ExplainLink question={d.hidden_unsubscribed.explain} about="unsubscribed subscribers at risk of going cold" />
        </p>

        <DefinitionList keys={d.definitions_used} />
        <TechnicalDetails>
          <p>
            Endpoint: <code className="font-mono">GET /api/insights/going-cold</code> · relation{' '}
            <code className="font-mono">v_profiles</code> where <code className="font-mono">kind = &apos;subscriber&apos;</code>; each row
            judged by <code className="font-mono">goingColdRisk(last_open_date, cold_since)</code> in shared/derive.ts
          </p>
          <DefinitionFormulas keys={d.definitions_used} />
          <p className="font-mono break-all">
            source · active · at_risk · rate:{' '}
            {d.by_source.map((r) => `${r.source ?? 'null'} ${r.active} ${r.at_risk} ${r.rate ?? 'null'}`).join('; ')} · hidden_unsubscribed{' '}
            {hidden}
          </p>
        </TechnicalDetails>
      </Disclosure>
    </Section>
  )
}

/** Plain words for each data-quality check (06 §UI principles 4): what was checked, and what is counted. */
const CHECK_LABEL: Record<DataQualityCheckKey, { label: string; unit: string }> = {
  subscribers_without_source: { label: 'Subscribers with no acquisition source', unit: 'subscribers' },
  subscribers_unexpected_source: { label: 'Subscribers with an acquisition source we don’t recognise', unit: 'subscribers' },
  page_views_without_utm: { label: 'Website visits with no UTM source', unit: 'website visits' },
  page_views_unexpected_utm: { label: 'Website visits with a UTM source we don’t recognise', unit: 'website visits' },
  app_users_not_on_list: { label: 'App accounts whose email is not a newsletter subscriber’s', unit: 'app accounts' },
}

function DataQualityPanel() {
  const state = useGet<DataQuality>('/api/insights/data-quality')
  const title = 'Gaps in the data'
  if (state === null || state.status !== 'ok') {
    return <Section title={title}>{state !== null && <PanelState state={state} />}</Section>
  }
  const d = state.data
  if (d.import.rows_in === 0) {
    return (
      <Section title={title}>
        <NothingLoaded what="loaded files" />
      </Section>
    )
  }
  const rows: ShareRow[] = d.checks.map((c) => ({
    key: c.key,
    label: CHECK_LABEL[c.key].label,
    rate: c.rate,
    count: `${n(c.count)} of ${n(c.of)} ${CHECK_LABEL[c.key].unit}`,
    explain: c.explain,
  }))
  return (
    <Section title={title} summary="Values missing from the records we loaded, or values we did not expect. A gap here makes the other numbers less complete.">
      <p className="text-gray-900">
        <span className="font-display text-2xl font-semibold tabular-nums text-accent-strong">{n(d.import.quarantined)}</span> of{' '}
        <span className="tabular-nums">{n(d.import.rows_in)}</span> rows in the three files ({percent(d.import.rate)}) were set
        aside while loading and are not counted.{' '}
        <Link to="/" className="inline-flex min-h-6 items-center text-sm text-blue-700 underline underline-offset-2 hover:text-blue-900">
          See why on the Overview
        </Link>
      </p>
      <TopRows caption="Gaps in the records that loaded" groupHeader="What we checked" rows={rows} label="Show each gap" />
      <Disclosure label="How this is counted">
        <p className="text-sm text-gray-700">
          Every subscriber is counted, unsubscribed or not: a gap matters whoever it belongs to. A source we don&apos;t recognise is
          kept as it was written, never dropped, so it shows up here. The rows set aside while loading are recorded by the
          import itself, which the AI assistant cannot read, so that number links to the Overview&apos;s report instead.
        </p>
        <TechnicalDetails>
          <p>
            Endpoint: <code className="font-mono">GET /api/insights/data-quality</code> · relations{' '}
            <code className="font-mono">import_runs</code>, <code className="font-mono">quarantine</code>,{' '}
            <code className="font-mono">v_profiles</code>, <code className="font-mono">v_web_events</code>
          </p>
          <p className="font-mono break-all">
            import_runs rows_in {d.import.rows_in} · rows_out {d.import.rows_out} · merged {d.import.merged} · quarantined{' '}
            {d.import.quarantined}
          </p>
          <p className="font-mono break-all">
            quarantine file · reason · rows:{' '}
            {d.import.by_file_reason.length === 0 ? 'none' : d.import.by_file_reason.map((g) => `${g.file} ${g.reason} ${g.rows}`).join('; ')}
          </p>
          <p className="font-mono break-all">
            check · count · of · rate: {d.checks.map((c) => `${c.key} ${c.count} ${c.of} ${c.rate ?? 'null'}`).join('; ')}
          </p>
        </TechnicalDetails>
      </Disclosure>
    </Section>
  )
}

export default function GrowthPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Growth"
        purpose="Where subscribers come from, who is slipping away, and where the data has gaps. “Explain this” asks the AI assistant about any number."
        icon={ICONS.growth}
      />
      <SourceAppPanel />
      <FunnelPanel />
      <GoingColdPanel />
      <DataQualityPanel />
    </div>
  )
}
