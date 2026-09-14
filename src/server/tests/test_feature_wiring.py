"""
Tests for the step-2/3 merges: analyst consensus, earnings clock, delivery
dynamics, and the options backfill (2026-09-13).

Each merge reads its table of record as-of the feature date (PIT): consensus
snapshots go stale after 35 days, surprises after 400, and sparse days stay NaN
(NEVER_FILL) instead of fabricating neutral values.
"""

import inspect
import os
import re
import sys
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402
import src.server.feature_engineering as fe_mod  # noqa: E402
from src.server.feature_engineering import FeatureEngineer  # noqa: E402

COLS = ["analyst_buy_pct", "analyst_target_mean", "analyst_target_upside_pct",
        "analyst_n", "broker_recos_90d", "days_to_next_earnings",
        "days_since_last_earnings", "last_eps_surprise_pct", "last_beat_score",
        "earnings_in_5d", "delivery_z_20d", "delivery_pct_chg_5d",
        "delivery_qty_5d", "nifty_pcr"]

_DDL = {
    "feature_store": """
        CREATE TABLE IF NOT EXISTS feature_store (
            symbol TEXT, date TEXT, timeframe TEXT, computed_at TEXT,
    ret_1d REAL,
    ret_5d REAL,
    ret_15d REAL,
    ret_21d REAL,
    ret_63d REAL,
    ret_126d REAL,
    ret_252d REAL,
    sma20 REAL,
    sma50 REAL,
    sma200 REAL,
    ema8 REAL,
    ema21 REAL,
    dist_sma20_pct REAL,
    dist_sma200_pct REAL,
    above_sma200 REAL,
    rsi_14 REAL,
    rsi_28 REAL,
    macd REAL,
    macd_signal REAL,
    macd_hist REAL,
    adx REAL,
    di_plus REAL,
    di_minus REAL,
    stoch_k REAL,
    stoch_d REAL,
    cci REAL,
    williams_r REAL,
    atr_14 REAL,
    atr_pct REAL,
    bb_upper REAL,
    bb_lower REAL,
    bb_width REAL,
    bb_pct REAL,
    hist_vol_21d REAL,
    hist_vol_63d REAL,
    vol_regime REAL,
    volume_ratio_20d REAL,
    volume_ratio_5d REAL,
    obv REAL,
    obv_slope REAL,
    vwap REAL,
    vwap_dist_pct REAL,
    trend_1d REAL,
    trend_1w REAL,
    trend_1m REAL,
    mtf_alignment_score REAL,
    fii_3d_net REAL,
    fii_10d_net REAL,
    dii_3d_net REAL,
    trailing_pe REAL,
    roe REAL,
    debt_to_equity REAL,
    op_margins REAL,
    piotroski_f REAL,
    earnings_yield REAL,
    nifty_vix REAL,
    nifty_ret_5d REAL,
    nifty_ret_21d REAL,
    us_10y_yield REAL,
    dxy REAL,
    crude_ret_5d REAL,
    gold_ret_5d REAL,
    sp500_ret_5d REAL,
    news_sentiment_score REAL,
    news_impact_count REAL,
    target_ret_1d REAL,
    target_ret_5d REAL,
    target_ret_15d REAL,
    target_dir_1d REAL,
    target_dir_5d REAL,
    target_dir_15d REAL,
    ret_12m_ex1m REAL,
    pcr_oi REAL,
    pcr_vol REAL,
    iv_rank REAL,
    iv_skew REAL,
    delivery_pct REAL,
    insider_buy_pct_90d REAL,
    block_deal_net_qty REAL,
    block_deal_value_cr REAL,
    block_deal_net_qty_5d REAL,
    block_deal_value_cr_5d REAL,
    analyst_buy_pct REAL,
    analyst_target_mean REAL,
    analyst_target_upside_pct REAL,
    analyst_n REAL,
    broker_recos_90d REAL,
    days_to_next_earnings REAL,
    days_since_last_earnings REAL,
    last_eps_surprise_pct REAL,
    last_beat_score REAL,
    earnings_in_5d REAL,
    delivery_z_20d REAL,
    delivery_pct_chg_5d REAL,
    delivery_qty_5d REAL,
    nifty_pcr REAL,
    call_wall_dist_pct REAL,
    put_wall_dist_pct REAL,
    near_expiry_gamma REAL,
    max_pain REAL,
    sector_ret_5d REAL,
    sector_ret_21d REAL,
    nifty_pe REAL,
    advance_decline_ratio REAL,
    price_to_book REAL,
    rev_growth REAL,
    eps_growth REAL,
    PRIMARY KEY (symbol, date, timeframe)
        )""",
    "stock_ohlcv": """
        CREATE TABLE IF NOT EXISTS stock_ohlcv (
            symbol TEXT, date DATE, open REAL, high REAL, low REAL, close REAL,
            volume REAL, is_suspect INTEGER DEFAULT 0)""",
    "analyst_estimates_history": """
        CREATE TABLE IF NOT EXISTS analyst_estimates_history (
            symbol TEXT, as_of_date DATE, n_analysts BIGINT, final_rating TEXT,
            buy_count BIGINT, hold_count BIGINT, sell_count BIGINT,
            target_high REAL, target_mean REAL, target_low REAL,
            eps_est_next REAL, revenue_est_next REAL, captured_at TEXT)""",
    "trendlyne_analyst_targets": """
        CREATE TABLE IF NOT EXISTS trendlyne_analyst_targets (
            symbol TEXT, reco_date DATE, broker TEXT, target_price REAL,
            reco_price REAL, rating TEXT, fetched_at TEXT)""",
    "stock_earnings_dates": """
        CREATE TABLE IF NOT EXISTS stock_earnings_dates (
            scid TEXT, result_date DATE, stock_name TEXT, result_type TEXT,
            result_time TEXT, market_cap REAL, exchange TEXT, fetched_at TEXT)""",
    "nse_stocks": """
        CREATE TABLE IF NOT EXISTS nse_stocks (
            symbol TEXT, mcsymbol TEXT)""",
    "mc_scid_map": """
        CREATE TABLE IF NOT EXISTS mc_scid_map (
            scid TEXT PRIMARY KEY, symbol TEXT NOT NULL, stock_name TEXT,
            source TEXT, resolved_at TEXT DEFAULT CURRENT_TIMESTAMP)""",
    "stock_earnings_beats": """
        CREATE TABLE IF NOT EXISTS stock_earnings_beats (
            id BIGINT, symbol TEXT, quarter_date DATE, period_type TEXT,
            beat_type TEXT, beat_score BIGINT, eps_actual REAL, eps_avg REAL,
            eps_high REAL, eps_low REAL, surprise_pct REAL, fetched_at TEXT)""",
    "stock_delivery_data": """
        CREATE TABLE IF NOT EXISTS stock_delivery_data (
            symbol TEXT, date DATE, delivery_pct REAL, delivery_qty BIGINT,
            traded_qty BIGINT, trades BIGINT, updated_at TEXT)""",
    "so_option_chain": """
        CREATE TABLE IF NOT EXISTS so_option_chain (
            symbol TEXT, date DATE, expiry TEXT, strike REAL,
            ce_oi REAL, pe_oi REAL, ce_volume REAL, pe_volume REAL, fetched_at TEXT)""",
    "nt_index_pcr_ts": """
        CREATE TABLE IF NOT EXISTS nt_index_pcr_ts (
            index_name TEXT, ts TEXT, expiry TEXT, pcr REAL, volume_pcr REAL,
            change_oi_pcr REAL, index_close REAL, fetched_at TEXT)""",
}


def _make_db(symbol: str) -> object:
    con = pg_memory_conn()
    for ddl in _DDL.values():
        con.execute(ddl)
    dates = pd.date_range(end=pd.Timestamp.today().normalize(), periods=60, freq="D")
    con.executemany(
        "INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)",
        [(symbol, d.strftime("%Y-%m-%d"), 100.0, 105.0, 95.0, 100.0, 1e6) for d in dates],
    )
    con.commit()
    return con


def _ins(con, table, rows, cols):
    ph = ",".join("?" * len(cols))
    con.executemany(
        f"INSERT INTO {table} ({','.join(cols)}) VALUES ({ph})",
        [tuple(r.get(c) for c in cols) for r in rows])
    con.commit()


def _feat(with_upstream: bool = True) -> pd.DataFrame:
    feat = pd.DataFrame(index=DATES)
    feat["block_deal_net_qty"] = np.nan
    if with_upstream:
        feat.loc[DATES[2], "block_deal_net_qty"] = 5.0
    return feat


def _run_merge(con, feat, method):
    """Run one real merge with feature_engineering.read_df pointed at the sandbox."""
    fn = getattr(FeatureEngineer(), method)

    def _read(sql, params=()):
        res = con.execute(sql, params)
        rows = res.fetchall()
        return pd.DataFrame(rows, columns=list(res._result.keys()))

    with patch.object(fe_mod, "read_df", _read):
        return fn(feat, "TEST")


DATES = pd.date_range(end=pd.Timestamp.today().normalize(), periods=10, freq="D")
D = [d.strftime("%Y-%m-%d") for d in DATES]


def _seed_analyst(con):
    # buy/hold/sell are ALREADY percentages summing to ~100 (verified live
    # 2026-09-13: RELIANCE 96/0/4) -- not counts.
    _ins(con, "analyst_estimates_history", [
        {"symbol": "TEST", "as_of_date": DATES[0] - pd.Timedelta(days=90),
         "n_analysts": 5, "buy_count": 60.0, "hold_count": 30.0, "sell_count": 10.0,
         "target_mean": 90.0},
        {"symbol": "TEST", "as_of_date": DATES[0] - pd.Timedelta(days=10),
         "n_analysts": 12, "buy_count": 66.7, "hold_count": 25.0, "sell_count": 8.3,
         "target_mean": 120.0},
    ], ["symbol", "as_of_date", "n_analysts", "buy_count", "hold_count",
        "sell_count", "target_mean"])
    _ins(con, "trendlyne_analyst_targets", [
        {"symbol": "TEST", "reco_date": DATES[2], "broker": "A", "target_price": 125.0},
        {"symbol": "TEST", "reco_date": DATES[5], "broker": "B", "target_price": 130.0},
        {"symbol": "TEST", "reco_date": str((pd.Timestamp.today()
                                             - pd.Timedelta(days=120)).date()),
         "broker": "OLD", "target_price": 99.0},
    ], ["symbol", "reco_date", "broker", "target_price"])


def _seed_earnings(con):
    nxt = (pd.Timestamp.today() + pd.Timedelta(days=3)).strftime("%Y-%m-%d")
    prv = (pd.Timestamp.today() - pd.Timedelta(days=20)).strftime("%Y-%m-%d")
    # The feed is scid-keyed; the merge must resolve TEST -> MC01 through
    # nse_stocks (mcsymbol != symbol, so a no-op WHERE scid=symbol fails here).
    # MAP04X exists only in mc_scid_map (recently-listed name, no nse_stocks row)
    # -- exercises the fallback. UNMAPPED's yesterday date must never leak.
    _ins(con, "nse_stocks", [
        {"symbol": "TEST", "mcsymbol": "MC01"},
        {"symbol": "OTHER", "mcsymbol": "MC02"},
    ], ["symbol", "mcsymbol"])
    _ins(con, "mc_scid_map", [
        {"scid": "MAP04X", "symbol": "TEST", "source": "autosuggest-name"},
    ], ["scid", "symbol", "source"])
    _ins(con, "stock_earnings_dates", [
        {"scid": "MC01", "result_date": nxt},
        {"scid": "MC01", "result_date": prv},
        {"scid": "MAP04X", "result_date": (pd.Timestamp.today()
                                           - pd.Timedelta(days=2)).strftime("%Y-%m-%d")},
        {"scid": "UNMAPPED", "result_date": (pd.Timestamp.today()
                                             - pd.Timedelta(days=1)).strftime("%Y-%m-%d")},
    ], ["scid", "result_date"])
    _ins(con, "stock_earnings_beats", [
        {"symbol": "TEST", "quarter_date": prv, "beat_score": 3, "surprise_pct": 7.5},
    ], ["symbol", "quarter_date", "beat_score", "surprise_pct"])


def _seed_delivery(con):
    d12 = pd.date_range(end=pd.Timestamp.today().normalize(), periods=12, freq="D")
    _ins(con, "stock_delivery_data", [
        {"symbol": "TEST", "date": d.strftime("%Y-%m-%d"), "delivery_pct": 40.0 + i,
         "delivery_qty": 100000 + 10000 * i, "traded_qty": 500000, "trades": 100}
        for i, d in enumerate(d12)
    ], ["symbol", "date", "delivery_pct", "delivery_qty", "traded_qty", "trades"])


def _seed_options(con):
    _ins(con, "so_option_chain", [
        {"symbol": "TEST", "date": D[3], "strike": 100.0, "ce_oi": 100.0,
         "pe_oi": 150.0, "ce_volume": 200.0, "pe_volume": 300.0},
    ], ["symbol", "date", "strike", "ce_oi", "pe_oi", "ce_volume", "pe_volume"])
    _ins(con, "nt_index_pcr_ts", [
        {"index_name": "NIFTY50", "ts": D[4] + "T15:30:00", "pcr": 0.95},
        {"index_name": "GIFTNIFTY", "ts": D[4] + "T15:30:00", "pcr": 24000.0},
    ], ["index_name", "ts", "pcr"])


class TestAnalystConsensus:

    def test_asof_and_upside(self):
        con = _make_db("TEST")
        _seed_analyst(con)
        out = _run_merge(con, _feat(), "_merge_analyst_consensus")
        assert out["analyst_buy_pct"].notna().all()
        # buy_count arrives as a percentage (66.7 = 66.7% buys) -- a count-ratio
        # here produced 369%-style nonsense live; this pins the semantics. The
        # sandbox stores REAL (float32), hence the 1% tolerance.
        assert out.loc[DATES[-1], "analyst_buy_pct"] == pytest.approx(66.7, rel=0.01)
        assert out.loc[DATES[-1], "analyst_n"] == 12
        assert out.loc[DATES[-1], "analyst_target_mean"] == 120.0
        assert out.loc[DATES[-1], "analyst_target_upside_pct"] == pytest.approx(20.0)

    def test_broker_recos_90d_counts_window(self):
        con = _make_db("TEST")
        _seed_analyst(con)
        out = _run_merge(con, _feat(), "_merge_analyst_consensus")
        # Two recos (D[2], D[5]) inside the 90-day window; the 120-day-old one out.
        assert out.loc[DATES[3], "broker_recos_90d"] == 1
        assert out.loc[DATES[6], "broker_recos_90d"] == 2
        assert out.loc[DATES[0], "broker_recos_90d"] == 0


class TestEarningsClock:

    def test_clock_and_surprise(self):
        con = _make_db("TEST")
        _seed_earnings(con)
        out = _run_merge(con, _feat(), "_merge_earnings_clock")
        # All 10 days precede the next result (today+3).
        assert out.loc[DATES[-1], "days_to_next_earnings"] == 3
        # today-20 is 21 days before DATES[0].
        assert out.loc[DATES[0], "days_since_last_earnings"] == 11
        # MAP04X (today-2) resolves ONLY through the mc_scid_map fallback -> 2.
        # Without the map row this reads 20; a UNMAPPED leak would read 1.
        assert out.loc[DATES[-1], "days_since_last_earnings"] == 2
        assert out.loc[DATES[-1], "last_eps_surprise_pct"] == 7.5
        assert out.loc[DATES[-1], "last_beat_score"] == 3
        assert out["earnings_in_5d"].notna().sum() >= 1


class TestDelivery:

    def test_zscore_and_5d_features(self):
        con = _make_db("TEST")
        d12 = pd.date_range(end=pd.Timestamp.today().normalize(), periods=12, freq="D")
        _seed_delivery(con)
        out = _run_merge(con, _feat(with_upstream=False), "_merge_delivery")
        assert out.loc[d12[11], "delivery_pct_chg_5d"] == pytest.approx(5.0)
        assert out.loc[d12[11], "delivery_z_20d"] > 0
        # d12[11]: 5-session delivered-qty sum (d12[7]..d12[11]).
        assert out.loc[d12[11], "delivery_qty_5d"] == sum(
            100000 + 10000 * i for i in range(7, 12))


class TestOptionsBackfill:

    def test_pcr_hole_fill_and_sanity(self):
        con = _make_db("TEST")
        _seed_options(con)
        feat = _feat(with_upstream=False)
        feat["pcr_oi"] = np.nan
        feat["pcr_vol"] = np.nan
        out = _run_merge(con, feat, "_merge_options_backfill")
        # D[3]: 150 put OI / 100 call OI = 1.5; volume 300/200 = 1.5.
        assert out.loc[DATES[3], "pcr_oi"] == pytest.approx(1.5)
        assert out.loc[DATES[3], "pcr_vol"] == pytest.approx(1.5)
        # NIFTY50 PCR broadcast (bounded ffill); GIFTNIFTY's index-level 'pcr'
        # (24000) must never leak through.
        assert out.loc[DATES[-1], "nifty_pcr"] == pytest.approx(0.95)
        assert (out["nifty_pcr"].dropna() < 20).all()


class TestWorkerPathMergeParity:
    """run_full_pipeline -- the body of the nightly dl-feature-refresh job -- computes
    every symbol through the module-level _compute_symbol_unscaled worker, NOT through
    FeatureEngineer.process_symbol. On 2026-09-14 the worker was found carrying only 8
    of process_symbol's 13 merges: _merge_block_deals, _merge_analyst_consensus,
    _merge_earnings_clock, _merge_delivery and _merge_options_backfill were never added
    to it when their step-2/3 versions landed 2026-09-13, so the nightly full-universe
    upsert overwrote every column those five merges own with NULL, day after day
    (live census 2026-09-14: analyst_buy_pct 205/2,674,984 non-null,
    block_deal_value_cr 1/2,674,984, days_to_next_earnings 1,227/2,674,984).
    Both call sequences are extracted from the live source and pinned equal so the
    two write paths cannot drift apart again.
    """

    def test_worker_calls_the_same_merges_as_process_symbol(self):
        worker = inspect.getsource(fe_mod._compute_symbol_unscaled)
        single = inspect.getsource(fe_mod.FeatureEngineer.process_symbol)
        worker_merges = re.findall(r"(?:self|fe)\._merge_(\w+)\(", worker)
        single_merges = re.findall(r"(?:self|fe)\._merge_(\w+)\(", single)
        assert worker_merges, "worker merge sequence not found -- source shape changed"
        assert single_merges, "process_symbol merge sequence not found -- source shape changed"
        assert worker_merges == single_merges, (
            "_compute_symbol_unscaled and process_symbol run different merge sequences; "
            f"worker={worker_merges} process_symbol={single_merges}"
        )

    def test_worker_calls_every_merge_this_file_covers(self):
        # The five step-2/3 merges unit-tested above must each appear in the worker's
        # own sequence. Guards against a future symmetric drop (removing a merge from
        # BOTH paths) that the equality assertion cannot see.
        worker = inspect.getsource(fe_mod._compute_symbol_unscaled)
        for merge in ("_merge_block_deals", "_merge_analyst_consensus",
                      "_merge_earnings_clock", "_merge_delivery",
                      "_merge_options_backfill"):
            assert f"fe.{merge}(" in worker, f"{merge} missing from _compute_symbol_unscaled"

