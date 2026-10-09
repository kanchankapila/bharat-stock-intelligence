"""Accuracy scorecard (spec 2026-10-08, section 2.C.2). The frozen forward test stays the arbiter; this is its sibling."""
import json
import os
import sys

import numpy as np
import pandas as pd

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
    con.execute("CREATE TABLE technical_signals (symbol TEXT, date DATE, calibrated_win_probability DOUBLE PRECISION)")
    con.execute("CREATE TABLE signal_outcomes (symbol TEXT, signal_date DATE, horizon_days INTEGER, outcome TEXT, "
                "signal_source TEXT, label_definition TEXT)")
    sess = pd.bdate_range("2025-06-02", periods=n_sess)
    rows = [("NIFTY50", d.date(), 100 + i, 100 + i, 1e6, 0) for i, d in enumerate(sess)]
    for s in range(n_sym):
        px = 100 * np.cumprod(1 + 0.01 * rng.normal(size=n_sess))
        rows += [(f"S{s}", d.date(), float(px[i]), float(px[i]), 2e7, 0) for i, d in enumerate(sess)]
    con.executemany("INSERT INTO stock_ohlcv VALUES (?,?,?,?,?,?)", rows)
    urh, ts, so = [], [], []
    for d in sess[-calls_last:]:
        for s in range(n_sym):
            g = pd.Timestamp(f"{d.date()} 22:00", tz="Asia/Kolkata").isoformat()
            e = rng.normal(size=4) * 20 + 50
            urh.append((f"S{s}", g, "SIDEWAYS", float(e.mean()), "Buy" if s < 8 else "Hold", *map(float, e)))
            ts.append((f"S{s}", d.date(), float(rng.random())))
            so.append((f"S{s}", d.date(), 5, "WIN" if rng.random() < 0.4 else "LOSS", "technical", "path_barrier"))
    con.executemany("INSERT INTO unified_recommendations_history VALUES (?,?,?,?,?,?,?,?,?)", urh)
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
    assert arms == {"published", "reblend", "reblend_vol_veto", "reblend_no_ml", "random_control"}
    assert {r["floor"] for r in out["rows"]} == {1e8, 5e8} or {r["floor"] for r in out["rows"]} == {1e8}
    pub = [r for r in out["rows"] if r["tier"] == "published"]
    assert pub and all(r["arm"] == "published" for r in pub)
    assert all(r["low_data"] for r in out["rows"])                     # 40 sessions cannot clear 20 windows at 5d
    assert "UP" in {r["regime"] for r in out["rows"]}
    assert out["calibration"]["5"]["n"] > 0
    r = next(r for r in out["rows"] if r["arm"] == "published" and r["tier"] == 1.0 and r["horizon"] == 5)
    assert abs(r["excess_030_pct"] - r["excess_050_pct"] - 0.20) < 1e-9
    S.persist_snapshot(con, out)
    S.persist_snapshot(con, out)                                        # upsert, still one row
    got = con.execute("SELECT key, value FROM app_settings").fetchall()
    assert len(got) == 1 and got[0]["key"] == "accuracy_scorecard" and json.loads(got[0]["value"])["rows"]
    con.close()
