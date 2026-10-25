import os
import sys
import warnings

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import reverse_engineering_study as study  # noqa: E402


def test_default_truth_excludes_whole_market_snapshots():
    assert "nteod_universe" not in study.DEFAULT_MOVER_CLASSES
    assert not any(name.endswith("_market") for name in study.DEFAULT_MOVER_CLASSES)
    assert {"calc_gap_up", "calc_gap_down", "calc_open_eq_low", "calc_open_eq_high",
            "calc_volume_shocker", "calc_intraday_breakout"}.issubset(
                study.DEFAULT_MOVER_CLASSES)


def test_render_dates_is_positional_and_rejects_mismatch():
    assert study._render_dates("date <= ? AND date > ?", "2026-10-02", "2026-09-02") == (
        "date <= '2026-10-02' AND date > '2026-09-02'")
    try:
        study._render_dates("date <= ? AND date > ?", "2026-10-02")
    except ValueError as exc:
        assert "not enough" in str(exc)
    else:
        raise AssertionError("a missing lookback date must not silently become the as-of date")


def test_flows_template_has_independent_point_in_time_windows():
    sql = study._render_dates(
        study.FACTOR_SQL["flows"],
        "2026-10-02", "2026-09-02", "2026-10-02", "2026-09-02",
    )
    assert sql.count("date <= '2026-10-02'") == 2
    assert sql.count("date > '2026-09-02'") == 2
    assert "?" not in sql
    assert "stock_block_deal_daily" in sql
    assert "stock_mf_holdings" in sql


def test_factor_ic_counts_a_symbol_once_when_multiple_sources_flag_it():
    symbols = [f"S{i:02d}" for i in range(30)]
    events = pd.DataFrame(
        [{"symbol": symbol, "fwd_ret": i, "source": source}
         for i, symbol in enumerate(symbols)
         for source in ("calc_gap_up", "nt_top_gainers")]
    )
    factors = pd.DataFrame({"symbol": symbols, "f_test": range(30)})
    result = study.factor_ic_table(events, factors)
    assert result.iloc[0]["n"] == 30
    assert result.iloc[0]["ic"] == 1.0


def test_preopen_factor_ic_uses_open_to_close_not_already_observed_overnight_gap():
    symbols = [f"S{i:02d}" for i in range(30)]
    events = pd.DataFrame({
        "symbol": symbols,
        "fwd_ret": list(range(30)),
        "intraday_ret": list(reversed(range(30))),
    })
    factors = pd.DataFrame({"symbol": symbols, "f_preopen_gap_pct": range(30)})

    row = study.factor_ic_table(events, factors).iloc[0]

    assert row["ic"] == -1.0
    assert row["outcome"] == "open_to_close"


def test_cohort_lift_excludes_symbols_outside_point_in_time_eligible_universe():
    eligible = [f"S{i:02d}" for i in range(40)]
    ineligible = [f"X{i:02d}" for i in range(40)]
    events = pd.DataFrame({
        "source": ["calc_gap_up"] * 12,
        "symbol": ["S00", "S01", *[f"S{i:02d}" for i in range(30, 40)]],
    })
    factors = pd.DataFrame({
        "symbol": eligible + ineligible,
        "f_test": list(range(40)) + list(range(100, 140)),
    })

    result = study.cohort_lift_table(
        events, factors, eligible_symbols=eligible,
    )

    row = result.iloc[0]
    assert row["lift"] == 5.0
    assert row["universe_n"] == 40
    assert row["factor_n"] == 40


def test_eligible_universe_requires_twenty_prior_clean_bars_and_excludes_etfs(pg_schema):
    from sqlalchemy import create_engine
    from pg_test_support import _sa_url

    conn, schema = pg_schema
    cur = conn.cursor()
    cur.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, open FLOAT8, close FLOAT8, "
                "volume FLOAT8, is_suspect INTEGER)")
    cur.execute("CREATE TABLE nse_universe_history (symbol TEXT, date DATE, series TEXT)")
    cur.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, instrument_type TEXT)")
    days = pd.bdate_range("2026-09-01", periods=21)
    full = [
        (symbol, day.date().isoformat(), 100.0 + k, 100.0 + k, 200_000.0, 0)
        for symbol in ("HISTORICAL_EQ", "KNOWN_ETF")
        for k, day in enumerate(days)
    ]
    short = [
        ("SHORT_HISTORY", day.date().isoformat(), 100.0 + k, 100.0 + k, 200_000.0, 0)
        for k, day in enumerate(days[1:])
    ]
    cur.executemany("INSERT INTO stock_ohlcv VALUES (%s,%s,%s,%s,%s,%s)", full + short)
    event_date = days[-1].date().isoformat()
    cur.executemany("INSERT INTO nse_universe_history VALUES (%s,%s,'EQ')", [
        (symbol, event_date) for symbol in ("HISTORICAL_EQ", "KNOWN_ETF", "SHORT_HISTORY")
    ])
    cur.execute("INSERT INTO nse_stocks VALUES ('KNOWN_ETF','etf')")

    engine = create_engine(_sa_url(schema), future=True)
    try:
        result = study.load_eligible_universe(engine, [event_date])
    finally:
        engine.dispose()

    assert result["symbol"].tolist() == ["HISTORICAL_EQ"]
    assert result.iloc[0]["adt20_cr"] > 1.0


def test_session_authority_drops_vendor_bars_on_a_non_trading_date():
    events = pd.DataFrame([
        {"source": "calc_gap_up", "trade_date": "2026-07-11", "symbol": "BAD"},
        {"source": "calc_gap_up", "trade_date": "2026-07-13", "symbol": "GOOD"},
    ])
    sessions = pd.Series(["2026-07-09", "2026-07-10", "2026-07-13"])
    out = study._attach_trading_sessions(events, sessions)
    assert out[["symbol", "trade_date", "t1_date"]].to_dict("records") == [{
        "symbol": "GOOD", "trade_date": "2026-07-13", "t1_date": "2026-07-10",
    }]


def test_rank_ic_constant_factor_is_nan_without_numpy_warning():
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        value = study._rank_ic(pd.Series([1.0] * 30), pd.Series(range(30)))
    assert pd.isna(value)
    assert not captured


def test_canonical_accuracy_reports_all_three_buckets(monkeypatch):
    recs = pd.DataFrame([
        {"symbol": "A", "classification": "Buy", "generated_at": "2026-10-04T17:00:00Z"},
        {"symbol": "B", "classification": "Sell", "generated_at": "2026-10-04T17:00:00Z"},
        {"symbol": "C", "classification": "Hold", "generated_at": "2026-10-04T17:00:00Z"},
        # Same-session post-open overwrite must not be allowed to grade the session.
        {"symbol": "A", "classification": "Sell", "generated_at": "2026-10-05T04:00:00Z"},
    ])
    monkeypatch.setattr(study, "get_engine", lambda: object())
    monkeypatch.setattr(pd, "read_sql", lambda *_args, **_kwargs: recs.copy())
    events = pd.DataFrame([
        {"trade_date": "2026-10-05", "symbol": "A", "fwd_ret": 3.0},
        {"trade_date": "2026-10-05", "symbol": "B", "fwd_ret": 2.0},
        {"trade_date": "2026-10-05", "symbol": "C", "fwd_ret": -2.0},
        {"trade_date": "2026-10-05", "symbol": "D", "fwd_ret": -4.0},
    ])
    row = study.canonical_signal_accuracy(events).iloc[0]
    assert (row["matched"], row["opposite"], row["not_flagged"]) == (1, 1, 2)
    assert (row["matched_pct"], row["opposite_pct"], row["not_flagged_pct"]) == (25.0, 25.0, 50.0)
    assert row["snapshot_symbols"] == 3


def test_canonical_accuracy_excludes_dates_before_snapshot_history(monkeypatch):
    recs = pd.DataFrame([
        {"symbol": "A", "classification": "Buy", "generated_at": "2026-10-04T17:00:00Z"},
    ])
    monkeypatch.setattr(study, "get_engine", lambda: object())
    monkeypatch.setattr(pd, "read_sql", lambda *_args, **_kwargs: recs.copy())
    events = pd.DataFrame([
        {"trade_date": "2026-09-01", "symbol": "OLD", "fwd_ret": 3.0},
        {"trade_date": "2026-10-05", "symbol": "A", "fwd_ret": 3.0},
    ])
    result = study.canonical_signal_accuracy(events)
    assert result["event_date"].tolist() == ["2026-10-05"]
    assert result.iloc[0]["matched"] == 1


def test_factor_summary_aggregates_dates_instead_of_showing_latest_only():
    raw = pd.DataFrame([
        {"event_date": "2026-10-01", "factor": "f_news", "ic": 0.3, "n": 100},
        {"event_date": "2026-10-02", "factor": "f_news", "ic": -0.1, "n": 120},
    ])
    row = study.summarize_factor_ic(raw).iloc[0]
    assert row["dates"] == 2
    assert row["positive_dates"] == 1
    assert row["mean_ic"] == 0.1
    assert row["total_n"] == 220


def test_accuracy_summary_keeps_coverage_beside_conditional_precision():
    raw = pd.DataFrame([
        {"event_date": "2026-10-01", "matched": 10, "opposite": 5, "not_flagged": 85},
        {"event_date": "2026-10-02", "matched": 5, "opposite": 10, "not_flagged": 85},
    ])
    row = study.summarize_accuracy(raw).iloc[0]
    assert row["matched_all_pct"] == 7.5
    assert row["opposite_all_pct"] == 7.5
    assert row["not_flagged_pct"] == 85.0
    assert row["directional_precision_pct"] == 50.0


def _momentum_plan_and_rows(sql_template):
    """Run the momentum family on a synthetic throwaway-Postgres stock_ohlcv."""
    import json
    from pg_test_support import pg_memory_conn
    con = pg_memory_conn()
    con.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, close FLOAT8, "
                "volume FLOAT8, is_suspect INTEGER)")
    days = pd.bdate_range("2026-08-03", "2026-10-08")
    rows = [(f"S{i:03d}", d.date().isoformat(), 100.0 + i + 0.37 * k, 1e5, 1 if (i + k) % 29 == 0 else 0)
            for i in range(300) for k, d in enumerate(days)]
    rows += [("NIFTY50", d.date().isoformat(), 20000.0 + 7 * k, 0.0, 0) for k, d in enumerate(days)]
    con.executemany("INSERT INTO stock_ohlcv VALUES (?, ?, ?, ?, ?)", rows)
    sql = study._render_dates(sql_template, "2026-10-08", "2026-08-09")
    plan = con.execute("EXPLAIN (ANALYZE, FORMAT JSON) " + sql).fetchone()[0]
    plan = plan if isinstance(plan, list) else json.loads(plan)
    out = sorted(tuple(r) for r in con.execute(sql + " ORDER BY 1").fetchall())
    return plan[0]["Plan"], out


def _rescans_of_latest(node):
    """Total loops > 1 over the window-function CTE (a per-outer-row re-scan of every bar)."""
    n = 0
    if node.get("Node Type") == "CTE Scan" and node.get("CTE Name") == "latest" \
            and node.get("Actual Loops", 1) > 1:
        n += node["Actual Loops"]
    for child in node.get("Plans", []):
        n += _rescans_of_latest(child)
    return n


def test_momentum_nifty_benchmark_is_computed_once_not_per_symbol():
    # 2026-10-15: the inlined `nifty` CTE re-scanned all ~100k window rows once per symbol
    # (loops=2403, 7.9s per T-1 date, x166 dates = ~22 min, ~90% of mover-study-weekly).
    plan, rows = _momentum_plan_and_rows(study.FACTOR_SQL["momentum"])
    assert _rescans_of_latest(plan) == 0
    assert len(rows) == 300


def test_momentum_materialized_benchmark_returns_identical_rows():
    unmaterialized = study.FACTOR_SQL["momentum"].replace(
        "nifty AS MATERIALIZED (", "nifty AS (")
    _, before = _momentum_plan_and_rows(unmaterialized)
    _, after = _momentum_plan_and_rows(study.FACTOR_SQL["momentum"])
    assert before == after and len(after) == 300


def test_canonical_accuracy_grades_strong_sell_as_a_directional_call(monkeypatch):
    """A Strong Sell on a name that fell is a MATCHED call, not 'not flagged'.

    The buy side has always matched both tiers ({"buy", "strong buy"}) while the sell side
    matched only the exact string "sell", so every Strong Sell fell through to side == 0 and
    was counted as 'no opinion'. Strong Sell is the largest directional bucket in the live
    ranking (204 of 2,354 on 2026-10-24), so the omission silently removed the whole
    high-conviction short book from matched/opposite and inflated not_flagged.
    """
    recs = pd.DataFrame([
        {"symbol": "SSDOWN", "classification": "Strong Sell", "generated_at": "2026-10-04T17:00:00Z"},
        {"symbol": "SSUP", "classification": "Strong Sell", "generated_at": "2026-10-04T17:00:00Z"},
        {"symbol": "SBDOWN", "classification": "Strong Buy", "generated_at": "2026-10-04T17:00:00Z"},
    ])
    monkeypatch.setattr(study, "get_engine", lambda: object())
    monkeypatch.setattr(pd, "read_sql", lambda *_args, **_kwargs: recs.copy())
    events = pd.DataFrame([
        {"trade_date": "2026-10-05", "symbol": "SSDOWN", "fwd_ret": -6.0},   # Strong Sell, fell  -> matched
        {"trade_date": "2026-10-05", "symbol": "SSUP", "fwd_ret": 4.0},      # Strong Sell, rose  -> opposite
        {"trade_date": "2026-10-05", "symbol": "SBDOWN", "fwd_ret": -3.0},   # Strong Buy, fell   -> opposite
    ])
    row = study.canonical_signal_accuracy(events).iloc[0]
    assert (row["matched"], row["opposite"], row["not_flagged"]) == (1, 2, 0)


def test_canonical_accuracy_splits_not_flagged_into_its_three_causes(monkeypatch):
    """'Not flagged' merges a rated Hold, an absent row and a flat tape. They need opposite work.

    A rated Hold on a mover is a CALIBRATION miss (we looked and said nothing); a symbol with no
    snapshot row is a COVERAGE miss (we never looked); a flat outcome is not a miss at all. The
    merged bucket read 77% on 2026-10-23 and sent every reader to the wrong fix. Keeps
    `not_flagged` as the sum so existing consumers are unchanged.
    """
    recs = pd.DataFrame([
        {"symbol": "HELD", "classification": "Hold", "generated_at": "2026-10-04T17:00:00Z"},
        {"symbol": "FLAT", "classification": "Buy", "generated_at": "2026-10-04T17:00:00Z"},
    ])
    monkeypatch.setattr(study, "get_engine", lambda: object())
    monkeypatch.setattr(pd, "read_sql", lambda *_args, **_kwargs: recs.copy())
    events = pd.DataFrame([
        {"trade_date": "2026-10-05", "symbol": "HELD", "fwd_ret": 6.0},    # rated Hold -> calibration
        {"trade_date": "2026-10-05", "symbol": "NOROW", "fwd_ret": 5.0},   # no snapshot row -> coverage
        {"trade_date": "2026-10-05", "symbol": "FLAT", "fwd_ret": 0.0},    # flat tape -> not a miss
    ])
    row = study.canonical_signal_accuracy(events).iloc[0]
    assert row["not_flagged"] == 3
    assert row["rated_hold"] == 1
    assert row["no_coverage"] == 1
    assert row["flat_outcome"] == 1


def test_every_accuracy_count_column_reaches_the_persisted_detail_json():
    """A grader column the persist block never names is invisible to every consumer.

    `persist_results` builds `detail_json` from a hand-written key list, so a new column in
    `canonical_signal_accuracy` changes only the in-memory frame while the database -- what
    the report, the DQ check and any dashboard read -- keeps the old shape. Derived from the
    source so a future column fails this test instead of silently not persisting.
    """
    import inspect
    import re as _re

    grader = inspect.getsource(study.canonical_signal_accuracy)
    persist = inspect.getsource(study.persist_results)

    # The dict literal the grader appends per date.
    produced = set(_re.findall(r'"(\w+)":\s*(?:int|float)?\(?\s*(?:matched|opposite|not_flagged|rated_hold|no_coverage|flat_outcome)\b', grader))
    counts = {c for c in ("matched", "opposite", "not_flagged", "rated_hold", "no_coverage", "flat_outcome")
              if f'"{c}"' in grader}
    assert counts, "scan found no count columns -- the grader's shape changed, fix this test"

    accuracy_block = persist[persist.index('"canonical_signal_accuracy"'):]
    accuracy_block = accuracy_block[:accuracy_block.index('n += 1')]
    missing = sorted(c for c in counts if f'"{c}"' not in accuracy_block)
    assert not missing, (
        f"canonical_signal_accuracy produces {missing} but persist_results never writes them "
        f"into detail_json, so no consumer can read them"
    )


def _gap_only_frames(n=60):
    import numpy as np
    symbols = [f"S{i:02d}" for i in range(n)]
    gap = np.arange(n, dtype=float)
    o2c = np.random.default_rng(7).permutation(n).astype(float)
    events = pd.DataFrame({"symbol": symbols, "fwd_ret": gap * 10 + o2c, "intraday_ret": o2c})
    factors = pd.DataFrame({"symbol": symbols, "f_carry": gap, "f_preopen_gap_pct": gap})
    return events, factors


def test_factor_that_only_predicts_the_overnight_gap_reads_high_c2c_and_near_zero_o2c():
    events, factors = _gap_only_frames()
    out = study.factor_ic_table(events, factors)
    c2c = out[(out["factor"] == "f_carry") & (out["metric"] == "spearman_ic")].iloc[0]
    o2c = out[(out["factor"] == "f_carry") & (out["metric"] == "spearman_ic_o2c")].iloc[0]
    assert c2c["ic"] > 0.9 and c2c["outcome"] == "prior_close_to_close"
    assert abs(o2c["ic"]) < 0.3 and o2c["outcome"] == "open_to_close"
    assert o2c["n"] == 60


def test_preopen_factors_get_no_o2c_duplicate():
    events, factors = _gap_only_frames()
    out = study.factor_ic_table(events, factors)
    pre = out[out["factor"] == "f_preopen_gap_pct"]
    assert list(pre["metric"]) == ["spearman_ic"] and list(pre["outcome"]) == ["open_to_close"]


def test_o2c_uses_only_rows_that_have_intraday_ret_and_records_that_n():
    events, factors = _gap_only_frames()
    events.loc[:19, "intraday_ret"] = float("nan")
    out = study.factor_ic_table(events, factors)
    o2c = out[(out["factor"] == "f_carry") & (out["metric"] == "spearman_ic_o2c")].iloc[0]
    assert o2c["n"] == 40
    events.loc[:39, "intraday_ret"] = float("nan")
    out = study.factor_ic_table(events, factors)
    assert out[(out["factor"] == "f_carry") & (out["metric"] == "spearman_ic_o2c")].empty
    assert len(out[(out["factor"] == "f_carry") & (out["metric"] == "spearman_ic")]) == 1


class _RecordingCon:
    def __init__(self):
        self.rows = []

    def cursor(self):
        return self

    def execute(self, sql, params=()):
        self.rows.append(params)

    def commit(self):
        pass


def test_persisted_rows_include_o2c_metric_and_leave_c2c_rows_unchanged():
    events, factors = _gap_only_frames()
    ic = study.factor_ic_table(events, factors)
    con = _RecordingCon()
    study.persist_results(con, "2026-10-25T00:00:00", ic, pd.DataFrame(), pd.DataFrame(), pd.DataFrame())
    by_key = {(r[3], r[4]): r for r in con.rows}
    assert set(by_key) == {("f_carry", "spearman_ic"), ("f_carry", "spearman_ic_o2c"),
                           ("f_preopen_gap_pct", "spearman_ic")}
    assert by_key[("f_carry", "spearman_ic")][5] > 0.9
    assert '"open_to_close"' in by_key[("f_carry", "spearman_ic_o2c")][7]
    assert '"prior_close_to_close"' in by_key[("f_carry", "spearman_ic")][7]


def test_factor_summary_shows_c2c_and_o2c_side_by_side():
    events, factors = _gap_only_frames()
    s = study.summarize_factor_ic(study.factor_ic_table(events, factors))
    row = s[s["factor"] == "f_carry"].iloc[0]
    assert row["mean_ic"] > 0.9 and abs(row["mean_ic_o2c"]) < 0.3
    assert row["dates_o2c"] == 1 and row["total_n_o2c"] == 60
    pre = s[s["factor"] == "f_preopen_gap_pct"].iloc[0]
    assert pd.isna(pre["mean_ic_o2c"])
