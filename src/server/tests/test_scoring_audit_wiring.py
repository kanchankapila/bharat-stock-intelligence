"""Audit regressions: execute production expressions/SQL, not copied scoring logic."""
import ast
import inspect
import textwrap
from datetime import date

import pytest
import unified_ranker as ur
import intraday_strategy_learner as learner


def _assignment(fn, name):
    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    return next(n.value for n in ast.walk(tree) if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == name for t in n.targets))


def test_paused_engines_do_not_support_coverage_or_size():
    expr = _assignment(ur.UnifiedRanker.run, 'present')
    ctx = {'sym': 'AAA', 'engine_maps': {
        'ml': {'AAA': 80}, 'technical': {'AAA': 60}, 'dl': {'AAA': 99},
        'absent': {}, 'unweighted': {'AAA': 50}},
        'base_weights': {'ml': .6, 'technical': .4, 'dl': 0, 'absent': .2}}
    actual = eval(compile(ast.Expression(expr), '<production>', 'eval'), ctx)
    assert actual == {'ml', 'technical'}
    old = {e for e, m in ctx['engine_maps'].items() if 'AAA' in m}
    assert old != actual  # negative control: the old implementation fails this assertion
    assert ur.size_confidence_multiplier(80, len(actual)) < ur.size_confidence_multiplier(80, len(old))
    scores = {'ml': 80, 'technical': 60, 'dl': 99}
    assert ur._blend(scores, actual, ctx['base_weights']) == ur._blend(scores, old, ctx['base_weights'])


@pytest.mark.postgres
def test_confluence_latest_snapshot_independent_of_insertion_order(pg_schema, monkeypatch):
    con, _ = pg_schema
    cur = con.cursor()
    cur.execute('CREATE TABLE confluence_signals (symbol TEXT, computed_at TIMESTAMPTZ, '
                'trend_alignment_score REAL, volume_score REAL, sector_strength_score REAL, fundamental_score REAL)')
    from psycopg2.extras import RealDictCursor

    class Adapter:
        def execute(self, sql, params):
            c = con.cursor(cursor_factory=RealDictCursor)
            # psycopg2 uses percent-style binds: escape literal LIKE wildcards first.
            c.execute(sql.replace('%', '%%').replace('?', '%s'), params)
            return c
        def rollback(self):
            con.rollback()

    ranker = ur.UnifiedRanker(conn=Adapter())
    monkeypatch.setattr(ur.as_of, 'trading_days_back', lambda *a: [date(2026, 9, 16)])
    rows = [('AAA', '2026-09-16T09:00Z', 1, 0, 0, 0),
            ('AAA', '2026-09-16T10:00Z', 9, 0, 0, 0),
            ('BBB', '2026-09-16T09:00Z', 5, 0, 0, 0)]
    results = []
    for batch in (rows, list(reversed(rows))):
        cur.execute('TRUNCATE confluence_signals')
        cur.executemany('INSERT INTO confluence_signals VALUES (%s,%s,%s,%s,%s,%s)', batch)
        results.append(ranker._get_confluence_scores())
    assert results[0] == results[1]
    assert results[0]['AAA'] > results[0]['BBB']


@pytest.mark.postgres
def test_learner_reads_first_eligible_long_not_last_cycle(pg_schema):
    con, _ = pg_schema
    cur = con.cursor()
    cur.execute('CREATE TABLE intraday_recommendation_outcomes '
                '(symbol TEXT, computed_at TEXT, direction TEXT, outcome TEXT, pnl_pct REAL)')
    cur.execute('CREATE TABLE intraday_recommendations_history '
                '(symbol TEXT, computed_at TEXT, cycle_at TEXT, classification TEXT, '
                'entry_price REAL, target_1 REAL, stop_loss REAL, breakout_score REAL, '
                'news_sentiment REAL, intraday_regime TEXT, bullish_count INT, conviction_level TEXT)')
    cur.executemany('INSERT INTO intraday_recommendation_outcomes VALUES (%s,%s,%s,%s,%s)',
                    [('AAA','2026-09-16','LONG','WIN',1), ('AAA','2026-09-16','SHORT','LOSS',-1),
                     ('PENDING','2026-09-16','LONG','PENDING',None)])
    for sym in ('AAA', 'PENDING'):
        for cycle, cls, entry, news, regime in [('08:00','Hold',100,0,'NEUTRAL'),
                ('08:30','Buy',None,0,'NEUTRAL'), ('09:00','Buy',100,.8,'BULL'),
                ('10:00','Buy',100,-.8,'BEAR')]:
            cur.execute('INSERT INTO intraday_recommendations_history VALUES '
                        '(%s,%s,%s,%s,%s,110,95,70,%s,%s,3,%s)',
                        (sym,'2026-09-16',cycle,cls,entry,news,regime,'A_HIGH'))
    tree = ast.parse(textwrap.dedent(inspect.getsource(learner.run)))
    sql = next(n.value for n in ast.walk(tree) if isinstance(n, ast.Constant)
               and isinstance(n.value, str) and 'SELECT o.outcome' in n.value)
    cur.execute(sql.replace('?', '%s'), ('2026-09-01',))
    rows = cur.fetchall()
    assert len(rows) == 1
    assert rows[0][3] == pytest.approx(.8)
    assert rows[0][4] == 'BULL'
