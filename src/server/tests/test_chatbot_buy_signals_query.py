"""
Pins the three independent filters that made chatbot `get_buy_signals` return a tiny,
unrepresentative slice of `unified_signals`.

All three were measured live against production on 2026-08-15 over a trailing 7 days
(15,752 rows in `unified_signals`):

1. `signal_type = 'BUY'` -- the largest writer (technical_analysis_engine.py,
   signal_source='technical') emits 'Bullish'/'Bearish', not 'BUY'/'SELL'. 8,033 of the
   7-day rows were 'Bullish' against 834 'BUY', so the dominant source was excluded whole.
2. `confidence_score` carries TWO SCALES in one column: 0-1 from
   technical_scan/screener/SCREENER_SURFACING (measured 0.10-0.95) and 0-100 from AI
   (measured 49-73). Against the 0.65 default threshold every 0-100 row passed
   unconditionally -- the filter did nothing for that source.
3. signal_source='technical' never writes `confidence_score` at all (14,732 of 15,752 rows
   NULL). `confidence_score >= ?` is never true for NULL, so those rows were dropped a
   second, independent time.

Negative control (run 2026-08-15): `git stash push -- src/server/chatbot/tools/sql_tool.py`
to restore the pre-fix query makes test_bullish_rows_are_included,
test_null_confidence_rows_are_included, test_high_scale_confidence_is_not_a_free_pass and
test_scored_rows_outrank_unknown_confidence all fail; test_bearish_rows_stay_excluded
passes either way and is the control that the widened match did not become "return
everything".

Runs against REAL Postgres via the `pg_conn` fixture (production's own db_compat
translation layer), auto-skipping when Postgres is unreachable -- same shape as
test_marketsmojo_incremental_write.py.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))                       # conftest's pg_available
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))   # src/server, for db_compat
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'chatbot'))
from conftest import pg_available  # noqa: E402
from tools import sql_tool  # noqa: E402

pytestmark = pytest.mark.skipif(not pg_available(), reason="live Postgres not reachable")

RECENT = "CURRENT_DATE - 1"


@pytest.fixture
def signals(pg_conn, monkeypatch):
    pg_conn.execute("""
        CREATE TABLE unified_signals (
            symbol TEXT, signal_date DATE, signal_source TEXT, signal_type TEXT,
            entry_price REAL, target_price REAL, stop_loss REAL,
            confidence_score REAL, reasoning TEXT
        )
    """)
    # (symbol, source, type, confidence) -- one row per behaviour under test.
    rows = [
        # 0-1 scale, 0.90 == 90%: the only row the pre-fix query and this one agree on.
        ("SCORED",   "technical_scan", "Bullish", 0.90),
        # Dominant source: 'Bullish' spelling AND a NULL confidence -- excluded twice before.
        ("BULLNULL", "technical",      "Bullish", None),
        # NULL confidence on a row whose signal_type the old query already matched, so this
        # isolates the NULL exclusion from the signal_type one.
        ("BUYNULL",  "screener",       "BUY",     None),
        # 0-100 scale: 40.0 means 40%, which is BELOW the 65% default. The pre-fix query
        # compared it against 0.65 and let it through.
        ("AILOW",    "AI",             "BUY",     40.0),
        # Control: widening the signal_type match must not start returning bearish calls.
        ("BEARISH",  "technical",      "Bearish", None),
    ]
    for sym, src, typ, conf in rows:
        pg_conn.execute(
            "INSERT INTO unified_signals (symbol, signal_date, signal_source, signal_type, "
            f"entry_price, target_price, stop_loss, confidence_score, reasoning) "
            f"VALUES (?, {RECENT}, ?, ?, 100.0, 110.0, 95.0, ?, 'why')",
            (sym, src, typ, conf),
        )
    pg_conn.commit()

    # get_buy_signals closes the connection it is handed; the fixture owns this one and needs
    # it alive for teardown, so close() is neutralised rather than the function changed.
    shim = type("ConnShim", (), {
        "execute": lambda _s, *a, **k: pg_conn.execute(*a, **k),
        "close": lambda _s: None,
    })()
    monkeypatch.setattr(sql_tool, "_connect", lambda *a, **k: shim)
    return pg_conn


def _symbols(**kw):
    return [r["symbol"] for r in sql_tool.get_buy_signals(**kw)]


def test_bullish_rows_are_included(signals):
    """signal_type 'Bullish' is the dominant source's spelling of a buy."""
    assert "BULLNULL" in _symbols()


def test_null_confidence_rows_are_included(signals):
    """A source that emits no confidence must not vanish from 'active signals'."""
    assert "BUYNULL" in _symbols()


def test_high_scale_confidence_is_not_a_free_pass(signals):
    """40.0 on the 0-100 scale is 40%, below the 65% default -- it must be filtered out."""
    assert "AILOW" not in _symbols()


def test_bearish_rows_stay_excluded(signals):
    """Control: matching 'Bullish' must not widen into returning every signal."""
    assert "BEARISH" not in _symbols()


def test_scored_rows_outrank_unknown_confidence(signals):
    """NULLs sort highest on a Postgres DESC -- unknown confidence must not lead the list."""
    assert _symbols()[0] == "SCORED"


def test_confidence_is_reported_on_one_scale(signals):
    """0.90 stored on the 0-1 scale is surfaced to the caller as 90, not 0.9."""
    scored = [r for r in sql_tool.get_buy_signals() if r["symbol"] == "SCORED"][0]
    assert scored["confidence"] == pytest.approx(90.0)
