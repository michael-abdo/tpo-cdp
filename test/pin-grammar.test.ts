import { describe, expect, it } from 'vitest'
import { classifyPinnableSql } from '../worker/insights/pin-grammar'

// worker/insights/pin-grammar.ts: the positive grammar a query_sql
// answer's SQL must pass to pin. Pure, no DB: every shape here is tested directly against
// classifyPinnableSql, the same function board.ts calls at pin time and on every board run. The
// bypass classes it must refuse (aliasing, subqueries, CTEs, window functions, string
// concatenation of a key, substr of a key, GROUP BY on a key, HAVING tricks, UNION) each get one
// test; T-INS-10..14 in test/insights-board.test.ts exercise the same classifier end to end.

describe('classifyPinnableSql: shape A (totals)', () => {
  it('count(*) with no dimension pins', () => {
    const r = classifyPinnableSql("SELECT count(*) AS n FROM v_profiles WHERE status = 'active'")
    expect(r).toMatchObject({ ok: true, shape: 'totals', countColumns: ['n'], dimensionColumns: [] })
  })

  it('count(DISTINCT pkey) grouped by an approved dimension pins', () => {
    const r = classifyPinnableSql('SELECT source, count(DISTINCT pkey) AS n FROM v_profiles GROUP BY source')
    expect(r).toMatchObject({ ok: true, shape: 'totals', countColumns: ['n'], dimensionColumns: ['source'] })
  })

  it('an aggregate of an approved numeric column, grouped by a date bucket, pins', () => {
    const r = classifyPinnableSql(
      "SELECT substr(signup_date, 1, 7) AS month, count(*) AS n, avg(engagement_score) AS avg_score FROM v_profiles GROUP BY substr(signup_date, 1, 7)",
    )
    expect(r).toMatchObject({ ok: true, shape: 'totals', countColumns: ['n'] })
  })

  it('a dimension column with no GROUP BY, or GROUP BY not matching the dimension, is refused', () => {
    expect(classifyPinnableSql('SELECT source, count(*) AS n FROM v_profiles')).toMatchObject({ ok: false })
    expect(classifyPinnableSql('SELECT source, count(*) AS n FROM v_profiles GROUP BY status')).toMatchObject({ ok: false })
  })

  it('a totals query needs at least one count column', () => {
    expect(classifyPinnableSql('SELECT source FROM v_profiles GROUP BY source')).toMatchObject({ ok: false })
  })

  it('an unapproved column, in any position, is refused', () => {
    expect(classifyPinnableSql('SELECT email_norm, count(*) AS n FROM v_profiles GROUP BY email_norm')).toMatchObject({ ok: false })
    expect(classifyPinnableSql('SELECT count(*) AS n, sum(story) AS s FROM v_app_events')).toMatchObject({ ok: false })
  })

  it('a bare approved column (plain_approved) alongside a count is refused, even ungrouped (max() + a bare date column)', () => {
    // SQLite reads an ungrouped bare column from one arbitrary row; with max() present, that row
    // is the top scorer's own record, so signup_date/last_open_date/cold_since named one real person.
    expect(
      classifyPinnableSql(
        'SELECT count(*) AS n, max(engagement_score) AS top, signup_date, last_open_date, app_created_at, cold_since FROM v_profiles',
      ),
    ).toMatchObject({ ok: false })
    expect(classifyPinnableSql('SELECT source, count(*) AS n, engagement_score FROM v_profiles GROUP BY source')).toMatchObject({ ok: false })
  })
})

describe('classifyPinnableSql: FROM is exactly one view (a join moved the small-group anchor off the aggregate it masked)', () => {
  it('a comma-joined FROM list is refused', () => {
    expect(
      classifyPinnableSql(
        "SELECT count(*) AS n, avg(a.engagement_score) AS s FROM v_profiles a, v_funnel b WHERE a.source = 'x' AND a.status = 'unsubscribed'",
      ),
    ).toMatchObject({ ok: false })
  })

  it('a JOIN is refused', () => {
    expect(classifyPinnableSql('SELECT count(*) AS n FROM v_profiles JOIN v_funnel ON 1 = 1')).toMatchObject({ ok: false })
  })

  it('count(*) on a non-v_profiles view is refused: it counts rows, not people', () => {
    expect(classifyPinnableSql('SELECT count(*) AS n FROM v_app_events')).toMatchObject({ ok: false })
    expect(classifyPinnableSql('SELECT count(*) AS n FROM v_web_events')).toMatchObject({ ok: false })
  })

  it('count(DISTINCT pkey) on an event view still pins: it is a real people count', () => {
    const r = classifyPinnableSql('SELECT count(DISTINCT pkey) AS n FROM v_app_events')
    expect(r).toMatchObject({ ok: true, shape: 'totals', countColumns: ['n'] })
  })
})

describe('classifyPinnableSql: an alias keeps its exact case (AS Subscribers never matched the lowercased countColumns)', () => {
  it('a mixed-case count alias still reports as written, so board.ts can find it in the D1 row', () => {
    const r = classifyPinnableSql('SELECT source, status, count(*) AS Subscribers FROM v_profiles GROUP BY source, status')
    expect(r).toMatchObject({ ok: true, shape: 'totals', countColumns: ['Subscribers'] })
  })
})

describe('classifyPinnableSql: "lists" (a person list)', () => {
  it('a bare pkey plus approved columns pins', () => {
    const r = classifyPinnableSql("SELECT pkey, source, status FROM v_profiles WHERE source = 'instagram'")
    expect(r).toMatchObject({ ok: true, shape: 'list', identifierColumn: 'pkey' })
  })

  it('visitor_hash is refused (no email to re-hydrate)', () => {
    expect(classifyPinnableSql('SELECT visitor_hash, page FROM v_web_events')).toMatchObject({ ok: false })
  })

  it('two identifier columns, or a count alongside one, is refused', () => {
    expect(classifyPinnableSql('SELECT pkey, visitor_hash FROM v_web_events')).toMatchObject({ ok: false })
    expect(classifyPinnableSql('SELECT pkey, count(*) AS n FROM v_profiles')).toMatchObject({ ok: false })
  })

  it('a grouped person list is refused (GROUP BY makes it a totals shape)', () => {
    expect(classifyPinnableSql('SELECT pkey, source FROM v_profiles GROUP BY pkey, source')).toMatchObject({ ok: false })
  })
})

describe('classifyPinnableSql: a person list may sort by its own key as a tie-breaker', () => {
  it('the live "most engaged" list, ORDER BY engagement_score DESC, pkey, pins as a list', () => {
    const sql = "SELECT pkey, engagement_score, last_open_date, has_app FROM v_profiles WHERE status = 'active' ORDER BY engagement_score DESC, pkey LIMIT 25"
    expect(classifyPinnableSql(sql)).toMatchObject({ ok: true, shape: 'list', identifierColumn: 'pkey' })
    expect(classifyPinnableSql('SELECT pkey, engagement_score FROM v_profiles ORDER BY pkey DESC LIMIT 10')).toMatchObject({ ok: true, shape: 'list' })
    expect(classifyPinnableSql('SELECT pkey FROM v_profiles ORDER BY pkey ASC')).toMatchObject({ ok: true, shape: 'list' })
  })

  it('anything more than the bare key in ORDER BY is still refused', () => {
    for (const order of ['substr(pkey, 1, 4)', "pkey || 'x'", 'pkey COLLATE NOCASE', 'pkey DESC NULLS LAST', 'pkey -1', 'pkey NOCASE' /* tokens, not SQL validity: only ASC/DESC may follow */, 'length(pkey)', 'engagement_score, substr(pkey, 5, 3) DESC']) {
      const r = classifyPinnableSql(`SELECT pkey, engagement_score FROM v_profiles ORDER BY ${order} LIMIT 10`)
      expect(r.ok, order).toBe(false)
    }
  })

  it('only a person list gets the tie-breaker: a totals query sorted by pkey is still refused', () => {
    expect(classifyPinnableSql('SELECT source, count(*) AS n FROM v_profiles GROUP BY source ORDER BY pkey').ok).toBe(false)
    expect(classifyPinnableSql('SELECT count(*) AS n FROM v_profiles ORDER BY pkey').ok).toBe(false)
  })
})

describe('classifyPinnableSql: every known bypass class is refused', () => {
  it('aliasing: the identifier column of a person list cannot be renamed', () => {
    expect(classifyPinnableSql('SELECT pkey AS reader_id, source FROM v_profiles')).toMatchObject({ ok: false })
  })

  it('subqueries: a second SELECT anywhere is refused', () => {
    expect(classifyPinnableSql('SELECT count(*) AS n FROM (SELECT pkey FROM v_profiles) t')).toMatchObject({ ok: false })
    expect(classifyPinnableSql('SELECT (SELECT count(*) FROM v_profiles) AS n FROM v_profiles LIMIT 1')).toMatchObject({ ok: false })
  })

  it('CTEs: a WITH clause holds a second SELECT, so it is refused the same way (Gate 2/3 also ban WITH itself)', () => {
    expect(classifyPinnableSql('WITH x AS (SELECT pkey FROM v_profiles) SELECT count(*) AS n FROM x')).toMatchObject({ ok: false })
  })

  it('window functions: OVER is refused outright, even wrapping an approved column', () => {
    expect(classifyPinnableSql('SELECT source, row_number() OVER (ORDER BY source) AS rn FROM v_profiles GROUP BY source')).toMatchObject({ ok: false })
  })

  it('string concatenation of a key is refused', () => {
    expect(classifyPinnableSql("SELECT count(*) AS n, pkey || '' AS x FROM v_profiles")).toMatchObject({ ok: false })
    expect(classifyPinnableSql("SELECT count(DISTINCT pkey || '') AS n FROM v_profiles")).toMatchObject({ ok: false })
  })

  it('substr of a key is refused, at any cut', () => {
    for (const expr of ['substr(pkey, 1, 8)', 'substr(pkey, 4, 15)', 'substr(visitor_hash, 5, 10)']) {
      expect(classifyPinnableSql(`SELECT ${expr} AS x FROM v_profiles`)).toMatchObject({ ok: false })
    }
  })

  it('GROUP BY on a key is refused, even when the key is never in the SELECT list', () => {
    expect(classifyPinnableSql('SELECT count(*) AS n FROM v_profiles GROUP BY pkey')).toMatchObject({ ok: false })
    expect(classifyPinnableSql('SELECT count(*) AS n FROM v_web_events GROUP BY visitor_hash')).toMatchObject({ ok: false })
  })

  it('HAVING is refused outright, whatever threshold it names', () => {
    expect(classifyPinnableSql('SELECT source, count(*) AS n FROM v_profiles GROUP BY source HAVING count(*) >= 5')).toMatchObject({ ok: false })
    expect(classifyPinnableSql('SELECT source, count(*) AS n FROM v_profiles GROUP BY source HAVING n < 5')).toMatchObject({ ok: false })
  })

  it('UNION (and INTERSECT, EXCEPT) is refused', () => {
    expect(classifyPinnableSql('SELECT count(*) AS n FROM v_profiles UNION SELECT count(*) AS n FROM v_web_events')).toMatchObject({ ok: false })
    expect(classifyPinnableSql('SELECT count(*) AS n FROM v_profiles INTERSECT SELECT count(*) AS n FROM v_web_events')).toMatchObject({ ok: false })
  })

  it('an identifier column reached through WHERE, ORDER BY or a second mention anywhere else is refused', () => {
    expect(classifyPinnableSql("SELECT count(*) AS n FROM v_profiles WHERE pkey = 'pk_0000000000000000'")).toMatchObject({ ok: false })
    // A bare `ORDER BY pkey` on a person list is the one allowed tie-breaker (tested above); any
    // expression over the key in ORDER BY is still a second mention.
    expect(classifyPinnableSql('SELECT pkey, source FROM v_profiles ORDER BY substr(pkey, 1, 4)')).toMatchObject({ ok: false })
  })
})
