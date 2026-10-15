/**
 * The check for a sign of SQL in model-written text (T-AI-5): staff should never be shown SQL.
 * The base rule: after deleting the six common invisible characters (soft hyphen, U+200B-U+200D,
 * U+2060, U+FEFF), text is SQL if it has a ```sql fence, a line that starts with SELECT, or the
 * word select followed anywhere later by the word from (any case, across lines). Matching text is
 * rejected whole, never stripped: every stripping rule that tried to keep the prose left a bypass,
 * and losing a sentence of model prose is the safe direction. Defined here only: the server
 * discards the model's `text` with it (worker/assistant/respond.ts), and the Insights answer card
 * hides the model's `filters_applied` with it (src/filters-applied.ts), so both screens are the
 * same check.
 *
 * Every Unicode format character (\p{Cf}: U+00AD soft hyphen, U+200B-U+200D zero-width, U+2060 word
 * joiner, U+FEFF and the rest) is invisible, so the signs are checked on several copies of the
 * text and any one matching counts:
 *   - LISTED: the base rule as written. Only its six characters are deleted; every other format character
 *     becomes a space (a separator either way, since a format character is not a letter or digit;
 *     the space also lets a "```\u2063sql" fence match). Checked raw and NFKC-folded. The raw copy
 *     makes the whole check a true superset of the base rule: NFKC can turn a separator into letters
 *     ("\u338F", the kg square, becomes "kg") and so glue it to a keyword.
 *   - DELETED, NFKC: every format character removed, so an unlisted one inside a keyword cannot
 *     split it ("sel\u2063ect").
 *   - SPACED, NFKC: every format character turned into a space, so a listed one between a keyword
 *     and the next word cannot glue them out of a whole-word match ("SELECT\u200Bemail").
 * A word boundary is a letter or digit boundary, not \b, so "_" (markdown emphasis or an
 * identifier) cannot hide a keyword: "_select_ email _from_ users" and "select_email from users"
 * count. There is no English exemption, so "select a segment from the builder" counts too
 * (accepted: the cost is a plain server sentence instead of the model's). Wider than the base rule
 * in the safe direction only: the LISTED raw copy is the base rule itself, and the other copies,
 * NFKC, "_", and any non-letter prefix before a line-start
 * SELECT (list markers, emphasis, digits as well as indentation, blockquote marks and backticks)
 * can only add matches.
 */

const LISTED_FORMAT_CHARS = /[\u00AD\u200B-\u200D\u2060\uFEFF]/gu
/** Every Unicode format character (category `Cf`); this check's own stripping, narrower than INVISIBLE_CHARS below. */
export const FORMAT_CHARS = /\p{Cf}/gu
/**
 * Every Unicode format character (category `Cf`) plus every other default-ignorable code point:
 * `Cf` alone misses some invisible characters a model can still
 * splice into a disguised address \u2014 U+034F COMBINING GRAPHEME JOINER, U+FE0F VARIATION
 * SELECTOR-16, U+180B MONGOLIAN FREE VARIATION SELECTOR ONE, U+115F HANGUL CHOSEONG FILLER,
 * U+3164 HANGUL FILLER, none of which are category `Cf`, all of which are
 * `Default_Ignorable_Code_Point`. Exported as the one home for this wider set:
 * `shared/pii.ts normalizeForScan` imports it (not `FORMAT_CHARS`) for its stage-1 drop, so the
 * PII disguise-stripping step is not narrowed to `Cf` the way this SQL-sign check still is.
 */
export const INVISIBLE_CHARS = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu
export type SqlSign = 'sql_fence' | 'select_line' | 'select_from'
const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}])'
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}])'
const SQL_SIGNS: ReadonlyArray<[SqlSign, RegExp]> = [
  // A fence whose tag starts with sql (```sql, ```sqlite, ~~~SQL…), any fence length, any case.
  // No word end: the rule is "contains a ```sql fence", so ```sqlite counts.
  ['sql_fence', new RegExp(`(?:\`{3,}|~{3,})[ \\t]*sql`, 'iu')],
  // A line whose first word is SELECT, after any characters that are not letters.
  ['select_line', new RegExp(`^[^\\p{L}\\r\\n]*select${NOT_WORD_AFTER}`, 'imu')],
  // The word select followed anywhere later, across lines, by the word from.
  ['select_from', new RegExp(`${NOT_WORD_BEFORE}select${NOT_WORD_AFTER}[\\s\\S]*${NOT_WORD_BEFORE}from${NOT_WORD_AFTER}`, 'iu')],
]

/** The first sign of SQL in `text`, or null. Pure. */
export function sqlSign(text: string): SqlSign | null {
  const listed = text.replace(LISTED_FORMAT_CHARS, '').replace(FORMAT_CHARS, ' ')
  const copies = [
    listed,
    listed.normalize('NFKC'),
    text.replace(FORMAT_CHARS, '').normalize('NFKC'),
    text.replace(FORMAT_CHARS, ' ').normalize('NFKC'),
  ]
  for (const [sign, pattern] of SQL_SIGNS) if (copies.some((copy) => pattern.test(copy))) return sign
  return null
}
