// GET /api/lookup?q= (04 §/api/lookup, 06 §/lookup; R2, R1.2, R4.9).
// q is an app user_id when it starts with "u_", otherwise an email, normalized here and only
// here (02 §Normalization lists this file; the browser sends raw input). One profile, four
// sections, each null when absent. Stored derived columns are read as stored (09 D-46);
// app_after_signup comes from shared/derive.ts, never from SQL. Identity resolution for app
// events is worker/identity/resolve.ts. Nothing is cached (03 §No-restart). 04 defines one error
// for this route: any q that names no profile (blank, missing, neither u_… nor a valid email, or
// simply unknown) is 404 not_found.

import { Hono } from 'hono'
import { appAfterSignup, hasApp } from '../../shared/derive'
import { normalizeEmail } from '../../shared/normalize'
import { pkeyForUnknownUser } from '../../shared/pseudonym'
import { ApiError } from '../auth/middleware'
import { type AppEnv, requireSecret } from '../env'
import { devicesForUser, resolveUserEvents } from '../identity/resolve'

const USER_ID_PREFIX = 'u_'

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

const notFound = () => new ApiError(404, 'not_found', 'No profile matches that email or app user id.')

/** At most one row, or a loud error: the 04 shape holds one of each per profile. Never names the key (PII). */
function single<T>(rows: T[], what: string): T | null {
  if (rows.length > 1)
    throw new Error(`lookup: ${rows.length} ${what} rows for one profile; the 04 shape holds one`)
  return rows[0] ?? null
}

async function profileByEmail(db: D1Database, emailNorm: string): Promise<ProfileRow | null> {
  const { results } = await db
    .prepare('SELECT pkey, email_norm, kind, engagement_score FROM profiles WHERE email_norm = ?')
    .bind(emailNorm)
    .all<ProfileRow>()
  return single(results, 'profiles')
}

/** Finds the profile and, when q named one, the app user; null when nothing matches. */
async function resolveQuery(
  env: AppEnv['Bindings'],
  q: string,
): Promise<{ profile: ProfileRow; appUser: AppUserRow | null } | null> {
  const db = env.DB
  if (q.startsWith(USER_ID_PREFIX)) {
    const appUser = await db
      .prepare('SELECT user_id, email_norm, created_at, from_csv FROM app_users WHERE user_id = ?')
      .bind(q)
      .first<AppUserRow>()
    if (appUser === null) return null
    if (appUser.email_norm !== null) {
      const profile = await profileByEmail(db, appUser.email_norm)
      if (profile === null) throw new Error('lookup: an app user with an email has no profile')
      return { profile, appUser }
    }
    // A webhook-created user with no email: its stub profile is keyed by the user id (02 §Linking 4).
    const pkey = await pkeyForUnknownUser(requireSecret(env, 'PII_KEY_SECRET'), appUser.user_id)
    const profile = await db
      .prepare('SELECT pkey, email_norm, kind, engagement_score FROM profiles WHERE pkey = ?')
      .bind(pkey)
      .first<ProfileRow>()
    if (profile === null) throw new Error('lookup: an app user without an email has no stub profile')
    return { profile, appUser }
  }
  const emailNorm = normalizeEmail(q)
  if (emailNorm === null) return null
  const profile = await profileByEmail(db, emailNorm)
  return profile === null ? null : { profile, appUser: null }
}

/** Mounted at /api by worker/index.ts, behind requireSession. */
export const lookupRoutes = new Hono<AppEnv>()

lookupRoutes.get('/lookup', async (c) => {
  // trim() only so ' u_…' is still a user id; the email branch normalizes the raw value itself.
  const raw = c.req.query('q') ?? ''
  const q = raw.trim()
  const found = await resolveQuery(c.env, q.startsWith(USER_ID_PREFIX) ? q : raw)
  if (found === null) throw notFound()
  const { profile } = found
  const db = c.env.DB

  let subscriber: SubscriberRow | null = null
  let visitor: VisitorRow | null = null
  let appUser = found.appUser
  if (profile.email_norm !== null) {
    const [subs, visitors, apps] = await db.batch([
      db
        .prepare(
          'SELECT signup_date, status, source, last_open_date, cold_since, merged_count FROM subscribers WHERE email_norm = ?',
        )
        .bind(profile.email_norm),
      db
        .prepare(
          'SELECT visitor_id, first_page, first_utm_source, signup_ts FROM web_visitors WHERE email_norm = ?',
        )
        .bind(profile.email_norm),
      db
        .prepare('SELECT user_id, email_norm, created_at, from_csv FROM app_users WHERE email_norm = ?')
        .bind(profile.email_norm),
    ])
    subscriber = single(subs.results as SubscriberRow[], 'subscribers')
    visitor = single(visitors.results as VisitorRow[], 'web_visitors')
    appUser = single(apps.results as AppUserRow[], 'app_users')
  }

  let web = null
  if (visitor !== null) {
    const signupTs = visitor.signup_ts
    if (signupTs === null) {
      throw new Error('lookup: a linked web visitor has no signup_ts, which the seed always writes (worker/ingest/web.ts)')
    }
    const { results } = await db
      .prepare('SELECT page, event_ts, utm_source FROM web_events WHERE visitor_id = ? ORDER BY event_ts, id')
      .bind(visitor.visitor_id)
      .all<WebEventRow>()
    web = {
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

  let app = null
  if (appUser !== null) {
    const [devices, events] = await Promise.all([
      devicesForUser(db, appUser.user_id),
      resolveUserEvents(db, appUser.user_id),
    ])
    app = {
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

  const appCreatedAt = appUser?.created_at ?? null
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
