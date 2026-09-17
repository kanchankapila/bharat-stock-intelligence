"""gap_fill() must not mint bars for symbols the exchange stopped printing.

AF-20260914-05 / AF-20260917-04. `backfill_ohlcv.gap_fill()` takes its universe from
`SELECT DISTINCT symbol FROM stock_ohlcv` -- every symbol that has EVER had a bar,
including delisted ones -- then asks yfinance to fill the days it thinks are missing.
Yahoo keeps serving a frozen last snapshot for a dead name, so every run mints another
bar and the next run sees an even longer history to extend. Self-perpetuating.

3,199 such bars were purged on 2026-09-14 and a write-side guard was added -- but only to
`liveStockData.ts`. Measured 2026-09-17: 42 more bars across 17 symbols had already
accumulated, and EVERY ONE was dated AFTER that purge, so the leak was never closed. The
tell is in the values: the bad bars carry float32 artifacts (34.29999923706055) with
volume=0, while the same symbol's genuine bars are clean float64 with real volume.

The guard could not be shared because it lived in TypeScript and the leaking writer is
Python. `post_exit_symbols()` is the Python half; POST_EXIT_GRACE_DAYS must stay in step
with liveStockData.ts's constant of the same name and with the
`ohlcv-exit-carryforward` data-quality check's `+ 7`.
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import datetime as _dt

from as_of import post_exit_symbols, POST_EXIT_GRACE_DAYS


def _setup(conn):
    cur = conn
    cur.execute("CREATE TABLE nse_universe_history (symbol TEXT, date DATE)")
    today = _dt.date.today()
    # ALIVE: printed by bhavcopy yesterday.
    cur.execute("INSERT INTO nse_universe_history (symbol, date) VALUES (?, ?)",
                ("ALIVE", today - _dt.timedelta(days=1)))
    # EDGE: exactly at the grace boundary -- must NOT be treated as dead.
    cur.execute("INSERT INTO nse_universe_history (symbol, date) VALUES (?, ?)",
                ("EDGE", today - _dt.timedelta(days=POST_EXIT_GRACE_DAYS)))
    # DEAD: absent well beyond the grace window.
    cur.execute("INSERT INTO nse_universe_history (symbol, date) VALUES (?, ?)",
                ("DEAD", today - _dt.timedelta(days=POST_EXIT_GRACE_DAYS + 30)))
    conn.commit()


def test_identifies_only_symbols_past_the_grace_window(pg_conn):
    _setup(pg_conn)
    dead = post_exit_symbols(pg_conn)
    assert "DEAD" in dead, "a symbol absent from bhavcopy for >grace is post-exit"
    assert "ALIVE" not in dead, "a currently-trading symbol must never be filtered out"
    assert "EDGE" not in dead, (
        "the boundary is exclusive -- filtering at exactly the grace day would drop names "
        "that are merely between bhavcopy publications"
    )


def test_grace_matches_the_typescript_guard_and_the_dq_check():
    """These three must move together or the guard and its backstop disagree."""
    ts = (pathlib.Path(__file__).resolve().parents[1] / "liveStockData.ts").read_text(
        encoding="utf-8", errors="replace")
    assert f"POST_EXIT_GRACE_DAYS = {POST_EXIT_GRACE_DAYS}" in ts, (
        "liveStockData.ts's POST_EXIT_GRACE_DAYS drifted from as_of.py's"
    )
    dq = (pathlib.Path(__file__).resolve().parents[1] / "dataQualityChecks.ts").read_text(
        encoding="utf-8", errors="replace")
    assert f"u.last_trade + {POST_EXIT_GRACE_DAYS}" in dq, (
        "ohlcv-exit-carryforward's grace drifted from as_of.py's"
    )


def test_missing_table_fails_open(pg_conn):
    """Fail OPEN, matching the TS guard: an unreachable exchange record must not block
    a legitimate backfill. The DQ check is the backstop."""
    assert post_exit_symbols(pg_conn) == set()
