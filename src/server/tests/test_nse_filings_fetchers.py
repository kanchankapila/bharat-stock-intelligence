"""Unit tests for the three NSE filing backfills (results / PIT / shareholding master) and their
shared client. Fixtures are trimmed copies of real responses recorded 2026-10-08/09; no network.
DB tests run against a throwaway Postgres schema (pg_conn), never production."""
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import nse_filings_common as common  # noqa: E402
import nse_pit_fetcher as pit  # noqa: E402
import nse_results_filings_fetcher as res  # noqa: E402
import nse_shareholding_master_fetcher as shp  # noqa: E402
from nse_filings_common import IST, NseBlocked, NseClient, NseFetchError, SymbolResolver  # noqa: E402

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _load(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return json.load(f)


# Mirrors nse_stocks for the fixture names. VALECHAENG is deliberately absent (delisted), and
# M&MFIN is absent too, to prove unmapped rows are dropped and counted, not guessed.
MASTER = [("SBIN", "INE062A01020"), ("RECLTD", "INE020B01018"), ("CDSL", "INE736A01011"),
          ("KSHITIJPOL", "INE013801027"), ("VTL", "INE825A01020"), ("KOTAKBANK", "INE237A01028"),
          ("EMAMILTD", "INE548C01032"), ("M&M", "INE101A01026"), ("DUPA", "INE999X01011"),
          ("DUPB", "INE999X01011")]


def resolver():
    return SymbolResolver(MASTER)


# ─── shared parsing helpers ─────────────────────────────────────────────────

class TestParsing:
    def test_missing_tokens_are_null_not_zero(self):
        for tok in ("Nil", "-", "", None, "NA", "  "):
            assert common.parse_num(tok) is None
        assert common.parse_num("0") == 0.0
        assert common.parse_num("1,291,500") == 1291500.0
        assert common.parse_num("nan") is None

    def test_timestamps_are_ist_aware(self):
        ts = common.parse_ts("05-Feb-2022 22:37:04")
        assert ts == datetime(2022, 2, 5, 22, 37, 4, tzinfo=IST)
        assert ts.astimezone(timezone.utc).hour == 17
        assert common.parse_ts("21-JUL-2026 15:44:00") == datetime(2026, 7, 21, 15, 44, tzinfo=IST)
        assert common.parse_ts("05-Feb-2022 20:11") == datetime(2022, 2, 5, 20, 11, tzinfo=IST)

    def test_date_only_value_is_not_promoted_to_a_timestamp(self):
        assert common.parse_ts("21-JUL-2026") is None
        assert common.parse_date("30-JUN-2026") == date(2026, 6, 30)

    def test_windows_cover_range_without_gaps(self):
        w = list(common.windows(date(2021, 1, 1), date(2021, 1, 12)))
        assert w == [(date(2021, 1, 1), date(2021, 1, 5)), (date(2021, 1, 6), date(2021, 1, 10)),
                     (date(2021, 1, 11), date(2021, 1, 12))]


class TestSymbolResolver:
    def test_isin_wins_and_survives_a_rename(self):
        assert resolver().resolve("TATAMOTORS-OLD", "INE062A01020") == "SBIN"

    def test_shared_isin_is_not_used_but_exact_symbol_still_resolves(self):
        r = resolver()
        assert r.resolve("DUPA", "INE999X01011") == "DUPA"
        assert r.resolve("UNKNOWN", "INE999X01011") is None

    def test_unmapped_is_counted(self):
        r = resolver()
        assert r.resolve("VALECHAENG", "INE624H01017") is None
        assert sum(r.unmapped.values()) == 1


# ─── NseClient politeness ───────────────────────────────────────────────────

class _Resp:
    def __init__(self, status, body=None):
        self.status_code, self._body = status, body
        self.text = json.dumps(body) if body is not None else "<html>"

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


class _Sess:
    def __init__(self, script):
        self.script, self.urls = list(script), []

    def get(self, url, timeout=None):
        self.urls.append(url)
        return self.script.pop(0)


def _client(script, budget=100):
    sess = _Sess(script)
    sleeps = []
    clock = iter(range(0, 10_000)).__next__
    c = NseClient(budget, 1.5, session_factory=lambda: sess, sleep=sleeps.append, clock=clock)
    return c, sess, sleeps


class TestNseClient:
    def test_stops_after_three_consecutive_blocks(self):
        c, sess, _ = _client([_Resp(403), _Resp(429), _Resp(403), _Resp(200, [])])
        with pytest.raises(NseBlocked):
            c.get_json("u")
        assert len(sess.urls) == 3

    def test_a_success_resets_the_block_counter(self):
        c, sess, _ = _client([_Resp(403), _Resp(200, [1]), _Resp(403), _Resp(403), _Resp(200, [2])])
        assert c.get_json("a") == [1]
        assert c.get_json("b") == [2]

    def test_a_connection_reset_opens_a_fresh_session_before_retrying(self):
        """NSE resets an HTTP/2 connection after ~600 requests (curl 92, stream ~1205): the crawl died at
        2025-02-08 (results) and at ~600 symbols (shareholding). Retrying on the same dead connection can
        never succeed, so a transport error must drop the session and re-warm a new one."""
        class _Dead:
            def get(self, url, timeout=None):
                raise RuntimeError("curl: (92) HTTP/2 stream 1205 reset by server")
        made = []

        def factory():
            made.append(1)
            return _Dead() if len(made) == 1 else _Sess([_Resp(200, [7])])
        c = NseClient(50, 1.5, session_factory=factory, sleep=lambda s: None, clock=iter(range(0, 10_000)).__next__)
        assert c.get_json("u") == [7]
        assert len(made) == 2

    def test_backs_off_exponentially_on_5xx_then_raises(self):
        c, _, sleeps = _client([_Resp(503)] * 4)
        with pytest.raises(NseFetchError):
            c.get_json("u")
        assert [s for s in sleeps if s >= 2.0] == [2.0, 4.0, 8.0]

    def test_budget_counts_the_warmup_and_every_attempt(self):
        c, _, _ = _client([_Resp(200, []), _Resp(200, [])], budget=2)
        c.get_json("a")  # warm-up + 1 GET = 2
        with pytest.raises(common.BudgetExhausted):
            c.get_json("b")

    def test_spacing_is_never_below_one_second(self):
        c = NseClient(10, min_interval=0.1)
        assert c.min_interval == 1.0

    def test_non_json_200_is_not_treated_as_empty(self):
        c, _, _ = _client([_Resp(200, None)] * 4)
        with pytest.raises(NseFetchError):
            c.get_json("u")


# ─── results filings ────────────────────────────────────────────────────────

class TestResultsParser:
    def test_fixture_rows_parse_with_point_in_time_fields(self):
        raw = _load("nse_results_filings_sample.json")
        rows, bad = res.parse_response(raw, resolver())
        assert bad == 1  # VALECHAENG is not in the master
        sbin = sorted((r for r in rows if r["symbol"] == "SBIN"), key=lambda r: r["consolidated"])
        assert [r["consolidated"] for r in sbin] == ["Consolidated", "Non-Consolidated"]
        r = sbin[0]
        assert r["period_end"] == date(2021, 12, 31) and r["period"] == "Quarterly"
        assert r["broadcast_ts"].tzinfo is not None
        assert r["exch_diss_ts"] >= r["broadcast_ts"]
        assert r["xbrl_url"].startswith("https://nsearchives.nseindia.com/")
        assert r["seq_number"]

    def test_negative_control_unkeyable_rows_are_dropped_not_filled(self):
        raw = dict(_load("nse_results_filings_sample.json")[0])
        raw["broadCastDate"] = "-"
        assert res.parse_filing(raw, resolver()) is None
        raw = dict(_load("nse_results_filings_sample.json")[0])
        raw["toDate"] = None
        assert res.parse_filing(raw, resolver()) is None

    def test_error_envelope_is_not_an_empty_window(self):
        with pytest.raises(NseFetchError):
            res.parse_response({"error": "blocked"}, resolver())


def _master_table(conn):
    conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, isin TEXT)")
    for s, i in MASTER:
        conn.execute("INSERT INTO nse_stocks VALUES (?, ?)", (s, i))
    conn.commit()


class TestResultsDb:
    def test_standalone_and_consolidated_coexist_and_upsert_is_idempotent(self, pg_conn):
        res.ensure_schema(pg_conn)
        rows, _ = res.parse_response(_load("nse_results_filings_sample.json"), resolver())
        assert res.upsert(pg_conn, rows) == len(rows)
        res.upsert(pg_conn, rows)
        n = pg_conn.execute("SELECT COUNT(*) FROM nse_results_filings").fetchone()[0]
        assert n == len(rows)
        assert pg_conn.execute(
            "SELECT COUNT(*) FROM nse_results_filings WHERE symbol='SBIN'").fetchone()[0] == 2

    def test_same_broadcast_second_does_not_merge_q4_with_annual_or_standalone_with_consolidated(self, pg_conn):
        # A Q4 result is filed once and listed under BOTH period=Quarterly and period=Annual with the
        # same broadCastDate; a combined standalone+consolidated filing can share a timestamp too.
        res.ensure_schema(pg_conn)
        raw = dict(_load("nse_results_filings_sample.json")[0])
        base = res.parse_filing(raw, resolver())
        annual = dict(base, period="Annual")
        other = dict(base, consolidated="Consolidated" if base["consolidated"] != "Consolidated" else "Non-Consolidated")
        res.upsert(pg_conn, [base, annual, other])
        assert pg_conn.execute("SELECT COUNT(*) FROM nse_results_filings").fetchone()[0] == 3

    def test_a_restatement_with_a_later_broadcast_is_a_new_row(self, pg_conn):
        res.ensure_schema(pg_conn)
        raw = dict(_load("nse_results_filings_sample.json")[0])
        first = res.parse_filing(raw, resolver())
        raw["broadCastDate"] = "20-Mar-2022 10:00:00"
        second = res.parse_filing(raw, resolver())
        res.upsert(pg_conn, [first, second])
        assert pg_conn.execute("SELECT COUNT(*) FROM nse_results_filings").fetchone()[0] == 2

    def test_crawl_stops_on_error_without_advancing_and_resume_overlaps(self, pg_conn):
        res.ensure_schema(pg_conn)
        _master_table(pg_conn)
        sample = _load("nse_results_filings_sample.json")
        c, sess, _ = _client([_Resp(200, sample), _Resp(200, []), _Resp(404)])
        stats = res.crawl(pg_conn, c, date(2022, 2, 1), date(2022, 2, 10))
        assert stats["stop"].startswith("error") and stats["windows"] == 1
        assert "period=Quarterly" in sess.urls[0] and "from_date=01-02-2022" in sess.urls[0]
        start = common.resume_start(pg_conn, "nse_results_filings", "broadcast_ts", date(2021, 1, 1))
        newest = max(r["broadcast_ts"] for r in res.parse_response(sample, resolver())[0])
        assert start == newest.date() - timedelta(days=5)
        assert common.resume_start(pg_conn, "nse_results_filings", "broadcast_ts", date(2022, 3, 1)) == date(2022, 3, 1)


# ─── PIT ────────────────────────────────────────────────────────────────────

class TestPitParser:
    def test_fixture_rows_parse_with_point_in_time_fields(self):
        rows, bad = pit.parse_response(_load("nse_pit_sample.json"), resolver())
        assert bad == 2  # both M&MFIN rows are unmapped in this master
        k = next(r for r in rows if r["symbol"] == "KSHITIJPOL")
        assert k["person_category"] == "Promoters" and k["acq_mode"] == "Market Purchase"
        assert k["transaction_from"] == date(2022, 2, 3) and k["intimation_dt"] == date(2022, 2, 5)
        assert k["dissemination_ts"] == datetime(2022, 2, 5, 20, 11, tzinfo=IST)
        assert k["sec_acq"] == 13998 and k["sec_val"] == 402443

    def test_nil_and_dash_become_null(self):
        rows, _ = pit.parse_response(_load("nse_pit_sample.json"), resolver())
        vtl = next(r for r in rows if r["symbol"] == "VTL")
        assert vtl["after_shares"] is None
        kotak = next(r for r in rows if r["symbol"] == "KOTAKBANK")
        assert kotak["person_category"] is None

    def test_negative_control_rows_without_did_or_ts_are_dropped(self):
        raw = dict(_load("nse_pit_sample.json")["data"][4])
        raw["date"] = "05-Feb-2022"  # date-only: no timestamp precision -> unkeyable, not midnight
        assert pit.parse_disclosure(raw, resolver()) is None
        raw = dict(_load("nse_pit_sample.json")["data"][4])
        raw["did"] = None
        assert pit.parse_disclosure(raw, resolver()) is None

    def test_payload_without_data_list_raises(self):
        with pytest.raises(NseFetchError):
            pit.parse_response([], resolver())


class TestPitDb:
    def test_identical_natural_fields_with_distinct_did_both_survive(self, pg_conn):
        pit.ensure_schema(pg_conn)
        r = SymbolResolver(MASTER + [("M&MFIN", "INE774D01024")])
        rows, bad = pit.parse_response(_load("nse_pit_sample.json"), r)
        assert bad == 0
        pit.upsert(pg_conn, rows)
        pit.upsert(pg_conn, rows)
        assert pg_conn.execute(
            "SELECT COUNT(*) FROM nse_pit_disclosures WHERE symbol='M&MFIN'").fetchone()[0] == 2
        assert pg_conn.execute("SELECT COUNT(*) FROM nse_pit_disclosures").fetchone()[0] == len(rows)


# ─── shareholding master ────────────────────────────────────────────────────

class TestShareholdingParser:
    def test_twenty_quarters_with_revision_and_broadcast(self):
        rows, bad = shp.parse_response(_load("nse_shareholding_mm_sample.json"), "M&M")
        assert bad == 0 and len(rows) == 20
        q = next(r for r in rows if r["quarter_end"] == date(2026, 3, 31))
        assert q["submission_date"] == date(2026, 4, 16)
        assert q["broadcast_ts"] == datetime(2026, 4, 21, 19, 41, 1, tzinfo=IST)
        assert q["revised"] == "Revised" and q["revision_date"] == date(2026, 4, 21)
        assert q["promoter_pct"] == 18.45 and q["public_pct"] == 78.05
        assert min(r["quarter_end"] for r in rows) == date(2021, 9, 30)

    def test_negative_control_other_company_rows_are_rejected(self):
        rows, bad = shp.parse_response(_load("nse_shareholding_mm_sample.json"), "TCS")
        assert rows == [] and bad == 20

    def test_missing_percent_is_null_not_zero(self):
        raw = dict(_load("nse_shareholding_mm_sample.json")[0])
        raw["pr_and_prgrp"] = "-"
        assert shp.parse_quarter(raw, "M&M")["promoter_pct"] is None


class TestShareholdingDb:
    def test_upsert_idempotent_and_resume_skips_symbols_present(self, pg_conn):
        shp.ensure_schema(pg_conn)
        rows, _ = shp.parse_response(_load("nse_shareholding_mm_sample.json"), "M&M")
        shp.upsert(pg_conn, rows)
        shp.upsert(pg_conn, rows)
        assert pg_conn.execute("SELECT COUNT(*) FROM nse_shareholding_history").fetchone()[0] == 20

    def test_crawl_url_encodes_symbol(self, pg_conn):
        shp.ensure_schema(pg_conn)
        c, sess, _ = _client([_Resp(200, _load("nse_shareholding_mm_sample.json"))])
        stats = shp.crawl(pg_conn, c, ["M&M"])
        assert sess.urls[0].endswith("symbol=M%26M")
        assert stats["written"] == 20 and stats["stop"] is None


# ─── results: integrated-filing endpoint (successor from 2025-04) ───────────

IF_MASTER = MASTER + [("DONEAR", None), ("TNTELE", None), ("INOXWIND", None)]  # EXPLEOSOL left out


class TestIntegratedFilingParser:
    def test_rows_parse_with_point_in_time_fields_and_marker(self):
        page = _load("nse_integrated_filing_sample.json")["page1"]
        rows, bad = res.parse_integrated_response(page, SymbolResolver(IF_MASTER))
        assert bad == 0 and len(rows) == 3
        d = next(r for r in rows if r["symbol"] == "DONEAR" and r["consolidated"] == "Consolidated")
        assert d["period"] == res.INTEGRATED_PERIOD
        assert d["period_end"] == date(2025, 6, 30)
        assert d["broadcast_ts"] == datetime(2025, 8, 14, 23, 45, 59, tzinfo=IST)
        assert d["seq_number"] == "111829" and d["xbrl_url"].endswith("_WEB.xml")
        assert d["relating_to"] == "Original" and d["audited"] == "Un-Audited"
        assert d["period_start"] is None and d["isin"] is None and d["exch_diss_ts"] is None

    def test_revision_without_broadcast_is_timed_by_its_own_revision_timestamp(self):
        page = _load("nse_integrated_filing_sample.json")["page1"]
        rows, _ = res.parse_integrated_response(page, SymbolResolver(IF_MASTER))
        t = next(r for r in rows if r["symbol"] == "TNTELE")
        assert t["relating_to"] == "Revision"
        assert t["broadcast_ts"] == datetime(2025, 8, 14, 23, 17, 26, tzinfo=IST)

    def test_negative_control_original_without_broadcast_is_dropped(self):
        raw = dict(_load("nse_integrated_filing_sample.json")["page1"]["data"][0])
        raw["broadcast_Date"] = None
        assert res.parse_integrated(raw, SymbolResolver(IF_MASTER)) is None
        raw = dict(_load("nse_integrated_filing_sample.json")["page1"]["data"][0])
        raw["qe_Date"] = "-"
        assert res.parse_integrated(raw, SymbolResolver(IF_MASTER)) is None

    def test_list_payload_is_an_error_not_an_empty_page(self):
        with pytest.raises(NseFetchError):
            res.parse_integrated_response([], SymbolResolver(IF_MASTER))


class TestIntegratedFilingCrawl:
    def test_pages_until_total_count_and_keeps_legacy_rows_apart(self, pg_conn):
        res.ensure_schema(pg_conn)
        pg_conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, isin TEXT)")
        for s, i in IF_MASTER:
            pg_conn.execute("INSERT INTO nse_stocks VALUES (?, ?)", (s, i))
        pg_conn.commit()
        legacy, _ = res.parse_response(_load("nse_results_filings_sample.json"), resolver())
        res.upsert(pg_conn, legacy)
        fx = _load("nse_integrated_filing_sample.json")
        c, sess, _ = _client([_Resp(200, fx["page1"]), _Resp(200, fx["page2"])])
        stats = res.crawl_integrated(pg_conn, c, date(2025, 8, 10), date(2025, 8, 14), page_size=3)
        assert stats["stop"] is None and stats["fetched"] == 5
        assert stats["written"] == 4 and stats["unkeyable"] == 1  # EXPLEOSOL unmapped
        assert "page=1&size=3" in sess.urls[0] and "page=2&size=3" in sess.urls[1]
        assert "from_date=10-08-2025" in sess.urls[0]
        n = pg_conn.execute("SELECT COUNT(*) FROM nse_results_filings WHERE period = ?",
                            (res.INTEGRATED_PERIOD,)).fetchone()[0]
        assert n == 4
        res.crawl_integrated(pg_conn, _client([_Resp(200, fx["page1"]), _Resp(200, fx["page2"])])[0],
                             date(2025, 8, 10), date(2025, 8, 14), page_size=3)
        assert pg_conn.execute("SELECT COUNT(*) FROM nse_results_filings").fetchone()[0] == len(legacy) + 4
        start = common.resume_start(pg_conn, "nse_results_filings", "broadcast_ts", date(2025, 1, 1),
                                    where=f"period = '{res.INTEGRATED_PERIOD}'")
        assert start == date(2025, 8, 14) - timedelta(days=5)

    def test_short_page_before_total_count_stops_instead_of_looping(self, pg_conn):
        res.ensure_schema(pg_conn)
        pg_conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, isin TEXT)")
        pg_conn.commit()
        empty = {"data": [], "size": 3, "page": 1, "totalCount": 5}
        fx = _load("nse_integrated_filing_sample.json")
        c, sess, _ = _client([_Resp(200, fx["page1"]), _Resp(200, empty)])
        stats = res.crawl_integrated(pg_conn, c, date(2025, 8, 10), date(2025, 8, 14), page_size=3)
        assert len(sess.urls) == 2 and stats["stop"].startswith("error")
