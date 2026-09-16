"""factor_edge.py's entry-price convention.

measurement.md's panel spec is explicit: "Next-day OPEN entry. Signals computed off a close
cannot be bought at that close." _forward_returns() graded close-to-close for its whole life,
which credits a strategy with the overnight gap between date d's close and d+1's open -- a move
no one holding an evening-generated signal could capture.

Measured live 2026-08-22 on engine_composite_scores: close-entry overstates rank IC at every
horizon (h=1 +0.045 -> +0.021, more than halved). Close remains the DEFAULT so existing
factor_edge_history rows stay comparable; --entry open is the honest read.
"""
import os
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import factor_edge as fe


class _FakeCon:
    """Returns one hand-built OHLCV panel with a deliberate overnight gap."""

    def __init__(self, rows):
        self._rows = rows

    def execute(self, sql, params=()):
        assert "stock_ohlcv" in sql
        # The open-entry mode is useless if the query never selects `open` -- that was the
        # original bug, and it is invisible from the returned numbers alone.
        assert "open" in sql, "_forward_returns must select the open price"
        self._last = sql
        return self

    def fetchall(self):
        return self._rows


# One symbol, 4 sessions. close doubles 100->110 within day-1..day-2, but the OPEN gaps up
# hard, so close-to-close and open-to-open disagree by construction.
ROWS = [
    ("AAA", "2026-08-17", 100.0, 100.0),
    ("AAA", "2026-08-18", 120.0, 110.0),   # opened at 120 after a 100 close: +20% gap
    ("AAA", "2026-08-19", 121.0, 111.0),
    ("AAA", "2026-08-20", 122.0, 112.0),
]


def _fwd(entry):
    oh = fe._forward_returns(_FakeCon(list(ROWS)), "2026-08-01", [1], entry=entry)
    return oh.set_index("date")["fwd_1"]


class TestEntryConvention:
    def test_close_entry_is_close_to_close(self):
        s = _fwd("close")
        # 110/100 - 1
        assert s[pd.Timestamp("2026-08-17")] == pytest.approx(0.10)

    def test_open_entry_skips_the_untradeable_overnight_gap(self):
        s = _fwd("open")
        # Enter at the NEXT session's open (120), exit at the following open (121).
        assert s[pd.Timestamp("2026-08-17")] == pytest.approx(121 / 120 - 1)

    def test_the_two_conventions_actually_differ(self):
        # Guards against a change that wires --entry through but silently computes the same
        # thing either way -- which would pass both tests above if they were checked loosely.
        assert _fwd("close")[pd.Timestamp("2026-08-17")] != pytest.approx(
            _fwd("open")[pd.Timestamp("2026-08-17")]
        )

    def test_rejects_an_unknown_entry_mode(self):
        with pytest.raises(ValueError):
            fe._forward_returns(_FakeCon(list(ROWS)), "2026-08-01", [1], entry="midpoint")


class TestHistoryTableSeparation:
    def test_open_entry_persists_under_a_distinct_table_name(self):
        # A close-entry and an open-entry verdict for the same table are not comparable, so
        # they must never share a table_name in factor_edge_history -- same collision shape as
        # signal_outcomes' two label_definitions (88-91% vs 41-44% win rates, read as skill).
        src = open(fe.__file__, encoding="utf-8").read()
        assert '__open_entry' in src
        assert 'history_table' in src
