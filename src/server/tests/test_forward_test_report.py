"""Forward test + selective-accuracy report (analyst recommendations 1 and 2, 2026-10-06).

Accuracy here means: of the calls the platform publishes at a given coverage, how often did they beat the
equal-weight liquid universe AFTER costs, with an uncertainty that counts independent windows (dates/h),
not overlapping daily rows. These tests pin the properties that make such a number honest."""
import datetime
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import forward_test_report as ftr


def _sessions(n=60, start="2026-01-05"):
    return pd.bdate_range(start, periods=n)


# ── dating a call ─────────────────────────────────────────────────────────────

def test_a_pre_open_publication_enters_that_morning_not_a_day_late():
    sess = _sessions()
    mon, tue = sess[5], sess[6]
    # Published Tuesday 06:33 IST, before the 09:15 open: knowable for Tuesday's open, so it belongs to MONDAY's
    # session (entry = next session open = Tuesday).
    early = pd.Timestamp(tue.date().isoformat() + " 06:33", tz="Asia/Kolkata")
    assert ftr.call_session(early, sess) == mon


def test_a_post_close_publication_belongs_to_that_session():
    sess = _sessions()
    mon = sess[5]
    late = pd.Timestamp(mon.date().isoformat() + " 22:30", tz="Asia/Kolkata")
    assert ftr.call_session(late, sess) == mon


def test_a_weekend_publication_maps_to_the_last_session():
    sess = _sessions()
    fri = sess[4]
    sat_night = pd.Timestamp((fri + pd.Timedelta(days=2)).date().isoformat() + " 23:00", tz="Asia/Kolkata")
    assert ftr.call_session(sat_night, sess) == fri


def test_latest_call_per_symbol_and_session_wins():
    sess = _sessions()
    mon = sess[5]
    rows = pd.DataFrame({
        "symbol": ["AAA", "AAA", "BBB"],
        "generated_at": [pd.Timestamp(mon.date().isoformat() + " 18:00", tz="Asia/Kolkata"),
                         pd.Timestamp(mon.date().isoformat() + " 22:30", tz="Asia/Kolkata"),
                         pd.Timestamp(mon.date().isoformat() + " 22:30", tz="Asia/Kolkata")],
        "unified_score": [10.0, 90.0, 50.0],
    })
    out = ftr.latest_call_per_session(rows, sess).set_index("symbol")
    assert out.loc["AAA", "unified_score"] == 90.0 and len(out) == 2


# ── selective accuracy ────────────────────────────────────────────────────────

def _panel(n_dates, n_syms, signal, seed=0, h=5):
    """score is `signal` x the realised forward return plus noise: signal=0 is a coin flip."""
    rng = np.random.default_rng(seed)
    rows = []
    for d in range(n_dates):
        fwd = rng.normal(0.0, 0.05, n_syms)
        score = signal * fwd / 0.05 + rng.normal(0, 1, n_syms)
        rows.append(pd.DataFrame({"date": pd.Timestamp("2026-01-05") + pd.Timedelta(days=d), "symbol": range(n_syms),
                                  "score": score, "fwd": fwd}))
    return pd.concat(rows, ignore_index=True)


def test_an_informative_score_shows_higher_accuracy_at_lower_coverage():
    res = ftr.selective_accuracy(_panel(120, 400, signal=1.0), horizon=5, tiers=(0.05, 0.25, 1.0), cost=0.0)
    by = {r["tier"]: r for r in res}
    assert by[0.05]["hit_rate"] > by[0.25]["hit_rate"] > by[1.0]["hit_rate"] - 1e-9
    assert by[0.05]["hit_lift"] > 0.15


def test_a_coin_flip_score_shows_no_lift_at_any_coverage():
    res = ftr.selective_accuracy(_panel(200, 400, signal=0.0, seed=3), horizon=5, tiers=(0.05, 0.25), cost=0.0)
    for r in res:
        assert abs(r["hit_lift"]) < 0.06
        assert r["verdict"] != "EDGE"


def test_full_coverage_is_the_baseline_not_an_edge():
    res = ftr.selective_accuracy(_panel(60, 300, signal=1.0), horizon=5, tiers=(1.0,), cost=0.0)
    assert abs(res[0]["mean_excess_pct"]) < 1e-9          # holding everything IS the benchmark


def test_costs_are_charged_to_the_calls():
    p = _panel(80, 300, signal=0.0, seed=1)
    free = ftr.selective_accuracy(p, 5, (0.1,), cost=0.0)[0]["mean_excess_pct"]
    paid = ftr.selective_accuracy(p, 5, (0.1,), cost=0.005)[0]["mean_excess_pct"]
    assert abs((free - paid) - 0.5) < 1e-6                 # 0.50 percentage points per call


def test_uncertainty_counts_independent_windows_not_overlapping_days():
    res = ftr.selective_accuracy(_panel(100, 300, signal=1.0), horizon=10, tiers=(0.1,), cost=0.0)[0]
    assert res["dates"] == 100 and abs(res["eff_dates"] - 10.0) < 1e-9
    assert res["verdict"] == "LOW-DATA"                    # 10 independent windows is under MIN_DATES_RELIABLE


def test_a_thin_cross_section_is_skipped_not_graded():
    res = ftr.selective_accuracy(_panel(40, 8, signal=1.0), horizon=5, tiers=(0.5,), cost=0.0, min_per_date=30)
    assert res[0]["dates"] == 0 and res[0]["verdict"] == "LOW-DATA"


# ── frozen protocol ───────────────────────────────────────────────────────────

def test_protocol_hash_changes_when_any_rule_changes():
    a = ftr.protocol_hash(ftr.PROTOCOL)
    b = ftr.protocol_hash({**ftr.PROTOCOL, "cost_per_side": 0.0010})
    assert a != b and a == ftr.protocol_hash(dict(ftr.PROTOCOL))


def test_protocol_pins_the_start_date_and_the_honest_conventions():
    p = ftr.PROTOCOL
    assert p["start_date"] == "2026-10-06"
    assert p["entry"] == "next session open" and p["benchmark"].startswith("equal-weight")
    assert p["cost_per_side"] == 0.0025 and tuple(p["horizons"]) == (5, 10, 21)


def test_report_refuses_calls_dated_before_the_protocol_start():
    calls = pd.DataFrame({"session": pd.to_datetime(["2026-09-30", "2026-10-06", "2026-10-07"]), "symbol": list("abc")})
    kept = ftr.apply_protocol_start(calls, "2026-10-06")
    assert list(kept["symbol"]) == ["b", "c"]


# ── the database path (a unit test of the pure functions cannot see a duplicated `date` column) ──────

def test_build_panel_end_to_end_on_a_throwaway_schema(pg_memory_conn_fixture=None):
    from pg_test_support import pg_memory_conn
    con = pg_memory_conn()
    con.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, open DOUBLE PRECISION, close DOUBLE PRECISION, "
                "volume DOUBLE PRECISION, is_suspect INTEGER DEFAULT 0)")
    sess = _sessions(60)
    rows = []
    for sym, base, vol in (("LIQ", 100.0, 1_000_000), ("ILQ", 100.0, 10)):   # ILQ trades Rs ~1k a day: below the floor
        for i, d in enumerate(sess):
            px = base * (1.0 + 0.002 * i)
            rows.append((sym, d.date(), px, px, vol, 0))
    con.executemany("INSERT INTO stock_ohlcv (symbol, date, open, close, volume, is_suspect) VALUES (?,?,?,?,?,?)", rows)
    con.commit()
    calls = pd.DataFrame({"symbol": ["LIQ", "ILQ"], "session": [sess[30], sess[30]],
                          "unified_score": [80.0, 90.0], "classification": ["Buy", "Strong Buy"]})
    panel = ftr.build_panel(con, calls, sess, [5], min_adt=10_000_000)
    assert list(panel["symbol"]) == ["LIQ"]                        # the illiquid name is dropped by the ADT floor
    assert "date" in panel.columns and panel.columns.tolist().count("date") == 1
    assert panel["fwd_5"].notna().all() and panel["fwd_5"].iloc[0] > 0
    con.close()


def test_hold_everything_has_no_t_statistic_not_a_huge_one():
    # excess is exactly -cost on every date (zero variance); a numerically-zero sd must not become t = 1e15
    r = ftr.selective_accuracy(_panel(60, 300, signal=1.0), horizon=5, tiers=(1.0,), cost=0.005)[0]
    assert r["t_eff"] != r["t_eff"]                       # NaN
