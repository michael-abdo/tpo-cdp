/**
 * "Treat September 28, 2026 as 'today' for anything time-based." (the brief)
 *
 * Every business-logic date comparison uses this constant. Wall-clock time (`Date.now()`) is
 * used only for bookkeeping that no date rule reads: when a webhook arrived, when a row or an
 * audit entry was written, how long a call took, the webhook replay window, session expiry and
 * the rate-limit windows.
 */
export const TODAY = '2026-09-28' as const

/**
 * The hosted deployment (README, the "Live:" line). The assistant's 503 names it, so a local run with
 * no ANTHROPIC_API_KEY has somewhere to go.
 */
export const HOSTED_URL = 'https://tpo-cdp.michaelabdo-mail.workers.dev'
