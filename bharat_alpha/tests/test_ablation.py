import numpy as np
import pytest

from bharat_alpha.modeling.ablation import feature_groups, group_of


def test_every_feature_prefix_maps_to_its_group():
    cases = {"deliv_z_60": "delivery", "opt_iv_atm": "options", "fo_basis_ann": "futures", "fo_ban_days": "fo_ban",
             "earn_ear": "earnings_reaction", "res_eps_yoy_px": "reported_results", "est_eps_rev": "estimates",
             "fund_book_yield": "fundamentals", "own_promoter_holding_pct_qoq": "ownership",
             "days_to_results": "events", "x_technical_signals__rsi_14": "legacy_bridge",
             "fii_idxfut_net": "participant_oi", "fii_net_5": "cash_flows", "us_spx_ret_1": "global_cues",
             "vix_chg_5": "market_context", "mom_12_1": "price", "vol_21": "price"}
    assert {c: group_of(c) for c in cases} == cases
    assert feature_groups(["mom_12_1", "deliv_pct", "ret_5"]) == {"price": ["mom_12_1", "ret_5"], "delivery": ["deliv_pct"]}


@pytest.mark.slow
def test_ablation_credits_the_planted_signal_not_noise(conn, monkeypatch):
    from bharat_alpha.config import get_settings
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.marketdata import derive_adjustments, flag_suspect_bars
    from bharat_alpha.modeling.ablation import ablate
    from bharat_alpha.modeling.dataset import build_dataset
    from bharat_alpha.modeling.members import RidgeMember
    from bharat_alpha.sim import simulate

    for k, v in dict(BQA_MIN_HISTORY_DAYS="20", BQA_TRAIN_MIN_DATES="120", BQA_CV_FOLDS="3").items():
        monkeypatch.setenv(k, v)
    get_settings.cache_clear()
    sim = simulate(n_stocks=80, n_days=360, signal_strength=2.0, seed=21)   # alpha visible only via delivery %
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    flag_suspect_bars(conn)
    derive_adjustments(conn)
    conn.commit()
    ds = build_dataset(conn, sim.dates[0], sim.dates[-1], horizon=5)
    ds.X["noise_col"] = np.random.default_rng(0).normal(size=len(ds.X))
    deliv = [c for c in ds.X.columns if c.startswith("deliv_")]
    res = ablate(ds, members_factory=lambda: [RidgeMember()],
                 groups={"delivery": deliv, "noise": ["noise_col"]}).set_index("group")
    get_settings.cache_clear()
    assert res.loc["delivery", "verdict"] == "adds" and res.loc["delivery", "delta_ic"] > 0.01
    assert res.loc["noise", "verdict"] == "no evidence" and abs(res.loc["noise", "delta_ic"]) < 0.01
