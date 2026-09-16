"""factor_edge.py must be able to read a tz-AWARE date column.

Until 2026-09-10 `_load` did a bare `pd.to_datetime(df["date"])`. For a column typed
`timestamp with time zone` -- which is what `confluence_signals.computed_at` and
`technical_signals.computed_at` actually are -- that yields a tz-aware datetime64[..., UTC],
and pandas refuses to merge it against the tz-NAIVE DATE column coming from stock_ohlcv:

    ValueError: You are trying to merge on datetime64[us, UTC] and datetime64[us] columns

So every timestamptz-keyed table was simply ungradeable. It failed loudly rather than silently,
but `confluence_signals` (73 dates, 5.88M rows) could not be measured at all until this was
fixed. `unified_recommendations` escaped only because its `computed_at` is stored as TEXT.

The conversion goes through **Asia/Kolkata**, not a bare tz-strip. This platform's jobs run into
the evening and past midnight IST; a row written at 00:30 IST is 19:00 UTC on the PREVIOUS
calendar day, so stripping the zone would silently shift those rows onto the wrong trading date.
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import factor_edge as fe


class _FakeCon:
    """Returns rows whose date column is whatever the test hands it."""

    def __init__(self, rows):
        self._rows = rows

    def execute(self, sql, params=()):
        self._last_sql = sql
        return self

    def fetchall(self):
        return self._rows


def _load(rows):
    return fe._load(_FakeCon(rows), "t", "symbol", "computed_at", ["score"])


def test_tz_aware_dates_come_back_naive_and_mergeable():
    """The regression: a tz-aware column must not stay tz-aware."""
    rows = [
        ("INFY", pd.Timestamp("2026-09-08 10:00:00", tz="UTC"), 1.0),
        ("TCS", pd.Timestamp("2026-09-09 10:00:00", tz="UTC"), 2.0),
    ]
    df = _load(rows)
    assert df["date"].dt.tz is None, "date column is still tz-aware; the merge will raise"

    # Prove it actually merges against a naive DATE panel, which is the real failure mode.
    ohlcv = pd.DataFrame({
        "symbol": ["INFY", "TCS"],
        "date": pd.to_datetime(["2026-09-08", "2026-09-09"]),
        "px": [10.0, 20.0],
    })
    merged = df.merge(ohlcv, on=["symbol", "date"], how="inner")
    assert len(merged) == 2, f"tz-aware date failed to merge against naive dates: {merged}"


def test_conversion_is_to_ist_not_a_bare_tz_strip():
    """A post-midnight-IST timestamp must land on the IST trading date, not the UTC one.

    19:00 UTC on 2026-09-08 is 00:30 IST on 2026-09-09. Stripping the zone would date this row
    2026-09-08; converting to IST correctly dates it 2026-09-09.
    """
    rows = [("INFY", pd.Timestamp("2026-09-08 19:00:00", tz="UTC"), 1.0)]
    df = _load(rows)
    assert df["date"].iloc[0] == pd.Timestamp("2026-09-09"), (
        f"expected the IST calendar day 2026-09-09, got {df['date'].iloc[0]} -- "
        "the zone was stripped instead of converted"
    )


def test_naive_dates_are_untouched():
    """Negative control: tables that already worked must be bit-identical.

    unified_recommendations stores computed_at as TEXT, so it was never affected; the fix must
    be a strict no-op there.
    """
    # Consistent format on purpose: pandas cannot infer a MIXED format in one call, and the
    # real TEXT column (unified_recommendations.computed_at) is uniformly date-only anyway --
    # verified live 2026-09-10, which is also why the added .dt.normalize() is a no-op there.
    rows = [
        ("INFY", "2026-09-08", 1.0),
        ("TCS", "2026-09-09", 2.0),
    ]
    df = _load(rows)
    assert df["date"].dt.tz is None
    assert list(df["date"]) == [pd.Timestamp("2026-09-08"), pd.Timestamp("2026-09-09")], (
        "a naive date column was altered by the tz fix"
    )
