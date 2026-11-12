"""The evening grid-ensurer must not keep a same-date row computed from an OLDER bar.

2026-11-12 (AF-20261112-01): the in-session technical scan dated its rows by the wall clock while
reading stored bars, so all 415 scan rows dated 2026-11-11 carried the 2026-11-09 close and
indicators (AUROPHARMA cmp 1855.30; the real close was 1827.50). run_full_universe_today used
ON CONFLICT DO NOTHING, kept every one of them, and the 22:30 ranker and the confluence trade
levels read them as that day's technicals. A row whose cmp differs from the session's final close
was computed from another bar: its indicators and any patterns on it are not valid for the date.

It also wrote computed_at from a timezone-naive datetime.now(), which a timestamptz column on a
UTC server stores 5.5 hours late on an IST host (the 18:50 IST grid read as 00:20).
"""
import os
import sys
from datetime import date, datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _weekdays(end: date, n: int) -> list[date]:
    out, d = [], end
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
    return list(reversed(out))


@pytest.fixture
def seeded(pg_db_conn):
    con = pg_db_conn
    days = _weekdays(date(2026, 1, 30), 40)
    for sym, base in (("AAA", 100.0), ("BBB", 200.0), ("CCC", 300.0)):
        for i, d in enumerate(days):
            c = base + i
            con.execute(
                "INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) "
                "VALUES (?,?,?,?,?,?,?)", (sym, d.isoformat(), c - 0.5, c + 1, c - 1, c, 10000 + i))
    last = days[-1].isoformat()
    # AAA: an in-session scan row for the last date, computed from the PREVIOUS bar.
    con.execute(
        "INSERT INTO technical_signals (symbol, date, signal_score, signals_json, cmp, rsi) "
        "VALUES ('AAA', ?, 7, '[{\"type\":\"BREAKOUT\"}]', ?, 55.0)", (last, 100.0 + 38))
    # BBB: a post-close scan row computed from the final bar: its patterns must survive.
    con.execute(
        "INSERT INTO technical_signals (symbol, date, signal_score, signals_json, cmp, rsi) "
        "VALUES ('BBB', ?, 6, '[{\"type\":\"MACD_CROSS\"}]', ?, 61.0)", (last, 200.0 + 39))
    con.commit()
    return con, last


def _row(con, sym, d):
    return con.execute(
        "SELECT signal_score, signal_type, signals_json, cmp, computed_at FROM technical_signals "
        "WHERE symbol = ? AND date = ?", (sym, d)).fetchone()


def test_stale_bar_row_is_recomputed_from_the_final_bar(seeded):
    import backfill_technical_features as btf
    con, last = seeded
    btf.run_full_universe_today()
    row = _row(con, "AAA", last)
    assert float(row["cmp"]) == pytest.approx(139.0)
    assert row["signal_score"] == 0
    assert row["signal_type"] == "GRID"
    assert row["signals_json"] is None


def test_row_already_on_the_final_bar_keeps_its_patterns(seeded):
    import backfill_technical_features as btf
    con, last = seeded
    btf.run_full_universe_today()
    row = _row(con, "BBB", last)
    assert row["signal_score"] == 6
    assert "MACD_CROSS" in row["signals_json"]


def test_computed_at_is_the_real_instant(seeded):
    # CCC has no pre-existing row, so its stamp is the grid's own (a pre-seeded row would keep
    # its insert-time default and pass vacuously). Discriminates only on a non-UTC host.
    import backfill_technical_features as btf
    con, last = seeded
    btf.run_full_universe_today()
    stamp = _row(con, "CCC", last)["computed_at"]
    stamp = stamp if isinstance(stamp, datetime) else datetime.fromisoformat(str(stamp))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    assert abs((datetime.now(timezone.utc) - stamp).total_seconds()) < 600
