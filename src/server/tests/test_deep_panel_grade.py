import numpy as np
import pandas as pd
import pytest

import deep_panel_grade as g
from deep_panel_score import LeakDetected, shuffled_control
from factor_edge import MIN_DATES_RELIABLE

ROW_KEYS = {
    "t_eff_raw", "mean_benchmark_excess_raw", "median_benchmark_excess_raw", "median_beater_flag_raw",
    "tier", "horizon", "rank_ic", "hit_auc", "n", "dates", "eff_dates", "symbols", "verdict",
    "median_benchmark_excess", "mean_benchmark_excess", "median_beater_flag", "zero_share_max",
    "contemporaneity", "label_convention",
}


def make_panel(n_sym=80, n_dates=100, seed=0, adt=2e9):
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2024-01-01", periods=n_dates)
    p = pd.DataFrame({
        "date": np.repeat(dates, n_sym),
        "symbol": np.tile([f"S{i:03d}" for i in range(n_sym)], n_dates),
    })
    p["adt"] = adt
    p["fno"] = False
    p["fno_covered"] = False
    p["ret_1d"] = rng.normal(0, 0.02, len(p))
    for h in (1, 5, 15, 21):
        p[f"target_ret_{h}d"] = rng.normal(0, 0.02 * np.sqrt(h), len(p))
    p["fwd_open_5d"] = rng.normal(0, 0.045, len(p))
    return p


def _score(p, seed=1):
    return pd.Series(np.random.default_rng(seed).normal(size=len(p)), index=p.index)


def _row(rows, horizon, label_col=None):
    hit = [r for r in rows if r["horizon"] == horizon and (label_col is None or r["label_col"] == label_col)]
    assert len(hit) == 1, hit
    return hit[0]


def test_a_tier_under_50_symbols_reads_degenerate_xs():
    p = make_panel(n_sym=30, n_dates=120)
    rows = g.grade_tier(p, _score(p), "ADT>=10cr")
    assert rows and all(r["verdict"] == "DEGENERATE-XS" for r in rows)


def test_every_row_carries_the_contract_and_eff_dates_is_dates_over_horizon():
    p = make_panel()
    rows = g.grade_tier(p, _score(p), "ADT>=10cr")
    assert {r["horizon"] for r in rows} == set(g.HORIZONS)
    for r in rows:
        assert ROW_KEYS <= set(r)
        assert r["eff_dates"] == pytest.approx(r["dates"] / r["horizon"])
        assert r["tier"] == "ADT>=10cr"
    # the 5d open-entry arm is a second, separately labelled row, never averaged into the first
    five = [r for r in rows if r["horizon"] == 5]
    assert {r["label_col"] for r in five} == {"target_ret_5d", "fwd_open_5d"}
    assert len({r["label_convention"] for r in five}) == 2


def test_null_labels_are_dropped_not_zero_filled():
    p = make_panel(n_sym=80, n_dates=100)
    last5 = p["date"].isin(sorted(p["date"].unique())[-5:])
    p.loc[last5, "target_ret_5d"] = np.nan
    r = _row(g.grade_tier(p, _score(p), "ADT>=10cr"), 5, "target_ret_5d")
    assert r["dates"] == 95
    assert r["n"] == 80 * 95


def test_a_corporate_action_seam_does_not_dominate_the_mean_excess():
    p = make_panel()
    s = _score(p)
    clean = _row(g.grade_tier(p, s, "ADT>=10cr"), 5, "target_ret_5d")
    seamed = p.copy()
    top = s.groupby(p["date"]).idxmax()
    seamed.loc[top.iloc[::10], "target_ret_5d"] = 99.0  # +9900%: a split ex-date the adjuster missed
    out = _row(g.grade_tier(seamed, s, "ADT>=10cr"), 5, "target_ret_5d")
    # unclipped, ten rows of 99.0 in an 8-name top decile add ~120 percentage points to the average
    assert abs(out["mean_benchmark_excess"] - clean["mean_benchmark_excess"]) < 2.0


def test_an_uncovered_fno_date_is_skipped_not_an_empty_eligible_set():
    p = make_panel(n_sym=80, n_dates=60)
    covered = p["date"].isin(sorted(p["date"].unique())[:30])
    p["fno_covered"] = covered
    p["fno"] = True  # even a stale True on an uncovered date must not make that date count
    p.attrs["fno_span"] = "2021-01-01..2024-07-05"
    p.attrs["fno_match_rate"] = 0.9
    rows = g.grade_tier(p, _score(p), "FNO")
    r1 = _row(rows, 1)
    assert r1["dates"] == 30
    assert r1["fno_span"] == "2021-01-01..2024-07-05"
    assert r1["fno_match_rate"] == 0.9


def test_fno_columns_use_is_covered_per_date(pg_db_conn):
    conn = pg_db_conn
    for d in ("2024-03-04", "2024-03-05"):
        for s in ("AAA", "BBB"):
            conn.execute(
                "INSERT INTO stock_option_features_history (symbol, trade_date, expiry, instrument, source) "
                "VALUES (?, ?, '2030-01-01', 'OPTSTK', 'nse_fo_bhav_old')", (s, d))
    conn.commit()
    dates = pd.to_datetime(["2024-03-04", "2024-03-05", "2024-03-06"])
    p = pd.DataFrame({"date": np.repeat(dates, 3), "symbol": np.tile(["AAA", "BBB", "CCC"], 3)})
    out = g.add_fno_columns(p, conn, {"AAA": "AAA", "BBB": "BBB"})
    by_date = out.groupby("date")["fno_covered"].first()
    assert by_date.tolist() == [True, True, False]
    assert out.loc[(out.date == dates[2]), "fno"].sum() == 0
    assert not out.loc[(out.date == dates[0]) & (out.symbol == "CCC"), "fno"].item()
    assert out.loc[(out.date == dates[0]) & (out.symbol == "AAA"), "fno"].item()
    assert out.loc[(out.date == dates[0]), "fno"].sum() == 2


def test_isin_resolution_keeps_renames_and_reports_ambiguity():
    isins = {
        "TATAMOTORS": {"INE155A01022"}, "TMPV": {"INE155A01022"},
        "LTIM": {"INE214T01019"}, "LTM": {"INE214T01019"},
        "AMBIG": {"INE999A01010"}, "X1": {"INE999A01010"}, "X2": {"INE999A01010"},
    }
    mapping, rep = g.resolve_fno_symbols(
        ["TATAMOTORS", "RELIANCE", "LTIM", "AMBIG", "GONE"], {"TMPV", "RELIANCE", "LTM", "X1", "X2"}, isins)
    assert mapping == {"RELIANCE": "RELIANCE", "TATAMOTORS": "TMPV", "LTIM": "LTM"}
    assert rep["ambiguous"] == ["AMBIG"]  # reported, never guessed
    assert rep["unresolved"] == ["GONE"]
    assert (rep["direct"], rep["by_isin"], rep["total"]) == (1, 2, 5)
    assert rep["match_rate"] == pytest.approx(3 / 5)


def test_a_tier_with_too_few_independent_windows_reads_low_data_not_no_edge():
    # 60 dates -> 12 effective windows at 5d (60/5), under MIN_DATES_RELIABLE (20); 1d keeps 60.
    # Without the gate the same random panel reads "no edge", which on data this thin is a claim not earned.
    p = make_panel(n_sym=80, n_dates=60, seed=7)
    rows = g.grade_tier(p, _score(p), "ADT>=10cr")
    thin = [r for r in rows if r["eff_dates"] < MIN_DATES_RELIABLE]
    assert {r["horizon"] for r in thin} == {5, 15, 21}
    assert {r["verdict"] for r in thin} == {"LOW-DATA"}
    assert _row(rows, 1)["verdict"] == "no edge"  # non-vacuous: enough windows still reaches a real verdict


def test_a_planted_real_signal_reads_usable():
    # Non-vacuity: a grader that can only say "no edge" proves nothing.
    p = make_panel(n_sym=80, n_dates=200, seed=3)
    s = _score(p, seed=4)
    noise = np.random.default_rng(5).normal(size=len(p))
    p["target_ret_5d"] = 0.01 * s + 0.03 * noise
    p["target_ret_1d"] = 0.004 * s + 0.02 * noise
    rows = g.grade_tier(p, s, "ADT>=10cr")
    assert _row(rows, 5, "target_ret_5d")["verdict"] == "USABLE"
    assert _row(rows, 1)["verdict"] == "USABLE"
    ctrl = g.grade_tier(p, shuffled_control(p, s), "ADT>=10cr")
    assert _row(ctrl, 5, "target_ret_5d")["verdict"] == "no edge"


def test_median_beater_is_flagged_when_median_excess_is_positive_and_mean_excess_negative():
    n_sym, n_dates = 100, 60
    p = make_panel(n_sym=n_sym, n_dates=n_dates)
    idx = p["symbol"].str[1:].astype(int)
    base = np.random.default_rng(9).normal(0, 0.001, len(p))
    lab = base + np.where(idx >= 90, 0.005, 0.0) + np.where(idx < 5, 0.30, 0.0)  # skew sits in the LOW-score names
    p["target_ret_5d"] = lab
    s = pd.Series(idx.astype(float), index=p.index)
    r = _row(g.grade_tier(p, s, "ADT>=10cr"), 5, "target_ret_5d")
    assert r["median_benchmark_excess"] > 0 > r["mean_benchmark_excess"]
    assert r["median_beater_flag"] is True
    # and a real edge is not flagged
    q = make_panel(n_sym=80, n_dates=100, seed=2)
    s2 = _score(q, seed=6)
    q["target_ret_5d"] = 0.01 * s2 + 0.03 * np.random.default_rng(7).normal(size=len(q))
    r2 = _row(g.grade_tier(q, s2, "ADT>=10cr"), 5, "target_ret_5d")
    assert r2["mean_benchmark_excess"] > 0 and r2["median_beater_flag"] is False


def test_tiers_are_cumulative_on_adt_and_the_floor_applies():
    p = make_panel(n_sym=80, n_dates=3)
    adt = np.tile(np.r_[np.full(20, 6e8), np.full(20, 2e8), np.full(20, 5e7), np.full(10, 5e6), np.full(10, 1e6)], 3)
    p["adt"] = adt
    p.loc[p.index[:1], "adt"] = np.nan
    n = lambda t: int(g.tier_mask(p, t).sum())
    assert n("ADT>=10cr") > n("ADT>=50cr") > 0
    assert n("ADT<10cr") > 0
    # the three ADT tiers partition the floor universe; a sub-Rs-1cr name is in none
    assert n("ADT>=10cr") + n("ADT<10cr") == n("ADT>=1cr")
    assert not g.tier_mask(p, "ADT<10cr")[(p["adt"] < 1e7) | p["adt"].isna()].any()


def test_label_gate_runs_before_any_file_is_written(tmp_path):
    p = make_panel()
    out = tmp_path / "out"
    with pytest.raises(LeakDetected):
        g.run(p, p["target_ret_5d"].copy(), out)  # the score IS the label
    assert not out.exists()


def test_run_writes_the_three_files(tmp_path):
    p = make_panel(n_sym=80, n_dates=120)
    out = tmp_path / "out"
    g.run(p, _score(p), out, notes={"atr_pct": "text"})
    assert (out / "verdicts.csv").exists() and (out / "control.csv").exists() and (out / "REPORT.md").exists()
    v = pd.read_csv(out / "verdicts.csv")
    assert ROW_KEYS <= set(v.columns)
    assert "median-beater" in (out / "REPORT.md").read_text(encoding="utf-8").lower()


def test_raw_columns_are_unclipped_and_sit_beside_the_winsorised_ones():
    p = make_panel()
    s = _score(p)
    top = s.groupby(p["date"]).idxmax()
    p.loc[top.iloc[::10], "target_ret_5d"] = 99.0
    r = _row(g.grade_tier(p, s, "ADT>=10cr"), 5, "target_ret_5d")
    assert abs(r["mean_benchmark_excess"]) < 2.0          # winsorised: seam clipped
    assert r["mean_benchmark_excess_raw"] > 20.0          # raw: the seam is in the number, on purpose
    assert r["t_eff_raw"] == r["t_eff_raw"] and r["t_eff_raw"] != r["mean_excess_t_eff"]


def test_raw_median_beater_flag_fires_on_the_skewed_panel_and_not_on_a_real_edge():
    p = make_panel(n_sym=100, n_dates=60)
    idx = p["symbol"].str[1:].astype(int)
    p["target_ret_5d"] = (np.random.default_rng(9).normal(0, 0.001, len(p))
                          + np.where(idx >= 90, 0.005, 0.0) + np.where(idx < 5, 0.30, 0.0))
    s = pd.Series(idx.astype(float), index=p.index)
    r = _row(g.grade_tier(p, s, "ADT>=10cr"), 5, "target_ret_5d")
    assert r["median_beater_flag_raw"] is True and r["mean_benchmark_excess_raw"] < 0 < r["median_benchmark_excess_raw"]
    q = make_panel(n_sym=80, n_dates=100, seed=2)
    s2 = _score(q, seed=6)
    q["target_ret_5d"] = 0.01 * s2 + 0.03 * np.random.default_rng(7).normal(size=len(q))
    r2 = _row(g.grade_tier(q, s2, "ADT>=10cr"), 5, "target_ret_5d")
    assert r2["median_beater_flag_raw"] is False
