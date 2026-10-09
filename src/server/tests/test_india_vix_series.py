"""Sub-project B.3b: India VIX is stored under two names in macro_asset_prices -- INDIAVIX
(global_macro_fetcher, nt_vix_fetcher, mc_index_ohlc; history from 2020) and INDIA_VIX
(market_regime_fetcher; from 2026-07). One read helper returns one series per date regardless
of name, preferring INDIAVIX; stored rows are not renamed."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from pg_test_support import pg_memory_conn  # noqa: E402
import macro_series  # noqa: E402


def _conn():
    conn = pg_memory_conn()
    conn.execute("CREATE TABLE macro_asset_prices (symbol TEXT, date DATE, close REAL)")
    rows = [
        ("INDIAVIX", "2026-10-01", 14.46), ("INDIA_VIX", "2026-10-01", 14.43),  # both: prefer INDIAVIX
        ("INDIAVIX", "2026-10-05", 14.78),                                       # only INDIAVIX
        ("INDIA_VIX", "2026-10-06", 13.60),                                      # only INDIA_VIX
        ("INDIAVIX", "2026-10-07", None), ("INDIA_VIX", "2026-10-07", 13.90),    # NULL falls through
        ("GIFT_NIFTY_CHG_PCT", "2026-10-07", 0.5),
    ]
    conn.executemany("INSERT INTO macro_asset_prices VALUES (?,?,?)", rows)
    conn.commit()
    return conn


def test_one_series_regardless_of_name():
    s = macro_series.read_india_vix(_conn())
    assert {str(k): round(float(v), 2) for k, v in s.items()} == {
        "2026-10-01": 14.46, "2026-10-05": 14.78, "2026-10-06": 13.60, "2026-10-07": 13.90}
    assert list(s.index) == sorted(s.index)


def test_date_bounds():
    s = macro_series.read_india_vix(_conn(), start="2026-10-05", end="2026-10-06")
    assert [str(k) for k in s.index] == ["2026-10-05", "2026-10-06"]
