// GET /api/lookup?q=: one person's whole profile for the Look up page.
// q is an id when it starts with u_, pk_, d_ or v_ (resolveQuery), otherwise an email, normalized
// here and only here (the browser sends raw input). The ids: `u_…` an app user; `pk_…` a profile
// key (a stub's user is found by deriving each email-less user's key); `d_…` a device, which
// names its current user through device_identity (the most recent user by event_ts, so a late
// event cannot roll it back); `v_…` a website visitor, which names the profile its /subscribe
// email linked.
// One profile, four sections, each null when absent. A profile can hold several app accounts or
// several website visitors (one email on two accounts or two browsers is normal, not an error):
// `app.accounts` and `web.visitors` list every one, first = earliest (the order v_profiles reads:
// app by created_at, visitor by first_seen_ts then visitor_hash), and the single-object fields of
// `app` and `web` repeat that first one. Stored derived columns are read as stored;
// app_after_signup comes from shared/derive.ts, never from SQL. Identity resolution
// for app events is worker/identity/resolve.ts. Nothing is cached. The route has
// one error: any q that names no profile (blank, missing, neither an id nor a
// valid email, simply unknown, an anonymous visitor or a device no identified event has named)
// is 404 not_found.
//
// GET /api/lookup/search?q= is the search box's candidate list, since staff rarely type a full
// address. The fragment is folded by normalizeQueryFragment, the one
// home for query normalization; SQL compares it with the stored email_norm and never folds
// (no SQL case folding). It returns emails, so it is never an assistant tool. When it finds
// nothing for a long enough fragment it adds `did_you_mean`, computed in the Worker by
// worker/lookup/fuzzy.ts over every stored email_norm (no SQL extension).

import { Hono } from 'hono'
import { appAfterSignup, hasApp } from '../../shared/derive'
import { normalizeEmail, normalizeQueryFragment, QUERY_FRAGMENT_MIN_LENGTH } from '../../shared/normalize'
import { pkeyForUnknownUser } from '../../shared/pseudonym'
import { ApiError } from '../auth/middleware'
import { type AppEnv, requireSecret } from '../env'
import { devicesForUser, resolveUserEvents } from '../identity/resolve'
import { nearestEmails, wantsSuggestions } from '../lookup/fuzzy'

const USER_ID_PREFIX = 'u_'
const PROFILE_KEY_PREFIX = 'pk_'
const DEVICE_ID_PREFIX = 'd_'
const VISITOR_ID_PREFIX = 'v_'

const PROFILE_COLUMNS = 'SELECT pkey, email_norm, kind, engagement_score FROM profiles'
const APP_USER_COLUMNS = 'SELECT user_id, email_norm, created_at, from_csv FROM app_users'

interface ProfileRow {
  pkey: string
  email_norm: string | null
  kind: 'subscriber' | 'app_only' | 'unknown_user_stub'
  engagement_score: number
}

interface SubscriberRow {
  signup_date: string
  status: string
  source: string | null
  last_open_date: string | null
  cold_since: string
  merged_count: number
}

interface AppUserRow {
  user_id: string
  email_norm: string | null
  created_at: string
  from_csv: number
}

interface VisitorRow {
  visitor_id: string
  first_page: string
  first_utm_source: string | null
  signup_ts: string | null
}

interface WebEventRow {
  page: string
  event_ts: string
  utm_source: string | null
}

const notFound = () => new ApiError(404, 'not_found', 'No profile matches that email or id.')

/** At most one row, or a loud error where a key allows only one (a primary or derived key). Never names the key (PII). */
function single<T>(rows: T[], what: string): T | null {
  if (rows.length > 1)
    throw new Error(`lookup: ${rows.length} ${what} rows for one key, which allows only one`)
  return rows[0] ?? null
}

async function profileByEmail(db: D1Database, emailNorm: string): Promise<ProfileRow | null> {
  const { results } = await db
    .prepare(`${PROFILE_COLUMNS} WHERE email_norm = ?`)
    .bind(emailNorm)
    .all<ProfileRow>()
  return single(results, 'profiles')
}

interface Found {
  profile: ProfileRow
  /** The app user, when the id named one or the profile is a stub; an email profile's is re-read by its email. */
  appUser: AppUserRow | null
}

/** The profile a known app user belongs to; null when no app user has this id. */
async function foundForUser(env: AppEnv['Bindings'], userId: string): Promise<Found | null> {
  const db = env.DB
  const appUser = await db.prepare(`${APP_USER_COLUMNS} WHERE user_id = ?`).bind(userId).first<AppUserRow>()
  if (appUser === null) return null
  if (appUser.email_norm !== null) {
    const profile = await profileByEmail(db, appUser.email_norm)
    if (profile === null) throw new Error('lookup: an app user with an email has no profile')
    return { profile, appUser }
  }
  // A webhook-created user with no email: its stub profile is keyed by the user id.
  const pkey = await pkeyForUnknownUser(requireSecret(env, 'PII_KEY_SECRET'), appUser.user_id)
  const profile = await db.prepare(`${PROFILE_COLUMNS} WHERE pkey = ?`).bind(pkey).first<ProfileRow>()
  if (profile === null) throw new Error('lookup: an app user without an email has no stub profile')
  return { profile, appUser }
}

/** A profile by its key. A stub's key is one-way, so its user is found by deriving each email-less user's key. */
async function foundForProfileKey(env: AppEnv['Bindings'], pkey: string): Promise<Found | null> {
  const db = env.DB
  const profile = await db.prepare(`${PROFILE_COLUMNS} WHERE pkey = ?`).bind(pkey).first<ProfileRow>()
  if (profile === null) return null
  if (profile.email_norm !== null) return { profile, appUser: null }
  const secret = requireSecret(env, 'PII_KEY_SECRET')
  const { results } = await db.prepare(`${APP_USER_COLUMNS} WHERE email_norm IS NULL`).all<AppUserRow>()
  const owners: AppUserRow[] = []
  for (const user of results) if ((await pkeyForUnknownUser(secret, user.user_id)) === pkey) owners.push(user)
  const appUser = single(owners, 'app_users')
  if (appUser === null) throw new Error('lookup: a stub profile has no app user without an email')
  return { profile, appUser }
}

/** A device's current user (the most recent by event_ts); null when no identified event has named one. */
async function foundForDevice(env: AppEnv['Bindings'], deviceId: string): Promise<Found | null> {
  const userId = await env.DB.prepare('SELECT user_id FROM device_identity WHERE device_id = ?')
    .bind(deviceId)
    .first<string>('user_id')
  if (userId === null) return null
  const found = await foundForUser(env, userId)
  if (found === null) throw new Error('lookup: a device names a user with no app_users row')
  return found
}

/** The profile a visitor's /subscribe email linked; null for an unknown or anonymous visitor. */
async function foundForVisitor(env: AppEnv['Bindings'], visitorId: string): Promise<Found | null> {
  const db = env.DB
  const visitor = await db.prepare('SELECT email_norm FROM web_visitors WHERE visitor_id = ?')
    .bind(visitorId)
    .first<{ email_norm: string | null }>()
  if (visitor === null || visitor.email_norm === null) return null
  const profile = await profileByEmail(db, visitor.email_norm)
  if (profile === null) throw new Error('lookup: a linked web visitor has no profile')
  return { profile, appUser: null }
}

/** Finds the profile and, for a stub, its app user; null when nothing matches. */
async function resolveQuery(env: AppEnv['Bindings'], raw: string): Promise<Found | null> {
  // trim() only so ' u_…' is still an id; ids are matched as stored, and the email branch
  // normalizes the raw value itself.
  const id = raw.trim()
  if (id.startsWith(USER_ID_PREFIX)) return foundForUser(env, id)
  if (id.startsWith(PROFILE_KEY_PREFIX)) return foundForProfileKey(env, id)
  if (id.startsWith(DEVICE_ID_PREFIX)) return foundForDevice(env, id)
  if (id.startsWith(VISITOR_ID_PREFIX)) return foundForVisitor(env, id)
  const emailNorm = normalizeEmail(raw)
  if (emailNorm === null) return null
  const profile = await profileByEmail(env.DB, emailNorm)
  return profile === null ? null : { profile, appUser: null }
}

/** Mounted at /api by worker/index.ts, behind requireSession. */
export const lookupRoutes = new Hono<AppEnv>()

/** One website visitor of a profile, as the response shows it. */
async function webVisitor(db: D1Database, visitor: VisitorRow) {
  const signupTs = visitor.signup_ts
  if (signupTs === null) {
    throw new Error('lookup: a linked web visitor has no signup_ts, which the seed always writes (worker/ingest/web.ts)')
  }
  const { results } = await db
    .prepare('SELECT page, event_ts, utm_source FROM web_events WHERE visitor_id = ? ORDER BY event_ts, id')
    .bind(visitor.visitor_id)
    .all<WebEventRow>()
  return {
    visitor_id: visitor.visitor_id,
    first_page: visitor.first_page,
    first_utm_source: visitor.first_utm_source,
    events: results.map((e) => ({
      page: e.page,
      event_ts: e.event_ts,
      utm_source: e.utm_source,
      pre_signup: e.event_ts < signupTs,
    })),
  }
}

/** One app account of a profile, as the response shows it; its events resolved by worker/identity/resolve.ts. */
async function appAccount(db: D1Database, appUser: AppUserRow) {
  const [devices, events] = await Promise.all([
    devicesForUser(db, appUser.user_id),
    resolveUserEvents(db, appUser.user_id),
  ])
  return {
    user_id: appUser.user_id,
    created_at: appUser.created_at,
    from_csv: appUser.from_csv === 1,
    devices,
    events: events.map((e) => ({
      event: e.event,
      event_ts: e.event_ts,
      properties: e.properties,
      attached_via: e.attached_via,
    })),
  }
}

/** The first item's fields plus the whole list under `key` (the single object, then every one). */
function firstWithAll<T extends object, K extends string>(items: T[], key: K): (T & Record<K, T[]>) | null {
  if (items.length === 0) return null
  return { ...items[0], [key]: items } as T & Record<K, T[]>
}

lookupRoutes.get('/lookup', async (c) => {
  const found = await resolveQuery(c.env, c.req.query('q') ?? '')
  if (found === null) throw notFound()
  const { profile } = found
  const db = c.env.DB

  let subscriber: SubscriberRow | null = null
  let visitors: VisitorRow[] = []
  // A stub's one account came with it; an email profile's accounts are read by its email.
  let appUsers: AppUserRow[] = found.appUser === null ? [] : [found.appUser]
  if (profile.email_norm !== null) {
    // Earliest first, in the order v_profiles reads them (0002_views.sql): app accounts by
    // created_at (MIN), visitors by first_seen_ts then visitor_hash (its first_page).
    const [subs, visitorRows, apps] = await db.batch([
      db
        .prepare(
          'SELECT signup_date, status, source, last_open_date, cold_since, merged_count FROM subscribers WHERE email_norm = ?',
        )
        .bind(profile.email_norm),
      db
        .prepare(
          'SELECT visitor_id, first_page, first_utm_source, signup_ts FROM web_visitors WHERE email_norm = ? ORDER BY first_seen_ts, visitor_hash',
        )
        .bind(profile.email_norm),
      db
        .prepare(`${APP_USER_COLUMNS} WHERE email_norm = ? ORDER BY created_at, user_id`)
        .bind(profile.email_norm),
    ])
    // subscribers.email_norm is the table's primary key: one row at most.
    subscriber = single(subs.results as SubscriberRow[], 'subscribers')
    visitors = visitorRows.results as VisitorRow[]
    appUsers = apps.results as AppUserRow[]
  }

  const web = firstWithAll(await Promise.all(visitors.map((v) => webVisitor(db, v))), 'visitors')
  const app = firstWithAll(await Promise.all(appUsers.map((u) => appAccount(db, u))), 'accounts')

  // has_app and app_after_signup read the earliest account, as v_profiles does (MIN(created_at)).
  const appCreatedAt = appUsers[0]?.created_at ?? null
  return c.json({
    profile: {
      pkey: profile.pkey,
      kind: profile.kind,
      email: profile.email_norm,
      engagement_score: profile.engagement_score,
      cold_since: subscriber?.cold_since ?? null,
      has_app: hasApp(appCreatedAt),
      app_after_signup: subscriber !== null && appAfterSignup(appCreatedAt, subscriber.signup_date),
    },
    newsletter:
      subscriber === null
        ? null
        : {
            signup_date: subscriber.signup_date,
            status: subscriber.status,
            source: subscriber.source,
            last_open_date: subscriber.last_open_date,
            merged_count: subscriber.merged_count,
          },
    web,
    app,
  })
})

/** At most this many candidates; `truncated` says more exist. */
export const SEARCH_LIMIT = 20

interface SearchRow {
  grp: 0 | 1 | 2
  /** NULL only for a stub user (no email), whose pkey is derived from the user id. */
  pkey: string | null
  kind: ProfileRow['kind'] | null
  email: string | null
  user_id: string | null
  status: 'active' | 'unsubscribed' | null
}

/** `%`, `_` and `\` match literally under `ESCAPE '\'`. */
function escapeLike(fragment: string): string {
  return fragment.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

// Three groups, each alphabetical: 0 = email starts with q, 1 = email contains q elsewhere,
// 2 = app user_id starts with q and the user was not already listed by its email. The groups
// are disjoint and each lists a profile once, so one LIMIT of SEARCH_LIMIT + 1 tells whether
// more than SEARCH_LIMIT exist. A profile with several app accounts names one:
// in groups 0/1 its earliest (created_at, then user_id; the first of /api/lookup's
// app.accounts), in group 2 the lowest matching user_id (GROUP BY its email; a stub has none and
// stands alone).
// ?1 = %q%, ?2 = q%, ?3 = SEARCH_LIMIT + 1; every pattern is escaped, every value bound.
const SEARCH_SQL = `
SELECT grp, pkey, kind, email, user_id, status FROM (
  SELECT CASE WHEN p.email_norm LIKE ?2 ESCAPE '\\' THEN 0 ELSE 1 END AS grp,
         p.pkey AS pkey, p.kind AS kind, p.email_norm AS email,
         (SELECT a.user_id FROM app_users a WHERE a.email_norm = p.email_norm
          ORDER BY a.created_at, a.user_id LIMIT 1) AS user_id,
         s.status AS status, p.email_norm AS sort_key
  FROM profiles p
  LEFT JOIN subscribers s ON s.email_norm = p.email_norm
  WHERE p.email_norm LIKE ?1 ESCAPE '\\'
  UNION ALL
  SELECT 2, p.pkey, p.kind, a.email_norm, MIN(a.user_id), s.status, MIN(a.user_id)
  FROM app_users a
  LEFT JOIN profiles p ON p.email_norm = a.email_norm
  LEFT JOIN subscribers s ON s.email_norm = a.email_norm
  WHERE a.user_id LIKE ?2 ESCAPE '\\'
    AND (a.email_norm IS NULL OR a.email_norm NOT LIKE ?1 ESCAPE '\\')
  GROUP BY a.email_norm, CASE WHEN a.email_norm IS NULL THEN a.user_id END
)
ORDER BY grp, sort_key
LIMIT ?3`

lookupRoutes.get('/lookup/search', async (c) => {
  const q = normalizeQueryFragment(c.req.query('q') ?? '')
  if (q.length < QUERY_FRAGMENT_MIN_LENGTH) {
    throw new ApiError(400, 'query_too_short', `Type at least ${QUERY_FRAGMENT_MIN_LENGTH} characters to search.`)
  }
  const escaped = escapeLike(q)
  const db = c.env.DB
  const { results } = await db
    .prepare(SEARCH_SQL)
    .bind(`%${escaped}%`, `${escaped}%`, SEARCH_LIMIT + 1)
    .all<SearchRow>()
  const rows = results.slice(0, SEARCH_LIMIT)

  const matches = []
  for (const row of rows) {
    let { pkey, kind } = row
    if (pkey === null) {
      // No profile joined: only a stub user (no email) may lack one; its pkey comes from the
      // user id, as in the exact lookup above.
      if (row.email !== null || row.user_id === null) {
        throw new Error('lookup/search: an app user with an email has no profile')
      }
      pkey = await pkeyForUnknownUser(requireSecret(c.env, 'PII_KEY_SECRET'), row.user_id)
      kind = await db.prepare('SELECT kind FROM profiles WHERE pkey = ?').bind(pkey).first<ProfileRow['kind']>('kind')
      if (kind === null) throw new Error('lookup/search: an app user without an email has no stub profile')
    }
    if (kind === null) throw new Error('lookup/search: a joined profile has no kind')
    matches.push({ pkey, email: row.email, kind, user_id: row.user_id, status: row.status })
  }
  if (new Set(matches.map((m) => m.pkey)).size !== matches.length) {
    throw new Error('lookup/search: one profile matched twice; the response lists each profile once')
  }
  // Suggestions only when nothing matched a long enough fragment; `[]` otherwise.
  let didYouMean: { pkey: string; email: string; kind: ProfileRow['kind']; distance: number }[] = []
  if (wantsSuggestions(q, matches.length)) {
    const { results: emails } = await db
      .prepare('SELECT pkey, email_norm AS email, kind FROM profiles WHERE email_norm IS NOT NULL')
      .all<{ pkey: string; email: string; kind: ProfileRow['kind'] }>()
    didYouMean = nearestEmails(q, emails).map(({ pkey, email, kind, distance }) => ({ pkey, email, kind, distance }))
  }
  return c.json({ q, matches, truncated: results.length > SEARCH_LIMIT, did_you_mean: didYouMean })
})
