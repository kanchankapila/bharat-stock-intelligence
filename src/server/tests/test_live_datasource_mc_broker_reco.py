"""Live-datasource test for mc_broker_reco_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). One of the ~130 previously-untested fetchers flagged in the
2026-07-30 fifth full-stack-audit pass.

mc_broker_reco_fetcher.py writes via db_compat's module-level executemany()/read_df(), and
those go through sql_translate.translate(), which converts SQL differently depending on
USE_POSTGRES -- this test patches sql_translate.use_postgres (not the fetcher module's own
name, since it never imports use_postgres directly; translate()'s internal call resolves
against sql_translate's own globals) so the throwaway SQLite round trip gets `?`-style SQL
regardless of this environment's real USE_POSTGRES setting.
"""
import os
import sqlite3
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import sql_translate
import mc_broker_reco_fetcher as mbr
from live_datasource_helpers import assert_non_empty_response, assert_stored_row_ml_usable


def _install_shims(monkeypatch, conn):
    monkeypatch.setattr(sql_translate, "use_postgres", lambda: False)

    def shim_executemany(sql, seq_of_params):
        conn.executemany(sql, seq_of_params)
        conn.commit()

    def shim_read_df(sql, params=None):
        return pd.read_sql_query(sql, conn, params=params)

    monkeypatch.setattr(mbr, "executemany", shim_executemany)
    monkeypatch.setattr(mbr, "read_df", shim_read_df)


@pytest.mark.live_datasource
class TestMcBrokerRecoLiveDataSource:
    def test_real_fetch_returns_ml_usable_recos(self):
        """Step 1-3: hit the real MC broker-research-reco API, parse with the fetcher's own
        fetch_recos(), assert non-empty and every rec has a usable scid/organization."""
        recos = mbr.fetch_recos(lookback_days=10)
        assert_non_empty_response(recos, "fetch_recos(lookback_days=10)")

        first = recos[0]
        assert first["scid"], "reco missing scid"
        assert first["organization"], "reco missing broker organization"
        assert first["recommend_flag"], "reco missing recommend_flag"

    def test_real_fetch_stores_and_backfills_ml_usable_rows(self, monkeypatch):
        """Step 4-5: write through the fetcher's own upsert_recos()/backfill_technical_signals()
        into a throwaway in-memory SQLite DB, then read the rows back and validate they're
        ML-usable. Maps one real fetched scid onto a synthetic NSE symbol (via a throwaway
        nse_stocks row) purely to exercise the real join/aggregation logic in
        backfill_technical_signals() -- the mapping itself doesn't need to be the real-world
        correct one, only present."""
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        _install_shims(monkeypatch, conn)

        mbr.ensure_schema(conn)
        conn.execute("CREATE TABLE nse_stocks (symbol TEXT, mcsymbol TEXT)")
        conn.execute("CREATE TABLE technical_signals (symbol TEXT, date TEXT, "
                     "mc_broker_buy_7d INTEGER, mc_broker_sell_7d INTEGER, mc_broker_upside REAL)")
        conn.commit()

        recos = mbr.fetch_recos(lookback_days=10)
        assert_non_empty_response(recos, "fetch_recos(lookback_days=10)")

        mbr.upsert_recos(recos)

        stored = conn.execute("SELECT * FROM mc_broker_reco LIMIT 1").fetchone()
        assert stored is not None, "no row landed in mc_broker_reco after upsert_recos()"
        assert_stored_row_ml_usable(dict(stored), numeric_cols=[], ticker_cols=[], context="mc_broker_reco")
        assert dict(stored)["scid"], "scid (MC's own instrument key) missing from stored row"

        # Wire one real fetched scid to a synthetic symbol so backfill_technical_signals()'s
        # real JOIN + aggregation logic has something to match against.
        real_scid = recos[0]["scid"]
        conn.execute("INSERT INTO nse_stocks (symbol, mcsymbol) VALUES (?, ?)", ("TESTSYM", real_scid))
        conn.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, date('now'))", ("TESTSYM",))
        conn.commit()

        updated = mbr.backfill_technical_signals(days=10)
        assert updated >= 1, "backfill_technical_signals() updated 0 symbols despite a matching scid/mcsymbol row"

        row = conn.execute("SELECT * FROM technical_signals WHERE symbol = 'TESTSYM'").fetchone()
        row = dict(row)
        assert row["mc_broker_buy_7d"] is not None, "mc_broker_buy_7d was not written"
        assert row["mc_broker_sell_7d"] is not None, "mc_broker_sell_7d was not written"
        assert isinstance(row["mc_broker_buy_7d"], int), \
            f"mc_broker_buy_7d stored as {type(row['mc_broker_buy_7d']).__name__}, not int"
