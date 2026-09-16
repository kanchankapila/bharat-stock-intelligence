"""nifty_pe_fetcher: MoneyControl's duration enum and its corrupt graph points (AF-20260913-08).

MoneyControl's /indices/fundamentals/graph accepts duration in [1M, 3M, 6M, 1Y, 5Y, Max] only
(its own 422 says so); the fetcher sent '3Y' for 366-1095 days. Its graph also returns impossible
points that were stored verbatim: NIFTY50 2025-09-08 pe=1.1 among ~21.7s, and 2025-12-29/30 with
pe == pb (26.0/26.0, 25.0/25.0) against pb ~3.55.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
f = pytest.importorskip("nifty_pe_fetcher")


@pytest.mark.parametrize("days,expected", [
    (30, "1M"), (90, "3M"), (180, "6M"), (365, "1Y"), (400, "5Y"), (1095, "5Y"), (1825, "5Y"), (4000, "Max"),
])
def test_duration_maps_onto_mc_enum(days, expected):
    assert f._mc_duration(days) == expected


def _series(pes, pbs=None, start=1):
    out = {}
    for i, pe in enumerate(pes):
        out[f"2025-09-{start + i:02d}"] = {"pe": pe, "pb": (pbs[i] if pbs else 3.3)}
    return out


def test_isolated_spike_is_dropped_and_neighbours_kept():
    c = _series([21.7, 21.7, 21.8, 1.1, 21.9, 21.9, 22.0])
    kept = f._drop_implausible(c)
    assert "pe" not in kept["2025-09-04"]
    assert kept["2025-09-03"]["pe"] == 21.8 and kept["2025-09-05"]["pe"] == 21.9


def test_pe_equal_to_pb_is_dropped_as_both():
    c = _series([22.7, 22.7, 26.0, 25.0, 22.8, 22.8], pbs=[3.55, 3.55, 26.0, 25.0, 3.55, 3.56])
    kept = f._drop_implausible(c)
    for d in ("2025-09-03", "2025-09-04"):
        assert "pe" not in kept[d] and "pb" not in kept[d]
    assert kept["2025-09-01"] == {"pe": 22.7, "pb": 3.55}


def test_a_real_crash_is_not_flagged():
    # March 2020-style: PE falls ~30% over 15 sessions, max ~4%/day
    pes = [28.0 * (0.976 ** i) for i in range(16)]
    c = {f"2020-03-{i + 1:02d}": {"pe": round(p, 2), "pb": 3.0} for i, p in enumerate(pes)}
    kept = f._drop_implausible(c)
    assert all("pe" in v for v in kept.values())


def test_weekend_points_are_dropped_and_negative_values_kept():
    c = {"2026-09-04": {"pe": 20.2, "pb": 2.89}, "2026-09-05": {"pe": 20.2, "pb": 2.0},
         "2026-09-06": {"pe": 20.2, "pb": 2.0}, "2026-09-07": {"pe": 20.1, "pb": 2.88}}
    kept = f._drop_implausible(c)
    assert set(kept) == {"2026-09-04", "2026-09-07"}
    tel = {f"2026-09-{d:02d}": {"pe": 18.8, "pb": -16.3} for d in (1, 2, 3, 4, 7, 8)}
    assert all(v["pb"] == -16.3 for v in f._drop_implausible(tel).values())


def test_other_fields_survive_when_pe_is_dropped():
    c = _series([21.7, 21.7, 1.1, 21.8, 21.8])
    c["2025-09-03"]["div_yield"] = 1.27
    kept = f._drop_implausible(c)
    assert kept["2025-09-03"].get("div_yield") == 1.27
