"""AF-20260912-11 negative control.

NSE retired /api/bulk-deals (404 with a "Resource not found" page) and /api/historical/
bulk-deals answers 503 -- verified 2026-09-12 with a warm nseindia cookie jar AND curl_cffi
Chrome TLS impersonation, so it is a retired route, not a bot block. The BULK half of
bulk_block_deals had therefore been frozen since 2026-07-01 while the job still exited 0.
MoneyControl's deals/list carries the same deals; this covers the parser that adapts it.

The load-bearing assertions are the two that DROP a row: MC's payload has no NSE symbol, only
its own opaque sc_id, and `mcsymbol` is not unique in stocklist.json (39 codes map to more
than one symbol, incl. API -> {ASIANPAINT, AGROPHOS}). Resolving an ambiguous code by position
would book a real institutional deal against the wrong company.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import delivery_trend_fetcher as d  # noqa: E402

_ROW = {
    "sc_id": "PJ", "deal_type": "bulk", "deal_date": "2026-09-11",
    "boughtBy": "jump trading financial india private limited", "action": "Buy",
    "quantity": 49999371, "tradedPrice": 13.59, "exchange": "NSE", "dealValue": "67.94",
}


def test_parses_a_real_mc_row_and_resolves_the_nse_symbol():
    got = d._parse_mc_deal(dict(_ROW))
    assert got is not None
    assert got["symbol"] == "PCJEWELLER"      # resolved from sc_id via mcsymbol, never guessed
    assert got["deal_type"] == "bulk"
    assert got["buy_sell"] == "BUY"
    assert got["source"] == "moneycontrol"    # must not collide with NSE rows on the PK
    assert got["deal_date"] == "2026-09-11"


def test_uses_the_rows_own_date_not_today():
    """`date.today()` here would stamp yesterday's deals with today's date on a post-midnight
    run -- the date.today()-as-write-anchor class in recurring-bugs.md."""
    got = d._parse_mc_deal({**_ROW, "deal_date": "2026-09-08"})
    assert got["deal_date"] == "2026-09-08"


def test_ambiguous_sc_id_is_dropped_not_guessed():
    """`mcsymbol` is not unique: API -> {ASIANPAINT, AGROPHOS}, TEL -> {TMPV, TOUCHWOOD}."""
    mapping = d.load_mc_sc_id_map()
    assert "API" not in mapping, "an ambiguous MC code resolved to a single symbol"
    assert "TEL" not in mapping
    assert d._parse_mc_deal({**_ROW, "sc_id": "API"}) is None


def test_unknown_and_non_nse_rows_are_dropped():
    assert d._parse_mc_deal({**_ROW, "sc_id": "ZZZZNOPE"}) is None
    # A BSE row shares the natural key with its NSE twin but carries different numbers.
    assert d._parse_mc_deal({**_ROW, "exchange": "BSE"}) is None


def test_unusable_numbers_are_dropped_never_zero_filled():
    assert d._parse_mc_deal({**_ROW, "quantity": "n/a", "tradedPrice": "n/a",
                             "dealValue": "n/a"}) is None
