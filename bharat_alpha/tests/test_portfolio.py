import numpy as np
import pandas as pd
import pytest

from bharat_alpha.costs import CostModel
from bharat_alpha.ingest.sources.nse_constituents import parse_constituents
from bharat_alpha.portfolio import PortfolioConfig, UNKNOWN_SECTOR, estimate_risk, optimise


def _risk(n=40, seed=0, days=150):
    rng = np.random.default_rng(seed)
    vol = np.linspace(0.01, 0.04, n)
    mkt = rng.normal(0, 0.01, days)
    r = pd.DataFrame(mkt[:, None] + rng.normal(size=(days, n)) * vol, columns=[f"S{i}" for i in range(n)])
    return estimate_risk(r, pd.Series(mkt)), r


def test_every_constraint_holds():
    risk, _ = _risk()
    names = risk.names
    mu = pd.Series(np.linspace(0.05, 0.0, len(names)), index=names)          # all attractive
    sector = pd.Series(["BANK"] * 20 + ["IT"] * 10 + [None] * 10, index=names)
    liq = pd.Series(0.10, index=names)
    liq.iloc[0] = 0.01                                                        # an illiquid favourite
    cfg = PortfolioConfig(max_weight=0.06, sector_cap=0.25, target_vol_annual=0.5, min_weight=0.0)
    res = optimise(mu, risk, 21, sector, liq, None, cfg)
    w = res.weights
    assert w.max() <= 0.06 + 1e-6 and w.sum() <= 1 + 1e-6 and (w >= 0).all()
    assert w.get("S0", 0) <= 0.01 + 1e-6 and res.cap_reason.get("S0") == "liquidity"
    by_sector = w.groupby(sector.reindex(w.index).fillna(UNKNOWN_SECTOR)).sum()
    assert (by_sector <= 0.25 + 1e-6).all()                                  # unknown sector capped too
    assert "BANK" in res.binding["sectors_at_cap"]


def test_vol_target_scales_the_book_to_cash():
    risk, _ = _risk()
    mu = pd.Series(0.05, index=risk.names)
    res = optimise(mu, risk, 21, pd.Series(dtype=object), pd.Series(1.0, index=risk.names), None,
                   PortfolioConfig(target_vol_annual=0.05, sector_cap=1.0, max_weight=0.2))
    assert res.ex_ante_vol == pytest.approx(0.05, rel=1e-3)
    assert res.weights.sum() < 1 and "vol_target_scaled_by" in res.binding


def test_costs_suppress_pointless_trades_but_allow_real_ones():
    risk, _ = _risk()
    names = risk.names
    cfg = PortfolioConfig(sector_cap=1.0, max_weight=0.1, target_vol_annual=1.0, min_weight=0.0)
    liq = pd.Series(1.0, index=names)
    mu = pd.Series(np.linspace(0.03, -0.01, len(names)), index=names)
    first = optimise(mu, risk, 21, pd.Series(dtype=object), liq, None, cfg).weights
    # a 0.2% change of view is below the ~0.42% round trip: with real costs, don't trade;
    # the zero-cost control proves the view change alone WOULD move the book
    small = mu + np.random.default_rng(1).normal(0, 2e-3, len(names))
    again = optimise(small, risk, 21, pd.Series(dtype=object), liq, first, cfg)
    assert again.turnover < 0.005
    free = CostModel(stt=0, stamp_buy=0, exchange=0, sebi=0, slippage=0)
    first_free = optimise(mu, risk, 21, pd.Series(dtype=object), liq, None, cfg, free).weights
    assert optimise(small, risk, 21, pd.Series(dtype=object), liq, first_free, cfg, free).turnover > 0.02
    flipped = optimise(-mu, risk, 21, pd.Series(dtype=object), liq, first, cfg)
    assert flipped.turnover > 0.3                                            # a real change of view does trade


def test_short_history_names_get_median_risk_not_dropped():
    _, r = _risk(n=10)
    r.iloc[:-20, 0] = np.nan                                                  # new listing: 20 days of history
    risk = estimate_risk(r, r.mean(axis=1))
    diag = np.diag(risk.cov_daily.to_numpy())
    assert diag[0] == pytest.approx(np.median(diag[1:]), rel=0.5) and diag[0] > 0


def test_parse_constituents_requires_industry_column():
    rows = parse_constituents("Company Name,Industry,Symbol,Series,ISIN Code\n"
                              "Reliance Industries Ltd.,Oil Gas & Consumable Fuels,RELIANCE,EQ,INE002A01018\n")
    assert rows == [{"symbol": "RELIANCE", "industry": "Oil Gas & Consumable Fuels", "isin": "INE002A01018"}]
    with pytest.raises(ValueError):
        parse_constituents("Company Name,Symbol\nX,Y\n")


@pytest.mark.slow
def test_optimiser_vs_equal_weight_and_recorded_targets(conn, monkeypatch, artifacts):
    """On a market with a planted edge and heterogeneous volatility, the optimiser must deliver
    lower realised volatility than equal-weight top-k on the SAME scores and dates, without
    giving up the edge; and build_targets must write a constrained, auditable book."""
    from bharat_alpha.db import read_df
    from bharat_alpha.features import universe_mask
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.marketdata import derive_adjustments, flag_suspect_bars, load_panel
    from bharat_alpha.portfolio.run import build_targets, compare_construction
    from bharat_alpha.sim import simulate

    for k, v in dict(BQA_MIN_HISTORY_DAYS="20", BQA_TOP_K="15").items():
        monkeypatch.setenv(k, v)
    from bharat_alpha.config import get_settings

    get_settings.cache_clear()
    sim = simulate(n_stocks=100, n_days=420, signal_strength=2.0, seed=13)
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    flag_suspect_bars(conn)
    derive_adjustments(conn)
    conn.commit()
    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    uni = universe_mask(p)
    sym = {c: s for s, c in read_df(conn, "SELECT symbol, instrument_id FROM alpha.symbol_history").itertuples(index=False)}
    alpha = sim.alpha.rename(columns={s: i for i, s in sym.items()}).reindex(columns=p.close.columns)
    alpha.index = p.dates
    mu = alpha * 0.004                                     # a calibrated-looking expected excess per unit alpha
    out = compare_construction(alpha, mu, p, uni, horizon=5, top_k=15, capital=5e7,
                               cfg=PortfolioConfig(target_vol_annual=0.15, sector_cap=1.0))
    ew, opt = out["equal_weight"], out["optimised"]
    assert out["n_periods"] >= 40
    # lower vol alone could be bought with cash; it must be better RISK-ADJUSTED and cheaper to run
    assert opt["vol_annual"] < ew["vol_annual"]
    assert opt["sharpe"] > ew["sharpe"]
    assert opt["avg_turnover"] < ew["avg_turnover"]
    assert opt["t_excess"] > 2                             # the edge survives construction and costs

    # recorded targets on a published list
    d = sim.dates[-10]
    ranks = alpha.loc[pd.Timestamp(d)].where(uni.loc[pd.Timestamp(d)]).dropna().rank(ascending=False).astype(int)
    rows = [{"as_of_date": d, "horizon": 21, "instrument_id": int(i), "model_id": "m", "rank": int(r),
             "action": "BUY" if r <= 15 else "HOLD", "score": float(-r), "pred_excess": float(mu.loc[pd.Timestamp(d), i]),
             "prob_outperform": None, "interval_lo": None, "interval_hi": None, "edge_status": "unvalidated"}
            for i, r in ranks.items()]
    from bharat_alpha.db import upsert

    upsert(conn, "alpha.recommendation", rows, key=("as_of_date", "horizon", "instrument_id"))
    conn.commit()
    got = build_targets(conn, d, 21, 5e7, PortfolioConfig(max_weight=0.08))
    t = read_df(conn, "SELECT weight, value_inr, shares FROM alpha.portfolio_target WHERE run_id=%s", (got["run_id"],))
    assert len(t) >= 5 and t.weight.max() <= 0.08 + 1e-6 and t.weight.sum() <= 1 + 1e-6
    assert (t.shares == np.floor(t.shares)).all() and got["edge_status"] == "unvalidated"
    get_settings.cache_clear()
