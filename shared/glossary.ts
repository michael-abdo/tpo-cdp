// The glossary (09 D-63, 06 §Overview InfoTip): the only home of the plain words for pipeline terms
// (source, sync, rows read, kept, merged, rejected, the source statuses, the two source checks of
// 09 D-65, webhook, the quarantine reasons and Overview's headline numbers), each with one or two sentences a
// non-technical reader can follow (06 §UI principles 4). Derived metrics keep their text in
// DEFINITIONS (shared/derive.ts, 02 §Derived); explain() reads either, so an InfoTip has one lookup.
// test/sources.test.ts (T-SRC-2) checks every term the Overview names exists here or there.

import { DEFINITIONS, type DefinitionKey } from './derive'

export interface GlossaryEntry {
  /** The words shown on screen for this term. */
  readonly term: string
  /** The plural, for a term that is counted ("2 invalid emails"). */
  readonly many?: string
  /** One or two plain sentences. */
  readonly text: string
}

export const GLOSSARY = {
  source: {
    term: 'Source',
    text: 'Where reader data comes from: a file exported from another tool, or the app sending events as they happen.',
  },
  sync: {
    term: 'Sync',
    text: 'One load of a source into this tool. Files load when the setup script runs; app events arrive one by one, all the time.',
  },
  csv: {
    term: 'CSV file',
    text: 'A spreadsheet file exported from another tool. The setup script loads it; there is no upload button yet.',
  },
  webhook: {
    term: 'Webhook',
    text: 'The app sends each event here the moment it happens, signed with a shared secret so only the app can send it.',
  },
  live: {
    term: 'Live',
    text: 'Nothing to sync: events arrive as the app sends them and count at once.',
  },
  records: {
    term: 'Records',
    text: 'How many records the source holds after its last sync.',
  },
  rows_read: {
    term: 'Rows read',
    text: 'Lines in the file, not counting the header row.',
  },
  kept: {
    term: 'Kept',
    text: 'Records stored from the file: the rows read, minus rows merged into another row and rows rejected.',
  },
  merged: {
    term: 'Merged',
    text: 'Rows whose email matched another row once capital letters and spaces were ignored. Each set became one reader, keeping the earliest signup.',
  },
  rejected: {
    term: 'Rejected',
    text: "Rows that couldn't become a record, such as a blank row or an invalid email. They are set aside for review, never deleted, and not counted.",
  },
  // A source's status chips (06 §/ Overview 2, 09 D-65). The two check kinds are the keys of
  // shared/sources.ts CHECK_KINDS, so a check from the API finds its words.
  ok: {
    term: 'OK',
    text: 'The last sync went through and nothing from this source needs a person.',
  },
  not_loaded: {
    term: 'Not loaded yet',
    text: 'The setup script has not loaded this file yet, so it holds no records.',
  },
  rows_to_fix: {
    term: 'row to fix',
    many: 'rows to fix',
    text: 'Rejected rows a person can fix in the source file, such as an invalid email. Blank rows have nothing to fix.',
  },
  possible_duplicates: {
    term: 'possible duplicate',
    many: 'possible duplicates',
    text: 'Two readers with different emails whose names match. Nothing merges on its own; a person decides whether they are the same reader.',
  },
  // Quarantine reasons (02 §Quarantine): the codes are the keys, so a reason from the API finds its words.
  blank_row: {
    term: 'blank row',
    many: 'blank rows',
    text: 'Every field in the row is empty, so there is nothing to load and nothing to fix.',
  },
  invalid_email: {
    term: 'invalid email',
    many: 'invalid emails',
    text: "The email field doesn't look like an email address, so the row can't be matched to anyone.",
  },
  missing_field: {
    term: 'missing field',
    many: 'missing fields',
    text: 'A field the row needs, such as the email or a date, is empty.',
  },
  bad_date: {
    term: 'unreadable date',
    many: 'unreadable dates',
    text: "A date isn't written in the file's own date format, so it can't be read.",
  },
  // Overview's headline numbers (06 §Overview 1).
  readers_signed_up: {
    term: 'Readers who signed up',
    text: 'Newsletter readers after merging duplicate emails, unsubscribed ones included. Rejected rows are not counted.',
  },
  readers_subscribed: {
    term: 'Readers still subscribed',
    text: 'Readers who signed up and have not unsubscribed.',
  },
  app_accounts: {
    term: 'App users',
    text: 'Accounts in the app, including people not on the newsletter list and accounts first seen in an app event.',
  },
  events_received: {
    term: 'Events received',
    text: 'App events received through the webhook since launch. The same event sent twice counts once.',
  },
  // /segments (19-segments-spec §2, 09 D-69).
  previous_searches: {
    term: 'Previous searches',
    text: 'The last 5 segments you previewed in this browser, newest first; only the filters are kept, never the subscribers. To share one with the Growth team, ask the AI assistant for it and pin it to Insights, or export the CSV.',
  },
} as const satisfies Record<string, GlossaryEntry>

export type GlossaryKey = keyof typeof GLOSSARY
/** Anything an InfoTip can explain: a pipeline term here, or a derived metric in DEFINITIONS. */
export type TipKey = GlossaryKey | DefinitionKey

export function isGlossaryKey(key: string): key is GlossaryKey {
  return Object.hasOwn(GLOSSARY, key)
}

/** The words and text for a term, from the glossary or DEFINITIONS; an unknown key throws (fail loud). */
export function explain(key: string): { term: string; text: string } {
  if (isGlossaryKey(key)) return { term: GLOSSARY[key].term, text: GLOSSARY[key].text }
  if (Object.hasOwn(DEFINITIONS, key)) {
    const d = DEFINITIONS[key as DefinitionKey]
    return { term: d.name, text: d.doc }
  }
  throw new Error(`glossary: "${key}" is neither a glossary term nor a DEFINITIONS entry`)
}

/** "2 invalid emails" / "1 blank row": a count with the term's singular or plural words. */
export function countOf(key: GlossaryKey, count: number): string {
  const entry: GlossaryEntry = GLOSSARY[key]
  const words = count === 1 ? entry.term : (entry.many ?? entry.term)
  return `${count.toLocaleString('en-US')} ${words}`
}
