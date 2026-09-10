"""A full recomputation must PURGE the rows it could not produce.

`run_full_pipeline` upserts on (symbol, date, timeframe), so it can only ever write dates that
exist as clean bars in `stock_ohlcv`. Any feature_store row for some OTHER date survives every
rebuild untouched, forever -- invisible, uncorrectable, and silently wrong.

Measured live 2026-09-10 after the AF-20260910-18 raw rebuild: **2,207 orphan rows**, of which
**2,130 sat on 2026-08-09 -- a SUNDAY**, a day NSE never traded and for which no price bar can
ever exist (surrounding trading days run Fri 08-07 -> Mon 08-10). They were not "missing data"
that could be backfilled; they were rows that should never have been written. The remaining 77
were computed from bars `ohlcv_quality.py` has since quarantined as `is_suspect=1`, which
`measurement.md`'s panel spec mandates filtering out.

This is `recurring-bugs.md`'s standing rule -- "any table written as today's full recomputation
needs a purge of rows the run did not produce, not just an upsert" -- which had bitten
`unified_recommendations`, `intraday_outcome_resolver` and `stock_event_triggers` before it
reached `feature_store`.
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.dirname(__file__))

from test_feature_engineering_batch import _OHLCV_DDL  # noqa: E402
from pg_test_support import pg_memory_conn  # noqa: E402

import feature_engineering as fe  # noqa: E402

# Deliberately NOT test_feature_engineering_batch's _FEATURE_STORE_DDL: that fixture declares
# `date TEXT`, while PRODUCTION (verified live 2026-09-10 via information_schema) has DATE on
# BOTH feature_store and stock_ohlcv. Reusing it would force a `::text` cast into the production
# query purely to satisfy a fixture that does not match production -- casting both sides of a
# 2.68M-row anti-join defeats the index for no real benefit. The fixture mirrors production
# types instead, which is also what makes this test able to catch a genuine type mismatch.
_FEATURE_STORE_DDL = """
CREATE TABLE IF NOT EXISTS feature_store (
    symbol TEXT NOT NULL, date DATE NOT NULL, timeframe TEXT NOT NULL,
    rsi_14 REAL,
    PRIMARY KEY (symbol, date, timeframe)
)
"""


def _seed():
    con = pg_memory_conn()
    con.execute(_FEATURE_STORE_DDL)
    con.execute(_OHLCV_DDL)
    # One clean bar, one SUSPECT bar, and no bar at all for the "Sunday" date.
    con.executemany(
        "INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume, is_suspect) "
        "VALUES (?,?,?,?,?,?,?,?)",
        [
            ("AAA", "2026-08-07", 10.0, 11.0, 9.0, 10.5, 1000.0, 0),   # clean -> keep
            ("AAA", "2026-08-10", 10.0, 11.0, 9.0, 10.5, 1000.0, 1),   # suspect -> purge
        ],
    )
    con.executemany(
        "INSERT INTO feature_store (symbol, date, timeframe, rsi_14) VALUES (?,?,?,?)",
        [
            ("AAA", "2026-08-07", "D", 55.0),   # backed by a clean bar
            ("AAA", "2026-08-10", "D", 55.0),   # backed only by a SUSPECT bar
            ("AAA", "2026-08-09", "D", -3.2),   # the Sunday: no bar exists at all
        ],
    )
    con.commit()
    return con


def _rows(con):
    return {r[0] for r in con.execute(
        "SELECT date FROM feature_store WHERE symbol='AAA'").fetchall()}


def test_purge_removes_rows_with_no_clean_ohlcv_bar():
    con = _seed()
    assert _rows(con) == {"2026-08-07", "2026-08-09", "2026-08-10"}, "fixture did not seed"

    removed = fe.purge_orphan_feature_rows(con)

    assert _rows(con) == {"2026-08-07"}, (
        "the Sunday row and the suspect-backed row must both be purged")
    assert removed == 2, f"expected 2 rows purged, reported {removed}"


def test_purge_keeps_every_row_that_has_a_clean_bar():
    """Negative control: a purge that deletes real rows is far worse than the bug it fixes.

    Guards against the obvious over-broad implementation (e.g. forgetting the is_suspect
    predicate direction, or joining on symbol only).
    """
    con = _seed()
    fe.purge_orphan_feature_rows(con)
    kept = con.execute(
        "SELECT rsi_14 FROM feature_store WHERE symbol='AAA' AND date='2026-08-07'").fetchone()
    assert kept is not None, "the row backed by a clean bar was wrongly purged"
    assert float(kept[0]) == 55.0, "the surviving row's data was altered"


def test_purge_is_a_noop_when_everything_is_backed():
    """Non-vacuity: on a healthy table the purge must delete nothing and report zero."""
    con = pg_memory_conn()
    con.execute(_FEATURE_STORE_DDL)
    con.execute(_OHLCV_DDL)
    con.execute("INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume, is_suspect) "
                "VALUES ('BBB','2026-08-07',10,11,9,10.5,1000,0)")
    con.execute("INSERT INTO feature_store (symbol, date, timeframe, rsi_14) "
                "VALUES ('BBB','2026-08-07','D',55.0)")
    con.commit()

    removed = fe.purge_orphan_feature_rows(con)

    assert removed == 0, f"healthy table should purge nothing, reported {removed}"
    assert con.execute("SELECT count(*) FROM feature_store").fetchone()[0] == 1
