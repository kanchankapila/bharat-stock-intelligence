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
