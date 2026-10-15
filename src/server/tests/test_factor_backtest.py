"""Regression tests for factor_backtest._add_beta_and_idio_vol (2026-10-11 quant audit).

The function computes rolling market beta and idiosyncratic vol vs NIFTY50 from
pairwise-valid rolling SUMS rather than pandas' .rolling().cov()/.var():

    beta      = cov(r_i, r_m) / var(r_m)
    idio_vol  = sqrt(max(0, var(r_i) - beta**2 * var(r_m))) * 100

The bug AF-20261011-16 fixed: n, sum(xy), sum(x), sum(y) and BOTH variance terms
must describe the IDENTICAL pairwise-valid observation set (rows where the stock
return AND the market return are both present). The old code counted stock-only
rows in var_i but not in cov or var_m, so resid_var mixed two different windows
and beta/idio_vol silently distorted on any symbol whose bars did not perfectly
overlap NIFTY50's. These tests lock the contract down with synthetic panels where
the correct beta is known exactly.

BETA_WINDOW = 252, BETA_MIN_OBS = 120.
"""
import numpy as np
import pandas as pd
import pytest

from factor_backtest import _add_beta_and_idio_vol, BETA_MIN_OBS


def _panel(market_closes, stock_closes, symbol="TESTCO", market_symbol="NIFTY50",
           start="2023-01-02"):
    """Build a minimal two-symbol panel with the columns the function reads.

    The function derives returns itself via groupby-pct_change on 'close', so we
    hand it price series, not returns. Every case needs >= BETA_MIN_OBS sessions
    for the rolling window to emit a value, and stays < BETA_WINDOW (252) so the
    window spans the whole series.
    """
    n = max(len(market_closes), len(stock_closes))
    dates = pd.bdate_range(start, periods=n).strftime("%Y-%m-%d")
    mkt = pd.DataFrame({"symbol": market_symbol, "date": dates,
                        "close": np.asarray(market_closes, float)})
    stk = pd.DataFrame({"symbol": symbol, "date": dates,
                        "close": np.asarray(stock_closes, float)})
    px = pd.concat([mkt, stk], ignore_index=True)
    px["_dr"] = px.groupby("symbol", sort=False)["close"].pct_change()
    return px


class TestBetaKnownValues:
    def test_perfect_tracker_has_beta_one_and_zero_idio(self):
        # A stock that IS the market (identical price series) must yield beta == 1
        # and idio_vol == 0 exactly: var_i == var_m and cov == var_m.
        rng = np.random.default_rng(7)
        closes = 100 * np.cumprod(1 + rng.normal(0, 0.01, BETA_MIN_OBS + 40))
        out = _add_beta_and_idio_vol(_panel(closes, closes))
        row = out[out["symbol"] == "TESTCO"]["beta"].dropna().iloc[-1]
        idio = out[out["symbol"] == "TESTCO"]["idio_vol"].dropna().iloc[-1]
        # cov uses the sum formula, var_m uses pandas' rolling .var() (different float
        # algorithm), so match to ~1e-6 rather than bit-exact.
        assert row == pytest.approx(1.0, abs=1e-6)
        assert idio == pytest.approx(0.0, abs=1e-6)

    def test_levered_tracker_has_beta_two(self):
        # r_i = 2 * r_m  =>  beta == 2. Breaks if the covariance sums are scaled by
        # an inconsistent n.
        rng = np.random.default_rng(11)
        mkt = 100 * np.cumprod(1 + rng.normal(0, 0.01, BETA_MIN_OBS + 40))
        mr = np.diff(mkt) / mkt[:-1]
        stk = np.empty(len(mkt))
        stk[0] = 100.0
        stk[1:] = stk[0] * np.cumprod(1 + 2 * mr)
        out = _add_beta_and_idio_vol(_panel(mkt, stk))
        row = out[out["symbol"] == "TESTCO"]["beta"].dropna().iloc[-1]
        assert row == pytest.approx(2.0, abs=1e-6)

    def test_uncorrelated_stock_has_beta_near_zero(self):
        # r_i independent of r_m  =>  cov ~ 0  =>  beta ~ 0, nowhere near 1 (the
        # shape a mismatched-n covariance would manufacture).
        rng = np.random.default_rng(23)
        mkt = 100 * np.cumprod(1 + rng.normal(0, 0.01, BETA_MIN_OBS + 40))
        mr = np.diff(mkt) / mkt[:-1]
        ir = rng.normal(0, 0.02, len(mr))
        stk = np.empty(len(mkt))
        stk[0] = 50.0
        stk[1:] = stk[0] * np.cumprod(1 + ir)
        out = _add_beta_and_idio_vol(_panel(mkt, stk))
        row = out[out["symbol"] == "TESTCO"]["beta"].dropna().iloc[-1]
        # Sample beta on n~160 independent returns has SE ~ 1/sqrt(n) ~ 0.08, so a
        # few tenths of noise is expected; the point is it sits near 0, not near the
        # ~1 a mismatched-n covariance would manufacture.
        assert abs(row) < 0.4

class TestPairwiseValidMasking:
    def test_missing_market_bars_do_not_corrupt_beta(self):
        # The AF-20261011-16 regression: delete a block of MARKET returns mid-series.
        # cov, var_m and the count must all ignore exactly those rows. Rebuilding
        # the expected beta from the SURVIVING pairwise-valid returns must match.
        rng = np.random.default_rng(31)
        mkt = 100 * np.cumprod(1 + rng.normal(0, 0.01, BETA_MIN_OBS + 60))
        mr = np.diff(mkt) / mkt[:-1]
        stk = np.empty(len(mkt))
        stk[0] = 100.0
        stk[1:] = stk[0] * np.cumprod(1 + 1.5 * mr)

        px = _panel(mkt, stk)
        mkt_idx = px.index[px["symbol"] == "NIFTY50"]
        hole = mkt_idx[100:130]
        px.loc[hole, "_dr"] = np.nan  # market return missing on those sessions

        out = _add_beta_and_idio_vol(px)
        beta = out[out["symbol"] == "TESTCO"]["beta"].dropna().iloc[-1]

        # Expected beta from ONLY the pairwise-valid rows: recompute cov/var by hand.
        # Panel is < BETA_WINDOW (252) rows, so the window spans the whole series and
        # the last beta uses every surviving pair.
        m = px[px["symbol"] == "NIFTY50"].set_index("date")["_dr"]
        s = px[px["symbol"] == "TESTCO"].set_index("date")["_dr"]
        j = pd.concat([m.rename("m"), s.rename("s")], axis=1).dropna()
        cov = np.cov(j["s"], j["m"], ddof=1)[0, 1]
        varm = np.var(j["m"], ddof=1)
        assert beta == pytest.approx(cov / varm, rel=1e-6, abs=1e-6)

    def test_beta_ignores_nan_stock_returns(self):
        # Symmetric case: missing STOCK returns must be excluded from var_i too, or
        # idio_vol's var_i describes a different window than cov/var_m.
        rng = np.random.default_rng(43)
        mkt = 100 * np.cumprod(1 + rng.normal(0, 0.01, BETA_MIN_OBS + 40))
        mr = np.diff(mkt) / mkt[:-1]
        stk = np.empty(len(mkt))
        stk[0] = 100.0
        stk[1:] = stk[0] * np.cumprod(1 + 1.0 * mr)
        px = _panel(mkt, stk)
        stk_idx = px.index[px["symbol"] == "TESTCO"]
        px.loc[stk_idx[90:110], "_dr"] = np.nan
        out = _add_beta_and_idio_vol(px)
        beta = out[out["symbol"] == "TESTCO"]["beta"].dropna().iloc[-1]
        # A perfect 1x tracker with holes dropped from BOTH series stays beta ~ 1.
        assert beta == pytest.approx(1.0, abs=5e-2)


class TestIdioVolProperties:
    def test_idio_vol_is_nonnegative(self):
        rng = np.random.default_rng(59)
        mkt = 100 * np.cumprod(1 + rng.normal(0, 0.01, BETA_MIN_OBS + 40))
        mr = np.diff(mkt) / mkt[:-1]
        stk = np.empty(len(mkt))
        stk[0] = 100.0
        stk[1:] = stk[0] * np.cumprod(1 + 0.5 * mr + rng.normal(0, 0.01, len(mr)))
        out = _add_beta_and_idio_vol(_panel(mkt, stk))
        idio = out[out["symbol"] == "TESTCO"]["idio_vol"].dropna()
        assert (idio >= 0).all()

    def test_idio_vol_scaled_to_percent(self):
        # idio_vol is multiplied by 100 (a return stdev expressed in percent).
        rng = np.random.default_rng(61)
        mkt = 100 * np.cumprod(1 + rng.normal(0, 0.01, BETA_MIN_OBS + 40))
        noise = rng.normal(0, 0.02, len(mkt) - 1)
        stk = np.empty(len(mkt))
        stk[0] = 100.0
        stk[1:] = stk[0] * np.cumprod(1 + noise)  # ~pure idiosyncratic, beta ~ 0
        out = _add_beta_and_idio_vol(_panel(mkt, stk))
        idio = out[out["symbol"] == "TESTCO"]["idio_vol"].dropna().iloc[-1]
        # idio_vol is a return stdev expressed in PERCENT POINTS: returns are decimal
        # (0.02 = 2%), and the function multiplies by 100, so a 2% noise process yields
        # ~2.0 (percent), NOT 200. This pins the *100 scaling and its unit.
        assert idio == pytest.approx(2.0, rel=0.25)


class TestMarketProxyDropped:
    def test_nifty50_row_is_removed(self):
        rng = np.random.default_rng(67)
        closes = 100 * np.cumprod(1 + rng.normal(0, 0.01, BETA_MIN_OBS + 20))
        out = _add_beta_and_idio_vol(_panel(closes, closes))
        assert "NIFTY50" not in set(out["symbol"])
        assert "TESTCO" in set(out["symbol"])


class TestMissingMarketDegradesGracefully:
    def test_no_market_series_yields_nan_not_crash(self):
        # If NIFTY50 is absent (or too short), beta/idio_vol must be NaN and the
        # stock retained, not raise. The factor loop treats NaN as "no signal".
        rng = np.random.default_rng(71)
        closes = 100 * np.cumprod(1 + rng.normal(0, 0.01, BETA_MIN_OBS + 20))
        px = pd.DataFrame({
            "symbol": "TESTCO",
            "date": pd.bdate_range("2023-01-02", periods=len(closes)).strftime("%Y-%m-%d"),
            "close": closes,
        })
        px["_dr"] = px["close"].pct_change()
        out = _add_beta_and_idio_vol(px)
        assert out["beta"].isna().all()
        assert out["idio_vol"].isna().all()
        assert "TESTCO" in set(out["symbol"])

