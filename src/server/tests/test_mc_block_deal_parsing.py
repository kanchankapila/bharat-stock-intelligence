"""Offline guards for mc_block_deal_history_fetcher's two documented vendor traps.

The `live_datasource` test beside this one is SKIPPED by default (`data-sources.md`: a gated test
is code that does not run, so it rots). These run on every suite and pin the two shapes that
`recurring-bugs.md` says bite repeatedly:

  1. a DISPLAY-format date ("24 Jun, 2026") reaching a date column, and
  2. an enum with two spellings ("purchase" / "Sell") defeating downstream IN/NOT IN.

Both were measured on real vendor payloads on 2026-09-18, not assumed.
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mc_block_deal_history_fetcher as mcbd  # noqa: E402


# Verbatim from a live response for RELIANCE, 2026-09-18.
LIVE_ROW = {
    "datetime": "24 Jun, 2026",
    "title": "The Mtbj Ltd. As Trst For Govrnmnt Pension Invstmnt Fund Mtbj400045828",
    "type": "Sell",
    "quantity": 719579,
    "price": 1309.5,
    "perTraded": "0.01",
}


class TestDateParsing:
    def test_vendor_display_format_parses(self):
        assert mcbd.parse_deal_date("24 Jun, 2026") == datetime.date(2026, 6, 24)

    def test_unparseable_date_returns_none_so_the_caller_can_skip(self):
        """Never store the raw string: a display-format date beside real dates sorts lexically
        and silently poisons every MIN/MAX on the column (the insider_trades trap)."""
        for bad in ("", None, "sometime last June", "2026/06/24 IST", "24-Jun"):
            assert mcbd.parse_deal_date(bad) is None, f"{bad!r} should not parse"

    def test_a_row_with_an_unparseable_date_is_dropped_not_stored_as_text(self):
        rows = mcbd.parse_rows("RELIANCE", [{**LIVE_ROW, "datetime": "garbage"}])
        assert rows == []


class TestTradeTypeNormalisation:
    def test_both_measured_vendor_spellings_normalise(self):
        """Live distribution on 2026-09-18 was exactly {'Sell': 16, 'purchase': 16}."""
        assert mcbd.normalize_trade_type("purchase") == "BUY"
        assert mcbd.normalize_trade_type("Sell") == "SELL"

    def test_casing_does_not_create_a_second_value(self):
        assert {mcbd.normalize_trade_type(v) for v in ("SELL", "sell", "Sell", " Sell ")} == {"SELL"}

    def test_unknown_type_is_skipped_not_guessed(self):
        assert mcbd.normalize_trade_type("transfer") is None
        assert mcbd.parse_rows("RELIANCE", [{**LIVE_ROW, "type": "transfer"}]) == []


class TestNumericBoundary:
    def test_missing_numeric_becomes_none_never_a_zero_sentinel(self):
        """A 0.0 written for 'missing' is invisible to every coverage check."""
        assert mcbd._num(None) is None
        assert mcbd._num("") is None
        assert mcbd._num("n/a") is None
        assert mcbd._num("1,234.5") == 1234.5
        assert mcbd._num("0.01%") == 0.01

    def test_row_missing_qty_or_price_is_dropped(self):
        assert mcbd.parse_rows("RELIANCE", [{**LIVE_ROW, "quantity": None}]) == []
        assert mcbd.parse_rows("RELIANCE", [{**LIVE_ROW, "price": "n/a"}]) == []


class TestParsedRow:
    def test_live_shaped_row_parses_into_a_usable_deal(self):
        (d,) = mcbd.parse_rows("RELIANCE", [LIVE_ROW])
        assert d["symbol"] == "RELIANCE"
        assert d["date"] == "2026-06-24"
        assert d["trade_type"] == "SELL"
        assert d["qty"] == 719579
        assert d["price"] == 1309.5
        assert d["source"] == "moneycontrol"
        assert d["category"] == "block"
        # 719579 * 1309.5 / 1e7
        assert abs(d["value_cr"] - 94.2288) < 0.01

    def test_id_is_a_content_hash_not_a_positional_index(self):
        """The NSE sibling uses `{symbol}_{date}_{i}`; a vendor reorder would duplicate rows."""
        (a,) = mcbd.parse_rows("RELIANCE", [LIVE_ROW])
        (b,) = mcbd.parse_rows("RELIANCE", [LIVE_ROW])
        assert a["id"] == b["id"]
        assert a["id"].startswith("mcbd_")
        # A different deal on the same symbol+date must not collide.
        (c,) = mcbd.parse_rows("RELIANCE", [{**LIVE_ROW, "quantity": 719580}])
        assert c["id"] != a["id"]

    def test_id_is_namespaced_so_it_cannot_collide_with_the_nse_or_tickertape_sources(self):
        (d,) = mcbd.parse_rows("RELIANCE", [LIVE_ROW])
        assert d["id"].startswith("mcbd_"), (
            "block_deals is keyed on a bare `id` shared by three sources; without the prefix "
            "this fetcher could overwrite an NSE or tickertape row"
        )
