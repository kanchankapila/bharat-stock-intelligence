"""Live-datasource test for stock_option_chain_fetcher.py (see CLAUDE.md's "Adding a new
data source" mandatory rule). NiftyTrader-sourced (distinct provider/table from
so_option_chain_fetcher.py's Trendlyne SmartOptions Greeks feed -- this one computes
expected-move/GEX-proxy/ATM-IV rather than raw per-strike Greeks). RELIANCE chosen -- a
real, always-liquid F&O stock.

Per the endpoint-corpus review's documented gotcha (CLAUDE.md 2026-07-31): an expired/
malformed expiry can return 200 with real OI but zeroed Greeks/IV that still LOOKS valid to
a naive check -- this test doesn't pass an explicit expiry at all, using fetch_chain()'s own
nearest-expiry default exactly as production does, and separately asserts atm_iv is a
plausible fraction (not exactly 0.0) when present.
"""
import os

os.environ["POSTGRES_HOST"] = "127.0.0.1"
os.environ["POSTGRES_PORT"] = "5433"

import sys

import pytest
import requests
from sqlalchemy import create_engine, text

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import stock_option_chain_fetcher as soc
from live_datasource_helpers import assert_numeric_and_finite

REAL_SYMBOL = "RELIANCE"


def _make_sqlite_engine():
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE technical_signals (
                symbol TEXT, date TEXT,
                expected_move_pct REAL, stock_gex_proxy REAL, atm_iv REAL,
                next_expiry_iv REAL, iv_term_slope REAL
            )
        """))
        conn.execute(text(
            "INSERT INTO technical_signals (symbol, date) VALUES (:s, :d)"
        ), {"s": REAL_SYMBOL, "d": "2026-01-01"})
        conn.execute(text("""
            CREATE TABLE stock_options_oi (
                symbol TEXT, date TEXT, expiry TEXT, call_oi REAL, put_oi REAL, pcr REAL,
                total_call_oi REAL, total_put_oi REAL, market_pcr REAL, atm_iv REAL,
                iv_skew REAL, fetched_at TEXT,
                PRIMARY KEY (symbol, date, expiry)
            )
        """))
    return engine


@pytest.mark.live_datasource
class TestStockOptionChainFetcherLiveDataSource:
    def test_real_fetch_and_compute_features(self):
        """Hits the real NiftyTrader option-chain endpoint for RELIANCE (nearest expiry,
        no forced date) via the fetcher's own fetch_chain(), computed with its own
        compute_features()."""
        session = requests.Session()
        session.headers.update(soc.HEADERS)
        result_data = soc.fetch_chain(session, REAL_SYMBOL)
        assert result_data is not None, "fetch_chain() returned None for RELIANCE -- endpoint may be down/changed"

        features = soc.compute_features(result_data, REAL_SYMBOL)
        assert features is not None, "compute_features() returned None for a real RELIANCE chain"
        assert_numeric_and_finite(features["spot"], context="spot")
        assert features["spot"] > 0
        if features.get("expected_move_pct") is not None:
            assert_numeric_and_finite(features["expected_move_pct"], context="expected_move_pct")
        if features.get("atm_iv") is not None:
            # A genuinely computed IV is never exactly 0.0 -- catches the documented
            # expired-expiry trap (real OI, zeroed Greeks) that still passes a bare non-null check.
            assert features["atm_iv"] != 0.0, "atm_iv is exactly 0.0 -- looks like the expired-expiry zero-Greeks trap"
            assert 0.0 < features["atm_iv"] < 5.0, f"atm_iv {features['atm_iv']} outside a plausible fractional-vol range"

    def test_write_path_stores_ml_usable_rows(self):
        """Writes real computed RELIANCE features through the fetcher's own
        ensure_schema()/upsert_features()/patch_technical_signals() against a real
        (throwaway) SQLite engine."""
        orig_use_postgres = os.environ.get("USE_POSTGRES")
        os.environ["USE_POSTGRES"] = "false"
        try:
            session = requests.Session()
            session.headers.update(soc.HEADERS)
            result_data = soc.fetch_chain(session, REAL_SYMBOL)
            assert result_data is not None, "no real chain to exercise the write path with"
            features = soc.compute_features(result_data, REAL_SYMBOL)
            assert features is not None, "no real computed features to exercise the write path with"
            # main() always sets these two keys (via next_month_iv(), best-effort) before
            # calling upsert_features() -- its SQL requires both bind params to be present.
            features["next_expiry_iv"] = None
            features["iv_term_slope"] = None
            if features.get("atm_iv") is not None and features.get("expiry"):
                nxt_iv, _nxt_expiry = soc.next_month_iv(session, REAL_SYMBOL, features["expiry"])
                if nxt_iv is not None:
                    features["next_expiry_iv"] = nxt_iv
                    features["iv_term_slope"] = round(nxt_iv - features["atm_iv"], 4)

            engine = _make_sqlite_engine()
            soc.ensure_schema(engine)
            today = "2026-01-01"
            soc.upsert_features(engine, features, today)
            soc.patch_technical_signals(
                engine, REAL_SYMBOL, today,
                features.get("expected_move_pct"), features.get("gex_proxy"), features.get("atm_iv"),
            )

            with engine.connect() as conn:
                row = conn.execute(text(
                    "SELECT symbol, spot, expected_move_pct FROM stock_option_features WHERE symbol = :s"
                ), {"s": REAL_SYMBOL}).fetchone()
            assert row is not None, "upsert_features() wrote no row to stock_option_features"
            assert row[0] == REAL_SYMBOL
            assert_numeric_and_finite(row[1], context="stock_option_features.spot")

            with engine.connect() as conn:
                ts_row = conn.execute(text(
                    "SELECT expected_move_pct, stock_gex_proxy FROM technical_signals "
                    "WHERE symbol = :s AND date = :d"
                ), {"s": REAL_SYMBOL, "d": today}).fetchone()
            assert ts_row is not None
        finally:
            if orig_use_postgres is None:
                os.environ.pop("USE_POSTGRES", None)
            else:
                os.environ["USE_POSTGRES"] = orig_use_postgres
