import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../shared/features'
import { LoadBar, SettingsButton } from '../../src/pages/OverviewPage'
import type { CsvSource } from '../../src/types'
import {
  describedByResolvesTo,
  elementText,
  gatedControlTags,
  hasDisabledAttribute,
  showsComingSoonChip,
  wearsGatedLook,
} from '../helpers/gated-assertions'

// Overview's gated future features: Upload a new file + Run
// again (csv_upload), Automatic daily sync (daily_sync, beehiiv and App accounts only — not
// Website, whose GA4 data carries no email to link by), and Settings for definitions
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
    expect(hasDisabledAttribute(html)).toBe(false)
    for (const m of html.matchAll(/aria-describedby="([^"]+)"/g)) expect(html).toContain(`id="${m[1]}"`)
  })

  it('both controls show their label/controls text from shared/features.ts (never a retyped "Run again")', () => {
    const html = renderToString(createElement(LoadBar, { source: csv('subscribers', 'beehiiv') }))
    expect(html).toContain(FEATURES.csv_upload.controls![0])
    expect(html).toContain(FEATURES.csv_upload.controls![1])
  })

  it('each button\'s own VISIBLE text equals its features.ts label/controls entry exactly, not merely contains it', () => {
    const html = renderToString(createElement(LoadBar, { source: csv('subscribers', 'beehiiv') }))
    expect(elementText(html, 'button', 0)).toBe(FEATURES.csv_upload.controls![0])
    expect(elementText(html, 'button', 1)).toBe(FEATURES.csv_upload.controls![1])
    expect(elementText(html, 'button', 2)).toBe(FEATURES.daily_sync.label)
  })

  it('the upload note equals shared/features.ts csv_upload.note and its describedby resolves; the sync note equals daily_sync.note', () => {
    const html = renderToString(createElement(LoadBar, { source: csv('subscribers', 'beehiiv') }))
    expect(html).toContain(FEATURES.csv_upload.note)
    expect(html).toContain(FEATURES.daily_sync.note)
    expect(describedByResolvesTo(html, FEATURES.csv_upload.note)).toBe(true)
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

  it('shows no "Coming soon" chip; all three controls wear the shared greyed look instead', () => {
    const html = renderToString(createElement(LoadBar, { source: csv('subscribers', 'beehiiv') }))
    expect(showsComingSoonChip(html)).toBe(false)
    const tags = gatedControlTags(html)
    expect(tags).toHaveLength(3)
    for (const tag of tags) expect(wearsGatedLook(tag), tag).toBe(true)
  })
})

describe('Overview: SettingsButton (definition_settings)', () => {
  it('renders aria-disabled, no disabled attribute, no href="/settings", and a describedby that resolves exactly', () => {
    const html = renderToString(createElement(SettingsButton)).replaceAll('<!-- -->', '')
    expect(html).toContain('aria-disabled="true"')
    expect(hasDisabledAttribute(html)).toBe(false)
    expect(html).not.toContain('href="/settings"')
    expect(describedByResolvesTo(html, FEATURES.definition_settings.note)).toBe(true)
  })

  it('shows no "Coming soon" chip and the button wears the shared greyed look', () => {
    const html = renderToString(createElement(SettingsButton))
    expect(showsComingSoonChip(html)).toBe(false)
    for (const tag of gatedControlTags(html)) expect(wearsGatedLook(tag), tag).toBe(true)
  })

  it('the button\'s own visible text equals shared/features.ts\'s definition_settings.label exactly ("Definition settings")', () => {
    const html = renderToString(createElement(SettingsButton))
    expect(elementText(html, 'button')).toBe(FEATURES.definition_settings.label)
  })
})
