import { describe, expect, it } from 'vitest'
import { classifyPinnableSql } from '../worker/insights/pin-grammar'

// worker/insights/pin-grammar.ts (09 D-64b amending D-64a): the positive grammar a query_sql
// answer's SQL must pass to pin. Pure, no DB: every shape here is tested directly against
// classifyPinnableSql, the same function board.ts calls at pin time and on every board run. The
// bypass classes named in the D-64b decision (aliasing, subqueries, CTEs, window functions, string
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

describe('classifyPinnableSql: every D-64b bypass class is refused', () => {
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
    expect(classifyPinnableSql('SELECT pkey, source FROM v_profiles ORDER BY pkey')).toMatchObject({ ok: false })
  })
})
