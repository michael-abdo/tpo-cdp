/**
 * "Treat September 28, 2026 as 'today' for anything time-based." (PDF; design 02 §Time, C6)
 *
 * Every business-logic date comparison uses this constant. Wall-clock time (`Date.now()`) is
 * allowed only for the entries of the allow-list in 02 §Time.
 */
export const TODAY = '2026-09-28' as const

/**
 * The hosted deployment (README, the "Live:" line). The assistant's 503 names it, so a local run with
 * no ANTHROPIC_API_KEY has somewhere to go (04 §POST /api/assistant, 11).
 */
export const HOSTED_URL = 'https://tpo-cdp.michaelabdo-mail.workers.dev'
