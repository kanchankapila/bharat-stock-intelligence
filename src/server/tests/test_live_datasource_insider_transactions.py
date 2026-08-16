"""Live-datasource test for insider_transactions_fetcher.py (see CLAUDE.md's "Adding a new
data source" mandatory rule). One of the ~130 previously-untested fetchers flagged in the
2026-07-30 fifth full-stack-audit pass.

Uses a long lookback window (720 days) since insider/promoter transaction filings are sparse
per stock — a short window risks a false negative on a quiet stock, not a fetcher bug.
"""
import os
import sqlite3
import sys
from datetime import date, timedelta

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import insider_transactions_fetcher as itf
from live_datasource_helpers import assert_looks_like_ticker, assert_stored_row_ml_usable
from conftest import conn_is_postgres

REAL_SYMBOL = "RELIANCE"
NSE_DATE_FMT = "%d-%m-%Y"


def _make_test_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    itf.ensure_schema(conn)
    conn.execute("CREATE TABLE nse_stocks (symbol TEXT, status TEXT)")
    conn.execute(
        "CREATE TABLE technical_signals (symbol TEXT, date TEXT, "
        "promoter_buy_90d_cr REAL, promoter_sell_90d_cr REAL, promoter_net_90d REAL, "
        "insider_buy_flag INTEGER, insider_sell_flag INTEGER)"
    )
    # compute_and_write_features() reads from insider_trades (a DIFFERENT, older table this
    # fetcher does NOT write to -- see test_insider_transactions_fetcher.py's own
    # TestComputeAndWriteFeaturesReadsInsiderTrades fixture, which this mirrors), not the
    # insider_transactions table upsert_transactions() writes above -- by design, not a bug
    # (found missing from this fixture 2026-08-07 while strengthening the before_pct/after_pct
    # assertions; this table was never created, so the second test always failed here
    # regardless of before_pct/after_pct, a pre-existing gap unrelated to that fix).
    conn.execute(
        'CREATE TABLE insider_trades (symbol TEXT, "typeOfTransaction" TEXT, '
        '"valueInr" REAL, category TEXT, date_iso TEXT)'
    )
    conn.execute(
        "INSERT INTO technical_signals (symbol, date) VALUES (?, ?)",
        (REAL_SYMBOL, date.today().isoformat()),
    )
    conn.commit()
    return conn


@pytest.mark.live_datasource
class TestInsiderTransactionsLiveDataSource:
    def test_real_fetch_parses_ml_usable_records(self, monkeypatch):
        """Step 1-3: hit the real NSE corporates-pit endpoint, parse with the fetcher's own
        fetch_nse_insider()/_parse_record(), assert any returned rows are ML-usable."""
        sess = itf._nse_session()
        today = date.today()
        to_date = today.strftime(NSE_DATE_FMT)
        from_date = (today - timedelta(days=720)).strftime(NSE_DATE_FMT)

        raw = itf.fetch_nse_insider(sess, REAL_SYMBOL, from_date, to_date)
        # A quiet 2-year window with zero promoter filings is plausible (not every large-cap
        # has recent insider activity), so we don't hard-require non-empty — but if NSE DID
        # return rows, every one must parse into an ML-usable record.
        parsed = [p for p in (itf._parse_record(REAL_SYMBOL, r) for r in raw) if p]
        if not raw:
            pytest.skip(f"NSE returned zero insider filings for {REAL_SYMBOL} in the last 720 days "
                        f"(plausible, not necessarily a fetcher bug) — nothing to validate")
        assert parsed, f"NSE returned {len(raw)} raw rows for {REAL_SYMBOL} but none parsed successfully"

        for p in parsed:
            assert_looks_like_ticker(p["symbol"], "insider record symbol")
            assert p["transaction_date"], "parsed record missing transaction_date"

        # Regression guard added 2026-08-07: before_pct/after_pct were derived from a
        # totSharesNo field that doesn't exist in NSE's real response at all, so they were
        # 100% NULL for every row ever written (23,596/23,596) despite this whole test
        # passing throughout, because it never checked these two fields specifically. NSE
        # supplies the percentage directly (befAcqSharesPer/afterAcqSharesPer) -- assert at
        # least one real filing in this window has a non-null value for each, not just that
        # the field exists on the dict.
        assert any(p["before_pct"] is not None for p in parsed), (
            "every before_pct came back None -- check befAcqSharesPer is still the real NSE "
            "field name (this table has no totSharesNo field to derive a ratio from)"
        )
        assert any(p["after_pct"] is not None for p in parsed), (
            "every after_pct came back None -- check afterAcqSharesPer is still the real NSE field name"
        )

    def test_real_fetch_stores_ml_usable_rows_and_computes_features(self, monkeypatch):
        """Step 4-5: write through the fetcher's own upsert_transactions()/
        compute_and_write_features() into a throwaway in-memory SQLite DB, then read back and
        validate. The dialect branch is keyed on the CONNECTION, not hardcoded: under the
        decommission shim the throwaway DB is Postgres, and a pinned False builds
        `INSERT OR REPLACE` and fires it at Postgres (translate() rejects it outright)."""

        sess = itf._nse_session()
        today = date.today()
        to_date = today.strftime(NSE_DATE_FMT)
        from_date = (today - timedelta(days=720)).strftime(NSE_DATE_FMT)
        raw = itf.fetch_nse_insider(sess, REAL_SYMBOL, from_date, to_date)
        parsed = [p for p in (itf._parse_record(REAL_SYMBOL, r) for r in raw) if p]
        if not parsed:
            pytest.skip(f"no parseable insider filings for {REAL_SYMBOL} in the last 720 days "
                        f"— nothing to round-trip through storage")

        conn = _make_test_conn()
        monkeypatch.setattr(itf, "use_postgres", lambda: conn_is_postgres(conn))
        n = itf.upsert_transactions(conn, parsed)
        assert n == len(parsed)

        stored = conn.execute(
            "SELECT * FROM insider_transactions WHERE symbol = ? LIMIT 1", (REAL_SYMBOL,)
        ).fetchone()
        assert stored is not None, "no row landed in insider_transactions after upsert_transactions()"
        assert_stored_row_ml_usable(dict(stored), numeric_cols=[], ticker_cols=["symbol"],
                                     context="insider_transactions")

        itf.compute_and_write_features(conn, REAL_SYMBOL, days=720)
        ts_row = conn.execute(
            "SELECT * FROM technical_signals WHERE symbol = ?", (REAL_SYMBOL,)
        ).fetchone()
        assert ts_row is not None
        ts_row = dict(ts_row)
        for col in ("promoter_buy_90d_cr", "promoter_sell_90d_cr", "promoter_net_90d"):
            assert ts_row[col] is not None, f"{col} was not written by compute_and_write_features()"
        conn.close()
