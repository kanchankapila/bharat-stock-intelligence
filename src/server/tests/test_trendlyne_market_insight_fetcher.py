"""Regression tests for trendlyne_market_insight_fetcher.py.

Fixtures shaped from real payloads captured live 2026-08-15 (KPIL order win, Alkem margin
decline).
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import trendlyne_market_insight_fetcher as tmi

UNIVERSE = {"KPIL", "ALKEM"}

REAL_ROW = {
    "notification": "KPIL secures domestic orders worth Rs 3,526 crore in the EPC, T&D & residential buildings biz",
    "timeStamp": "14 Aug, 2026  3:31 PM (IST)", "nColor": "neutral",
    "screenRedirectUrl": "https://trendlyne.com/posts/5791830/kalpataru-projects-international-ltd-522287-announcement-under-regulation-30-lodr-award-of-order-receipt-of-order",
    "label": "Order Win", "stockCode": "KPIL", "stockName": "Kalpataru Projects",
    "url": "https://trendlyne.com/equity/712/KPIL/kalpataru-projects-international-ltd/",
    "completeUrl": "https://trendlyne.com/equity/712/KPIL/kalpataru-projects-international-ltd/",
    "NSEcode": "KPIL", "BSEcode": "522287", "ISIN": "INE220B01022",
}

# A real row shape whose screenRedirectUrl carries no /posts/{id}/ suffix (module docstring:
# 33% of the live sample looks like this) -- confirms the composite key doesn't depend on it.
REAL_ROW_NO_POST_ID = {
    "notification": "Alkem Labs' Q1 EBITDA margin drops 140 bps YoY due to higher input, staff, fin & depreciation costs",
    "timeStamp": "14 Aug, 2026  3:30 PM (IST)", "nColor": "neutral",
    "screenRedirectUrl": "https://trendlyne.com/latest-news/1878/ALKEM/alkem-laboratories-ltd/",
    "label": "Margin Decline", "stockCode": "ALKEM", "stockName": "Alkem Laboratories",
    "url": "https://trendlyne.com/equity/1878/ALKEM/alkem-laboratories-ltd/",
    "completeUrl": "https://trendlyne.com/equity/1878/ALKEM/alkem-laboratories-ltd/",
    "NSEcode": "ALKEM", "BSEcode": "539523", "ISIN": "INE540L01014",
}


class TestParseTimestamp:
    def test_parses_real_double_space_format(self):
        assert tmi._parse_timestamp("14 Aug, 2026  3:31 PM (IST)") == "2026-08-14 15:31:00"

    def test_unparseable_string_returns_none(self):
        assert tmi._parse_timestamp("not a date") is None

    def test_empty_string_returns_none(self):
        assert tmi._parse_timestamp("") is None


class TestParseInsight:
    def test_maps_a_real_row(self):
        r = tmi.parse_insight(REAL_ROW, UNIVERSE)
        assert r["id"] == "trendlyne:KPIL:Order Win:2026-08-14 15:31:00"
        assert r["symbol"] == "KPIL"
        assert r["label"] == "Order Win"
        assert r["event_time"] == "2026-08-14 15:31:00"
        assert r["source"] == "trendlyne"
        assert set(r.keys()) == set(tmi.COLS)

    def test_maps_a_row_with_no_post_id_in_its_url(self):
        """The id is a composite key, not derived from screenRedirectUrl -- must work
        identically whether or not the row's URL carries a /posts/{id}/ suffix."""
        r = tmi.parse_insight(REAL_ROW_NO_POST_ID, UNIVERSE)
        assert r is not None
        assert r["symbol"] == "ALKEM"
        assert r["label"] == "Margin Decline"

    def test_symbol_not_in_universe_is_dropped(self):
        assert tmi.parse_insight({**REAL_ROW, "NSEcode": "NOTREAL"}, UNIVERSE) is None

    def test_missing_label_is_dropped(self):
        assert tmi.parse_insight({**REAL_ROW, "label": ""}, UNIVERSE) is None

    def test_unparseable_timestamp_is_dropped(self):
        assert tmi.parse_insight({**REAL_ROW, "timeStamp": "garbage"}, UNIVERSE) is None

    def test_two_different_events_same_stock_same_minute_get_different_ids(self):
        """Composite key includes label -- two distinct event types for the same stock at the
        same timestamp must not collide."""
        r1 = tmi.parse_insight(REAL_ROW, UNIVERSE)
        r2 = tmi.parse_insight({**REAL_ROW, "label": "Target Upgrade"}, UNIVERSE)
        assert r1["id"] != r2["id"]


class TestSchemaAndStorage:
    def test_ensure_schema_and_upsert_round_trip(self):
        con = sqlite3.connect(":memory:")
        tmi.ensure_schema(con)
        row = tmi.parse_insight(REAL_ROW, UNIVERSE)
        assert tmi.store(con, [row]) == 1
        result = con.execute(
            "SELECT symbol, label, event_time FROM trendlyne_market_insights"
        ).fetchone()
        assert result == ("KPIL", "Order Win", "2026-08-14 15:31:00")

    def test_upsert_is_idempotent(self):
        con = sqlite3.connect(":memory:")
        tmi.ensure_schema(con)
        row = tmi.parse_insight(REAL_ROW, UNIVERSE)
        assert tmi.store(con, [row]) == 1
        assert tmi.store(con, [row]) == 1
        count = con.execute("SELECT COUNT(*) FROM trendlyne_market_insights").fetchone()[0]
        assert count == 1

    def test_store_empty_list_is_a_noop(self):
        con = sqlite3.connect(":memory:")
        tmi.ensure_schema(con)
        assert tmi.store(con, []) == 0
