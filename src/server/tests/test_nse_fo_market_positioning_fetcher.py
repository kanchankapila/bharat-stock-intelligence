"""nse_fo_market_positioning_fetcher parsing, against payloads captured live 2026-11-19 (AF-20261119-19).

The fixtures are the exchange's own files: participant OI for 19-Nov-2026 and 03-Jan-2022 (the older
title format 'Jan 03,2022' and tab-padded header cells), participant volume for 18-Nov-2026, and the ban
list published for trade date 20-Nov-2026.
"""
import datetime as dt
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from nse_filings_common import NseFetchError  # noqa: E402
from nse_fo_market_positioning_fetcher import (  # noqa: E402
    PARTICIPANTS, VALUE_COLS, parse_ban, parse_participant,
)

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "nse_fo_positioning")


def _read(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return f.read()


@pytest.mark.parametrize("name,kind,day", [
    ("fao_participant_oi_19112026.csv", "oi", dt.date(2026, 11, 19)),
    ("fao_participant_oi_03012022.csv", "oi", dt.date(2022, 1, 3)),
    ("fao_participant_vol_18112026.csv", "vol", dt.date(2026, 11, 18)),
])
def test_participant_file_parses_to_five_rows_that_sum_to_total(name, kind, day):
    rows = parse_participant(_read(name), kind, day)
    by = {r["client_type"]: r for r in rows}
    assert set(by) == set(PARTICIPANTS)
    assert all(r["trade_date"] == day and r["kind"] == kind for r in rows)
    for col in VALUE_COLS:
        parts = [by[p][col] for p in ("CLIENT", "DII", "FII", "PRO")]
        assert all(isinstance(v, float) for v in parts), col
        # NSE's own TOTAL row can differ from the participant sum by a contract (19-Nov-2026
        # opt_idx_call_long: 4,768,557 vs 4,768,556), so this checks alignment, not exactness.
        assert abs(sum(parts) - by["TOTAL"][col]) <= 2, col


def test_known_values_land_in_the_right_columns():
    by = {r["client_type"]: r for r in parse_participant(
        _read("fao_participant_oi_19112026.csv"), "oi", dt.date(2026, 11, 19))}
    assert by["FII"]["fut_idx_long"] == 73516 and by["FII"]["fut_idx_short"] == 141763
    assert by["DII"]["fut_stk_short"] == 4335347
    assert by["TOTAL"]["total_long"] == by["TOTAL"]["total_short"] == 26390953


def test_a_file_for_another_session_is_refused():
    with pytest.raises(NseFetchError, match="file is for 2026-11-19"):
        parse_participant(_read("fao_participant_oi_19112026.csv"), "oi", dt.date(2026, 11, 18))


def test_an_html_page_is_refused_not_stored_as_empty():
    with pytest.raises(NseFetchError):
        parse_participant("<!DOCTYPE html><html><body>Not found</body></html>\n<p>x</p>\n<p>y</p>", "oi",
                          dt.date(2026, 11, 19))


def test_ban_list_uses_the_files_trade_date_and_drops_unknown_symbols():
    trade_date, kept, unknown = parse_ban(_read("fo_secban_20112026.csv"), {"KAYNES", "RELIANCE"})
    assert trade_date == dt.date(2026, 11, 20)
    assert kept == ["KAYNES"] and unknown == []
    _, kept, unknown = parse_ban(_read("fo_secban_20112026.csv"), {"RELIANCE"})
    assert kept == [] and unknown == ["KAYNES"]


def test_an_empty_ban_day_is_a_date_with_no_symbols():
    trade_date, kept, unknown = parse_ban("Securities in Ban For Trade Date 21-NOV-2026: NIL\n", {"KAYNES"})
    assert trade_date == dt.date(2026, 11, 21) and kept == [] and unknown == []


def test_a_ban_page_without_a_trade_date_is_refused():
    with pytest.raises(NseFetchError):
        parse_ban("<html>maintenance</html>", {"KAYNES"})
