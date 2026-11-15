"""AF-20261112-12: ohlcv_adjust.scan persisted every price-derived factor, including circuit-band-range ones
(0.75 to 1.25) that nothing declares (a gap-up day that runs to the +20% limit reads as a 7:6 action), and its
upsert overwrote even factors from authoritative sources with the price-derived approximation. TEJ plus raw
prices found 59 such artifacts and 19 more rows with no price jump; the weekly `ohlcv_adjust --persist` would
have re-created them after any cleanup."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import ohlcv_adjust as oa

BASE = [(f"2026-03-0{i}", 100.0, 100.0, 101.0, 99.0, 100.0) for i in range(1, 5)]


def _series(day):
    """Four flat days, the ex-date row, three days that stay on the new level."""
    level = day[5]
    return BASE + [day] + [(f"2026-03-0{6 + i}", level, level, level + 1, level - 1, level) for i in range(3)]


GAP_UP = ("2026-03-05", 100.0, 118.0, 125.0, 117.0, 121.0)      # whole range above +15%: detected as 1.1667
SPLIT = ("2026-03-05", 100.0, 49.0, 51.0, 48.0, 50.0)           # a real 2:1: detected as 0.5


def _db(conn, sym, rows):
    conn.execute("CREATE TABLE IF NOT EXISTS nse_universe_history (date TEXT, symbol TEXT, series TEXT, prev_close REAL, "
                 "open REAL, high REAL, low REAL, close REAL)")
    conn.execute("CREATE TABLE IF NOT EXISTS corporate_actions (symbol TEXT, ex_date TEXT, action_type TEXT)")
    for r in rows:
        conn.execute("INSERT INTO nse_universe_history VALUES (?,?,?,?,?,?,?,?)", (r[0], sym, "EQ", r[1], r[2], r[3], r[4], r[5]))


def _factors(conn):
    oa.ensure_schema(conn)          # scan() creates the table only when it persists something
    return {(r[0], str(r[1])[:10]): (round(r[2], 4), r[3]) for r in
            conn.execute("SELECT symbol, ex_date, factor, source FROM ohlcv_adjustment_factors").fetchall()}


def test_undeclared_band_factor_is_reported_not_persisted(pg_conn):
    _db(pg_conn, "BAND", _series(GAP_UP))
    res = oa.scan(pg_conn, persist=True)
    assert [(s, d) for s, d, _ in res["band_undeclared"]] == [("BAND", "2026-03-05")]
    assert [(s, d) for s, d, _ in res["accepted"]] == [("BAND", "2026-03-05")]      # still detected, still reported
    assert _factors(pg_conn) == {}


def test_declared_band_factor_and_a_clean_split_are_persisted(pg_conn):
    _db(pg_conn, "DECL", _series(GAP_UP))
    _db(pg_conn, "SPLT", _series(SPLIT))
    pg_conn.execute("INSERT INTO corporate_actions VALUES ('DECL', '2026-03-07', 'BONUS')")     # declared two days off: a record date
    res = oa.scan(pg_conn, persist=True)
    assert res["band_undeclared"] == []
    f = _factors(pg_conn)
    assert f[("DECL", "2026-03-05")][0] == round(7 / 6, 4)
    assert f[("SPLT", "2026-03-05")] == (0.5, "bhavcopy_prev_close")


def test_a_declaration_far_from_the_date_does_not_unlock_a_band_factor(pg_conn):
    _db(pg_conn, "FAR", _series(GAP_UP))
    pg_conn.execute("INSERT INTO corporate_actions VALUES ('FAR', '2026-04-20', 'BONUS')")
    assert [(s, d) for s, d, _ in oa.scan(pg_conn, persist=True)["band_undeclared"]] == [("FAR", "2026-03-05")]
    assert _factors(pg_conn) == {}


def test_a_price_derived_factor_never_overwrites_an_authoritative_row(pg_conn):
    _db(pg_conn, "AUTH", _series(SPLIT))
    _db(pg_conn, "PLAIN", _series(SPLIT))
    oa.ensure_schema(pg_conn)
    pg_conn.execute("INSERT INTO ohlcv_adjustment_factors VALUES ('AUTH', '2026-03-05', 0.4, 'tej_action')")
    pg_conn.execute("INSERT INTO ohlcv_adjustment_factors VALUES ('PLAIN', '2026-03-05', 0.4, 'bhavcopy_prev_close')")
    pg_conn.commit()
    oa.scan(pg_conn, persist=True)
    f = _factors(pg_conn)
    assert f[("AUTH", "2026-03-05")] == (0.4, "tej_action")                          # kept
    assert f[("PLAIN", "2026-03-05")][0] == 0.5                                      # a price-derived row is still refreshed


def test_a_listing_day_is_not_a_split(pg_conn):
    """On an IPO's first session prev_close is the ISSUE price: 25 -> 40 reads as a 1.6 consolidation. The table starts
    2021-01-01, so a symbol whose first row is later was listed then and has no earlier bar for a factor to adjust."""
    _db(pg_conn, "OLD", BASE + [("2026-03-05", 100.0, 100.0, 101.0, 99.0, 100.0)])
    ipo = [("2026-03-05", 25.0, 40.0, 48.0, 37.2, 48.0)] + [(f"2026-03-0{6 + i}", 48.0, 48.0, 49.0, 47.0, 48.0) for i in range(3)]   # UTKARSHBNK 2023-07-21
    _db(pg_conn, "IPO", ipo)
    _db(pg_conn, "SPLT", _series(SPLIT))                                              # first row 03-01, seam on 03-05: still a split
    _db(pg_conn, "STRT", [("2026-03-01", 100.0, 49.0, 51.0, 48.0, 50.0)] + [(f"2026-03-0{2 + i}", 50.0, 50.0, 51.0, 49.0, 50.0) for i in range(3)])
    res = oa.scan(pg_conn, persist=True)         # STRT: a seam on the table's own first date is not a listing, the data just starts there
    assert ("STRT", "2026-03-01") in [(s, str(d)[:10]) for s, d, _ in res["accepted"]]
    assert ("IPO", "2026-03-05") not in [(s, str(d)[:10]) for s, d, _ in res["accepted"]]
    assert ("SPLT", "2026-03-05") in [(s, str(d)[:10]) for s, d, _ in res["accepted"]]
    assert sorted(k[0] for k in _factors(pg_conn)) == ["SPLT", "STRT"]


# --- cross_validate_with_mc_actions: a MoneyControl action the price never made must not be re-created ----------
def _mc_db(conn, sym, record_date, factor, raw_ratios):
    """raw_ratios: close/prev_close for the days around record_date (None = no raw rows at all)."""
    conn.execute("CREATE TABLE IF NOT EXISTS stock_corporate_action_history (symbol TEXT, action_type TEXT, event_key TEXT, "
                 "announce_date TEXT, record_date TEXT, ratio_text TEXT, ratio_factor REAL, amount REAL, detail TEXT, "
                 "PRIMARY KEY (symbol, action_type, event_key))")
    conn.execute("INSERT INTO stock_corporate_action_history VALUES (?, 'split', 'k1', NULL, ?, '1:10', ?, NULL, NULL)",
                 (sym, record_date, factor))
    oa.ensure_schema(conn)
    if raw_ratios is not None:
        conn.execute("CREATE TABLE IF NOT EXISTS nse_universe_history (date TEXT, symbol TEXT, series TEXT, prev_close REAL, "
                     "open REAL, high REAL, low REAL, close REAL)")
        for i, r in enumerate(raw_ratios):
            conn.execute("INSERT INTO nse_universe_history VALUES (?,?,?,?,?,?,?,?)",
                         (f"2026-11-0{3 + i}", sym, "EQ", 100.0, 100.0, 100.0 * r, 100.0 * r, 100.0 * r))
    conn.commit()


def _rows(conn):
    return conn.execute("SELECT symbol, factor, source FROM ohlcv_adjustment_factors").fetchall()


def test_mc_split_with_no_price_jump_is_reported_filled_but_not_persisted(pg_conn):
    _mc_db(pg_conn, "LAGNAM", "2026-11-05", 0.1, [1.0, 0.99, 1.01, 1.0, 0.98])     # raw continuous across the date
    res = oa.cross_validate_with_mc_actions(pg_conn, persist=True)
    assert len(res["filled"]) == 1 and _rows(pg_conn) == []


def test_mc_split_with_a_price_jump_is_persisted_even_on_a_circuit_day(pg_conn):
    _mc_db(pg_conn, "GOLD", "2026-11-05", 0.5, [1.0, 1.0, 0.6, 1.0, 1.0])           # 0.6 = a 0.5 split plus a 20% circuit move
    res = oa.cross_validate_with_mc_actions(pg_conn, persist=True)
    assert len(res["filled"]) == 1 and [(r[0], round(r[1], 2), r[2]) for r in _rows(pg_conn)] == [("GOLD", 0.5, "mc_corporate_action")]


def test_without_raw_rows_or_for_a_band_factor_the_old_behaviour_stands(pg_conn):
    _mc_db(pg_conn, "NORAW", "2026-11-05", 0.1, None)                                  # no nse_universe_history at all
    oa.cross_validate_with_mc_actions(pg_conn, persist=True)
    assert [r[0] for r in _rows(pg_conn)] == ["NORAW"]
    # 0.76 is inside the band and a no-jump day is 31.6% away from it: only the band exemption lets it through
    _mc_db(pg_conn, "BANDX", "2026-11-05", 0.76, [1.0, 1.0, 1.0, 1.0, 1.0])
    # the raw table now exists for BANDX; GAPSYM has no rows in it, which is no evidence either way
    _mc_db(pg_conn, "GAPSYM", "2026-11-05", 0.1, None)
    oa.cross_validate_with_mc_actions(pg_conn, persist=True)
    assert sorted(r[0] for r in _rows(pg_conn)) == ["BANDX", "GAPSYM", "NORAW"]
