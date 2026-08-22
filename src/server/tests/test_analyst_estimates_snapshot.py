"""
TDD tests for analyst_estimates_snapshot.py.

Pure-function tests (parse_*) need no DB.
DB-integration tests use a temp SQLite via DATABASE_URL env injection.
No network calls: fetch_fn is injected via run(fetch_fn=...).
"""

import importlib
import os
import sys
import uuid

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

import analyst_estimates_snapshot as aes


# ── Pure-function tests ───────────────────────────────────────────────────────

class TestParseAnalystRating:
    def test_extracts_buy_hold_sell_counts(self):
        data = {
            "analystCount": "20",
            "finalRating": "BUY",
            "ratings": [
                {"name": "BUY",  "value": "15"},
                {"name": "HOLD", "value": "3"},
                {"name": "SELL", "value": "2"},
            ],
        }
        r = aes.parse_analyst_rating(data)
        assert r["n_analysts"]   == 20
        assert r["final_rating"] == "BUY"
        assert r["buy_count"]    == 15
        assert r["hold_count"]   == 3
        assert r["sell_count"]   == 2

    def test_neutral_rating_counted_as_hold(self):
        data = {
            "analystCount": "5",
            "finalRating": "NEUTRAL",
            "ratings": [{"name": "NEUTRAL", "value": "5"}],
        }
        r = aes.parse_analyst_rating(data)
        assert r["hold_count"] == 5
        assert r["buy_count"]  is None
        assert r["sell_count"] is None

    def test_returns_none_fields_for_empty_dict(self):
        r = aes.parse_analyst_rating({})
        assert r["n_analysts"] is None
        assert r["final_rating"] is None

    def test_returns_none_fields_for_none_input(self):
        r = aes.parse_analyst_rating(None)
        assert all(v is None for v in r.values())

    def test_analyst_count_zero_becomes_none(self):
        data = {"analystCount": "0", "finalRating": None, "ratings": []}
        r = aes.parse_analyst_rating(data)
        assert r["n_analysts"] is None

    def test_outperform_counted_as_buy_underperform_as_sell(self):
        data = {
            "analystCount": "40",
            "finalRating": "Outperform",
            "ratings": [
                {"name": "BUY",         "value": "20"},
                {"name": "OUTPERFORM",  "value": "13"},
                {"name": "HOLD",        "value": "4"},
                {"name": "UNDERPERFORM","value": "2"},
                {"name": "SELL",        "value": "1"},
            ],
        }
        r = aes.parse_analyst_rating(data)
        assert r["buy_count"]  == 33   # 20 + 13
        assert r["hold_count"] == 4
        assert r["sell_count"] == 3    # 2 + 1


class TestParsePriceForecast:
    def test_extracts_high_mean_low(self):
        data = {"high": "2500.0", "mean": "2100.0", "low": "1800.0", "displayLock": "0"}
        r = aes.parse_price_forecast(data)
        assert r["target_high"] == pytest.approx(2500.0)
        assert r["target_mean"] == pytest.approx(2100.0)
        assert r["target_low"]  == pytest.approx(1800.0)

    def test_returns_none_for_none_input(self):
        r = aes.parse_price_forecast(None)
        assert all(v is None for v in r.values())

    def test_zero_mean_becomes_none(self):
        r = aes.parse_price_forecast({"mean": "0", "high": "0", "low": "0"})
        assert r["target_mean"] is None
        assert r["target_high"] is None

    def test_string_float_parsed(self):
        data = {"high": "3000", "mean": "2800.50", "low": "2600.25"}
        r = aes.parse_price_forecast(data)
        assert r["target_mean"] == pytest.approx(2800.50)


class TestParseEarningsForecast:
    def test_picks_next_period_with_empty_actual(self):
        data = {
            "eps": [
                {"date": "Mar 2025", "avg": "50.0", "actual": "48.5"},   # past
                {"date": "Mar 2026", "avg": "62.0", "actual": ""},        # future
            ],
            "revenue": [
                {"date": "Mar 2025", "avg": "50000", "actual": "49000"},
                {"date": "Mar 2026", "avg": "58000", "actual": None},
            ],
        }
        r = aes.parse_earnings_forecast(data)
        assert r["eps_est_next"]     == pytest.approx(62.0)
        assert r["revenue_est_next"] == pytest.approx(58000.0)

    def test_returns_none_when_all_entries_have_actuals(self):
        data = {
            "eps": [{"date": "Mar 2025", "avg": "50.0", "actual": "48.5"}],
            "revenue": [],
        }
        r = aes.parse_earnings_forecast(data)
        assert r["eps_est_next"]     is None
        assert r["revenue_est_next"] is None

    def test_returns_none_for_none_input(self):
        r = aes.parse_earnings_forecast(None)
        assert all(v is None for v in r.values())

    def test_missing_avg_returns_none(self):
        data = {"eps": [{"date": "Mar 2026", "avg": None, "actual": ""}], "revenue": []}
        r = aes.parse_earnings_forecast(data)
        assert r["eps_est_next"] is None


# ── DB-integration tests ──────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _restore_db_env():
    """Repoint POSTGRES_URL at a throwaway Postgres schema per test; restore + invalidate engine cache after."""
    import psycopg2
    from pg_test_support import _pg_dsn, _sa_url, pg_available, drop_throwaway_schema
    if not pg_available():
        pytest.skip("live Postgres not reachable — set PGTEST_* or start the container")
    saved = {k: os.environ.get(k) for k in ("POSTGRES_URL", "USE_POSTGRES", "DATABASE_URL")}
    schema = f"t_{uuid.uuid4().hex[:12]}"
    admin = psycopg2.connect(**_pg_dsn())
    admin.autocommit = True
    admin.cursor().execute(f'CREATE SCHEMA "{schema}"')
    os.environ["USE_POSTGRES"] = "true"
    os.environ["POSTGRES_URL"] = _sa_url(schema)
    os.environ.pop("DATABASE_URL", None)
    yield
    import db_compat
    # MUST precede the DROP: pooled connections still scoped to this schema hold
    # AccessShareLocks on its tables, and DROP SCHEMA CASCADE needs AccessExclusiveLock.
    # reload() alone abandons the old engine cache with its sockets open. See dispose_engines().
    db_compat.dispose_engines()
    try:
        drop_throwaway_schema(admin, schema)
    finally:
        admin.close()
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    importlib.reload(db_compat)


def _make_db(symbols_with_mc: list):
    """Create nse_stocks + analyst_estimates_history in the throwaway Postgres schema.
    Returns a ConnWrapper for assertions."""
    import db_compat
    importlib.reload(db_compat)
    importlib.reload(aes)
    con = db_compat.connect()
    con.executescript("""
        CREATE TABLE nse_stocks (
            symbol TEXT PRIMARY KEY, mcsymbol TEXT, name TEXT,
            sector TEXT, industry TEXT, isin TEXT, status TEXT
        );
        CREATE TABLE analyst_estimates_history (
            symbol           TEXT NOT NULL,
            as_of_date       TEXT NOT NULL,
            n_analysts       INTEGER,
            final_rating     TEXT,
            buy_count        INTEGER,
            hold_count       INTEGER,
            sell_count       INTEGER,
            target_high      REAL,
            target_mean      REAL,
            target_low       REAL,
            eps_est_next     REAL,
            revenue_est_next REAL,
            captured_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, as_of_date)
        );
    """)
    for symbol, mcsymbol in symbols_with_mc:
        con.execute("INSERT INTO nse_stocks (symbol, mcsymbol) VALUES (?, ?)", (symbol, mcsymbol))
    con.commit()
    return con


def _good_fetch(_mcsymbol):
    return {
        "n_analysts": 10, "final_rating": "BUY",
        "buy_count": 7, "hold_count": 2, "sell_count": 1,
        "target_high": 2500.0, "target_mean": 2100.0, "target_low": 1800.0,
        "eps_est_next": 60.0, "revenue_est_next": 50000.0,
    }


def _empty_fetch(_mcsymbol):
    return {k: None for k in ("n_analysts", "final_rating", "buy_count", "hold_count",
                               "sell_count", "target_high", "target_mean", "target_low",
                               "eps_est_next", "revenue_est_next")}


class TestRunDb:
    def test_writes_one_row_per_covered_symbol(self):
        con = _make_db([("RELIANCE", "RL"), ("TCS", "TCS01")])
        n = aes.run(as_of="2026-06-22", fetch_fn=_good_fetch)
        assert n == 2
        assert con.execute("SELECT COUNT(*) FROM analyst_estimates_history").fetchone()[0] == 2

    def test_idempotent_same_date_overwrites(self):
        con = _make_db([("RELIANCE", "RL")])
        aes.run(as_of="2026-06-22", fetch_fn=_good_fetch)
        aes.run(as_of="2026-06-22", fetch_fn=_good_fetch)
        count = con.execute(
            "SELECT COUNT(*) FROM analyst_estimates_history WHERE as_of_date='2026-06-22'"
        ).fetchone()[0]
        assert count == 1

    def test_different_dates_keep_separate_rows(self):
        con = _make_db([("RELIANCE", "RL")])
        aes.run(as_of="2026-06-21", fetch_fn=_good_fetch)
        aes.run(as_of="2026-06-22", fetch_fn=_good_fetch)
        count = con.execute("SELECT COUNT(*) FROM analyst_estimates_history").fetchone()[0]
        assert count == 2

    def test_skips_symbols_with_all_none_data(self):
        con = _make_db([("NOCOVER", "NC01")])
        n = aes.run(as_of="2026-06-22", fetch_fn=_empty_fetch)
        assert n == 0
        assert con.execute("SELECT COUNT(*) FROM analyst_estimates_history").fetchone()[0] == 0

    def test_stores_correct_field_values(self):
        con = _make_db([("RELIANCE", "RL")])
        aes.run(as_of="2026-06-22", fetch_fn=_good_fetch)
        row = con.execute(
            "SELECT n_analysts, final_rating, buy_count, hold_count, sell_count, "
            "target_high, target_mean, target_low, eps_est_next, revenue_est_next "
            "FROM analyst_estimates_history WHERE symbol='RELIANCE'"
        ).fetchone()
        assert row[0] == 10
        assert row[1] == "BUY"
        assert row[2] == 7
        assert row[3] == 2
        assert row[4] == 1
        assert row[5] == pytest.approx(2500.0)
        assert row[6] == pytest.approx(2100.0)
        assert row[7] == pytest.approx(1800.0)
        assert row[8] == pytest.approx(60.0)
        assert row[9] == pytest.approx(50000.0)

    def test_skips_symbol_without_mcsymbol(self):
        con = _make_db([("RELIANCE", "RL"), ("UNKNOWN", None)])
        n = aes.run(as_of="2026-06-22", fetch_fn=_good_fetch)
        assert n == 1  # only RELIANCE has mcsymbol


# ── build_features analyst factors ───────────────────────────────────────────

class TestAnalystBuildFeatures:
    """build_features must emit analyst_buy_pct, n_analysts_log, target_upside_pct
    even when those columns are absent from the input (falls back to neutral defaults)."""

    def _df(self, **extra):
        import pandas as pd
        import numpy as np
        base = {
            "signal_score": [7], "rsi": [55.0], "adx": [25.0], "volume_ratio": [1.0],
            "horizon_days": [15], "nifty_regime": ["BULL"],
            "cmp": [100.0], "sma200": [90.0], "fii_3d_net": [0.0],
            "above_sma200": [1], "fifty_two_week_high": [110.0],
            "signals_json": ["[]"], "signal_date": ["2026-06-22"],
        }
        base.update(extra)
        return pd.DataFrame(base)

    def test_analyst_features_emitted_when_absent(self):
        import sys
        sys.path.insert(0, SERVER_DIR)
        from ml_ensemble import build_features
        X = build_features(self._df())
        assert "analyst_buy_pct"   in X.columns
        assert "n_analysts_log"    in X.columns
        assert "target_upside_pct" in X.columns

    def test_analyst_buy_pct_neutral_when_no_data(self):
        from ml_ensemble import build_features
        X = build_features(self._df())
        assert X["analyst_buy_pct"].iloc[0] == pytest.approx(0.5)  # neutral default

    def test_analyst_buy_pct_computed_from_buy_n_analysts(self):
        from ml_ensemble import build_features
        X = build_features(self._df(buy_count=[7], n_analysts=[10]))
        assert X["analyst_buy_pct"].iloc[0] == pytest.approx(0.7)

    def test_target_upside_positive_when_target_above_cmp(self):
        from ml_ensemble import build_features
        # cmp=100, target_mean=120 → upside = 20%
        X = build_features(self._df(target_mean=[120.0]))
        assert X["target_upside_pct"].iloc[0] == pytest.approx(20.0)
