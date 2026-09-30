"""decision_outcome_resolver: realized outcomes for market_decision_event rows.

Until 2026-09-30 nothing called record_decision_outcome(), so market_decision_outcome stayed
empty and its freshness check reported the same non-pass verdict every day.
"""
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from decision_outcome_resolver import LABEL, resolve_decision_outcomes
from semantic_evidence import decision_key, persist_decision_evidence_bundles


def _rec():
    return {
        "symbol": "RELIANCE", "computed_at": "2026-09-25",
        # 18:30 UTC = 00:00 IST on 09-26: the decision is knowable only from 09-26 IST, so the
        # 09-26 bar is NOT tradeable after it -- entry must be the next session (09-28).
        "generated_at": datetime(2026, 9, 25, 18, 30, tzinfo=timezone.utc),
        "unified_score": 78.0, "classification": "Buy", "timeframe": "LONG_TERM",
    }


def _bars(conn, rows):
    for d, o, h, l, c in rows:
        conn.execute(
            "INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume, is_suspect) "
            "VALUES ('RELIANCE', ?, ?, ?, ?, ?, 1000, 0)", [d, o, h, l, c])


def _setup(conn):
    for t in ("market_decision_outcome", "market_decision_evidence", "market_decision_event"):
        conn.execute(f"DELETE FROM {t}")
    conn.execute("DELETE FROM stock_ohlcv WHERE symbol = 'RELIANCE'")
    persist_decision_evidence_bundles(conn, [_rec()])


def _outcomes(conn):
    rows = conn.execute(
        "SELECT horizon_days, outcome_status, entry_price, exit_price, return_pct, mfe_pct, mae_pct "
        "FROM market_decision_outcome WHERE decision_key = ? AND label_definition = ? "
        "ORDER BY horizon_days", [decision_key(_rec()), LABEL]).fetchall()
    return {r[0]: r for r in rows}


def test_entry_is_next_open_after_the_decision_became_knowable(pg_db_conn):
    conn = pg_db_conn
    _setup(conn)
    _bars(conn, [
        ("2026-09-25", 90.0, 91.0, 89.0, 90.0),    # before the decision
        ("2026-09-26", 95.0, 96.0, 94.0, 95.0),    # same IST day the decision landed: not tradeable
        ("2026-09-28", 100.0, 105.0, 99.0, 102.0),
        ("2026-09-29", 102.0, 104.0, 97.0, 98.0),
    ])
    resolve_decision_outcomes(conn, horizons=(1, 2, 5))
    out = _outcomes(conn)

    _, status, entry, exit_, ret, mfe, mae = out[1]
    assert status == "resolved"
    assert (entry, exit_) == (100.0, 102.0)
    assert abs(ret - 2.0) < 1e-9 and abs(mfe - 5.0) < 1e-9 and abs(mae + 1.0) < 1e-9

    _, status, entry, exit_, ret, mfe, mae = out[2]
    assert status == "resolved" and (entry, exit_) == (100.0, 98.0)
    assert abs(ret + 2.0) < 1e-9 and abs(mfe - 5.0) < 1e-9 and abs(mae + 3.0) < 1e-9

    # Not enough sessions yet: recorded as pending with no fabricated prices.
    _, status, entry, exit_, ret, _, _ = out[5]
    assert status == "pending" and entry is None and exit_ is None and ret is None


def test_pending_resolves_on_a_later_run_and_suspect_bars_are_excluded(pg_db_conn):
    conn = pg_db_conn
    _setup(conn)
    _bars(conn, [("2026-09-28", 100.0, 101.0, 99.0, 100.0)])
    resolve_decision_outcomes(conn, horizons=(2,))
    assert _outcomes(conn)[2][1] == "pending"

    _bars(conn, [("2026-09-29", 100.0, 101.0, 99.0, 110.0)])
    conn.execute("UPDATE stock_ohlcv SET is_suspect = 1 WHERE symbol='RELIANCE' AND date='2026-09-29'")
    resolve_decision_outcomes(conn, horizons=(2,))
    row = _outcomes(conn)[2]
    assert row[1] == "excluded" and row[4] is None, "a suspect bar in the window must not grade"
