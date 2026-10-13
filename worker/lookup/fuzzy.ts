/**
 * Fuzzy ("did you mean") lookup (09 D-59, 04 §/api/lookup/search, 06 §/lookup), pure: no D1,
 * no secrets, so test/lookup-search.test.ts runs it directly. worker/routes/lookup.ts calls it
 * only when partial lookup (09 D-52) found nothing, over every stored `profiles.email_norm`.
 *
 * The fragment comes in already folded by `normalizeQueryFragment` and the emails are stored
 * folded (02 §Normalization), so nothing here trims or lowercases. Distance is the unrestricted
 * Damerau–Levenshtein distance (insert, delete, substitute, swap two neighbouring characters,
 * each costing 1, with later edits allowed inside a swapped pair), counted in code points.
 */

/** Shortest normalized fragment that gets suggestions (04: "≥ 5 characters"). */
export const FUZZY_MIN_LENGTH = 5
/** Largest distance that is still a suggestion (09 D-59). */
export const FUZZY_MAX_DISTANCE = 2
/** At most this many suggestions (04: "≤ 5"). */
export const DID_YOU_MEAN_LIMIT = 5

/** The unrestricted Damerau–Levenshtein distance between `a` and `b` (Lowrance–Wagner). */
export function damerauLevenshtein(a: string, b: string): number {
  const s = Array.from(a)
  const t = Array.from(b)
  const n = s.length
  const m = t.length
  const far = n + m
  // d[i + 1][j + 1] = distance between s[0, i) and t[0, j); row and column 0 hold the sentinel.
  const d: number[][] = Array.from({ length: n + 2 }, () => new Array<number>(m + 2).fill(0))
  d[0][0] = far
  for (let i = 0; i <= n; i++) {
    d[i + 1][0] = far
    d[i + 1][1] = i
  }
  for (let j = 0; j <= m; j++) {
    d[0][j + 1] = far
    d[1][j + 1] = j
  }
  /** The last row (1-based) of `s` holding each character seen so far. */
  const lastRow = new Map<string, number>()
  for (let i = 1; i <= n; i++) {
    let lastMatchCol = 0
    for (let j = 1; j <= m; j++) {
      const i1 = lastRow.get(t[j - 1]) ?? 0
      const j1 = lastMatchCol
      let cost = 1
      if (s[i - 1] === t[j - 1]) {
        cost = 0
        lastMatchCol = j
      }
      d[i + 1][j + 1] = Math.min(
        d[i][j] + cost, // substitute (or keep)
        d[i + 1][j] + 1, // insert
        d[i][j + 1] + 1, // delete
        d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1), // swap, with the characters between deleted/inserted
      )
    }
    lastRow.set(s[i - 1], i)
  }
  return d[n + 1][m + 1]
}

/** Code-point length; the distance is never below the difference of two lengths. */
function length(text: string): number {
  return Array.from(text).length
}

/**
 * The distance from `fragment` to `email`, compared against the whole address and against its
 * local part (before the last `@`), whichever is nearer; `null` when both exceed
 * FUZZY_MAX_DISTANCE. Lengths that differ by more than that are skipped without the table.
 */
export function emailDistance(fragment: string, email: string): number | null {
  const at = email.lastIndexOf('@')
  const targets = at < 0 ? [email] : [email, email.slice(0, at)]
  const fragmentLength = length(fragment)
  let best: number | null = null
  for (const target of targets) {
    if (Math.abs(length(target) - fragmentLength) > FUZZY_MAX_DISTANCE) continue
    const distance = damerauLevenshtein(fragment, target)
    if (distance <= FUZZY_MAX_DISTANCE && (best === null || distance < best)) best = distance
  }
  return best
}

/** Whether a search answer gets suggestions at all: no partial match and a long enough fragment (04). */
export function wantsSuggestions(fragment: string, matchCount: number): boolean {
  return matchCount === 0 && length(fragment) >= FUZZY_MIN_LENGTH
}

/**
 * The DID_YOU_MEAN_LIMIT candidates nearest to `fragment`, within FUZZY_MAX_DISTANCE: nearest
 * first, then by email in code-unit order (the order SQLite's `ORDER BY email_norm` uses).
 */
export function nearestEmails<T extends { email: string }>(
  fragment: string,
  candidates: readonly T[],
): (T & { distance: number })[] {
  const near: (T & { distance: number })[] = []
  for (const candidate of candidates) {
    const distance = emailDistance(fragment, candidate.email)
    if (distance !== null) near.push({ ...candidate, distance })
  }
  near.sort((x, y) => x.distance - y.distance || (x.email < y.email ? -1 : x.email > y.email ? 1 : 0))
  return near.slice(0, DID_YOU_MEAN_LIMIT)
}
