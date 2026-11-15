"""AF-20261112-12: scripts/repair/repair_factor_rows.py cleans ohlcv_adjustment_factors from the reviewed TEJ plus
raw-price arbitration (research/out/tej-corporate-actions-validation-2026-11-15/tej_raw_arbiter.csv). decide() is
pure; one test runs the real harness on a throwaway schema."""
import csv
import importlib.util
import os
import sys

import pytest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))


def _load():
    sys.path.insert(0, os.path.join(REPO, 'scripts', 'repair'))
    path = os.path.join(REPO, 'scripts', 'repair', 'repair_factor_rows.py')
    spec = importlib.util.spec_from_file_location('repair_factor_rows', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _row(arbiter, our=0.5, tej=None):
    return {'symbol': 'S', 'ex_date': '2026-03-05', 'our_factor': our, 'arbiter': arbiter, 'tej_factor': tej}


def test_decide_deletes_spurious_rows_only_while_the_stored_row_is_unchanged():
    m = _load()
    stored = (0.5, 'mc_corporate_action')
    assert m.decide(_row('SPURIOUS_NO_JUMP'), stored, False) == ('delete', None)
    assert m.decide(_row('NO_JUMP_NON_EQUITY_OR_SPURIOUS'), stored, False) == ('delete', None)
    assert m.decide(_row('SPURIOUS_NO_JUMP'), (0.4, 'mc_corporate_action'), False)[0] == 'skip'      # changed since review
    assert m.decide(_row('SPURIOUS_NO_JUMP'), None, False)[0] == 'skip'                              # already gone


def test_decide_band_rows_need_to_be_price_derived_and_undeclared_by_any_source():
    m = _load()
    assert m.decide(_row('CIRCUIT_BAND_ARTIFACT', 1.2), (1.2, 'bhavcopy_prev_close'), False) == ('delete', None)
    assert m.decide(_row('CIRCUIT_BAND_ARTIFACT', 1.2), (1.2, 'mc_corporate_action'), False)[0] == 'skip'   # MoneyControl declared it
    assert m.decide(_row('CIRCUIT_BAND_ARTIFACT', 1.2), (1.2, 'bhavcopy_prev_close'), True)[0] == 'skip'    # a declaration sits nearby


def test_decide_updates_to_the_confirmed_value_with_the_new_source():
    m = _load()
    assert m.decide(_row('TEJ_RIGHT', 0.5, 0.25), (0.5, 'mc_corporate_action'), False) == ('update', 0.25)
    assert m.decide(_row('BOTH_PLAUSIBLE', 0.7778, 0.75), (0.7778, 'bhavcopy_prev_close'), False) == ('update', 0.75)
    assert m.decide(_row('TEJ_RIGHT', 0.5, None), (0.5, 'mc_corporate_action'), False)[0] == 'skip'      # no confirmed value
    assert m.decide(_row('NEITHER', 0.5, 0.25), (0.5, 'mc_corporate_action'), False)[0] == 'skip'        # unresolved
    assert m.decide(_row('NO_RAW_BARS', 0.5), (0.5, 'mc_corporate_action'), False)[0] == 'skip'          # nothing to judge by


@pytest.fixture
def dump(tmp_path):
    p = tmp_path / 'factors.dump'
    p.write_bytes(b'PGDMP\x01\x0e\x00' + b'\x00' * 64)
    return str(p)


def test_apply_end_to_end_is_exact_and_idempotent(pg_conn, dump, tmp_path, capsys):
    m = _load()
    pg_conn.execute("CREATE TABLE ohlcv_adjustment_factors (symbol TEXT NOT NULL, ex_date TEXT NOT NULL, factor REAL NOT NULL, "
                    "source TEXT DEFAULT 'bhavcopy_prev_close', PRIMARY KEY (symbol, ex_date))")
    pg_conn.execute("CREATE TABLE corporate_actions (symbol TEXT, ex_date TEXT, action_type TEXT)")
    for r in [('SPUR', '2026-03-05', 0.1, 'mc_corporate_action'), ('WRONG', '2026-03-05', 0.5, 'mc_corporate_action'),
              ('BAND', '2026-03-05', 1.2, 'bhavcopy_prev_close'), ('DECL', '2026-03-05', 1.2, 'bhavcopy_prev_close'),
              ('KEEP', '2026-03-05', 0.5, 'bhavcopy_prev_close')]:
        pg_conn.execute("INSERT INTO ohlcv_adjustment_factors VALUES (?,?,?,?)", r)
    pg_conn.execute("INSERT INTO corporate_actions VALUES ('DECL', '2026-03-06', 'BONUS')")
    pg_conn.commit()
    csv_path = tmp_path / 'arb.csv'
    with open(csv_path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['symbol', 'ex_date', 'our_factor', 'tej_verdict', 'tej_factor', 'raw_jump_nearest_ours', 'arbiter'])
        w.writerows([['SPUR', '2026-03-05', 0.1, 'NO_TEJ_ACTION', '', 0.98, 'SPURIOUS_NO_JUMP'],
                     ['WRONG', '2026-03-05', 0.5, 'MISMATCH', 0.25, 0.27, 'TEJ_RIGHT'],
                     ['BAND', '2026-03-05', 1.2, 'NO_TEJ_ACTION', '', 1.2, 'CIRCUIT_BAND_ARTIFACT'],
                     ['DECL', '2026-03-05', 1.2, 'NO_TEJ_ACTION', '', 1.2, 'CIRCUIT_BAND_ARTIFACT'],
                     ['GONE', '2026-03-05', 0.2, 'NO_TEJ_ACTION', '', 1.0, 'SPURIOUS_NO_JUMP']])
    args = ['--decisions', str(csv_path), '--insert', 'NEW:2026-10-19:10:tej_action', '--apply', '--dump-path', dump]
    assert m.main(args, conn=pg_conn) == 0
    rows = {(r[0]): (round(r[2], 4), r[3]) for r in pg_conn.execute(
        "SELECT symbol, ex_date, factor, source FROM ohlcv_adjustment_factors").fetchall()}
    assert 'SPUR' not in rows and 'BAND' not in rows                                  # deleted
    assert rows['WRONG'] == (0.25, 'tej_action')                                      # corrected, now protected from scan()
    assert rows['DECL'] == (1.2, 'bhavcopy_prev_close') and rows['KEEP'] == (0.5, 'bhavcopy_prev_close')
    assert rows['NEW'] == (10.0, 'tej_action')
    before = sorted(rows.items())
    assert m.main(args, conn=pg_conn) == 0
    after = {(r[0]): (round(r[2], 4), r[3]) for r in pg_conn.execute(
        "SELECT symbol, ex_date, factor, source FROM ohlcv_adjustment_factors").fetchall()}
    assert sorted(after.items()) == before
    capsys.readouterr()
    assert m.main([a for a in args if a not in ('--apply', '--dump-path', dump)], conn=pg_conn) == 0
    out = capsys.readouterr().out
    assert '0 delete, 0 update' in out and 'would insert 0' in out     # a second dry-run finds nothing to do
    pg_conn.execute("UPDATE ohlcv_adjustment_factors SET factor = 7.0 WHERE symbol = 'NEW'")
    pg_conn.commit()
    assert m.main(args, conn=pg_conn) == 0
    assert pg_conn.execute("SELECT factor FROM ohlcv_adjustment_factors WHERE symbol = 'NEW'").fetchone()[0] == 7.0   # insert never overwrites
