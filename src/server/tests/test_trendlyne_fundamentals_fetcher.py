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
    # Mirror _load_stocks' real signature, keyword included. main() calls it as
    # _load_stocks(args.symbol, skip_done_for_date=...) and passes no `con` (it opens/manages
    # its own connection internally).
    #
    # This lambda has now drifted from the real signature TWICE -- once when `con` was dropped,
    # again when `skip_done_for_date` was added for the WAF run-budget work. A stub with a
    # hand-copied signature is a second declaration of the same interface, and nothing keeps the
    # two honest; the failure surfaces as a TypeError on the first call, far from the change
    # that caused it. Same shape as _CaptureDB.query_all in
    # test_live_datasource_intraday_fetcher.py, which broke for 7 days the same way.
    monkeypatch.setattr(
        tff, "_load_stocks",
        lambda symbol_filter, skip_done_for_date=None: [("BEL", "175")],
    )
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
