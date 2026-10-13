/**
 * What counts as PII for the model boundary (design 01 §PII denylist, 05 §What counts as
 * PII, 05 §Scanner, 09 D-17). Imported by the view introspection test (T-PII-2) and the
 * scanner; defined nowhere else.
 */

/** Columns no `v_*` view may select (01 §PII denylist). */
export const PII_COLUMNS = [
  'email_norm',
  'email_raw',
  'user_id',
  'device_id',
  'visitor_id',
  'raw_row',
  'properties',
] as const

export type PiiColumn = (typeof PII_COLUMNS)[number]

/**
 * An email anywhere in serialized text, case-insensitive. The local part excludes quotes
 * and brackets so a match inside JSON stops at the string delimiter. No `g` flag: the
 * regex is shared, and a global regex carries `lastIndex` between `.test()` calls.
 */
export const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i

/**
 * A raw app user, device or web visitor id (`u_`, `d_`, `v_` followed by hex; data/*.csv has
 * `u_2b6447a3` and `v_c9e136fd6d`, the brief's sample webhook has device `d_4b21e8`, the
 * shortest seen). At least 6 hex chars and word-bounded, so
 * ordinary words and `pk_` keys do not match. No `g` flag, as above.
 */
export const RAW_ID_REGEX = /\b[udv]_[0-9a-f]{6,}\b/i
