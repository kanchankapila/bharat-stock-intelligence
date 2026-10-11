"""Q2-FY27 post-results drift shadow arm (measurement.md 2026-10-11 pre-registration + 2026-10-12 amendment,
AF-20261008-42). Synthetic worlds pin the properties that make the number honest: drift is found on closed
windows only, exclusions are counted, post-15:30 filings move a session, and nothing before entry matters."""
import json
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import q2_drift_shadow_arm as q2

SEASON = "2026-10-12"
SESSIONS = pd.bdate_range("2026-08-03", "2027-06-30")


def _ist(day, hhmm="11:00"):
    return pd.Timestamp(f"{pd.Timestamp(day).date()} {hhmm}", tz="Asia/Kolkata")


def _fin_row(sym, pe, ts, pat, consolidated=True, parse_error=None, unit_scale="Crores", is_original=True):
    return {"symbol": sym, "period_end": pd.Timestamp(pe), "consolidated": consolidated, "broadcast_ts": ts,
            "is_original": is_original, "pat": pat, "parse_error": parse_error, "unit_scale": unit_scale}


def _world(n_weeks=20, per_week=30, signal=1.0, seed=0, sessions=SESSIONS, volume=2e6):
    """per_week filers each ISO week from SEASON; each symbol's daily drift is signal x its PAT growth."""
    rng = np.random.default_rng(seed)
    fin, px = [], []
    for w in range(n_weeks):
        monday = pd.Timestamp(SEASON) + pd.Timedelta(weeks=w)
        for j in range(per_week):
            sym = f"S{w:02d}{j:02d}"
            g = rng.normal(0, 0.5)
            fin.append(_fin_row(sym, "2025-09-30", _ist("2025-10-20"), 100.0))
            fin.append(_fin_row(sym, "2026-09-30", _ist(monday + pd.Timedelta(days=j % 5)), 100.0 * (1 + g)))
            path = 100 * np.exp(np.cumsum(rng.normal(signal * g * 0.002, 0.01, len(sessions))))
            px.append(pd.DataFrame({"symbol": sym, "date": sessions, "open": path, "close": path, "volume": volume}))
    return pd.DataFrame(fin), pd.concat(px, ignore_index=True)


# ── dating a filing ───────────────────────────────────────────────────────────

def test_a_post_1530_broadcast_counts_for_the_next_session():
    cal = pd.bdate_range("2026-10-12", periods=10)
    mon, tue = 0, 1
    assert q2.event_session_idx(_ist(cal[0], "11:00"), cal) == mon
    assert q2.event_session_idx(_ist(cal[0], "15:30"), cal) == mon
    assert q2.event_session_idx(_ist(cal[0], "15:31"), cal) == tue
    assert q2.event_session_idx(_ist("2026-10-17", "10:00"), cal) == 5   # Saturday -> Monday


def test_the_season_starts_by_event_session_not_by_broadcast_date():
    """'filings broadcast on a session (after 15:30 IST count for the next session) on or after 2026-10-12':
    Friday 10-09 16:10 belongs to Monday 10-12's session and is in; Friday 10-09 11:00 is not."""
    fin, px = _world(n_weeks=1, per_week=20, signal=0.0)
    q = fin.period_end == pd.Timestamp("2026-09-30")
    fin.loc[q & (fin.symbol == "S0000"), "broadcast_ts"] = _ist("2026-10-09", "16:10")
    fin.loc[q & (fin.symbol == "S0001"), "broadcast_ts"] = _ist("2026-10-09", "11:00")
    rep = q2.evaluate(fin, px, SESSIONS, SEASON)
    syms = {m["symbol"]: m for m in rep["cohorts"][0]["members"]}
    assert "S0000" in syms and "S0001" not in syms and rep["filers"] == 19
    assert syms["S0000"]["entry"] == "2026-10-13"


def test_a_post_1530_broadcast_enters_one_session_later():
    fin, px = _world(n_weeks=1, per_week=20, signal=0.0)
    late = fin.index[(fin.symbol == "S0000") & (fin.period_end == pd.Timestamp("2026-09-30"))][0]
    early = q2.evaluate(fin, px, SESSIONS, SEASON)
    fin.loc[late, "broadcast_ts"] = _ist(SEASON, "16:05")
    moved = q2.evaluate(fin, px, SESSIONS, SEASON)
    e0 = {m["symbol"]: m for m in early["cohorts"][0]["members"]}["S0000"]
    e1 = {m["symbol"]: m for m in moved["cohorts"][0]["members"]}["S0000"]
    assert e0["entry"] == str(SESSIONS[SESSIONS.get_loc(pd.Timestamp(SEASON)) + 1].date())
    assert e1["entry"] == str(SESSIONS[SESSIONS.get_loc(pd.Timestamp(SEASON)) + 2].date())


# ── the arm ───────────────────────────────────────────────────────────────────

def test_a_planted_drift_is_detected_on_closed_windows():
    fin, px = _world(n_weeks=20, signal=1.0)
    rep = q2.evaluate(fin, px, SESSIONS, SEASON)
    pooled = rep["pooled"]
    assert pooled["cohort_weeks"] == 20 and not rep["pending"]
    assert pooled["mean_excess_net"] > 0.01 and pooled["t_one_sided"] > 3
    assert pooled["verdict"] != "LOW-DATA"
    assert np.mean([c["rank_ic"] for c in rep["cohorts"]]) > 0.1


def test_the_same_world_without_drift_is_not_detected():
    """Negative control on the planted-drift test: the harness does not manufacture the result."""
    fin, px = _world(n_weeks=20, signal=0.0)
    assert q2.evaluate(fin, px, SESSIONS, SEASON)["pooled"]["t_one_sided"] < 1.65


def test_a_cohort_whose_window_is_open_is_pending_not_graded():
    short = SESSIONS[SESSIONS <= pd.Timestamp("2026-11-20")]
    fin, px = _world(n_weeks=4, per_week=20, sessions=short)
    rep = q2.evaluate(fin, px, short, SEASON)
    graded = [c["cohort"] for c in rep["cohorts"]]
    pending = [p["cohort"] for p in rep["pending"]]
    # week 42 (events 10-12..10-16) exits by 11-17 and closes; weeks 43-45 exit after 11-20
    assert graded == ["2026-W42"] and pending == ["2026-W43", "2026-W44", "2026-W45"]
    for p in rep["pending"]:
        assert p["expected_close"] > "2026-11-20"
    for c in rep["cohorts"]:
        assert c["exit_last"] <= "2026-11-20"
    assert pending, "an open window must be listed as pending"
    assert rep["pooled"]["verdict"] == "LOW-DATA"


def test_half_year_missing_base_and_scale_errors_are_excluded_and_counted():
    fin, px = _world(n_weeks=1, per_week=20, signal=0.0)
    q = (fin.period_end == pd.Timestamp("2026-09-30"))
    py = (fin.period_end == pd.Timestamp("2025-09-30"))
    fin.loc[q & (fin.symbol == "S0000"), "parse_error"] = "not_a_quarter"
    fin = fin[~(py & (fin.symbol == "S0001"))]
    fin.loc[py & (fin.symbol == "S0002"), "pat"] = 0.0
    fin.loc[py & (fin.symbol == "S0003"), "parse_error"] = "not_a_quarter"
    fin.loc[q & (fin.symbol == "S0004"), ["pat", "unit_scale"]] = [100.0 * 5000, "Lakhs"]   # lakh/crore slip
    fin.loc[q & (fin.symbol == "S0005"), "pat"] = 100.0 * 5000                             # crores: real, winsorised
    fin.loc[py & (fin.symbol == "S0006"), "consolidated"] = False                          # only the other basis a year ago
    rep = q2.evaluate(fin, px, SESSIONS, SEASON)
    ex = rep["exclusions"]
    assert ex["half_year_in_quarter_slot"] == 1
    assert ex["no_year_ago"] == 2
    assert ex["year_ago_zero_or_missing"] == 1
    assert ex["year_ago_half_year"] == 1
    assert ex["scale_error"] == 1
    members = {m["symbol"]: m for c in rep["cohorts"] + rep["pending"] for m in c.get("members", [])}
    assert members["S0005"]["growth"] == pytest.approx(3.0)
    assert not {"S0000", "S0001", "S0002", "S0003", "S0004", "S0006"} & set(members)


def test_revisions_are_ignored_and_consolidated_wins():
    fin, px = _world(n_weeks=1, per_week=20, signal=0.0)
    ts = fin.loc[(fin.symbol == "S0007") & (fin.period_end == pd.Timestamp("2026-09-30")), "broadcast_ts"].iloc[0]
    fin = pd.concat([fin, pd.DataFrame([
        _fin_row("S0007", "2026-09-30", ts + pd.Timedelta(days=1), 900.0, is_original=False),
        _fin_row("S0007", "2026-09-30", ts, 700.0, consolidated=False),
    ])], ignore_index=True)
    rep = q2.evaluate(fin, px, SESSIONS, SEASON)
    m = {m["symbol"]: m for c in rep["cohorts"] for m in c["members"]}["S0007"]
    base = fin[(fin.symbol == "S0007") & fin.consolidated & fin.is_original
               & (fin.period_end == pd.Timestamp("2026-09-30"))]
    assert len(base) == 1
    want = (base.pat.iloc[0] - 100.0) / 100.0
    assert m["growth"] == pytest.approx(max(min(want, 3.0), -3.0))


def test_illiquid_and_unpriced_filers_are_counted_not_graded():
    fin, px = _world(n_weeks=1, per_week=20, signal=0.0)
    px.loc[px.symbol == "S0000", "volume"] = 1_000           # ADT far below Rs10cr
    px = px[px.symbol != "S0001"]                             # no bars at all
    rep = q2.evaluate(fin, px, SESSIONS, SEASON)
    assert rep["exclusions"]["below_adt_10cr"] == 1 and rep["exclusions"]["unmapped_symbol"] == 1
    assert rep["cohorts"][0]["n"] == 18


def test_small_weeks_merge_into_the_next():
    fin, px = _world(n_weeks=3, per_week=10, signal=0.0)
    rep = q2.evaluate(fin, px, SESSIONS, SEASON)
    assert [c["n"] for c in rep["cohorts"]] == [20]
    assert rep["cohorts"][0]["weeks"] == ["2026-W42", "2026-W43"]
    tail = [p for p in rep["pending"] if p["status"] == "undersized"]
    assert len(tail) == 1 and tail[0]["n"] == 10


def test_the_benchmark_is_every_eligible_filer_and_cost_is_per_entry():
    fin, px = _world(n_weeks=1, per_week=20, signal=0.0)
    c = q2.evaluate(fin, px, SESSIONS, SEASON)["cohorts"][0]
    rets = np.array([m["ret"] for m in c["members"]])
    top = np.array([m["ret"] for m in c["members"] if m["quintile"] == 5])
    assert len(top) == 4
    assert c["bench"] == pytest.approx(rets.mean())
    assert c["excess_net"] == pytest.approx(top.mean() - 0.003 - rets.mean())


# ── look-ahead ────────────────────────────────────────────────────────────────

def test_prices_up_to_the_event_session_change_nothing_but_the_entry_open_does():
    fin, px = _world(n_weeks=2, per_week=20, signal=1.0)
    base = q2.evaluate(fin, px, SESSIONS, SEASON)
    q = fin[fin.period_end == pd.Timestamp("2026-09-30")]
    event_day = dict(zip(q.symbol, q.broadcast_ts.map(lambda t: pd.Timestamp(t.date()))))   # 11:00 IST -> same session
    early = px.copy()
    sel = early.date <= early.symbol.map(event_day)
    early.loc[sel, ["open", "close"]] *= 1.5             # each name's announcement-day bar and everything before it
    same = q2.evaluate(fin, early, SESSIONS, SEASON)
    assert [c["excess_net"] for c in same["cohorts"]] == [c["excess_net"] for c in base["cohorts"]]
    late = px.copy()
    entry = SESSIONS[SESSIONS.get_loc(pd.Timestamp(SEASON)) + 1]
    late.loc[(late.date == entry) & (late.symbol == "S0000"), "open"] *= 1.5
    moved = q2.evaluate(fin, late, SESSIONS, SEASON)
    assert moved["cohorts"][0]["bench"] != base["cohorts"][0]["bench"]


# ── statistics ────────────────────────────────────────────────────────────────

def test_a_random_score_does_not_pass():
    """Net t never clears the bar; before the 0.30% cost (which drags a random arm's net t negative as the
    cohort count grows) the excess is centred on zero, |t| < 2."""
    for s in range(5):
        rep = q2.evaluate(*_world(n_weeks=30, per_week=30, signal=0.0, seed=s), SESSIONS, SEASON)
        assert rep["pooled"]["t_one_sided"] < 1.65
        gross = np.array([c["excess_net"] + 0.003 for c in rep["cohorts"]])
        assert len(gross) == 30
        assert abs(gross.mean() / (gross.std(ddof=1) / np.sqrt(len(gross)))) < 2, s


def test_fewer_than_15_cohort_weeks_is_low_data():
    fin, px = _world(n_weeks=5, signal=1.0)
    p = q2.evaluate(fin, px, SESSIONS, SEASON)["pooled"]
    assert p["cohort_weeks"] == 5 and p["verdict"] == "LOW-DATA"


# ── persistence (throwaway schema) ────────────────────────────────────────────

@pytest.mark.postgres
def test_persist_upserts_one_app_settings_row(pg_conn):
    import nse_xbrl_fundamentals_fetcher as xf
    xf.ensure_schema(pg_conn)
    pg_conn.execute('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, "updatedAt" TIMESTAMPTZ DEFAULT now())')
    pg_conn.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, open DOUBLE PRECISION, high DOUBLE PRECISION, "
                    "low DOUBLE PRECISION, close DOUBLE PRECISION, volume DOUBLE PRECISION, is_suspect INTEGER)")
    fin, px = _world(n_weeks=1, per_week=20, signal=0.0)
    for r in fin.itertuples():
        pg_conn.execute(f"INSERT INTO {xf.TABLE} (symbol, period_end, consolidated, broadcast_ts, filing_period, "
                        "is_original, pat, parse_error, unit_scale, source_url) VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (r.symbol, r.period_end.date(), r.consolidated, r.broadcast_ts.to_pydatetime(), "Integrated",
                         r.is_original, r.pat, r.parse_error, r.unit_scale, f"u/{r.symbol}/{r.period_end.date()}"))
    nifty = pd.DataFrame({"symbol": "NIFTY50", "date": SESSIONS, "open": 1.0, "close": 1.0, "volume": 1.0})
    for r in pd.concat([px, nifty]).itertuples():
        pg_conn.execute("INSERT INTO stock_ohlcv (symbol, date, open, close, volume) VALUES (?,?,?,?,?)",
                        (r.symbol, r.date.date(), float(r.open), float(r.close), float(r.volume)))
    pg_conn.commit()
    for _ in range(2):
        out = q2.run(pg_conn, SEASON, persist=True)
    rows = pg_conn.execute("SELECT key, value FROM app_settings").fetchall()
    assert len(rows) == 1 and rows[0][0] == "q2_drift_shadow_arm"
    stored = json.loads(rows[0][1])
    assert stored["pooled"]["cohort_weeks"] == out["pooled"]["cohort_weeks"] == 1
    assert stored["exclusions"]["no_year_ago"] == 0
