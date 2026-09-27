"""Chatbot market tools against the REAL production schema (AF-20260925-05).

Why this file exists: three tools were broken on Postgres for weeks -- `get_sector_momentum` returned
`[]` (SELECT aliases used in HAVING, an ungrouped column), `get_signal_accuracy` lost its model
section (columns `auc`/`accuracy` do not exist), and `get_top_confluence_stocks` scanned every
compressed chunk -- while the whole suite stayed green. Every tool wraps its queries in
`except Exception`, so a SQL error looks exactly like "no data", and no test asserted a non-empty
result. Two defences here: (1) every tool, every branch, runs through a connection that RECORDS each
failed statement even when the tool swallows it, and the test asserts there were none; (2) the three
fixed tools are checked for real content against a seeded copy of the production schema.

The fixtures come from `pg_db_conn` (the full schema in a throwaway schema, reached through
db_compat.connect() itself), not from hand-written DDL -- hand-written DDL is how a test drifts from
the schema it claims to check.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'server', 'chatbot'))
sys.path.insert(0, os.path.dirname(__file__))

from _pg_support import pg_available
from tools import market_tool as mt

pytestmark = pytest.mark.skipif(not pg_available(), reason="live Postgres not reachable")


def _ago(**kw) -> datetime:
    return datetime.now(timezone.utc) - timedelta(**kw)


class _RecordingConn:
    """Proxy that records every statement that fails, then re-raises: the tools swallow errors."""

    def __init__(self, conn, failures):
        self._c, self._failures = conn, failures

    def execute(self, sql, params=()):
        try:
            return self._c.execute(sql, params)
        except Exception as exc:
            self._failures.append((" ".join(sql.split())[:90], type(exc).__name__,
                                   str(exc).splitlines()[0][:140]))
            raise

    def close(self):  # the fixture owns the connection
        pass

    def __getattr__(self, name):
        return getattr(self._c, name)


@pytest.fixture
def db(pg_db_conn, monkeypatch):
    failures: list = []
    monkeypatch.setattr(mt, "_connect", lambda *a, **k: _RecordingConn(pg_db_conn, failures))
    pg_db_conn.failures = failures
    return pg_db_conn


def _insert(conn, table, **cols):
    names = ", ".join(cols)
    marks = ", ".join("?" for _ in cols)
    conn.execute(f"INSERT INTO {table} ({names}) VALUES ({marks})", tuple(cols.values()))


def _seed_sector_data(conn):
    for sym, sector in (("INFY", "IT"), ("TCS", "IT")):
        _insert(conn, "nse_stocks", symbol=sym, name=sym + " Ltd", sector=sector, industry="Software")
        _insert(conn, "quant_scores", symbol=sym, return_1m=4.0, return_3m=9.0,
                momentum_score=71.0, above_sma200=1)
    for i, sent in enumerate(("BULLISH", "BULLISH", "BEARISH")):
        _insert(conn, "news_sentiment_items", id=f"n{i}", title=f"n{i}", source="test", sector="IT",
                sentiment=sent, sentiment_score=0.5 if sent == "BULLISH" else -0.4,
                published_at=_ago(days=1))


# (function name, kwargs) -- every public tool, including the parameterised branches that a
# no-argument smoke call never reaches (the sector branch of get_sector_momentum was broken too).
_CALLS = [
    ("get_market_pulse", {}),
    ("get_top_confluence_stocks", {}),
    ("get_top_confluence_stocks", {"conviction": "ELITE", "sector": "IT", "min_confluence": 0}),
    ("get_stock_signals", {"symbol": "RELIANCE"}),
    ("get_fii_dii_sentiment", {}),
    ("get_sector_momentum", {}),
    ("get_sector_momentum", {"sector": "IT"}),
    ("get_signal_accuracy", {}),
    ("get_live_news_sentiment", {}),
    ("get_live_news_sentiment", {"symbol": "INFY"}),
    ("get_live_news_sentiment", {"sector": "IT"}),
    ("get_daily_briefing", {}),
    ("get_unified_recommendation", {"symbol": "RELIANCE"}),
]


@pytest.mark.parametrize("fn_name, kwargs", _CALLS, ids=[f"{n}-{i}" for i, (n, _) in enumerate(_CALLS)])
def test_no_market_tool_swallows_a_sql_error(db, fn_name, kwargs):
    getattr(mt, fn_name)(**kwargs)
    assert db.failures == [], f"{fn_name}{kwargs} swallowed failed SQL: {db.failures}"


def test_sector_momentum_all_sectors_returns_news_and_quant_sections(db):
    _seed_sector_data(db)
    out = mt.get_sector_momentum()
    assert db.failures == []
    news = out["sector_news_sentiment"]
    assert news and news[0]["sector"] == "IT" and news[0]["total_news"] == 3
    assert isinstance(news[0]["avg_sentiment"], float)          # not Decimal
    quant = out["quant_momentum_by_sector"]
    assert quant and quant[0]["stock_count"] == 2 and quant[0]["avg_momentum_score"] == 71.0
    assert quant[0]["above_sma200_count"] == 2


def test_sector_momentum_single_sector_returns_grouped_sentiment_and_top_stocks(db):
    _seed_sector_data(db)
    # _SECTOR_ALIASES maps "IT" -> ("Information Technology" for confluence, "IT" for news).
    _insert(db, "confluence_signals", symbol="INFY", computed_at=_ago(hours=1), confluence_score=80.0,
            conviction_level="ELITE", sector="Information Technology")
    out = mt.get_sector_momentum(sector="IT")
    assert db.failures == []
    by_sent = {r["sentiment"]: r for r in out["sector_news_sentiment"]}
    assert by_sent["BULLISH"]["cnt"] == 2 and by_sent["BEARISH"]["cnt"] == 1
    assert by_sent["BULLISH"]["sentiment_score"] == pytest.approx(0.5)   # an AVG, not an arbitrary row
    assert [r["symbol"] for r in out["top_stocks"]] == ["INFY"]


def test_signal_accuracy_reports_the_active_model_with_real_columns(db):
    _insert(db, "model_registry", model_name="ensemble", model_version="t1", model_type="stack",
            trained_at=_ago(days=1), cv_roc_auc=0.531, cv_accuracy=0.54, is_active=1)
    out = mt.get_signal_accuracy()
    assert db.failures == []
    m = out["active_model"]
    assert m["model_name"] == "ensemble" and m["cv_roc_auc"] == pytest.approx(0.531)
    assert "NOT realized accuracy" in m["note"]        # a self-reported CV number must be labelled


def test_top_confluence_returns_the_latest_row_per_symbol_inside_the_window(db):
    for sym, hours, score in (("AAA", 2, 70.0), ("AAA", 1, 80.0), ("BBB", 24 * 10, 95.0)):
        _insert(db, "confluence_signals", symbol=sym, computed_at=_ago(hours=hours),
                confluence_score=score, conviction_level="HIGH", sector="IT")
    rows = mt.get_top_confluence_stocks(min_confluence=0)
    assert db.failures == []
    assert [(r["symbol"], r["confluence_score"]) for r in rows] == [("AAA", 80.0)]
    # BBB's newest row is 10 days old: outside _CONFLUENCE_LATEST_WINDOW_DAYS, so it is not
    # "current" confluence -- and excluding it is what bounds the scan to the newest chunks.


def test_swallowed_failures_are_reported_on_stderr(monkeypatch, capsys):
    class _Boom:
        def execute(self, *a, **k):
            raise RuntimeError('boom: column "x" does not exist\nsecond line is dropped')

        def close(self):
            pass

    monkeypatch.setattr(mt, "_connect", lambda *a, **k: _Boom())
    assert mt.get_signal_accuracy() == {}        # graceful: sections dropped, no exception
    err = capsys.readouterr().err
    assert "[market_tool] get_signal_accuracy:" in err and "RuntimeError" in err
    assert "second line" not in err
