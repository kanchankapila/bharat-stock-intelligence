"""nse_fo_activity_fetcher against NSE payloads captured live 2026-11-20 for the 19-Nov-2026 session (AF-20261120-01).

The fixtures are the exchange's own JSON: the most-active snapshot, the four OI-spurt contract groups and the
OI-spurt underlyings.
"""
import datetime as dt
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import nse_fo_activity_fetcher as fa  # noqa: E402
from nse_filings_common import NseFetchError  # noqa: E402

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "nse_fo_activity")
SESSION = dt.date(2026, 11, 19)


def _load(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return json.load(f)


def test_snapshot_gives_twenty_ranked_contracts_by_volume_and_by_value():
    rows = fa.parse_snapshot(_load("snapshot_contracts_19112026.json"))
    by = {s: [r for r in rows if r["screen"] == s] for s in ("most_active_volume", "most_active_value")}
    assert all(len(v) == 20 for v in by.values())
    assert all(r["trade_date"] == SESSION for r in rows)
    assert [r["rank"] for r in by["most_active_value"]] == list(range(1, 21))
    assert all(r["symbol"] and r["identifier"] and r["turnover"] and r["turnover"] > 0 for r in rows)


def test_oi_spurt_groups_mean_what_their_names_say():
    rows = fa.parse_spurts_contracts(_load("oi_spurts_contracts_19112026.json"))
    assert {r["screen"] for r in rows} == set(fa.SPURT_SCREENS.values())
    sign = {"long_buildup": (1, 1), "short_buildup": (1, -1), "short_covering": (-1, 1), "long_unwinding": (-1, -1)}
    for r in rows:
        oi_dir, px_dir = sign[r["screen"]]
        assert r["change_in_oi"] * oi_dir > 0, r
        assert r["pchange"] * px_dir >= 0, r
        assert r["trade_date"] == SESSION


def test_underlyings_carry_every_fno_name_with_consistent_oi_change():
    rows = fa.parse_spurts_underlyings(_load("oi_spurts_underlyings_19112026.json"))
    assert len(rows) >= 200 and len({r["symbol"] for r in rows}) == len(rows)
    for r in rows:
        assert abs((r["latest_oi"] - r["prev_oi"]) - r["change_in_oi"]) <= 1, r


@pytest.mark.parametrize("ts", ["19-Nov-2026 11:05:00", "", None])
def test_an_in_session_or_missing_stamp_is_refused(ts):
    with pytest.raises(NseFetchError):
        fa.session_stamp(ts, "test")


class _Fixed:
    """Returns the captured payloads by URL, so run() exercises the fetcher's own parsing and writing."""
    status_counts = {}

    def __init__(self, overrides=None):
        self.payloads = {fa.SNAPSHOT_URL: _load("snapshot_contracts_19112026.json"),
                         fa.SPURTS_CONTRACTS_URL: _load("oi_spurts_contracts_19112026.json"),
                         fa.SPURTS_UNDERLYINGS_URL: _load("oi_spurts_underlyings_19112026.json")}
        self.payloads.update(overrides or {})

    def get_json(self, url):
        return self.payloads[url]


def test_run_writes_one_session_and_a_rerun_drops_contracts_that_left_a_screen(pg_conn):
    fa.ensure_schema(pg_conn)
    stats = fa.run(pg_conn, _Fixed())
    assert stats["trade_date"] == "2026-11-19" and stats["contracts"] == 140 and stats["underlyings"] >= 200
    snap = _load("snapshot_contracts_19112026.json")
    dropped = snap["volume"]["data"].pop()["identifier"]
    fa.run(pg_conn, _Fixed({fa.SNAPSHOT_URL: snap}))
    left = pg_conn.execute(f"SELECT count(*) FROM {fa.CONTRACTS_TABLE} WHERE screen = 'most_active_volume'").fetchone()[0]
    assert left == 19
    assert pg_conn.execute(f"SELECT count(*) FROM {fa.CONTRACTS_TABLE} WHERE screen = 'most_active_volume' AND identifier = ?",
                           (dropped,)).fetchone()[0] == 0


def test_screens_from_two_different_sessions_are_refused(pg_conn):
    fa.ensure_schema(pg_conn)
    under = _load("oi_spurts_underlyings_19112026.json")
    under["timestamp"] = "18-Nov-2026 15:40:18"
    with pytest.raises(NseFetchError, match="different sessions"):
        fa.run(pg_conn, _Fixed({fa.SPURTS_UNDERLYINGS_URL: under}))
