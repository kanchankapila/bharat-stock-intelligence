"""Live-datasource test for eps_surprise_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). Documented incident: the old per-stock Pass 2 endpoint 422'd on
every call and burned the job's whole timeout budget (2026-07-31 fix); Pass 2 is now a pure
read of eps_surprise_history the bulk pass itself writes, so this test exercises the real
bulk endpoint + the real read-back logic, not a hand-rolled reimplementation.

executemany()/read_df() are bare module-level functions imported from db_compat (no `con`
parameter) -- same monkeypatch-the-module pattern as the nt_* fetchers.
"""
import os


import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import eps_surprise_fetcher as esf
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite


def _resolve_real_mc_map(scids):
    if not scids:
        return {}
    try:
        import psycopg2
        conn = psycopg2.connect(host="127.0.0.1", port=5433, user="bharat",
                                 password="bharat", dbname="bharat_intel", connect_timeout=3)
        cur = conn.cursor()
        cur.execute("SELECT mcsymbol, symbol FROM nse_stocks WHERE mcsymbol = ANY(%s)",
                    (list(scids),))
        result = dict(cur.fetchall())
        conn.close()
        return result
    except Exception:
        return {}


class _CaptureDB:
    def __init__(self):
        self.executemany_calls = []

    def executemany(self, sql, rows):
        self.executemany_calls.extend((sql, row) for row in rows)


@pytest.mark.live_datasource
class TestEpsSurpriseFetcherLiveDataSource:
    def test_bulk_endpoint_produces_ml_usable_features(self):
        """Hits the real MC bulk earnings endpoint (fetch_bulk's ONLY network call -- Pass 2
        deliberately makes zero network calls, per this fetcher's own docstring), resolved
        against real production mcsymbol->symbol mappings so the DB-shape half is exercised
        with real data rather than a synthetic map."""
        import requests
        # A minimal scid probe first to discover which scids actually appear today, mirroring
        # mc_earnings_fetcher's live-resolution pattern rather than guessing a static mcsymbol.
        r = esf.retry_get(esf.cffi_req, esf.BULK_URL, headers=esf.MC_HEADERS,
                          impersonate="chrome110", timeout=30)
        raw = r.json()["data"]["list"]
        assert raw, "bulk earnings endpoint returned zero rows -- may be down/blocked"

        scids = [row[0] for row in raw[:200] if row and row[0]]
        mc_to_symbol = _resolve_real_mc_map(scids)

        features, history_rows = esf.fetch_bulk(mc_to_symbol)

        if mc_to_symbol:
            assert history_rows, "fetch_bulk() resolved real mcsymbols but produced zero history rows"
            for scid, symbol, quarter, np_a, np_e, np_s, rev_a, rev_e, rev_s, eps_a, eps_e, eps_s in history_rows[:10]:
                assert_looks_like_ticker(symbol, context="eps_surprise_history.symbol")
                assert quarter, "eps_surprise_history.quarter is empty"

            assert features, "fetch_bulk() produced history rows but zero computed features"
            for symbol, feats in list(features.items())[:5]:
                assert_looks_like_ticker(symbol, context="features.symbol")
                assert "eps_beat_streak" in feats
                if feats.get("eps_surprise_q1") is not None:
                    assert_numeric_and_finite(feats["eps_surprise_q1"], context="eps_surprise_q1")

    def test_write_paths_called_with_ml_usable_rows(self):
        """Writes real fetched data through the fetcher's own _write_history()/
        _write_technical_signals() with executemany()/read_df() monkeypatched to capture
        instead of hitting a real DB file."""
        r = esf.retry_get(esf.cffi_req, esf.BULK_URL, headers=esf.MC_HEADERS,
                          impersonate="chrome110", timeout=30)
        raw = r.json()["data"]["list"]
        scids = [row[0] for row in raw[:200] if row and row[0]]
        mc_to_symbol = _resolve_real_mc_map(scids)
        if not mc_to_symbol:
            pytest.skip("no live production DB reachable to resolve real mcsymbol->symbol mappings")

        features, history_rows = esf.fetch_bulk(mc_to_symbol)
        assert history_rows, "no real history rows to exercise the write path with"

        cap = _CaptureDB()
        orig_executemany = esf.executemany
        esf.executemany = cap.executemany
        try:
            esf._write_history(history_rows)
        finally:
            esf.executemany = orig_executemany

        assert cap.executemany_calls, "_write_history() made no executemany() calls despite real history rows"
        sql, row = cap.executemany_calls[0]
        # _UPSERT_HISTORY param order: (scid, symbol, quarter, np_actual, np_estimate, np_surprise, ...)
        assert row[0], "eps_surprise_history.scid is empty in the captured write"
        assert_looks_like_ticker(row[1], context="eps_surprise_history.symbol (captured write)")

        # Feed the real just-fetched history back through enrich_from_history()'s read_df()
        # dependency with a real DataFrame built from the same real rows -- exercises the
        # actual quarter-sort/streak logic against real (not synthetic) quarter-date strings.
        hist_df = pd.DataFrame(
            [{"symbol": r_[1], "quarter": r_[2], "np_surprise": r_[5], "rev_surprise": r_[8]}
             for r_ in history_rows],
        )
        orig_read_df = esf.read_df
        esf.read_df = lambda *a, **k: hist_df
        try:
            enriched, extra = esf.enrich_from_history(features, None, None)
        finally:
            esf.read_df = orig_read_df
        assert extra == [], "enrich_from_history() should never write new history rows (pure read)"
        assert enriched, "enrich_from_history() returned nothing given a non-empty real history frame"
