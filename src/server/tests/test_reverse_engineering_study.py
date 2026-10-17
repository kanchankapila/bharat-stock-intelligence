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
