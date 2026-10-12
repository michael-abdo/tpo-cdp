/**
 * "Treat September 28, 2026 as 'today' for anything time-based." (PDF; design 02 §Time, C6)
 *
 * Every business-logic date comparison uses this constant. Wall-clock time (`Date.now()`)
 * is allowed only for: received_at, the webhook replay window, session-cookie expiry and
 * ai_audit timestamps — the allow-list in 02 §Time.
 */
export const TODAY = '2026-09-28' as const
