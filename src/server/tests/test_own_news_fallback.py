"""news_sentiment_score's fallback comes from the platform's own tagged news, identically in every
training and scoring query (replacing GDELT, retired 2026-09-11).

GDELT throttled this host (HTTP 429 on 2 of 3 compliant requests) and, over the last 10 trading
dates, filled 0 technical_signals rows -- every symbol it covered already had a primary score.
The platform's own news (news_symbol_link: 21 sources incl. pre-market-hour articles, ~1-1.8k
symbol links/day) had tagged articles in the prior 30 days for ~80% of the rows whose primary
score is NULL (368-419 of 466-526 per date).

Before this change only the TRAINING queries applied a fallback; the SCORING queries used the raw
column. That is train/serve skew by construction (recurring-bugs / ml-model-bugs), so the source
text of all four queries is checked for the same expression -- same shape as
test_ml_ensemble_pricefeed_fallback.py.
"""
import ast
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import ml_ensemble  # noqa: E402

SRC = os.path.join(os.path.dirname(__file__), "..", "ml_ensemble.py")
FALLBACK = re.compile(r"COALESCE\(ts\.news_sentiment_score,\s*own_news\.news_30d\)\s+AS\s+news_sentiment_score")


def _source():
    with open(SRC, encoding="utf-8") as f:
        return f.read()


def _func_body(src, name):
    a = src.index("def " + name + "(")
    nxt = src.find(chr(10) + "def ", a + 1)
    return src[a:nxt if nxt != -1 else len(src)]


def _live_queries():
    src = _source()
    train_body = _func_body(src, "load_training_data")
    a = train_body.index("    if use_postgres():")
    select_cols, joins = ml_ensemble.full_feature_score_sql()
    train_select, train_joins = ml_ensemble.full_feature_train_sql()
    return {
        "load_training_data (postgres)": train_body[a:train_body.index("    else:", a)],
        "load_pending_signals": _func_body(src, "load_pending_signals").split("    else:")[0],
        "full_feature_train_sql": train_select + train_joins,
        "full_feature_score_sql": select_cols + joins,
    }


def test_every_live_query_uses_the_same_own_news_fallback():
    for name, sql in _live_queries().items():
        assert FALLBACK.search(sql), f"{name}: missing the own-news fallback"
        assert "own_news_fallback_join(" in sql or "news_symbol_link nsl" in sql, \
            f"{name}: fallback expression without the own-news join"


def _code_lines(src):
    """(lineno, line) for every line EXCEPT docstrings. Docstrings are documentation and are
    allowed to name a retired source; executable code and SQL strings are not. `#` comments are
    filtered by the caller. Bare string statements that are not first-in-body (i.e. not
    docstrings) are treated as code and correctly fail the check."""
    drop = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) \
                    and isinstance(body[0].value, ast.Constant) \
                    and isinstance(body[0].value.value, str):
                drop.update(range(body[0].lineno, (body[0].end_lineno or body[0].lineno) + 1))
    return [(i + 1, line) for i, line in enumerate(src.splitlines()) if i + 1 not in drop]


def test_ml_ensemble_never_reads_the_retired_gdelt_table():
    """Whole-file check, because the per-query version had a hole in it.

    _live_queries() slices load_training_data() at `    else:`, i.e. it deliberately reads only
    the Postgres half of that function. A retired source can therefore sit in the other half and
    this guard stays green while the file's own docstring says GDELT was retired — which is
    exactly what happened: load_training_data's unreachable SQLite branch kept a
    `COALESCE(ts.news_sentiment_score, (SELECT AVG(avg_tone) ... FROM gdelt_sentiment ...))`
    fallback for two weeks after the 2026-09-11 retirement.

    Assert over the entire file instead: the identifier may appear in prose (docstrings, comments —
    recording WHY it was retired is wanted) but in no executable line. A SQL fragment embedded in
    an f-string or triple-quoted query is an executable line, so the shape that actually broke
    still fails here.
    """
    for lineno, line in _code_lines(_source()):
        if "gdelt" in line.lower() and not line.lstrip().startswith("#"):
            raise AssertionError(
                "line %d names the retired GDELT table in executable code (retired 2026-09-11; "
                "the only sentiment fallback is own_news_fallback_join()): %s"
                % (lineno, line.strip()[:110])
            )


def _fallback_value(pg_conn, as_of):
    pg_conn.execute("CREATE TABLE IF NOT EXISTS technical_signals (symbol TEXT, date DATE, news_sentiment_score REAL)")
    pg_conn.execute("DELETE FROM technical_signals")
    pg_conn.execute("INSERT INTO technical_signals VALUES ('ABC', ?, NULL), ('XYZ', ?, 0.9)", (as_of, as_of))
    sql = ("SELECT ts.symbol, COALESCE(ts.news_sentiment_score, own_news.news_30d) AS news_sentiment_score "
           "FROM technical_signals ts " + ml_ensemble.own_news_fallback_join("ts", "date") + " ORDER BY 1")
    return {r[0]: r[1] for r in pg_conn.execute(sql).fetchall()}


def test_fallback_averages_only_the_prior_30_days(pg_conn):
    pg_conn.execute("CREATE TABLE news_symbol_link (news_id TEXT, symbol TEXT, published_at TIMESTAMPTZ, "
                    "sentiment_score REAL, PRIMARY KEY (news_id, symbol))")
    pg_conn.executemany("INSERT INTO news_symbol_link VALUES (?, ?, ?, ?)", [
        ("n1", "ABC", "2026-09-01T10:00:00+00:00", 0.6),    # inside the window
        ("n2", "ABC", "2026-09-09T23:59:00+00:00", -0.2),   # inside, last minute before as-of
        ("n3", "ABC", "2026-09-10T02:00:00+00:00", -1.0),   # ON the as-of date: excluded
        ("n4", "ABC", "2026-09-12T02:00:00+00:00", -1.0),   # after it: look-ahead, excluded
        ("n5", "ABC", "2026-07-01T02:00:00+00:00", 1.0),    # older than 30 days: excluded
        ("n6", "XYZ", "2026-09-05T02:00:00+00:00", -1.0),   # XYZ has a primary score
    ])
    got = _fallback_value(pg_conn, "2026-09-10")
    assert abs(got["ABC"] - 0.2) < 1e-6          # mean(0.6, -0.2)
    assert abs(got["XYZ"] - 0.9) < 1e-6          # the primary value always wins


def test_no_news_in_the_window_stays_null(pg_conn):
    pg_conn.execute("CREATE TABLE news_symbol_link (news_id TEXT, symbol TEXT, published_at TIMESTAMPTZ, "
                    "sentiment_score REAL, PRIMARY KEY (news_id, symbol))")
    assert _fallback_value(pg_conn, "2026-09-10")["ABC"] is None
