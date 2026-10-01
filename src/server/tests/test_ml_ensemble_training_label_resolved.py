"""AF-20261001-41: the ensemble's triple_barrier training query took any signal_excursions label
whose signal_outcomes row existed -- including PENDING ones. The 2026-10-01 regrade
(AF-20260930-31..33) resets an outcome to PENDING precisely when the horizon has not elapsed on
canonical bars, so a PENDING row's tb_label is a label the resolver itself refuses to issue.
Live 2026-10-01: 5,396 such training rows (h15 4,665, h5 541, h1 189, h3 1).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
me = pytest.importorskip("ml_ensemble")


def test_triple_barrier_training_skips_unresolved_outcomes(pg_db_conn):
    c = pg_db_conn
    for sym, outcome in (("RESOLVED", "WIN"), ("PENDINGX", "PENDING")):
        c.execute(
            "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, outcome, return_pct, "
            "signal_source, entry_price) VALUES (?, '2026-09-01', 5, ?, 1.0, 'technical', 100.0)",
            (sym, outcome))
        c.execute(
            "INSERT INTO signal_excursions (symbol, signal_date, horizon_days, entry_price, tb_label, "
            "computed_at) VALUES (?, '2026-09-01', 5, 100.0, 1, '2026-09-10')", (sym,))
    c.commit()
    df = me.load_training_data("triple_barrier")
    assert sorted(df["symbol"]) == ["RESOLVED"]
