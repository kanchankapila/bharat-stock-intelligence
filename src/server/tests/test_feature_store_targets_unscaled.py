"""feature_store must persist RAW feature and target values, not per-symbol-scaled ones.

Regression guard for the 2026-09-10 finding: `_apply_scaler` selected *every* numeric
column -- including target_ret_1d/5d/15d -- and was fit per symbol inside the write loop,
so the stored label was (raw - that symbol's median) / that symbol's IQR rather than a
return. 230,572 live rows held target_ret_5d < -1, which a close ratio minus 1 cannot
produce, and rsi_14 (bounded 0-100 by construction) was stored across +/-6.2 million.

Normalization now belongs to the consumer (dl_engine fits its own per-symbol scaler over
FEATURES ONLY); the store holds raw values so cross-sectional readers -- ml_ensemble's wide
train/score queries, factor_backtest -- compare commensurable units across symbols.
"""

import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.dirname(__file__))

from test_feature_engineering_batch import (  # noqa: E402
    _FEATURE_STORE_DDL,
    _OHLCV_DDL,
    _stub_fe,
)
from pg_test_support import pg_memory_conn  # noqa: E402


def _seeded_db(symbol: str = "TESTRAW", n: int = 150):
    """OHLCV with real price VARIATION -- a constant series makes every return 0.0, which
    passes a scaling check vacuously (RobustScaler on a constant column is the identity)."""
    con = pg_memory_conn()
    con.execute(_FEATURE_STORE_DDL)
    con.execute(_OHLCV_DDL)
    rng = np.random.default_rng(20260910)
    dates = pd.date_range(end=pd.Timestamp.today().normalize(), periods=n, freq="D")
    close = 100.0 * np.cumprod(1.0 + rng.normal(0.0005, 0.02, n))
    rows = [
        (symbol, d.strftime("%Y-%m-%d"), float(c) * 0.995, float(c) * 1.02,
         float(c) * 0.98, float(c), float(1e6 + rng.integers(0, 500000)))
        for d, c in zip(dates, close)
    ]
    con.executemany(
        "INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) "
        "VALUES (?,?,?,?,?,?,?)", rows)
    con.commit()
    return con, pd.Series(close, index=dates)


def _run(symbol, con):
    fe = _stub_fe()
    # Stub only the exogenous merges (they need tables absent from this sandbox).
    # _compute_ohlcv_features runs for real -- it is what derives the targets.
    fe._merge_fii = lambda feat: feat
    fe._merge_fundamentals = lambda feat, sym: feat
    fe._merge_macro = lambda feat: feat
    fe._merge_sentiment = lambda feat, sym: feat
    fe._merge_flow_features = lambda feat, sym: feat
    fe._merge_market_context = lambda feat: feat
    return fe.process_symbol(symbol, con=con)


def test_target_ret_5d_is_a_raw_return_not_a_scaled_value():
    symbol = "TESTRAW"
    con, close = _seeded_db(symbol)
    assert _run(symbol, con) > 0, "fixture wrote no rows"

    got = pd.DataFrame(
        con.execute("SELECT date, target_ret_5d FROM feature_store WHERE symbol=? "
                    "ORDER BY date", (symbol,)).fetchall(),
        columns=["date", "target_ret_5d"])
    got["date"] = pd.to_datetime(got["date"])
    # feature_engineering.py's own convention: T+1 entry, held 5 sessions.
    expected = close.pct_change(5).shift(-6).rename("expected")
    m = got.set_index("date").join(expected, how="inner").dropna()
    assert len(m) > 50, f"too few comparable rows ({len(m)})"

    m["target_ret_5d"] = m["target_ret_5d"].astype(float)
    worst = (m["target_ret_5d"] - m["expected"]).abs().max()
    assert worst < 1e-9, (
        f"stored target_ret_5d is not the raw return (max abs diff {worst:.6g}). "
        "A per-symbol scaler is still being applied to the target columns.")


def test_stored_targets_respect_the_minus_one_floor():
    """A close ratio minus 1 cannot go below -1. Live data held 230,572 rows that did."""
    symbol = "TESTRAW"
    con, _ = _seeded_db(symbol)
    _run(symbol, con)
    rows = con.execute(
        "SELECT count(*) FROM feature_store WHERE symbol=? AND target_ret_5d < -1",
        (symbol,)).fetchone()
    assert int(rows[0]) == 0, "target_ret_5d below the -1 floor: values are not returns"


def test_bounded_features_stay_within_their_construction_bounds():
    """rsi_14 is 0-100 by construction; live data stored it across +/-6.2 million."""
    symbol = "TESTRAW"
    con, _ = _seeded_db(symbol)
    _run(symbol, con)
    vals = [float(r[0]) for r in con.execute(
        "SELECT rsi_14 FROM feature_store WHERE symbol=? AND rsi_14 IS NOT NULL",
        (symbol,)).fetchall()]
    assert vals, "no rsi_14 rows written"
    assert min(vals) >= -0.001 and max(vals) <= 100.001, (
        f"rsi_14 out of its 0-100 construction bounds: [{min(vals):.3f}, {max(vals):.3f}]")


def test_non_computable_values_write_as_null_not_zero():
    """rsi_14's construction warmup is genuinely not computable -- it must be NULL.

    The old write path ran fillna(0) inside _apply_scaler, so "no data" became a literal
    0 that every NULL/coverage check reads as populated (live: roe 77.8% zeros, piotroski_f
    83.8%). NaN is not an acceptable substitute either -- on Postgres NaN sorts highest and
    `x != x` matches nothing. Detection here uses the Postgres-correct form.
    """
    symbol = "TESTRAW"
    con, _ = _seeded_db(symbol)
    _run(symbol, con)
    warmup = con.execute(
        "SELECT count(*) FROM feature_store WHERE symbol=? AND rsi_14 IS NULL",
        (symbol,)).fetchone()
    assert int(warmup[0]) > 0, "expected the rsi_14 warmup rows to persist as NULL"

    zeros = con.execute(
        "SELECT count(*) FROM feature_store WHERE symbol=? AND rsi_14 = 0", (symbol,)
    ).fetchone()
    assert int(zeros[0]) == 0, "rsi_14 warmup written as a 0.0 sentinel instead of NULL"

    nans = con.execute(
        "SELECT count(*) FROM feature_store WHERE symbol=? "
        "AND rsi_14 = 'NaN'::float8", (symbol,)).fetchone()
    assert int(nans[0]) == 0, "NaN reached the DB; coerce to NULL at the write boundary"
