"""mc_stock_futures_oi_fetcher expiry selection -- AF-20260930-44.

On 2026-09-29 (September expiry day) the fetcher kept `expiry >= date.today()`, so it stored the
EXPIRING contract for all 232 stocks: oi_change 0.0 on every row and a vendor build-up label
computed from nothing, which then became the newest session getFuturesBuildupMatrix served.
"""
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mc_stock_futures_oi_fetcher as mc

EXPIRIES = ["2026-09-29", "2026-10-27", "2026-11-24"]


def _patch(monkeypatch, expiries):
    seen = []

    def fake_get(url, timeout=20):
        if "getExpDts" in url:
            return {"data": {str(i): {"fno_exp": e} for i, e in enumerate(expiries)}}
        seen.append(url.split("expirydate=")[1])
        return {"data": {"open_int": "100", "expiry_date": seen[-1], "oi_change": "5"}}

    monkeypatch.setattr(mc, "_get", fake_get)
    return seen


def test_on_expiry_day_the_next_month_contract_is_used(monkeypatch):
    seen = _patch(monkeypatch, EXPIRIES)
    mc.fetch_symbol("XX", as_of="2026-09-29")
    assert seen == ["2026-10-27"]


def test_before_expiry_the_near_month_is_used(monkeypatch):
    seen = _patch(monkeypatch, EXPIRIES)
    mc.fetch_symbol("XX", as_of="2026-09-28")
    assert seen == ["2026-09-29"]


def test_selection_is_anchored_to_the_session_date_not_the_wall_clock(monkeypatch):
    # A catch-up run for 09-28 executed on a later wall-clock day must still pick 09-29.
    seen = _patch(monkeypatch, EXPIRIES)
    mc.fetch_symbol("XX", as_of="2026-09-28")
    assert seen[0] == "2026-09-29"


def test_a_run_killed_midway_keeps_what_it_fetched(monkeypatch):
    """AF-20261127-01: the only write followed the loop, so the runs killed at the 30 min budget on
    2026-11-25 and 11-26 stored nothing. Batches of 50 must already be in the table."""
    import datetime

    names = {f"S{i:03d}": f"C{i:03d}" for i in range(120)}
    calls = []

    def fetch(sc_id, as_of=None):
        calls.append(sc_id)
        if len(calls) > 110:
            raise SystemExit("killed by timeout")
        return [{"expiry": "2026-12-29"}]

    written = []
    monkeypatch.setattr(mc, "is_trading_session", lambda *a, **k: True)
    monkeypatch.setattr(mc, "ensure_schema", lambda: None)
    monkeypatch.setattr(mc, "load_mc_symbol_map", lambda s=None: names)
    monkeypatch.setattr(mc, "fetch_symbol", fetch)
    monkeypatch.setattr(mc, "write_rows", lambda rows, as_of: written.extend(r["symbol"] for r in rows) or len(rows))
    with pytest.raises(SystemExit):
        mc.run(now=datetime.datetime(2026, 11, 26, 20, 0), sleep=0)
    assert written == sorted(names)[:100]
