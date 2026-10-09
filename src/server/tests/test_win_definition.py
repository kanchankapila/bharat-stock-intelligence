"""One definition of "win" (spec 2026-10-08 section 2.C.5).

The Dashboard's getAccuracyMetrics SQL and win_definition.py must agree. The parity test reads that SQL out of
signals.router.ts as TEXT and runs it on a throwaway schema next to win_rate(), so editing either side alone fails."""
import os
import re
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import win_definition as W

ROUTER = Path(__file__).resolve().parents[1] / "routers" / "signals.router.ts"


def _router_sql():
    text = ROUTER.read_text(encoding="utf-8")
    block = text[text.index("getAccuracyMetrics:"):]
    start = block.index("dbGet<any>(`") + len("dbGet<any>(`")
    sql = block[start:block.index("`, [HORIZON]")]
    horizon = int(re.search(r"const HORIZON = (\d+);", block).group(1))
    return sql, horizon


def test_router_text_pins_the_same_definition():
    sql, horizon = _router_sql()
    assert horizon == W.ACCURACY_HORIZON == 15
    assert "o.outcome = 'WIN'" in sql
    assert "o.outcome IN (" + ",".join(f"'{o}'" for o in W.DECISIVE) + ")" in sql
    assert "s.target_price > s.stop_loss" in sql        # LONG = target above stop, the resolver's own geometry rule


def test_classify_outcome():
    assert W.classify_outcome("WIN") == "WIN"
    assert W.classify_outcome("LOSS") == "LOSS"
    assert W.classify_outcome("STOP_LOSS") == "LOSS"
    assert W.classify_outcome("NEUTRAL") == "NEUTRAL"
    assert W.classify_outcome("PENDING") is None and W.classify_outcome(None) is None
    # a labelled WIN that does not clear the round trip is not a win after costs
    assert W.classify_outcome("WIN", 0.2, 0.3) == "LOSS"
    assert W.classify_outcome("WIN", 0.5, 0.3) == "WIN"
    # no label: graded on the net return
    assert W.classify_outcome(None, 1.0, 0.3) == "WIN"
    assert W.classify_outcome(None, 0.1, 0.3) == "LOSS"


def _rows():
    # (id, target, stop, horizon, outcome, return_pct)
    return [
        (1, 110, 90, 15, "WIN", 6.0), (2, 110, 90, 15, "LOSS", -3.0), (3, 110, 90, 15, "STOP_LOSS", -5.0),
        (4, 110, 90, 15, "NEUTRAL", 0.5), (5, 110, 90, 15, "PENDING", None), (6, 110, 90, 15, "WIN", 2.0),
        (7, 90, 110, 15, "WIN", 4.0),      # short geometry: excluded on the LONG side
        (8, 110, 90, 5, "WIN", 1.0),       # other horizon: excluded
    ]


def test_win_rate_matches_the_router_sql_on_the_same_rows():
    from pg_test_support import pg_memory_conn
    sql, horizon = _router_sql()
    con = pg_memory_conn()
    con.execute("CREATE TABLE unified_signals (id INTEGER PRIMARY KEY, target_price DOUBLE PRECISION, stop_loss DOUBLE PRECISION)")
    con.execute("CREATE TABLE unified_signal_outcomes (unified_signal_id INTEGER, horizon_days INTEGER, outcome TEXT, "
                "return_pct DOUBLE PRECISION, check_date DATE)")
    rows = _rows()
    con.executemany("INSERT INTO unified_signals VALUES (?,?,?)", [(r[0], r[1], r[2]) for r in rows])
    con.executemany("INSERT INTO unified_signal_outcomes VALUES (?,?,?,?, DATE '2026-10-01')", [(r[0], r[3], r[4], r[5]) for r in rows])
    con.commit()
    got = dict(con.execute(sql, (horizon,)).fetchone())
    con.close()

    df = pd.DataFrame(rows, columns=["id", "target_price", "stop_loss", "horizon_days", "outcome", "return_pct"])
    w = W.win_rate(df, "LONG", horizon)
    assert w["wins"] == int(got["wins"]) == 2
    assert w["decisive"] == int(got["decisive"]) == 4
    assert w["neutral"] == int(got["neutral"]) == 1
    assert abs(w["win_rate"] - 0.5) < 1e-12
    assert abs(w["avg_return_pct"] - float(got["avg_ret"])) < 1e-9


def test_short_side_uses_geometry_not_the_label():
    df = pd.DataFrame(_rows(), columns=["id", "target_price", "stop_loss", "horizon_days", "outcome", "return_pct"])
    w = W.win_rate(df, "SHORT", 15)
    assert (w["wins"], w["decisive"]) == (1, 1)
