import datetime as dt

import pytest

from bharat_alpha.ingest.sources.nse_pr import classify_purpose, parse_bc

HEADER = "SERIES,SYMBOL,SECURITY,RECORD_DT,BC_STRT_DT,BC_END_DT,EX_DT,ND_STRT_DT,ND_END_DT,PURPOSE\n"


def bc(rows: list[tuple[str, dt.date, str]]) -> str:
    return HEADER + "".join(f'EQ,{s},X LTD,{d:%d-%b-%Y},,,{d:%d-%b-%Y},,,"{p}"\n' for s, d, p in rows)


@pytest.mark.parametrize("purpose,kind,factor", [
    ("BONUS 1:1", "bonus", 0.5),
    ("BONUS 2:5", "bonus", 5 / 7),
    ("FACE VALUE SPLIT (SUB-DIVISION) - FROM RS 10/- PER SHARE TO RS 2/- PER SHARE", "split", 0.2),
    ("FACE VALUE SPLIT FROM RS.10/- TO RE.1/-", "split", 0.1),
    ("CONSOLIDATION OF SHARES FROM RS 1/- TO RS 10/-", "consolidation", 10.0),
    ("INTERIM DIVIDEND - RS 5 PER SHARE", "dividend", None),
    ("RIGHTS 1:4 @ PREMIUM RS 90/-", "rights", None),
    ("ANNUAL GENERAL MEETING", "other", None),
])
def test_purpose_gives_a_factor_only_when_the_ratio_is_unambiguous(purpose, kind, factor):
    k, f = classify_purpose(purpose)
    assert k == kind and (f == pytest.approx(factor) if factor else f is None)


def test_parse_requires_the_core_columns():
    rows = parse_bc(bc([("ABC", dt.date(2026, 9, 25), "BONUS 1:1")]))
    assert rows[0]["ex_date"] == dt.date(2026, 9, 25) and rows[0]["expected_factor"] == 0.5
    with pytest.raises(ValueError):
        parse_bc("SYMBOL,PURPOSE\nABC,BONUS 1:1\n")


def test_derived_factors_are_checked_against_the_exchange_record(conn):
    from bharat_alpha.db import read_df
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.nse_pr import NsePrBundle
    from bharat_alpha.marketdata import derive_adjustments, flag_suspect_bars
    from bharat_alpha.quality.checks import check_adjustments
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=6, n_days=60, seed=13)
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    flag_suspect_bars(conn)
    derive_adjustments(conn)
    conn.commit()
    split_sym, split_day = sim.events["split"]
    last = sim.dates[-1]
    assert check_adjustments(conn, last)[0].status == "warn"                     # nothing to compare: never a pass

    # the exchange records the planted 2:1 split -> derived factor 0.5 matches
    assert run_connector(conn, NsePrBundle(), split_day,
                         raw=bc([(split_sym, split_day, "FACE VALUE SPLIT FROM RS 10/- TO RS 5/-")]))[0] == "success"
    res = {r.check_id: r for r in check_adjustments(conn, last)}
    assert res["adjustments:vs_exchange"].status == "pass" and res["adjustments:unexplained"].status == "pass"

    # a recorded bonus the price data never adjusted for is a failure, naming it
    other = "SIM003"
    bonus_day = sim.dates[-5]
    run_connector(conn, NsePrBundle(), bonus_day, raw=bc([(other, bonus_day, "BONUS 1:1")]))
    res = {r.check_id: r for r in check_adjustments(conn, last)}
    assert res["adjustments:vs_exchange"].status == "fail" and "no derived factor" in res["adjustments:vs_exchange"].detail
    # and a derived factor the exchange did not record is flagged
    with conn.cursor() as cur:
        cur.execute("DELETE FROM alpha.corporate_event WHERE source='nse_pr_bc' AND event_type='split'")
    assert {r.check_id: r for r in check_adjustments(conn, last)}["adjustments:unexplained"].status == "warn"
    assert len(read_df(conn, "SELECT 1 FROM alpha.adjustment")) >= 1
    # every status must be one alpha.dq_result accepts (a 'skip' here once broke run_checks)
    allowed = set(read_df(conn, """SELECT unnest(regexp_matches(pg_get_constraintdef(oid), '''(\\w+)''', 'g')) s
                                    FROM pg_constraint WHERE conname = 'dq_result_status_check'""").s)
    assert allowed >= {"pass", "warn", "fail"}
    assert {r.status for r in check_adjustments(conn, last)} <= allowed
