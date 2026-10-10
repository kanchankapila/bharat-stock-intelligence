"""Unit tests for nse_bulk_block_fetcher (NSE daily bulk.csv / block.csv archives).

Fixtures are verbatim lines of the real files fetched 2026-10-10 (trade date 09-OCT-2026); no network.
DB tests run in a throwaway Postgres schema (pg_conn), never production."""
import os
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import nse_bulk_block_fetcher as bb  # noqa: E402
from nse_filings_common import NseClient, NseFetchError  # noqa: E402

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
KNOWN = {"ACEVECTOR", "ADROITIND"}  # TFCILTD deliberately absent: must be counted, not guessed


def _read(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return f.read()


BULK = _read("nse_bulk_deals_sample.csv")
BLOCK_EMPTY = _read("nse_block_deals_norecords.csv")
BLOCK_HDR = "Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price\n"


class TestParser:
    def test_real_bulk_rows_parse_typed(self):
        rows, stats = bb.parse_csv(BULK, "bulk", KNOWN)
        assert stats == {"raw": 11, "unmapped": 3, "unkeyable": 0, "empty_file": False}
        assert len(rows) == 8
        r = rows[0]
        assert r["trade_date"] == date(2026, 10, 9)
        assert (r["symbol"], r["buy_sell"], r["quantity"], r["price"]) == ("ACEVECTOR", "BUY", 2362529.0, 30.45)
        assert r["value_cr"] == pytest.approx(2362529 * 30.45 / 1e7, rel=1e-9)
        assert r["deal_type"] == "bulk" and r["source"] == "nse_archive" and r["remarks"] is None
        assert {x["symbol"] for x in rows} == KNOWN

    def test_unmapped_symbols_are_counted_by_name(self):
        _, stats = bb.parse_csv(BULK, "bulk", KNOWN)
        assert stats["unmapped"] == 3
        assert bb.parse_csv(BULK, "bulk", KNOWN | {"TFCILTD"})[1]["unmapped"] == 0

    def test_no_records_block_file_is_a_valid_empty_day(self):
        rows, stats = bb.parse_csv(BLOCK_EMPTY, "block", KNOWN)
        assert rows == [] and stats["empty_file"] is True

    def test_nil_and_dash_quantities_are_null_not_zero(self):
        text = BLOCK_HDR + "09-OCT-2026,ACEVECTOR,AceVector Limited,SOME FUND,BUY,NIL,-\n" \
                           "09-OCT-2026,ACEVECTOR,AceVector Limited,SOME FUND,SELL,0,30.1\n"
        rows, _ = bb.parse_csv(text, "block", KNOWN)
        assert (rows[0]["quantity"], rows[0]["price"], rows[0]["value_cr"]) == (None, None, None)
        assert rows[1]["quantity"] == 0.0 and rows[1]["value_cr"] == 0.0  # a literal 0 stays 0

    def test_side_normalised(self):
        text = BLOCK_HDR + "09-OCT-2026,ACEVECTOR,A,C1,buy,1,1\n09-OCT-2026,ACEVECTOR,A,C1,S,1,1\n" \
                           "09-OCT-2026,ACEVECTOR,A,C1,??,1,1\n"
        rows, _ = bb.parse_csv(text, "block", KNOWN)
        assert [r["buy_sell"] for r in rows] == ["BUY", "SELL", None]

    def test_rows_without_date_or_client_are_unkeyable(self):
        text = BLOCK_HDR + "garbage,ACEVECTOR,A,C1,BUY,1,1\n09-OCT-2026,ACEVECTOR,A,-,BUY,1,1\n"
        rows, stats = bb.parse_csv(text, "block", KNOWN)
        assert rows == [] and stats["unkeyable"] == 2

    def test_html_or_reshaped_body_is_an_error_not_an_empty_day(self):
        with pytest.raises(NseFetchError):
            bb.parse_csv("<html><body>Access Denied</body></html>", "bulk", KNOWN)
        with pytest.raises(NseFetchError):
            bb.parse_csv("Date,Symbol,Qty\n09-OCT-2026,ACEVECTOR,1\n", "bulk", KNOWN)

    def test_dedupe_key_keeps_one_clients_buy_and_sell_apart(self):
        """The real file has JUMP TRADING both BUY and SELL ACEVECTOR on 09-Oct. bulk_block_deals'
        key (source, symbol, deal_date, client_name, deal_type) would collapse them into one row."""
        rows, _ = bb.parse_csv(BULK, "bulk", KNOWN)
        keys = {bb.row_key(r) for r in rows}
        assert len(keys) == len(rows) == 8
        old_key = {(r["symbol"], r["trade_date"], r["client_name"], r["deal_type"]) for r in rows}
        assert len(old_key) == 4  # negative control: the narrower key loses half the day


class TestStore:
    def test_upsert_is_idempotent_and_keeps_both_sides(self, pg_conn):
        bb.ensure_schema(pg_conn)
        rows, _ = bb.parse_csv(BULK, "bulk", KNOWN)
        assert bb.upsert(pg_conn, rows) == 8
        bb.upsert(pg_conn, rows)
        assert pg_conn.execute(f"SELECT COUNT(*) FROM {bb.TABLE}").fetchone()[0] == 8
        sides = pg_conn.execute(f"SELECT buy_sell FROM {bb.TABLE} WHERE symbol='ACEVECTOR' "
                                "AND client_name LIKE 'JUMP%' ORDER BY buy_sell").fetchall()
        assert [s[0] for s in sides] == ["BUY", "SELL"]

    def test_null_quantity_rows_are_idempotent_too(self, pg_conn):
        bb.ensure_schema(pg_conn)
        rows, _ = bb.parse_csv(BLOCK_HDR + "09-OCT-2026,ACEVECTOR,A,FUND,BUY,NIL,-\n", "block", KNOWN)
        bb.upsert(pg_conn, rows)
        bb.upsert(pg_conn, rows)
        got = pg_conn.execute(f"SELECT COUNT(*), MAX(quantity) FROM {bb.TABLE}").fetchone()
        assert (got[0], got[1]) == (1, None)

    def test_bulk_and_block_coexist_for_the_same_trade(self, pg_conn):
        bb.ensure_schema(pg_conn)
        line = "09-OCT-2026,ACEVECTOR,A,FUND,BUY,10,2\n"
        bb.upsert(pg_conn, bb.parse_csv(BLOCK_HDR + line, "block", KNOWN)[0])
        bb.upsert(pg_conn, bb.parse_csv(BLOCK_HDR + line, "bulk", KNOWN)[0])
        assert pg_conn.execute(f"SELECT COUNT(*) FROM {bb.TABLE}").fetchone()[0] == 2

    def test_known_symbols_come_from_master_and_traded_universe(self, pg_conn):
        pg_conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY)")
        pg_conn.execute("CREATE TABLE nse_universe_history (date DATE, symbol TEXT)")
        pg_conn.execute("INSERT INTO nse_stocks VALUES ('ACEVECTOR')")
        pg_conn.execute("INSERT INTO nse_universe_history VALUES (CURRENT_DATE - 3, 'ADROITIND'), "
                        "(CURRENT_DATE - 400, 'OLDNAME')")
        pg_conn.commit()
        assert bb.load_known_symbols(pg_conn) == {"ACEVECTOR", "ADROITIND"}


class _Resp:
    def __init__(self, status, text):
        self.status_code, self.text = status, text


class _Sess:
    def __init__(self, script):
        self.script, self.urls = list(script), []

    def get(self, url, timeout=None):
        self.urls.append(url)
        return self.script.pop(0)


class TestRun:
    def _client(self, script):
        sess = _Sess(script)
        return NseClient(10, 1.0, session_factory=lambda: sess, sleep=lambda s: None,
                         clock=iter(range(0, 10_000)).__next__), sess

    def test_run_writes_both_files_and_reports(self, pg_conn):
        bb.ensure_schema(pg_conn)
        c, sess = self._client([_Resp(200, BULK), _Resp(200, BLOCK_EMPTY)])
        stats = bb.run(pg_conn, c, KNOWN)
        assert sess.urls == [bb.URL.format(kind="bulk"), bb.URL.format(kind="block")]
        assert stats["bulk"]["written"] == 8 and stats["block"]["written"] == 0
        assert stats["bulk"]["trade_dates"] == ["2026-10-09"] and stats["stop"] is None

    def test_a_404_stops_the_run_as_an_error(self, pg_conn):
        bb.ensure_schema(pg_conn)
        c, _ = self._client([_Resp(404, "<html>")])
        stats = bb.run(pg_conn, c, KNOWN)
        assert stats["stop"].startswith("error") and stats["bulk"]["written"] == 0
