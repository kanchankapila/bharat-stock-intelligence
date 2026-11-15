"""AF-20261112-12: scripts/repair/repair_tej_truth.py corrects stock_ohlcv bars whose level differs from
raw bhavcopy x TEJ's exact split/bonus factors by a clean ratio, for NAMED symbols only. The pure
functions are tested without a database; one test runs the real harness on a throwaway schema."""
import importlib.util
import math
import os
import sys
from datetime import date, timedelta

import pytest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))


def _load():
    sys.path.insert(0, os.path.join(REPO, 'scripts', 'repair'))
    path = os.path.join(REPO, 'scripts', 'repair', 'repair_tej_truth.py')
    spec = importlib.util.spec_from_file_location('repair_tej_truth', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


D = [date(2026, 1, 1) + timedelta(days=i) for i in range(70)]
EX = D[40]                      # corporate action: bars 0-39 are old basis in the raw series
LAST = D[-1]


def _raw(f):
    """Raw bhavcopy: the price level steps by 1/f on the ex-date (f < 1 split/bonus, f > 1 consolidation)."""
    return {d: (100.0 / f if i < 40 else 100.0) for i, d in enumerate(D)}


def _series(closes):
    return [(d, c, c, c, c, 1000) for d, c in zip(D, closes)]


def test_tej_factors_bonus_split_dedupe_and_unratioed_actions():
    m = _load()
    acts = [
        {"type": "bonus", "ex_date": "2026-06-04", "ratio_num": 1, "ratio_den": 2, "exchange": "NSE"},
        {"type": "bonus", "ex_date": "2026-06-04", "ratio_num": 1, "ratio_den": 2, "exchange": "BSE"},   # duplicate
        {"type": "split", "ex_date": "2016-09-12", "face_value_from": 10, "face_value_to": 1},
        {"type": "bonus", "ex_date": "2023-06-05", "ratio_num": 1, "ratio_den": 3},                     # same day as the split
        {"type": "split", "ex_date": "2023-06-05", "face_value_from": 10, "face_value_to": 1},
        {"type": "bonus", "ex_date": "2025-08-25"},                                                      # no ratio: non-equity bonus
        {"type": "dividend", "ex_date": "2026-01-01", "cash_amount": 5},
        {"type": "agm", "ex_date": "2026-02-01"},
    ]
    f = dict(m.tej_factors(acts))
    assert math.isclose(f[date(2026, 6, 4)], 2 / 3)
    assert math.isclose(f[date(2023, 6, 5)], 0.075)
    assert date(2025, 8, 25) not in f and date(2026, 1, 1) not in f and date(2026, 2, 1) not in f


def test_missing_consolidation_is_multiplied_in():
    m = _load()                                            # CCAVENUE: 10:1 consolidation, old bars never adjusted
    raw = _raw(10.0)
    mult, rep = m.plan_symbol(_series([raw[d] for d in D]), raw, [(EX, 10.0)], [], LAST)
    assert sorted(mult) == D[:40] and all(math.isclose(v, 10.0) for v in mult.values())
    assert rep['segments'][0]['bars'] == 40


def test_wrong_stored_factor_is_corrected_by_the_ratio():
    m = _load()                                            # NARMADA: applied 0.5556, the exact bonus is 0.5
    raw = _raw(0.5)
    prod = [raw[d] * 0.5556 if i < 40 else raw[d] for i, d in enumerate(D)]
    mult, _ = m.plan_symbol(_series(prod), raw, [(EX, 0.5)], [(EX, 0.5556)], LAST)
    assert sorted(mult) == D[:40] and all(math.isclose(v, 0.5 / 0.5556) for v in mult.values())


def test_double_application_is_undone():
    m = _load()                                            # TRENT: the 2/3 factor applied twice
    f = 2 / 3
    raw = _raw(f)
    prod = [raw[d] * f * f if i < 40 else raw[d] for i, d in enumerate(D)]
    mult, _ = m.plan_symbol(_series(prod), raw, [(EX, f)], [(EX, f)], LAST)
    assert sorted(mult) == D[:40] and all(math.isclose(v, 1 / f) for v in mult.values())


def test_correct_series_and_dividend_sized_gaps_are_left_alone():
    m = _load()
    f = 0.5
    raw = _raw(f)
    right = [raw[d] * f if i < 40 else raw[d] for i, d in enumerate(D)]
    assert m.plan_symbol(_series(right), raw, [(EX, f)], [(EX, f)], LAST)[0] == {}
    div = [c * 0.953 for c in right]                       # ITC-style 4.7% non-split basis difference
    assert m.plan_symbol(_series(div), raw, [(EX, f)], [(EX, f)], LAST)[0] == {}


def test_a_step_under_five_percent_is_never_applied_even_with_a_candidate_for_it():
    m = _load()                                            # stored 0.5155 vs TEJ 0.5 gives a 0.97 candidate: dividend-sized
    raw = _raw(0.5)
    prod = [raw[d] * 0.5155 if i < 40 else raw[d] for i, d in enumerate(D)]
    assert m.plan_symbol(_series(prod), raw, [(EX, 0.5)], [(EX, 0.5155)], LAST)[0] == {}


def test_future_ex_date_is_never_applied():
    m = _load()                                            # INTERARCH/SPAL: split announced, not yet effective
    raw = {d: 100.0 for d in D}
    mult, _ = m.plan_symbol(_series([100.0] * len(D)), raw, [(LAST + timedelta(days=9), 0.2)], [], LAST)
    assert mult == {}


def test_short_segments_and_bars_without_raw_are_untouched():
    m = _load()
    raw = _raw(10.0)
    prod = [raw[d] for d in D]
    short = {d: raw[d] for d in D[:15]} | {d: raw[d] for d in D[40:]}       # only 15 verifiable old bars
    assert m.plan_symbol(_series(prod), short, [(EX, 10.0)], [], LAST)[0] == {}
    no_raw = {d: raw[d] for d in D[40:]}
    assert m.plan_symbol(_series(prod), no_raw, [(EX, 10.0)], [], LAST)[0] == {}


def test_a_segment_must_be_contiguous_not_scattered_matches():
    m = _load()
    raw = _raw(10.0)
    prod = [raw[d] if i % 2 == 0 else raw[d] * 10 for i, d in enumerate(D[:40])] + [raw[d] for d in D[40:]]
    mult, _ = m.plan_symbol(_series(prod), raw, [(EX, 10.0)], [], LAST)
    assert mult == {}                                      # alternating bars never form a run of MIN_BARS


L = [date(2026, 1, 1) + timedelta(days=i) for i in range(140)]         # long series: both sides of a gap stay real segments
EXL, LASTL = L[110], L[-1]


def _long_case():
    raw = {d: (10.0 if i < 110 else 100.0) for i, d in enumerate(L)}   # 10:1 consolidation on L[110], prod unadjusted
    return raw, [raw[d] for d in L]


def _lseries(closes):
    return [(d, c, c, c, c, 1000) for d, c in zip(L, closes)]


def test_a_hole_inside_a_corrected_segment_is_bridged_not_left_as_a_fake_seam():
    m = _load()
    raw, prod = _long_case()
    no_raw = {d: c for d, c in raw.items() if d not in L[40:44]}               # four bars with no raw close
    mult, rep = m.plan_symbol(_lseries(prod), no_raw, [(EXL, 10.0)], [], LASTL)
    assert sorted(mult) == L[:110] and rep['bridged'] == 4
    glitch = dict(raw)
    glitch.update({L[40]: raw[L[40]] * 1.07, L[41]: raw[L[41]] * 0.93})        # raw present but matches nothing
    assert sorted(m.plan_symbol(_lseries(prod), glitch, [(EXL, 10.0)], [], LASTL)[0]) == L[:110]


def test_bridging_never_crosses_a_verified_fine_bar_a_seam_or_a_long_gap():
    m = _load()
    raw, prod = _long_case()
    fine = list(prod)
    fine[50] = raw[L[50]] * 10                                                 # one bar already adjusted, verifiable
    mult, _ = m.plan_symbol(_lseries(fine), raw, [(EXL, 10.0)], [], LASTL)
    assert L[50] not in mult and L[49] in mult and L[51] in mult               # never multiplied twice
    small_raw = {d: (10.0 if i < 110 else 12.5) for i, d in enumerate(L)}      # a 1.25 step passes the seam check, so
    small = [small_raw[d] for d in L]                                          # only the verified-bar guard can stop this
    small[50] = small_raw[L[50]] * 1.25
    mult_s, _ = m.plan_symbol(_lseries(small), small_raw, [(EXL, 1.25)], [], LASTL)
    assert L[50] not in mult_s and L[49] in mult_s and L[51] in mult_s
    seam = list(prod)
    for i in range(40, 44):
        seam[i] = raw[L[i]] * 10                                               # unverifiable bars already on the new basis
    no_raw = {d: c for d, c in raw.items() if d not in L[40:44]}
    mult2, _ = m.plan_symbol(_lseries(seam), no_raw, [(EXL, 10.0)], [], LASTL)
    assert L[39] in mult2 and not set(L[40:44]) & set(mult2)                   # a x10 step inside the gap: do not bridge
    long_gap = {d: c for d, c in raw.items() if d not in L[40:60]}             # 20 unverifiable bars > BRIDGE_MAX
    mult3, rep3 = m.plan_symbol(_lseries(prod), long_gap, [(EXL, 10.0)], [], LASTL)
    assert mult3 == {} and rep3['review'] == [L[40], L[60]]                    # an unbridged hole would leave two fake steps


def test_unverifiable_bars_before_the_first_verified_one_are_extended_by_continuity():
    m = _load()                                            # SIKKO: raw coverage starts after the first prod bars
    raw, prod = _long_case()
    no_raw = {d: c for d, c in raw.items() if d not in L[:8]}
    mult, rep = m.plan_symbol(_lseries(prod), no_raw, [(EXL, 10.0)], [], LASTL)
    assert sorted(mult) == L[:110] and rep['bridged'] == 8
    stepped = list(prod)
    for i in range(8):
        stepped[i] = raw[L[i]] * 4                         # a 4x step before the first verified bar: another basis
    mult2, _ = m.plan_symbol(_lseries(stepped), no_raw, [(EXL, 10.0)], [], LASTL)
    assert not set(L[:8]) & set(mult2) and L[8] in mult2


def test_unverifiable_bars_after_the_last_verified_one_stop_at_a_price_step_and_the_ex_date():
    m = _load()
    raw, prod = _long_case()
    no_raw = {d: c for d, c in raw.items() if d not in L[100:110]}          # last 10 old bars unverifiable
    mult, rep = m.plan_symbol(_lseries(prod), no_raw, [(EXL, 10.0)], [], LASTL)
    assert sorted(mult) == L[:110] and rep['bridged'] == 10               # continuous with the run: still old basis
    seam = list(prod)
    for i in range(104, 110):
        seam[i] = raw[L[i]] * 10                           # CCAVENUE: bars after the last verified one already on the new basis
    mult2, _ = m.plan_symbol(_lseries(seam), no_raw, [(EXL, 10.0)], [], LASTL)
    assert L[99] in mult2 and not set(L[104:110]) & set(mult2)
    assert not set(L[110:]) & set(mult)                                    # the ex-date and later are never corrected
    flat = list(prod)
    for i in range(110, 113):
        flat[i] = 10.0                                    # three unverifiable bars past the ex-date that look continuous
    gap_past_ex = {d: c for d, c in raw.items() if d not in L[104:113]}
    mult3, rep3 = m.plan_symbol(_lseries(flat), gap_past_ex, [(EXL, 10.0)], [], LASTL)
    assert not set(L[110:113]) & set(mult3)                                # extension never crosses the ex-date ...
    assert mult3 == {} and rep3['review'] == [L[110]]                      # ... and the step it would leave blocks the symbol (L[113]'s already existed)


def test_a_plan_that_would_create_a_new_price_step_is_refused_for_review():
    m = _load()                                            # SIKKO: a 1:1 SME-board action on 2021-03-18 that TEJ does not list
    raw = {d: (20.0 if i < 30 else 10.0 if i < 110 else 5.0) for i, d in enumerate(L)}
    prod = [10.0] * 110 + [5.0] * 30                       # continuous before the repair
    mult, rep = m.plan_symbol(_lseries(prod), raw, [(EXL, 0.5)], [], LASTL)
    assert mult == {} and rep['review'] == [L[30]]          # correcting 30..109 alone would step 10 -> 5 at L[30]


def test_raw_lookup_uses_any_series_prefers_eq_and_follows_an_explicit_alias(pg_conn):
    m = _load()                                            # SHRADHA trades BE for months; CCAVENUE was INFIBEAM
    pg_conn.execute("CREATE TABLE nse_universe_history (symbol TEXT, date DATE, series TEXT, close FLOAT8)")
    rows = [('NEW', D[0], 'EQ', 11.0), ('NEW', D[1], 'BE', 12.0), ('NEW', D[2], 'EQ', 13.0), ('NEW', D[2], 'BE', 99.0),
            ('OLD', D[2], 'EQ', 77.0), ('OLD', D[3], 'EQ', 14.0), ('OTHER', D[4], 'EQ', 55.0), ('NEW', D[5], 'EQ', 0.0)]
    for r in rows:
        pg_conn.execute("INSERT INTO nse_universe_history VALUES (?,?,?,?)", r)
    pg_conn.commit()
    got = m.raw_closes(pg_conn, 'NEW', ['OLD'])
    assert got == {D[0]: 11.0, D[1]: 12.0, D[2]: 13.0, D[3]: 14.0}     # BE used, EQ beats BE, NEW beats OLD, 0 dropped
    assert m.raw_closes(pg_conn, 'NEW', []) == {D[0]: 11.0, D[1]: 12.0, D[2]: 13.0}


@pytest.fixture
def dump(tmp_path):
    p = tmp_path / 'stock_ohlcv.dump'
    p.write_bytes(b'PGDMP\x01\x0e\x00' + b'\x00' * 64)
    return str(p)


def test_apply_end_to_end_is_exact_and_idempotent(pg_conn, dump, monkeypatch):
    m = _load()
    pg_conn.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, open FLOAT8, high FLOAT8, "
                    "low FLOAT8, close FLOAT8, volume BIGINT, is_suspect BIGINT DEFAULT 0)")
    pg_conn.execute("CREATE TABLE nse_universe_history (symbol TEXT, date DATE, series TEXT, close FLOAT8)")
    pg_conn.execute("CREATE TABLE ohlcv_adjustment_factors (symbol TEXT, ex_date DATE, factor REAL, source TEXT)")
    raw = _raw(10.0)
    for sym in ('CONS', 'FINE'):
        for d in D:
            c = raw[d] if sym == 'CONS' else 100.0
            pg_conn.execute("INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)",
                            (sym, d, c, c * 1.01, c * 0.99, c, 1000))
            pg_conn.execute("INSERT INTO nse_universe_history VALUES (?,?,?,?)", (sym, d, 'EQ', raw[d] if sym == 'CONS' else 100.0))
    pg_conn.commit()
    monkeypatch.setattr(m, 'fetch_actions', lambda s: {"data": [
        {"type": "split", "ex_date": EX.isoformat(), "face_value_from": 1, "face_value_to": 10}] if s == 'CONS' else []})
    assert m.main(['--symbols', 'CONS,FINE', '--apply', '--dump-path', dump], conn=pg_conn) == 0
    rows = pg_conn.execute("SELECT date, close, volume FROM stock_ohlcv WHERE symbol='CONS' ORDER BY date").fetchall()
    assert [round(r[1], 6) for r in rows] == [100.0] * 70            # old bars 10 x 10: continuous across the ex-date
    assert [r[2] for r in rows] == [100] * 40 + [1000] * 30          # volume / 10 on the corrected bars only
    assert {r[0] for r in pg_conn.execute("SELECT close FROM stock_ohlcv WHERE symbol='FINE'").fetchall()} == {100.0}
    assert m.main(['--symbols', 'CONS,FINE', '--apply', '--dump-path', dump], conn=pg_conn) == 0
    again = pg_conn.execute("SELECT close, volume FROM stock_ohlcv WHERE symbol='CONS' ORDER BY date").fetchall()
    assert [round(r[0], 6) for r in again] == [100.0] * 70 and [r[1] for r in again] == [100] * 40 + [1000] * 30
