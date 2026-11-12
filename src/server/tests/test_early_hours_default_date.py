"""early_hours_predictor with no --date must predict TODAY's session, never re-score an old one.

2026-11-11: the host slept through the 09:00-09:20 pre-open window, so preopen_stock_snapshot's
newest date stayed 2026-11-06. The 13:20 catch-up ran run_predictor() with no date, which
defaulted to MAX(snapshot_date) and re-scored 2026-11-06, rewriting that day's
early_hours_predictions (and their computed_at) five sessions later. Pre-open predictions exist
only for the session whose book was captured; with no book for today there is nothing to predict.
"""
import os
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def test_default_target_is_today_in_ist():
    import early_hours_predictor as ehp
    # 2026-11-11 20:00 UTC is already 2026-11-12 01:30 in IST.
    assert ehp.default_target_date(datetime(2026, 11, 11, 20, 0, tzinfo=timezone.utc)) == "2026-11-12"
    assert ehp.default_target_date(datetime(2026, 11, 11, 3, 40, tzinfo=timezone.utc)) == "2026-11-11"


def test_stale_snapshot_is_not_rescored(pg_db_conn, monkeypatch):
    import early_hours_predictor as ehp
    old = (date.today() - timedelta(days=5)).isoformat()
    pg_db_conn.execute(
        "INSERT INTO preopen_stock_snapshot (symbol, snapshot_date, iep, prev_close, iep_gap_pct, "
        "total_buy_qty, total_sell_qty, preopen_imbalance) VALUES ('AAA', ?, 105, 100, 5.0, 900, 100, 0.8)",
        (old,))
    pg_db_conn.commit()
    asked = []
    monkeypatch.setattr(ehp, "fetch_preopen_snapshots", lambda con, d: asked.append(str(d)) or {})
    assert ehp.run_predictor() == []
    assert asked == [ehp.default_target_date()]
    assert old not in asked
