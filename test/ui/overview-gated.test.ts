import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../shared/features'
import { LoadBar, SettingsButton } from '../../src/pages/OverviewPage'
import type { CsvSource } from '../../src/types'

// Overview's gated future features (09 D-80, 22-pages/overview.md): Upload a new file + Run
// again (csv_upload), Automatic daily sync (daily_sync, beehiiv and App accounts only — 00-plan.md
// D3 overrides the page spec's "beehiiv and Website"), and Settings for definitions
// (definition_settings, the header's action slot, every state). T-GATE-OVR-1.

function csv(id: string, name: string): CsvSource {
  return {
    id,
    name,
    kind: 'csv',
    unit: 'x',
    unit_one: 'x',
    loads_by: 'seed',
    checks: [],
    records: 1,
    status: 'ok',
    last_sync: '2026-09-28T00:00:00Z',
    runs: [],
  } as unknown as CsvSource
}

describe('Overview: LoadBar (csv_upload, daily_sync)', () => {
  it('both buttons and, on beehiiv, the switch are aria-disabled, never disabled, and describedby resolves', () => {
    const html = renderToString(createElement(LoadBar, { source: csv('subscribers', 'beehiiv') })).replaceAll('<!-- -->', '')
    expect(html.match(/aria-disabled="true"/g)?.length).toBe(3) // Upload, Run again, the switch
    expect(html).not.toContain(' disabled')
    for (const m of html.matchAll(/aria-describedby="([^"]+)"/g)) expect(html).toContain(`id="${m[1]}"`)
  })

  it('the upload note equals shared/features.ts csv_upload.note; the sync note equals daily_sync.note', () => {
    const html = renderToString(createElement(LoadBar, { source: csv('subscribers', 'beehiiv') }))
    expect(html).toContain(FEATURES.csv_upload.note)
    expect(html).toContain(FEATURES.daily_sync.note)
  })

  it('the daily-sync switch shows on beehiiv and App accounts, never on Website', () => {
    expect(renderToString(createElement(LoadBar, { source: csv('subscribers', 'beehiiv') }))).toContain('role="switch"')
    expect(renderToString(createElement(LoadBar, { source: csv('app_users', 'App accounts') }))).toContain('role="switch"')
    expect(renderToString(createElement(LoadBar, { source: csv('web_events', 'Website') }))).not.toContain('role="switch"')
  })

  it('never renders a file input while gated', () => {
    const html = renderToString(createElement(LoadBar, { source: csv('subscribers', 'beehiiv') }))
    expect(html).not.toContain('type="file"')
  })

  it('shows the fixed "Coming soon" chip, never the disabled attribute, for every rendered control', () => {
    const html = renderToString(createElement(LoadBar, { source: csv('subscribers', 'beehiiv') }))
    expect((html.match(/Coming soon/g) ?? []).length).toBe(2) // one chip for the upload group, one for the switch
  })
})

describe('Overview: SettingsButton (definition_settings)', () => {
  it('renders aria-disabled, no disabled attribute, no href="/settings", and the describedby note', () => {
    const html = renderToString(createElement(SettingsButton)).replaceAll('<!-- -->', '')
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain(' disabled')
    expect(html).not.toContain('href="/settings"')
    expect(html).toContain(FEATURES.definition_settings.note)
  })
})
