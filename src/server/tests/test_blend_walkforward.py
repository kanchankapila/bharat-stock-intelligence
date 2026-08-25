"""Tests for blend_walkforward.py -- the AF-20260823-81 ordering-quality harness.

The harness produced the 2026-08-24 gate verdict that kept engine_ic_tilt_enabled OFF
(tilt ~= base walk-forward), so its measurement machinery must itself be pinned:
mirror-equivalence with the ranker's real blend arithmetic, point-in-time/embargo
discipline in the IC estimator (a leak here would fabricate a gate verdict either way),
and the exact AF-81 gainer-hit criterion. The end-to-end test plants a perfect
ordering signal and requires BOTH arms to recover it through the real main() pipeline,
which exercises the SQL loaders against a throwaway Postgres schema.
"""
import math
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import blend_walkforward as bw  # noqa: E402
from unified_ranker import (  # noqa: E402
    ENGINE_TO_SCORE_COL,
    REGIME_WEIGHTS,
    _blend,
    _normalize_to_100,
)


# ── helpers ──────────────────────────────────────────────────────────────────────

def _panel(rows):
    """rows: list of dicts with keys symbol + engine names (+ optional fwd/next_ret)."""
    out = []
    for r in rows:
        row = {"symbol": r["symbol"], "fwd": r.get("fwd"), "next_ret": r.get("next_ret")}
        for eng, col in ENGINE_TO_SCORE_COL.items():
            row[col] = r.get(eng)
        out.append(row)
    return pd.DataFrame(out)


def _planted_rows(n=60, engine="technical", noise=0.05, seed=7, priced=True):
    """A cross-section whose true 5d outcome is an increasing function of one engine's
    score (+ small noise), so a correct blend must rank it near-perfectly."""
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(n):
        s = float(i)
        truth = (i + 1) / n + (noise * rng.standard_normal() if noise else 0.0)
        row = {"symbol": f"S{i:03d}", "fwd": truth}
        if priced:
            # monotone in the signal too, so the top-30 batch always covers the
            # top-15 gainer set (a cyclic residue here would break that inclusion)
            row["next_ret"] = (i + 1) / 500.0
        for eng in ENGINE_TO_SCORE_COL:
            # decoy engines carry pure noise -> they cannot rescue a broken mirror
            row[eng] = float(rng.uniform(0, 100)) if eng != engine else s
        rows.append(row)
    return rows


# ── blend-mirror equivalence ─────────────────────────────────────────────────────

BASE_W = dict(REGIME_WEIGHTS["SIDEWAYS"])


class TestNormalizeMirror:
    def test_matches_ranker_midrank_percentile_exactly(self):
        # Finite inputs only: the live ranker normalizes engine maps that
        # _finite_engine_map already stripped of non-finite scores, so that is the
        # domain the two implementations must agree on. (With NaN present the
        # ranker's denominator counts them and the mirror's does not.)
        vals = [3.0, 1.0, 2.0, 2.0, 5.0, 1.0, 4.0]
        raw = {f"s{i}": v for i, v in enumerate(vals)}
        mine = bw._normalize_to_100_series(pd.Series(raw))
        ref = _normalize_to_100(raw)
        for k in raw:
            assert mine[k] == pytest.approx(ref[k], abs=1e-9)

    def test_degenerate_small_cross_section_yields_all_nan(self):
        out = bw._normalize_to_100_series(pd.Series({"only": 42.0}))
        assert math.isnan(out["only"])   # unrankable -> excluded downstream, not scored 50


class TestBlendRowMirror:
    def test_identical_to_ranker_blend_when_all_engines_present(self):
        scores = {e: float(i * 7 + 3) for i, e in enumerate(ENGINE_TO_SCORE_COL)}
        got = bw._blend_row(scores, BASE_W)
        want = _blend(scores, set(BASE_W), BASE_W)
        assert got == pytest.approx(want, rel=1e-12)

    def test_missing_engine_renormalizes_like_the_ranker(self):
        scores = {e: float(i * 11 + 1) for i, e in enumerate(ENGINE_TO_SCORE_COL)}
        del scores["dl"]                      # dl_score absent for this symbol
        got = bw._blend_row(scores, BASE_W)
        want = _blend(scores, set(BASE_W) - {"dl"}, BASE_W)
        assert got == pytest.approx(want, rel=1e-12)

    def test_all_nan_scores_blend_to_nan_not_zero(self):
        scores = {e: None for e in ENGINE_TO_SCORE_COL}
        assert math.isnan(bw._blend_row(scores, BASE_W))


# ── point-in-time estimator: embargo + evidence gates ────────────────────────────

class TestDailyEngineIc:
    def test_measures_every_informative_engine_and_scales_with_truth(self):
        m = _panel(_planted_rows(engine="technical", noise=0.0))
        ics = bw.daily_engine_ic(m)
        assert set(ics) == set(ENGINE_TO_SCORE_COL)     # all covered & dispersive
        assert ics["technical"] == pytest.approx(1.0)   # the planted engine

    def test_thinly_covered_engine_is_not_measured(self):
        rows = _planted_rows()
        for r in rows[:55]:
            r["dl"] = None                              # only 5 priced dl names left
        assert "dl" not in bw.daily_engine_ic(_panel(rows))


def _timeline(n=40, start="2026-01-05"):
    days = pd.bdate_range(start, periods=n)
    return days, {d: i for i, d in enumerate(days)}


class TestEstimateIcsAsof:
    def test_embargo_blocks_recent_and_label_overlapping_sessions(self):
        days, pos = _timeline()
        daily_ic = [(d, {"technical": 0.10}) for d in days]

        def est_for(p):
            return bw.estimate_ics_asof(daily_ic, pos, days[p],
                                        embargo=bw.EMBARGO_SESSIONS, min_dates=1)

        # 5d labels mature EMBARGO-3 sessions after their session; +3 further sessions
        # of embargo. A session exactly (embargo-1) back is still label-overlapping.
        assert est_for(bw.EMBARGO_SESSIONS - 1) == {}
        assert est_for(bw.EMBARGO_SESSIONS) == {}
        # One further session out the history becomes eligible.
        assert est_for(bw.EMBARGO_SESSIONS + 1)["technical"]["ic"] == pytest.approx(0.10)

    def test_engine_below_min_dates_is_withheld(self):
        days, pos = _timeline()
        daily_ic = [(d, {"technical": 0.20}) for d in days[:bw.ENGINE_IC_MIN_DATES - 1]]
        out = bw.estimate_ics_asof(daily_ic, pos, days[-1], min_dates=20)
        assert out == {}

    def test_mean_and_date_count_cover_eligible_sessions_only(self):
        days, pos = _timeline(60)
        daily_ic = [(d, {"technical": 0.10 if i < 30 else 0.30})
                    for i, d in enumerate(days)]
        out = bw.estimate_ics_asof(daily_ic, pos, days[59], min_dates=1)
        # embargo=8 evaluated at index 59 -> eligible sessions are indices 0..50
        # (need dd_index + 8 < 59); of those, indices 30..50 sit in the 0.30 region
        assert out["technical"]["dates"] == 51
        assert out["technical"]["ic"] == pytest.approx((30 * 0.10 + 21 * 0.30) / 51)

    def test_unknown_date_returns_empty(self):
        days, pos = _timeline()
        out = bw.estimate_ics_asof([(days[0], {"dl": 0.1})], pos,
                                   pd.Timestamp("1999-01-01"), min_dates=1)
        assert out == {}


# ── AF-81 criterion arithmetic ───────────────────────────────────────────────────

class TestArmMetrics:
    def test_perfect_ordering_gives_ic_one_and_max_hits(self):
        m = pd.DataFrame(_planted_rows(engine="technical", noise=0.0))
        met = bw.arm_metrics(m, "technical")
        assert met["ic"] == 1.0
        # the quantile cut flags ~TOP_N_GAINERS names by construction, so a PERFECT
        # ordering saturates at 15 -- this is why AF-81 read "6/30" against a 15 ceiling
        assert met["hits"] == bw.TOP_N_GAINERS
        assert met["edge_pp"] > 0

    def test_inverted_ordering_gives_negative_ic_and_no_hits(self):
        n = 60
        m = pd.DataFrame({
            # anti-aligned: score DESCENDS while both outcomes ASCEND in quality
            "technical": [float(n - i) for i in range(n)],
            "fwd": [(i + 1) / n for i in range(n)],
            "next_ret": [(i + 1) / 1000.0 for i in range(n)],
        })
        met = bw.arm_metrics(m, "technical")
        assert met["ic"] == -1.0
        assert met["hits"] == 0          # the batch is entirely non-gainers
        assert met["edge_pp"] is not None and met["edge_pp"] < 0

    def test_flat_arm_reports_null_ic_without_crashing(self):
        m = pd.DataFrame(_planted_rows())
        m["flat"] = 50.0
        met = bw.arm_metrics(m, "flat")
        assert met["ic"] is None and met["hits"] >= 0

    def test_hits_stay_within_batch_size_on_random_data(self):
        rng = np.random.default_rng(3)
        m = pd.DataFrame({
            "score": rng.uniform(0, 100, 200),
            "fwd": rng.uniform(-0.05, 0.05, 200),
            "next_ret": rng.uniform(-0.02, 0.08, 200),
        })
        met = bw.arm_metrics(m, "score")
        assert 0 <= met["hits"] <= bw.TOP_N_BATCH


# ── loaders against a real (throwaway) Postgres schema ───────────────────────────

REC_COLS = ("symbol, computed_at, regime, unified_score, conviction_level, "
            + ", ".join(ENGINE_TO_SCORE_COL.values()))


def _rec_row(sym, date, regime="BULL"):
    vals = [sym, date, regime, 50.0, "B_STRONG"]
    vals += [float(abs(hash(f"{sym}{c}")) % 100) for c in ENGINE_TO_SCORE_COL]
    return tuple(vals)


def _exec_many(con, sql, rows):
    for r in rows:
        con.execute(sql, r)
    try:
        con.commit()
    except Exception:
        pass


def _insert_recs(con, rows):
    ph = ", ".join(["?"] * (5 + len(ENGINE_TO_SCORE_COL)))
    _exec_many(con, f"INSERT INTO unified_recommendations ({REC_COLS}) VALUES ({ph})", rows)


def _insert_prices(con, rows):
    _exec_many(con, "INSERT INTO stock_ohlcv (symbol, date, open, close) VALUES (?, ?, ?, ?)",
               rows)


@pytest.mark.postgres
class TestLoadersPg:
    def test_load_panel_dedupes_keeps_last(self, pg_db_conn):
        con = pg_db_conn
        # production has UNIQUE(symbol, computed_at), so same-day duplicates arise
        # from intraday re-stamps: two different timestamps truncating to one date
        early = list(_rec_row("AAA", "2026-08-10 09:30"))
        late = list(early)
        late[1] = "2026-08-10 15:45"
        late[3] = 99.0                       # the LATER stamp must win keep="last"

        _insert_recs(con, [_rec_row("BBB", "2026-08-10 09:30"),
                           tuple(early), tuple(late)])
        panel = bw._load_panel(con, "2026-01-01")
        aaa = panel[panel.symbol == "AAA"]
        assert len(panel) == 2 and len(aaa) == 1
        assert float(aaa.iloc[0]["unified_score"]) == 99.0
        assert pd.to_numeric(panel["unified_score"], errors="coerce").notna().all()

    def test_load_panel_since_filter(self, pg_db_conn):
        con = pg_db_conn
        _insert_recs(con, [_rec_row("AAA", "2026-08-10"), _rec_row("BBB", "2026-06-01")])
        panel = bw._load_panel(con, "2026-07-01")
        assert sorted(panel.symbol.tolist()) == ["AAA"]

    def test_load_prices_computes_honest_open_entry_forward(self, pg_db_conn):
        con = pg_db_conn
        op = [100.0 + i for i in range(9)]
        # one symbol, 9 consecutive sessions -- fwd/next_ret are per-symbol
        # time-series shifts, so multiple symbols with one bar each stay NaN
        rows = [("PX", f"2026-08-{3+i:02d}", op[i], op[i] + 0.5) for i in range(9)]
        _exec_many(con, "CREATE TABLE IF NOT EXISTS stock_ohlcv "
                        "(symbol TEXT, date TEXT, open REAL, close REAL)", [()])
        _insert_prices(con, rows)
        px = bw._load_prices(con).set_index("date").sort_index()
        # fwd = open[t+H+1]/open[t+1] - 1: entry at the NEXT OPEN, exit at open H days
        # later -- the panel-spec convention. A close-entry bug would read close[t+H]/close[t].
        assert px.loc[rows[0][1], "fwd"] == pytest.approx(op[6] / op[1] - 1)
        assert px.loc[rows[0][1], "next_ret"] == pytest.approx((op[1] + 0.5) / (op[0] + 0.5) - 1)

    def test_suspect_bars_are_excluded(self, pg_db_conn):
        con = pg_db_conn
        con.execute("INSERT INTO stock_ohlcv (symbol, date, open, close, is_suspect) "
                    "VALUES ('BAD', '2026-08-03', 10.0, 10.0, 1)")
        try:
            con.commit()
        except Exception:
            pass
        _insert_prices(con, [("GOOD", "2026-08-03", 10.0, 10.0)])
        px = bw._load_prices(con)
        assert "BAD" not in set(px.symbol)


# ── end-to-end through main(): both arms must recover a planted signal ───────────

def _plant_world(con, n_sym=60, n_days=90, seed=11):
    """60 symbols x 90 sessions where every engine emits a (differently scaled but
    order-preserving) copy of each symbol's fixed quality, and prices compound at a
    quality-proportional drift. Percentile normalization erases the scalings, so ANY
    admissible weighting -- base or tilted -- must recover near-perfect ordering;
    a broken mirror, leaky estimator, or dishonest forward return cannot."""
    days = pd.bdate_range("2026-03-02", periods=n_days)
    rng = np.random.default_rng(seed)
    recs, price_rows = [], []
    for i in range(n_sym):
        sym = f"S{i:03d}"
        quality = float(i) / n_sym                       # fixed cross-sectional truth
        drift = 0.0005 + 0.003 * quality                 # higher quality -> higher drift
        for j, d in enumerate(days):
            ds = d.strftime("%Y-%m-%d")
            # rises through the day's cross-section as quality matures...
            tech = 100.0 * (i + j * n_sym) / (n_sym * n_days)
            vals = [sym, ds, "SIDEWAYS", 50.0, "B_STRONG"]
            for k, eng in enumerate(ENGINE_TO_SCORE_COL):
                # ...into every engine, at distinct positive scales (order kept)
                vals.append(tech * (0.8 + 0.05 * k))
            recs.append(tuple(vals))
        for j, d in enumerate(days):
            ds = d.strftime("%Y-%m-%d")
            o = 100.0 * (1.0 + drift) ** j               # multiplicative, so the
            c = 100.0 * (1.0 + drift) ** (j + 1)         # RATIO fwd rises with quality
            price_rows.append((sym, ds, float(o), float(c)))
    _insert_recs(con, recs)
    _insert_prices(con, price_rows)
    return days[0].strftime("%Y-%m-%d")


@pytest.mark.postgres
def test_main_recovers_planted_edge_in_both_arms(pg_db_conn, capsys, monkeypatch):
    con = pg_db_conn
    since = _plant_world(con)
    monkeypatch.setattr(sys, "argv", ["blend_walkforward.py", "--since", since])
    bw.main()
    out = capsys.readouterr().out

    assert "[harness]" in out and "SUMMARY" in out
    # Both arms score the planted cross-section through the REAL blend path
    # (percentile-normalize -> weighted average -> renormalize), so each must
    # recover near-perfect ordering.
    base_line = next(l for l in out.splitlines()
                     if l.strip().startswith("base") and "'mean_rank_ic'" in l)
    tilt_line = next(l for l in out.splitlines()
                     if l.strip().startswith("tilt") and "'mean_rank_ic'" in l)
    base_ic = float(base_line.split("'mean_rank_ic': ")[1].split(",")[0])
    tilt_ic = float(tilt_line.split("'mean_rank_ic': ")[1].split(",")[0])
    assert base_ic > 0.95, base_line
    assert tilt_ic > 0.95, tilt_line
    # And the delta line the gate decision gets read off of exists.
    assert "tilt-vs-base rank-IC delta" in out


@pytest.mark.postgres
def test_main_prints_guidance_when_nothing_is_evaluable(pg_db_conn, capsys,
                                                        monkeypatch):
    con = pg_db_conn
    _insert_recs(con, [_rec_row("AAA", "2026-08-10")])
    _insert_prices(con, [("AAA", "2026-08-10", 10.0, 10.0)])
    monkeypatch.setattr(sys, "argv", ["blend_walkforward.py", "--since", "2026-01-01"])
    bw.main()
    assert "no evaluable sessions" in capsys.readouterr().out


