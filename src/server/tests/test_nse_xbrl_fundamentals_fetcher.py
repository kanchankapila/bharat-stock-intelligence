"""Unit tests for nse_xbrl_fundamentals_fetcher (first-reported quarterly financials parsed from each
NSE results filing's XBRL). Fixtures are trimmed copies of three real files fetched 2026-10-11; no
network. DB tests run against a throwaway Postgres schema (pg_conn), never production.

  nse_xbrl_infy_integrated_consol_q1fy27.xml   integrated filing, Ind-AS, Q1 (quarter context only)
  nse_xbrl_hdfcbank_legacy_standalone_q1fy24.xml legacy BANKING file whose 'OneD' context is
                                                 referenced by every fact but never declared
  nse_xbrl_tcs_legacy_consol_q2fy24.xml        Q2: quarter ('OneD') + half-year YTD ('FourD', whose
                                                 declared period WRONGLY repeats the quarter) +
                                                 balance sheet ('OneI') + YTD cash flow
"""
import os
import sys
from datetime import date, datetime

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import nse_xbrl_fundamentals_fetcher as xf  # noqa: E402
from nse_filings_common import IST, NseClient  # noqa: E402

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _fx(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return f.read()


INFY = _fx("nse_xbrl_infy_integrated_consol_q1fy27.xml")
HDFC = _fx("nse_xbrl_hdfcbank_legacy_standalone_q1fy24.xml")
TCS = _fx("nse_xbrl_tcs_legacy_consol_q2fy24.xml")


class TestParseXbrl:
    def test_integrated_indas_values_are_rupee_crore(self):
        v = xf.parse_xbrl(INFY, date(2026, 6, 30), True)
        # INFY Q1-FY27 consolidated as filed: revenue Rs 48,211 cr, PAT Rs 7,775 cr.
        assert v["revenue"] == pytest.approx(48211.0)
        assert v["total_income"] == pytest.approx(49195.0)
        assert v["pat"] == pytest.approx(7775.0)
        assert v["pat_owners"] == pytest.approx(7769.0)
        assert v["pbt"] == pytest.approx(11028.0)
        assert v["tax_expense"] == pytest.approx(3253.0)
        assert v["finance_costs"] == pytest.approx(119.0)
        assert v["eps_basic"] == pytest.approx(19.19)  # per share: never scaled
        assert v["period_start"] == date(2026, 4, 1)
        assert v["unit_scale"] == "Crores"

    def test_q1_file_has_no_balance_sheet_cash_flow_or_ytd_so_those_are_null(self):
        v = xf.parse_xbrl(INFY, date(2026, 6, 30), True)
        for k in ("total_assets", "cfo_ytd", "revenue_ytd", "pat_ytd"):
            assert v[k] is None, k

    def test_bank_uses_bank_tags_and_undeclared_context_still_resolves(self):
        v = xf.parse_xbrl(HDFC, date(2023, 6, 30), False)
        # HDFC Bank Q1-FY24 standalone: interest earned 48,586.81 cr, PAT 11,951.77 cr.
        assert v["revenue"] == pytest.approx(48586.81)
        assert v["total_income"] == pytest.approx(57816.67)
        assert v["pat"] == pytest.approx(11951.77)
        assert v["pbt"] == pytest.approx(15911.99)
        assert v["finance_costs"] == pytest.approx(24987.74)  # InterestExpended
        assert v["eps_basic"] == pytest.approx(21.40)

    def test_quarter_is_never_taken_from_the_ytd_context(self):
        v = xf.parse_xbrl(TCS, date(2023, 9, 30), True)
        # Q2-FY24: quarter PAT 11,380 cr; the half-year (FourD) PAT is 22,500 cr.
        assert v["pat"] == pytest.approx(11380.0)
        assert v["revenue"] == pytest.approx(59692.0)
        assert v["pat_ytd"] == pytest.approx(22500.0)
        assert v["revenue_ytd"] == pytest.approx(119073.0)
        assert v["cfo_ytd"] == pytest.approx(22001.0)
        assert v["total_assets"] == pytest.approx(154940.0)
        assert v["period_start"] == date(2023, 7, 1)

    def test_life_insurer_uses_premium_and_insurance_profit_tags(self):
        v = xf.parse_xbrl(_fx("nse_xbrl_canhlife_integrated_standalone_q2fy27.xml"), date(2026, 9, 30), False)
        # CANHLIFE Q2-FY27 standalone, filed in lakhs: net premium 2,553.16 cr, PAT 43.05 cr.
        assert v["revenue"] == pytest.approx(2553.16)
        assert v["pat"] == pytest.approx(43.05)
        assert v["pbt"] == pytest.approx(48.21)
        assert v["unit_scale"] == "Lakhs"

    def test_missing_tag_is_null_and_a_real_zero_stays_zero(self):
        stripped = INFY
        for tag in ("ProfitLossForPeriod",):
            start = stripped.index(f"<in-capmkt:{tag} ")
            end = stripped.index(f"</in-capmkt:{tag}>", start) + len(f"</in-capmkt:{tag}>")
            stripped = stripped[:start] + stripped[end:]
        zeroed = stripped.replace('unitRef="INR">1190000000<', 'unitRef="INR">0<')
        assert zeroed != stripped, "fixture must carry the FinanceCosts value being zeroed"
        v = xf.parse_xbrl(zeroed, date(2026, 6, 30), True)
        assert v["pat"] is None
        assert v["revenue"] == pytest.approx(48211.0)
        assert v["finance_costs"] == 0.0

    def test_dimensional_fact_with_the_same_tag_is_ignored(self):
        decoy = ('<in-capmkt:RevenueFromOperations contextRef="OneReportable1D" decimals="-7" '
                 'unitRef="INR">1</in-capmkt:RevenueFromOperations>')
        i = INFY.index("<in-capmkt:RevenueFromOperations ")
        v = xf.parse_xbrl(INFY[:i] + decoy + INFY[i:], date(2026, 6, 30), True)
        assert v["revenue"] == pytest.approx(48211.0)

    def test_non_inr_monetary_unit_is_rejected_not_rescaled(self):
        usd = INFY.replace("<xbrli:measure>iso4217:INR</xbrli:measure></xbrli:unit>",
                           "<xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>", 1)
        assert usd != INFY
        v = xf.parse_xbrl(usd, date(2026, 6, 30), True)
        assert v["revenue"] is None and v["pat"] is None

    def test_period_end_mismatch_with_the_listing_is_an_error(self):
        with pytest.raises(xf.XbrlParseError) as e:
            xf.parse_xbrl(INFY, date(2026, 3, 31), True)
        assert e.value.reason == "period_mismatch"

    def test_consolidation_mismatch_with_the_listing_is_an_error(self):
        with pytest.raises(xf.XbrlParseError) as e:
            xf.parse_xbrl(INFY, date(2026, 6, 30), False)
        assert e.value.reason == "consolidation_mismatch"

    def test_html_or_garbage_is_not_xbrl(self):
        for body in ("<html><body>Resource not found</body></html>", "", "not xml at all <"):
            with pytest.raises(xf.XbrlParseError) as e:
                xf.parse_xbrl(body, date(2026, 6, 30), True)
            assert e.value.reason == "not_xbrl"

    def test_xbrl_kind_from_file_name(self):
        assert xf.xbrl_kind("https://x/xbrl/INTEGRATED_FILING_BANKING_1_2_WEB.xml") == "bank"
        assert xf.xbrl_kind("https://x/xbrl/BANKING_94218_888372_17072023062652.xml") == "bank"
        assert xf.xbrl_kind("https://x/xbrl/INTEGRATED_FILING_NBFC_INDAS_1_WEB.xml") == "nbfc"
        assert xf.xbrl_kind("https://x/xbrl/INTEGRATED_FILING_LI_1_WEB.xml") == "insurance"
        assert xf.xbrl_kind("https://x/xbrl/INTEGRATED_FILING_GI_1_WEB.xml") == "insurance"
        assert xf.xbrl_kind("https://x/xbrl/NONINDAS_1_2_3.xml") == "nonindas"
        assert xf.xbrl_kind("https://x/xbrl/INDAS_94298_895038_20072023043507.xml") == "indas"


# ─── DB: selection, resume, crawl ───────────────────────────────────────────

def _filings_table(conn, rows):
    conn.execute("""CREATE TABLE nse_results_filings (
        symbol TEXT, period_end DATE, period TEXT, consolidated TEXT, relating_to TEXT,
        broadcast_ts TIMESTAMPTZ, xbrl_url TEXT)""")
    conn.executemany("INSERT INTO nse_results_filings VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
    conn.commit()


def _ts(d, h=18):
    return datetime(d.year, d.month, d.day, h, 0, tzinfo=IST)


Q1 = date(2026, 6, 30)
LISTING = [
    # INFY: standalone + consolidated originals, plus a later consolidated revision
    ("INFY", Q1, "Integrated", "Standalone", "Original", _ts(date(2026, 7, 23), 17), "https://n/xbrl/INFY_SA.xml"),
    ("INFY", Q1, "Integrated", "Consolidated", "Original", _ts(date(2026, 7, 23)), "https://n/xbrl/INFY_C.xml"),
    ("INFY", Q1, "Integrated", "Consolidated", "Revision", _ts(date(2026, 8, 20)), "https://n/xbrl/INFY_C_REV.xml"),
    # SMALLCO: standalone only
    ("SMALLCO", Q1, "Integrated", "Standalone", "Original", _ts(date(2026, 8, 1)), "https://n/xbrl/SMALL.xml"),
    # NOURL: no xbrl link -> never requested
    ("NOURL", Q1, "Integrated", "Consolidated", "Original", _ts(date(2026, 8, 2)), None),
    # out of the window
    ("OLDCO", date(2025, 6, 30), "Integrated", "Consolidated", "Original", _ts(date(2025, 8, 1)), "https://n/xbrl/OLD.xml"),
]


class _Resp:
    def __init__(self, status, text=""):
        self.status_code, self.text = status, text


class _Sess:
    def __init__(self, by_url):
        self.by_url, self.urls = by_url, []

    def get(self, url, timeout=None):
        self.urls.append(url)
        return self.by_url[url]


def _client(by_url, budget=100):
    sess = _Sess(by_url)
    c = NseClient(budget, 1.5, session_factory=lambda: sess, sleep=lambda s: None,
                  clock=iter(range(0, 10_000)).__next__, max_attempts=1)
    return c, sess


class TestSelection:
    def test_only_latest_prefers_consolidated_original_and_skips_missing_urls(self, pg_conn):
        _filings_table(pg_conn, LISTING)
        xf.ensure_schema(pg_conn)
        sel = xf.select_filings(pg_conn, date(2026, 7, 1), date(2026, 9, 30), only_latest=True)
        assert [(f["symbol"], f["xbrl_url"]) for f in sel] == [
            ("INFY", "https://n/xbrl/INFY_C.xml"), ("SMALLCO", "https://n/xbrl/SMALL.xml")]

    def test_without_only_latest_every_filing_in_window_is_selected(self, pg_conn):
        _filings_table(pg_conn, LISTING)
        xf.ensure_schema(pg_conn)
        sel = xf.select_filings(pg_conn, date(2026, 7, 1), date(2026, 9, 30))
        assert len(sel) == 4
        sel = xf.select_filings(pg_conn, date(2025, 1, 1), date(2026, 9, 30), period_end=date(2025, 6, 30))
        assert [f["symbol"] for f in sel] == ["OLDCO"]


class TestCrawl:
    def test_crawl_parses_records_errors_and_resumes_without_refetching(self, pg_conn):
        _filings_table(pg_conn, LISTING)
        xf.ensure_schema(pg_conn)
        sel = xf.select_filings(pg_conn, date(2026, 7, 1), date(2026, 9, 30))
        by_url = {
            "https://n/xbrl/INFY_C.xml": _Resp(200, INFY),
            "https://n/xbrl/INFY_C_REV.xml": _Resp(200, INFY),
            "https://n/xbrl/INFY_SA.xml": _Resp(200, INFY),       # file says Consolidated -> mismatch
            "https://n/xbrl/SMALL.xml": _Resp(404, "nope"),
        }
        c, sess = _client(by_url)
        stats = xf.crawl(pg_conn, c, sel)
        assert stats["stop"] is None
        assert stats["parsed"] == 2 and stats["http_404"] == 1 and stats["consolidation_mismatch"] == 1
        rows = pg_conn.execute(
            "SELECT symbol, consolidated, is_original, pat, parse_error FROM nse_filing_financials "
            "ORDER BY symbol, broadcast_ts").fetchall()
        assert len(rows) == 4
        infy_c = [r for r in rows if r[0] == "INFY" and r[1] and r[2]][0]
        assert float(infy_c[3]) == pytest.approx(7775.0) and infy_c[4] is None
        rev = [r for r in rows if r[0] == "INFY" and r[1] and not r[2]][0]
        assert rev[4] is None  # the revision is recorded, marked not-original
        small = [r for r in rows if r[0] == "SMALLCO"][0]
        assert small[3] is None and small[4] == "http_404"

        # resume: nothing left to fetch, and a second run makes no request
        assert xf.select_filings(pg_conn, date(2026, 7, 1), date(2026, 9, 30)) == []
        n_before = len(sess.urls)
        xf.crawl(pg_conn, c, [])
        assert len(sess.urls) == n_before

    def test_half_year_in_the_quarter_context_is_flagged_not_a_quarter_values_kept(self, pg_conn):
        # Real shape (IRFC/OBEROIRLTY Q2-FY26): 'OneD' declared 01-Apr..30-Sep, half-year figures in it.
        half = INFY.replace(">2026-04-01<", ">2026-01-01<")
        assert half != INFY
        _filings_table(pg_conn, LISTING)
        xf.ensure_schema(pg_conn)
        sel = [f for f in xf.select_filings(pg_conn, date(2026, 7, 1), date(2026, 9, 30), only_latest=True)
               if f["symbol"] == "INFY"]
        c, _ = _client({"https://n/xbrl/INFY_C.xml": _Resp(200, half)})
        stats = xf.crawl(pg_conn, c, sel)
        assert stats["not_a_quarter"] == 1 and stats["parsed"] == 0
        err, pat = pg_conn.execute("SELECT parse_error, pat FROM nse_filing_financials").fetchone()
        assert err == "not_a_quarter" and float(pat) == pytest.approx(7775.0)

    def test_upsert_is_idempotent(self, pg_conn):
        _filings_table(pg_conn, LISTING)
        xf.ensure_schema(pg_conn)
        sel = [f for f in xf.select_filings(pg_conn, date(2026, 7, 1), date(2026, 9, 30), only_latest=True)
               if f["symbol"] == "INFY"]
        c, _ = _client({"https://n/xbrl/INFY_C.xml": _Resp(200, INFY)})
        xf.crawl(pg_conn, c, sel)
        xf.crawl(pg_conn, c, sel)
        assert pg_conn.execute("SELECT COUNT(*) FROM nse_filing_financials").fetchone()[0] == 1

    def test_html_page_is_transient_not_recorded_and_sustained_failures_stop(self, pg_conn):
        _filings_table(pg_conn, LISTING)
        xf.ensure_schema(pg_conn)
        sel = xf.select_filings(pg_conn, date(2026, 7, 1), date(2026, 9, 30))
        html = _Resp(200, "<html>busy</html>")
        c, _ = _client({f["xbrl_url"]: html for f in sel})
        stats = xf.crawl(pg_conn, c, sel, max_consecutive_transient=3)
        assert stats["not_xbrl"] == 3 and stats["stop"].startswith("error")
        assert pg_conn.execute("SELECT COUNT(*) FROM nse_filing_financials").fetchone()[0] == 0

    def test_budget_stop_is_clean(self, pg_conn):
        _filings_table(pg_conn, LISTING)
        xf.ensure_schema(pg_conn)
        sel = xf.select_filings(pg_conn, date(2026, 7, 1), date(2026, 9, 30), only_latest=True)
        c, _ = _client({f["xbrl_url"]: _Resp(200, INFY) for f in sel}, budget=2)  # warm-up + 1 file
        stats = xf.crawl(pg_conn, c, sel)
        assert stats["stop"].startswith("budget") and stats["parsed"] == 1, stats
