"""Accuracy scorecard (spec 2026-10-08, section 2.C.2). The frozen forward test stays the arbiter; this is its sibling."""
import json
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import accuracy_scorecard as S


def test_objective_regime_is_index_vs_its_200_session_mean_and_unlabelled_before():
    d = pd.bdate_range("2025-01-01", periods=260)
    up = pd.Series(np.linspace(100, 200, 260), index=d)
    r = S.objective_regime(up)
    assert r.iloc[:199].isna().all() and (r.iloc[199:] == "UP").all()
    assert (S.objective_regime(up[::-1].set_axis(d)).iloc[199:] == "DOWN").all()


def test_calibration_flags_a_score_that_is_not_a_probability():
    rng = np.random.default_rng(0)
    y = (rng.random(5000) < 0.32).astype(int)
    honest = S.calibration_table(np.full(5000, y.mean()), y)                        # the base rate itself
    off = S.calibration_table(np.full(5000, 0.51), y)                                 # the live shape: mean 0.51 vs 0.32
    assert abs(honest["brier"] - honest["brier_base"]) < 1e-12
    assert off["brier"] > off["brier_base"]
    assert sum(b["n"] for b in off["bins"]) == 5000


def test_calibration_bins_follow_an_informative_score():
    rng = np.random.default_rng(1)
    p = rng.random(20000)
    y = (rng.random(20000) < p).astype(int)
    c = S.calibration_table(p, y)
    rates = [b["realised"] for b in c["bins"]]
    assert rates == sorted(rates) and c["brier"] < c["brier_base"]


def test_turnover_and_payoff():
    sets = [{"A", "B"}, {"A", "B"}, {"C", "D"}]
    assert S.turnover(sets) == 0.5                       # 0 then 1
    assert abs(S.payoff_ratio(np.array([0.02, 0.04, -0.01, -0.03])) - 1.5) < 1e-12


def _seed(con, n_sym=40, n_sess=260, calls_last=40, seed=5):
    rng = np.random.default_rng(seed)
    con.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, open DOUBLE PRECISION, close DOUBLE PRECISION, "
                "volume DOUBLE PRECISION, is_suspect INTEGER DEFAULT 0)")
    con.execute('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, "updatedAt" TIMESTAMPTZ DEFAULT now())')
    con.execute("CREATE TABLE unified_recommendations_history (symbol TEXT, generated_at TIMESTAMPTZ, regime TEXT, "
                "unified_score DOUBLE PRECISION, classification TEXT, ml_score DOUBLE PRECISION, confluence_score DOUBLE PRECISION, "
                "technical_score DOUBLE PRECISION, breakout_score DOUBLE PRECISION)")
    con.execute("CREATE TABLE unified_recommendations (symbol TEXT, generated_at TIMESTAMPTZ, est_cost_bps DOUBLE PRECISION)")
    con.execute("CREATE TABLE technical_signals (symbol TEXT, date DATE, calibrated_win_probability DOUBLE PRECISION)")
    con.execute("CREATE TABLE signal_outcomes (symbol TEXT, signal_date DATE, horizon_days INTEGER, outcome TEXT, "
                "signal_source TEXT, label_definition TEXT)")
    con.execute("CREATE TABLE confluence_signals (symbol TEXT, computed_at TIMESTAMPTZ, trend_alignment_score DOUBLE PRECISION, "
                "volume_score DOUBLE PRECISION, sector_strength_score DOUBLE PRECISION, fundamental_score DOUBLE PRECISION)")
    sess = pd.bdate_range("2025-06-02", periods=n_sess)
    rows = [("NIFTY50", d.date(), 100 + i, 100 + i, 1e6, 0) for i, d in enumerate(sess)]
    for s in range(n_sym):
        px = 100 * np.cumprod(1 + 0.01 * rng.normal(size=n_sess))
        rows += [(f"S{s}", d.date(), float(px[i]), float(px[i]), 2e7, 0) for i, d in enumerate(sess)]
    con.executemany("INSERT INTO stock_ohlcv VALUES (?,?,?,?,?,?)", rows)
    urh, ur, ts, so, cs = [], [], [], [], []
    for d in sess[-calls_last:]:
        parts = np.column_stack([rng.uniform(0, 15, n_sym), rng.choice([0.0, 2.0, 5.0, 7.0, 10.0], n_sym),
                                 rng.uniform(0, 8, n_sym), rng.uniform(0, 12, n_sym)])
        conf = parts.sum(axis=1).argsort().argsort() / n_sym * 100        # the ranker's confluence_score: a rank of the four-term sum
        for s in range(n_sym):
            g = pd.Timestamp(f"{d.date()} 22:00", tz="Asia/Kolkata").isoformat()
            e = rng.normal(size=4) * 20 + 50
            e[1] = conf[s]
            cs.append((f"S{s}", (pd.Timestamp(g) - pd.Timedelta(minutes=30)).isoformat(), *map(float, parts[s])))
            urh.append((f"S{s}", g, "SIDEWAYS", float(e.mean()), "Buy" if s < 8 else "Hold", *map(float, e)))
            if s < 5:                                                    # S0-S3 costed at 100 bps, S4 NULL, the rest absent
                ur.append((f"S{s}", g, 100.0 if s < 4 else None))
            if s == 5:                                                   # another run's cost is not this call's own cost
                ur.append(("S5", (pd.Timestamp(g) + pd.Timedelta(hours=1)).isoformat(), 999.0))
            ts.append((f"S{s}", d.date(), float(rng.random())))
            so.append((f"S{s}", d.date(), 5, "WIN" if rng.random() < 0.4 else "LOSS", "technical", "path_barrier"))
    con.executemany("INSERT INTO unified_recommendations_history VALUES (?,?,?,?,?,?,?,?,?)", urh)
    con.executemany("INSERT INTO confluence_signals VALUES (?,?,?,?,?,?)", cs)
    con.executemany("INSERT INTO unified_recommendations VALUES (?,?,?)", ur)
    con.executemany("INSERT INTO technical_signals VALUES (?,?,?)", ts)
    con.executemany("INSERT INTO signal_outcomes VALUES (?,?,?,?,?,?)", so)
    con.commit()
    return sess


def test_end_to_end_on_a_throwaway_schema_and_persist_writes_one_row():
    from pg_test_support import pg_memory_conn
    con = pg_memory_conn()
    sess = _seed(con)
    since = str(sess[-40].date())
    out = S.build_scorecard(con, since)
    arms = {r["arm"] for r in out["rows"]}
    assert arms == {"published", "reblend", "reblend_vol_veto", "reblend_no_ml", "random_control", "reblend_no_sector_slot"}
    assert out["no_sector_slot"] == {"sessions_covered": 40, "sessions_excluded": 0, "excluded": []}
    assert {r["floor"] for r in out["rows"]} == {1e8, 5e8} or {r["floor"] for r in out["rows"]} == {1e8}
    pub = [r for r in out["rows"] if r["tier"] == "published"]
    assert pub and all(r["arm"] == "published" for r in pub)
    assert all(r["low_data"] for r in out["rows"])                     # 40 sessions cannot clear 20 windows at 5d
    assert "UP" in {r["regime"] for r in out["rows"]}
    assert out["calibration"]["5"]["n"] > 0
    assert out["calibration"]["5"]["brier_base_label"].startswith("hindsight base rate")
    assert out["calibration"]["5"]["trailing"]["n"] > 0              # 40 signal dates: 10+ closed by date 15
    r = next(r for r in out["rows"] if r["arm"] == "published" and r["tier"] == 1.0 and r["horizon"] == 5)
    assert abs(r["excess_030_pct"] - r["excess_050_pct"] - 0.20) < 1e-9
    S.persist_snapshot(con, out)
    S.persist_snapshot(con, out)                                        # upsert, still one row
    got = con.execute("SELECT key, value FROM app_settings").fetchall()
    assert len(got) == 1 and got[0]["key"] == "accuracy_scorecard" and json.loads(got[0]["value"])["rows"]
    con.close()


def test_attach_alerts_puts_the_evaluated_alerts_into_the_snapshot():
    worse = {"n": 100, "diff": 0.05, "ci95": [0.03, 0.07]}
    sc = {"rows": [], "calibration": {"5": {"n": 100, "brier": 0.27, "brier_base": 0.22, "trailing": worse}}}
    S.attach_alerts(sc)
    assert [a["code"] for a in sc["alerts"]] == ["brier_worse_than_base"]
    noise = {"n": 100, "diff": 0.001, "ci95": [-0.002, 0.004]}
    clean = {"rows": [], "calibration": {"5": {"n": 100, "brier": 0.27, "brier_base": 0.22, "trailing": noise}}}
    S.attach_alerts(clean)
    assert clean["alerts"] == []


# ── AF-20261008-45: Brier against a TRAILING, purged base rate, not the same-period (hindsight) one ──

def _drifting(n_dates=120, per_date=200, seed=11, swings=True):
    """A decisive-WIN label whose level drifts between 0.5 and 0.3 (live: 0.50 in July -> 0.29 in September):
    swinging every 25 dates, or one linear slide."""
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2026-05-01", periods=n_dates)
    t = np.arange(n_dates)
    rate = np.where((t // 25) % 2 == 0, 0.5, 0.3) if swings else np.linspace(0.5, 0.3, n_dates)
    d = np.repeat(days, per_date)
    y = (rng.random(n_dates * per_date) < np.repeat(rate, per_date)).astype(int)
    return d, y


def test_trailing_base_is_purged_by_the_horizon():
    days = pd.bdate_range("2026-06-01", periods=40)
    d = np.repeat(days, 10)
    y = np.repeat((np.arange(40) >= 20).astype(int), 10)          # every outcome from date 20 on is a WIN
    bases = S.trailing_bases(d, y, horizon=5, window=20, min_dates=10)[::10]   # one value per date
    assert np.isnan(bases[:14]).all()                               # under 10 closed dates: no forecast
    assert (bases[14:25] == 0).all()                                # date 24 may only see dates <= 19, all LOSS
    assert bases[25] == pytest.approx(1 / 20)                        # date 25 first sees date 20


def test_drifting_label_hindsight_says_worse_but_trailing_is_within_noise():
    d, y = _drifting()
    p = S.trailing_bases(d, y, horizon=5, window=30)                 # another honest, knowable estimate of the level
    m = ~np.isnan(p)
    hindsight = S.calibration_table(p[m], y[m])
    assert hindsight["brier"] - hindsight["brier_base"] > 0.004      # the old benchmark calls it clearly worse
    tr = S.trailing_base_benchmark(d, p, y, horizon=5)
    lo, hi = tr["ci95"]
    assert lo <= 0 <= hi and abs(tr["diff"]) < 0.002
    from accuracy_alerts import brier_alert
    assert brier_alert({"calibration": {"5": {**hindsight, "trailing": tr}}}) is None


def test_a_level_that_overstates_the_win_rate_is_clearly_worse_than_the_trailing_base():
    d, y = _drifting(swings=False)
    p = np.full(len(y), 0.55)                                       # the live shape: ~0.55 predicted vs ~0.34 realised
    tr = S.trailing_base_benchmark(d, p, y, horizon=5)
    assert tr["ci95"][0] > 0.01
    from accuracy_alerts import brier_alert
    a = brier_alert({"calibration": {"5": {**S.calibration_table(p, y), "trailing": tr}}})
    assert a and a["code"] == "brier_worse_than_base" and "5" in a["detail"]["horizons"]


def test_too_few_dates_for_two_independent_blocks_gives_no_ci_and_no_alert():
    # Live 15d on 2026-10-15: 7 signal dates under a 15-date block -> every resample was the whole series and the
    # "CI" collapsed to the point estimate, which read as significant. Not measured is not measured.
    d, y = _drifting(n_dates=22, swings=False)
    tr = S.trailing_base_benchmark(d, np.full(len(y), 0.55), y, horizon=5)
    assert tr["dates"] < 10 and tr["ci95"] is None and tr["low_data"] is True
    from accuracy_alerts import brier_alert
    assert brier_alert({"calibration": {"5": {"n": 1, "trailing": tr}}}) is None


# ── AF-20261103-08: net results at each signal's own est_cost_bps, beside the flat costs ──

def _costed_panel():
    """One date, 40 names: A (100 bps) and B (NULL cost) are the published calls."""
    fwd = [0.05, 0.90] + [0.0] * 38
    return pd.DataFrame({"date": pd.Timestamp("2026-10-20"), "symbol": [f"S{i}" for i in range(40)], "score": range(40, 0, -1),
                         "fwd": fwd, "buy": [True, True] + [False] * 38, "est_cost_bps": [100.0, None] + [40.0] * 38})


def test_est_cost_of_100_bps_takes_one_percentage_point_and_null_stays_null():
    net = S.net_at_own_cost(pd.Series([0.05, 0.05]), pd.Series([100.0, None]))
    assert net[0] == pytest.approx(0.04)
    assert np.isnan(net[1])                                         # missing cost is not zero cost


def test_null_cost_call_is_excluded_from_the_own_cost_figure_and_counted_in_coverage():
    p = _costed_panel()
    u = p["fwd"].mean()
    fig = S.own_cost_figures(p, "published", 5)
    assert fig["excess_own_pct"] == pytest.approx((0.05 - 0.01 - u) * 100)     # B at +90% would swamp this as a zero-cost row
    assert fig["excess_030_same_rows_pct"] == pytest.approx((0.05 - S.COST_LOW - u) * 100)
    assert (fig["own_cost_calls"], fig["own_cost_missing"], fig["own_cost_coverage"]) == (1, 1, 0.5)
    assert fig["own_cost_dates"] == 1 and fig["own_cost_low_data"] is True


def test_a_selection_with_no_known_cost_has_no_own_cost_figure():
    p = _costed_panel().assign(est_cost_bps=None)
    fig = S.own_cost_figures(p, "published", 5)
    assert np.isnan(fig["excess_own_pct"]) and np.isnan(fig["excess_030_same_rows_pct"])
    assert (fig["own_cost_calls"], fig["own_cost_missing"], fig["own_cost_coverage"], fig["own_cost_dates"]) == (0, 2, 0.0, 0)


def test_scorecard_rows_add_own_cost_keys_and_keep_every_existing_key():
    from pg_test_support import pg_memory_conn
    con = pg_memory_conn()
    sess = _seed(con)
    out = S.build_scorecard(con, str(sess[-40].date()))
    con.execute("DELETE FROM unified_recommendations")
    uncosted = S.build_scorecard(con, str(sess[-40].date()))
    con.close()
    assert uncosted["rows"] and all(r["own_cost_calls"] == 0 and r["excess_own_pct"] != r["excess_own_pct"] for r in uncosted["rows"])
    assert [r["excess_030_pct"] for r in uncosted["rows"]] == [r["excess_030_pct"] for r in out["rows"]]     # costs move no existing key
    assert out["cost_round_trip"] == [S.COST_FROZEN, S.COST_LOW]
    r = next(r for r in out["rows"] if r["arm"] == "published" and r["tier"] == 1.0 and r["horizon"] == 5 and r["regime"] == "ALL")
    existing = {"arm", "tier", "horizon", "floor", "regime", "dates", "eff_dates", "calls_per_date", "rank_ic", "ic_t_eff", "hit_rate",
                "base_hit", "hit_lift", "hit_ci95", "excess_050_pct", "excess_030_pct", "t_eff", "payoff", "turnover", "verdict", "low_data"}
    assert existing <= set(r)
    assert abs(r["excess_030_pct"] - r["excess_050_pct"] - 0.20) < 1e-9
    assert r["excess_030_same_rows_pct"] - r["excess_own_pct"] == pytest.approx(0.70)       # 100 bps own vs 30 flat
    assert r["own_cost_calls"] == 4 * r["own_cost_dates"]                                   # S0-S3 only
    assert r["own_cost_missing"] == 36 * r["own_cost_dates"]                                # S4's NULL, S5's other run, 34 with no row


# -- reblend_no_sector_slot: the as-of read of the confluence sub-scores --

def _cs_table(con):
    con.execute("CREATE TABLE confluence_signals (symbol TEXT, computed_at TIMESTAMPTZ, trend_alignment_score DOUBLE PRECISION, "
                "volume_score DOUBLE PRECISION, sector_strength_score DOUBLE PRECISION, fundamental_score DOUBLE PRECISION)")


def test_confluence_parts_never_use_a_row_computed_after_the_call():
    from pg_test_support import pg_memory_conn
    con = pg_memory_conn()
    _cs_table(con)
    sess = pd.bdate_range("2026-10-26", periods=5)                        # Mon..Fri
    call = pd.Timestamp("2026-10-29 22:00", tz="Asia/Kolkata")
    at = lambda delta: (call + pd.Timedelta(hours=delta)).isoformat()
    con.executemany("INSERT INTO confluence_signals VALUES (?,?,?,?,?,?)", [
        ("A", (call - pd.Timedelta(days=3)).isoformat(), 1.0, 1.0, 1.0, 1.0),  # before the previous session: the ranker's window excludes it
        ("A", at(-2), 2.0, 2.0, 2.0, 2.0),
        ("A", at(-1), 3.0, 3.0, 3.0, 3.0),                                       # the latest row at or before the call
        ("A", at(+1), 99.0, 99.0, 99.0, 99.0),                                   # computed AFTER the call: must never be used
        ("B", at(+1), 99.0, 99.0, 99.0, 99.0),                                   # only a later row: no value
        ("C", (call - pd.Timedelta(days=3)).isoformat(), 5.0, 5.0, 5.0, 5.0),    # only a stale row: no value
    ])
    con.commit()
    calls = pd.DataFrame({"symbol": list("ABCD"), "generated_at": call, "session": pd.Timestamp("2026-10-29")})
    got = S.attach_confluence_parts(con, calls, sess)
    con.close()
    assert list(got["symbol"]) == list("ABCD")                                   # row order untouched
    assert list(got.loc[0, list(S.A.SLOT_COLS)]) == [3.0, 3.0, 3.0, 3.0]
    assert got.loc[1:, list(S.A.SLOT_COLS)].isna().all().all()


def test_confluence_parts_read_is_bounded_to_the_calls_window_and_selects_only_the_four_columns():
    from pg_test_support import pg_memory_conn
    con = pg_memory_conn()
    _cs_table(con)
    sess = pd.bdate_range("2026-10-26", periods=5)
    call = pd.Timestamp("2026-10-29 22:00", tz="Asia/Kolkata")
    seen = []
    class Spy:
        def execute(self, sql, params=()):
            seen.append(sql)
            return con.execute(sql, params)
        def rollback(self):
            con.rollback()
    S.attach_confluence_parts(Spy(), pd.DataFrame({"symbol": ["A"], "generated_at": call, "session": pd.Timestamp("2026-10-29")}), sess)
    con.close()
    sql = seen[0]
    assert "computed_at >= ?" in sql and "computed_at <= ?" in sql
    assert "sector_strength_score" in sql and "*" not in sql


def test_a_failing_confluence_read_leaves_the_connection_usable_and_the_scorecard_and_its_other_arms_intact():
    from pg_test_support import pg_memory_conn
    con = pg_memory_conn()
    sess = _seed(con)
    since = str(sess[-40].date())
    good = S.build_scorecard(con, since)
    con.execute("DROP TABLE confluence_signals")                       # the read now raises inside an open transaction
    con.commit()
    out = S.build_scorecard(con, since)                                # later queries only work if the handler rolled back
    con.close()
    assert "UndefinedTable" in out["no_sector_slot_error"] and "no_sector_slot_error" not in good
    assert out["no_sector_slot"] == {"sessions_covered": 0, "sessions_excluded": 40, "excluded": out["no_sector_slot"]["excluded"]}
    slot = [r for r in out["rows"] if r["arm"] == "reblend_no_sector_slot"]
    assert all(r["dates"] == 0 for r in slot)                          # blank, not a different arm
    keep = lambda sc: json.dumps(S._clean([r for r in sc["rows"] if r["arm"] != "reblend_no_sector_slot"]))   # NaN != NaN
    assert keep(out) == keep(good)                                     # the other arms are exactly as with the read working


def test_printed_report_marks_own_cost_low_data_even_when_the_flat_cost_flag_is_not():
    nan = float("nan")
    row = dict(arm="published", tier="published", horizon=5, regime="ALL", floor=S.FLOORS[0], dates=60, eff_dates=40.0,
               rank_ic=nan, ic_t_eff=nan, hit_rate=nan, base_hit=nan, hit_lift=nan, hit_ci95=nan, excess_030_pct=nan,
               excess_050_pct=nan, t_eff=nan, payoff=nan, turnover=nan, low_data=False, verdict="NO EDGE",
               excess_own_pct=nan, excess_030_same_rows_pct=nan, own_cost_calls=3, own_cost_missing=0,
               own_cost_eff_dates=2.0, own_cost_low_data=True)
    out = dict(since="2026-01-01", calls=1, sessions=1, forward_test_protocol_hash="h", rows=[row], calibration={})
    import contextlib, io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        S.print_report(out)
    line = [l for l in buf.getvalue().splitlines() if l.lstrip().startswith("published")][0]
    flat, own = line.split("|")
    assert "LOW-DATA" not in flat and "LOW-DATA" in own
