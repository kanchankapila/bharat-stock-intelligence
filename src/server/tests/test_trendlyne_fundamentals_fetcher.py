import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import trendlyne_fundamentals_fetcher as tff


def test_pe_and_pb_params_are_not_fetched_during_a_full_run(monkeypatch):
    """PE_TTM_SHARE_NOW / PBV_A_SHARE_NOW are now fed by mc_pricefeed_fetcher.py daily —
    the weekly Trendlyne fetcher's main loop must no longer request them. Drives the
    real main() end-to-end with everything except _fetch mocked, so this actually
    exercises the per-stock loop instead of asserting on isolated helpers."""
    requested_params = []

    def fake_fetch(tlid, param, session):
        requested_params.append(param)
        if param == "EPS_TTM":
            return {"eodData": [[1774895400000, 8.29]], "stockHeaders": [], "stockData": []}
        if param == "DIVIDEND_YIELD_TTM_Q":
            return {"eodData": [[1774895400000, 0.5]]}
        return {"eodData": []}

    monkeypatch.setattr(tff, "_fetch", fake_fetch)
    # _load_stocks(symbol_filter) takes one arg -- main() calls it as _load_stocks(args.symbol)
    # with no `con` (it opens/manages its own connection internally). The old 2-arg mock
    # signature here predates that and TypeErrors on the very first call in main().
    monkeypatch.setattr(tff, "_load_stocks", lambda symbol_filter: [("BEL", "175")])
    monkeypatch.setattr(tff, "connect", lambda: MagicMock())
    monkeypatch.setattr(tff, "ensure_schema", lambda con: None)
    monkeypatch.setattr(tff, "_upsert_series", lambda *a, **k: None)
    monkeypatch.setattr(tff, "_upsert_dvm", lambda *a, **k: None)
    monkeypatch.setattr(tff, "_backfill_technical_signals", lambda *a, **k: None)
    monkeypatch.setattr(tff, "_pe_features_from_db", lambda *a, **k: {})
    monkeypatch.setattr(tff, "_pb_features_from_db", lambda *a, **k: {})
    monkeypatch.setattr(tff.time, "sleep", lambda *_: None)
    monkeypatch.setattr(sys, "argv", ["trendlyne_fundamentals_fetcher.py"])

    tff.main()

    assert "PE_TTM_SHARE_NOW" not in requested_params
    assert "PBV_A_SHARE_NOW" not in requested_params
    assert "EPS_TTM" in requested_params
    assert "DIVIDEND_YIELD_TTM_Q" in requested_params
