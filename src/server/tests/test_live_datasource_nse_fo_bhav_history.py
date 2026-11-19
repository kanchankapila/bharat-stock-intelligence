"""Live-datasource test for nse_fo_bhav_history_fetcher.py (data-sources.md mandate).

Skipped unless RUN_LIVE_DATASOURCE_TESTS=1. One GET: the real old-format F&O bhavcopy for
2022-01-03, through the fetcher's own Fetcher/URL builder/parser/feature code/store_day, into a
throwaway Postgres schema, then read back and checked for ML-usable values.
"""
import datetime as dt
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import nse_fo_bhav_history_fetcher as m  # noqa: E402
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite  # noqa: E402
from pg_test_support import pg_memory_conn  # noqa: E402

DAY = dt.date(2022, 1, 3)


@pytest.mark.live_datasource
def test_live_old_format_day_writes_ml_usable_rows():
    recs = m.Fetcher().fetch_day(DAY)
    assert recs, f"{m.day_url(DAY)} returned no records (a 404 here means the archive moved -- ask, don't conclude dead)"
    feats = m.compute_features(recs, DAY)
    assert len(feats) > 100, f"only {len(feats)} underlyings; the 2022-01-03 file carries ~190 option underlyings"

    conn = pg_memory_conn()
    m.ensure_schema(conn)
    m.store_day(conn, feats, "nse_fo_bhav_old")
    row = conn.execute(
        "SELECT symbol, atm_iv, pcr_oi, straddle_pct, forward, total_oi FROM stock_option_features_history "
        "WHERE symbol = 'RELIANCE' AND trade_date = ?", (DAY.isoformat(),)).fetchone()
    assert row is not None
    assert_looks_like_ticker(row[0], context="symbol")
    for i, col in enumerate(("atm_iv", "pcr_oi", "straddle_pct", "forward", "total_oi"), start=1):
        assert_numeric_and_finite(row[i], context=col)
    assert 0.05 < row[1] < 1.5, f"atm_iv {row[1]} is not a fraction-scale IV"

    futs = m.futures_rows(recs, DAY)
    assert len(futs) > 100, f"only {len(futs)} futures rows; the 2022-01-03 file carries ~190 stock futures x 2 kept expiries"
    m.store_day(conn, futs, "nse_fo_bhav_old", m.FUT_TABLE, m.FUT_COLS)
    f = conn.execute(
        "SELECT symbol, close, settle, contracts_traded, open_interest, oi_change FROM stock_futures_eod_history "
        "WHERE symbol = 'RELIANCE' AND trade_date = ? AND expiry_rank = 1", (DAY.isoformat(),)).fetchone()
    assert f is not None
    assert_looks_like_ticker(f[0], context="symbol")
    for i, col in enumerate(("close", "settle", "contracts_traded", "open_interest", "oi_change"), start=1):
        assert_numeric_and_finite(f[i], context=col)
    assert f[4] % 250 == 0, "old-format OPEN_INT is in shares: a multiple of RELIANCE's 250 lot"


def _recent_udiff_session(fetcher, lookback=10):
    """The newest weekday up to the logical trading date whose UDiFF file is published (AF-20261119-19:
    the nightly ml-daily-ops run only ever reads this format)."""
    from as_of import logical_trading_date

    d = dt.date.fromisoformat(logical_trading_date())
    for _ in range(lookback):
        if d.weekday() < 5 and d > m.OLD_FORMAT_LAST:
            recs = fetcher.fetch_day(d)
            if recs:
                return d, recs
        d -= dt.timedelta(days=1)
    return None, None


@pytest.mark.live_datasource
def test_live_udiff_recent_session_writes_ml_usable_rows():
    day, recs = _recent_udiff_session(m.Fetcher(max_requests=12))
    assert day is not None, f"no UDiFF file in the last 10 days ({m.UDIFF_URL}) -- ask, don't conclude dead"
    feats = m.compute_features(recs, day)
    assert len(feats) > 100, f"only {len(feats)} underlyings on {day}"
    futs = m.futures_rows(recs, day)
    assert len(futs) > 100, f"only {len(futs)} futures rows on {day}"

    conn = pg_memory_conn()
    m.ensure_schema(conn)
    m.store_day(conn, feats, "nse_fo_udiff")
    m.store_day(conn, futs, "nse_fo_udiff", m.FUT_TABLE, m.FUT_COLS)
    row = conn.execute(
        "SELECT symbol, atm_iv, pcr_oi, forward FROM stock_option_features_history "
        "WHERE symbol = 'RELIANCE' AND trade_date = ?", (day.isoformat(),)).fetchone()
    assert row is not None
    assert_looks_like_ticker(row[0], context="symbol")
    for i, col in enumerate(("atm_iv", "pcr_oi", "forward"), start=1):
        assert_numeric_and_finite(row[i], context=col)
    assert 0.05 < row[1] < 1.5, f"atm_iv {row[1]} is not a fraction-scale IV"
    f = conn.execute(
        "SELECT symbol, close, settle, open_interest FROM stock_futures_eod_history "
        "WHERE symbol = 'RELIANCE' AND trade_date = ? AND expiry_rank = 1", (day.isoformat(),)).fetchone()
    assert f is not None
    assert_looks_like_ticker(f[0], context="symbol")
    for i, col in enumerate(("close", "settle", "open_interest"), start=1):
        assert_numeric_and_finite(f[i], context=col)
