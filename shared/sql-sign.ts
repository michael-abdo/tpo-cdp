/**
 * The D-58 check for a sign of SQL in model-written text (09 D-58, 08 T-AI-5). Defined here only:
 * the server discards the model's `text` with it (worker/assistant/respond.ts), and "Ask a
 * question" hides the model's `filters_applied` with it (src/filters-applied.ts), so both screens
 * are the same check.
 *
 * Every Unicode format character (\p{Cf}: U+00AD soft hyphen, U+200B-U+200D zero-width, U+2060 word
 * joiner, U+FEFF and the rest) is invisible, so the signs are checked on several copies of the
 * text and any one matching counts:
 *   - LISTED: D-58 as written. Only its six characters are deleted; every other format character
 *     becomes a space (a separator either way, since a format character is not a letter or digit;
 *     the space also lets a "```\u2063sql" fence match). Checked raw and NFKC-folded. The raw copy
 *     makes the whole check a true superset of D-58: NFKC can turn a separator into letters
 *     ("\u338F", the kg square, becomes "kg") and so glue it to a keyword.
 *   - DELETED, NFKC: every format character removed, so an unlisted one inside a keyword cannot
 *     split it ("sel\u2063ect").
 *   - SPACED, NFKC: every format character turned into a space, so a listed one between a keyword
 *     and the next word cannot glue them out of a whole-word match ("SELECT\u200Bemail").
 * A word boundary is a letter or digit boundary, not \b, so "_" (markdown emphasis or an
 * identifier) cannot hide a keyword: "_select_ email _from_ users" and "select_email from users"
 * count. There is no English exemption, so "select a segment from the builder" counts too
 * (accepted by D-58). Wider than D-58's wording in the safe direction only: the LISTED raw copy is
 * D-58 itself, and the other copies, NFKC, "_", and any non-letter prefix before a line-start
 * SELECT (list markers, emphasis, digits as well as indentation, blockquote marks and backticks)
 * can only add matches.
 */

const LISTED_FORMAT_CHARS = /[\u00AD\u200B-\u200D\u2060\uFEFF]/gu
const FORMAT_CHARS = /\p{Cf}/gu
export type SqlSign = 'sql_fence' | 'select_line' | 'select_from'
const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}])'
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}])'
const SQL_SIGNS: ReadonlyArray<[SqlSign, RegExp]> = [
  // A fence whose tag starts with sql (```sql, ```sqlite, ~~~SQL…), any fence length, any case.
  // No word end: D-58 says "contains a ```sql fence", so ```sqlite counts.
  ['sql_fence', new RegExp(`(?:\`{3,}|~{3,})[ \\t]*sql`, 'iu')],
  // A line whose first word is SELECT, after any characters that are not letters.
  ['select_line', new RegExp(`^[^\\p{L}\\r\\n]*select${NOT_WORD_AFTER}`, 'imu')],
  // The word select followed anywhere later, across lines, by the word from.
  ['select_from', new RegExp(`${NOT_WORD_BEFORE}select${NOT_WORD_AFTER}[\\s\\S]*${NOT_WORD_BEFORE}from${NOT_WORD_AFTER}`, 'iu')],
]

/** The first D-58 sign of SQL in `text`, or null. Pure. */
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
