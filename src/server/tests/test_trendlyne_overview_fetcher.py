import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import trendlyne_overview_fetcher as tof


def test_extract_company_description_reads_the_field():
    body = {"companyProfileData": {"companyDescription": "Bharat Electronics Limited manufactures..."}}
    assert tof.extract_company_description(body) == "Bharat Electronics Limited manufactures..."


def test_extract_company_description_returns_none_when_missing():
    assert tof.extract_company_description({}) is None
    assert tof.extract_company_description({"companyProfileData": {}}) is None


def test_extract_profile_data_includes_shareholding_qoq_changes():
    def chart(*values):
        return {"annualChartData": [{"value": v} for v in values]}

    body = {
        "financialsData": {
            "annualDataDump": {
                "shareholdingMetrics": {
                    "PROMPCT": chart(51.0, 50.5),
                    "FIIHOLD": chart(19.5, 18.0),
                    "MFHOLD": chart(14.2, 15.0),
                    "PROMPLEDGE": chart(0.0, 2.0),
                }
            },
            "quarterlyDataDump": {},
        }
    }

    profile = tof.extract_profile_data(body)

    assert profile["promoter_pct"] == 51.0
    assert profile["promoter_chg_qoq"] == 0.5
    assert profile["fii_chg_qoq"] == 1.5
    assert profile["mf_chg_qoq"] == -0.8
    assert profile["pledge_chg_qoq"] == -2.0


def test_extract_profile_data_reads_shareholding_as_of_from_period_end():
    def chart(*rows):
        return {"annualChartData": [{"value": v, "yearStrTrim": d} for v, d in rows]}

    body = {
        "financialsData": {
            "annualDataDump": {
                "shareholdingMetrics": {
                    "PROMPCT": chart((51.0, "2026-03-31"), (50.5, "2025-03-31")),
                    "FIIHOLD": chart((19.5, "2025-12-31"), (18.0, "2025-09-30")),
                    "MFHOLD": chart((14.2, "2026-03-31"), (15.0, "2025-03-31")),
                    "PROMPLEDGE": chart((0.0, "2026-03-31"), (2.0, "2025-03-31")),
                }
            },
            "quarterlyDataDump": {},
        }
    }

    profile = tof.extract_profile_data(body)
    assert profile["shareholding_as_of"] == "2026-03-31"  # latest period end across series


def test_sh_floor_lags_the_period_end_and_defaults_to_today():
    from datetime import date

    assert tof._sh_floor("2026-03-31") == "2026-04-30"      # +30 days
    assert tof._sh_floor(None) == date.today().isoformat()  # unknown → confine to today
    assert tof._sh_floor("garbage") == date.today().isoformat()


def test_backfill_technical_signals_is_point_in_time():
    con = sqlite3.connect(":memory:")
    try:
        con.execute("CREATE TABLE technical_signals (symbol TEXT, date TEXT)")
        tof.ensure_schema(con)
        con.execute("INSERT INTO technical_signals (symbol, date) VALUES ('BEL','2026-01-15')")  # pre-disclosure
        con.execute("INSERT INTO technical_signals (symbol, date) VALUES ('BEL','2026-05-15')")  # post-disclosure
        con.commit()

        profile = {
            "promoter_pct": 51.0, "fii_pct": 19.5, "mf_pct": 14.2, "pledge_pct": 0.0,
            "promoter_chg_qoq": 0.5, "fii_chg_qoq": 1.5, "mf_chg_qoq": -0.8, "pledge_chg_qoq": -2.0,
            "shareholding_as_of": "2026-03-31",  # floor → 2026-04-30
        }
        tof.backfill_technical_signals("BEL", profile, con)

        old = con.execute(
            "SELECT promoter_pct, mf_pct, promoter_chg_qoq FROM technical_signals WHERE date='2026-01-15'"
        ).fetchone()
        new = con.execute(
            "SELECT promoter_pct, mf_pct, promoter_chg_qoq FROM technical_signals WHERE date='2026-05-15'"
        ).fetchone()

        assert old == (None, None, None)      # look-ahead blocked on the pre-disclosure row
        assert new == (51.0, 14.2, 0.5)       # stamped on the post-disclosure row
    finally:
        con.close()


def test_upsert_profile_persists_shareholding_changes():
    con = sqlite3.connect(":memory:")
    try:
        con.execute("CREATE TABLE technical_signals (symbol TEXT)")
        tof.ensure_schema(con)
        profile = {
            "promoter_pct": 51.0,
            "fii_pct": 19.5,
            "mf_pct": 14.2,
            "pledge_pct": 0.0,
            "promoter_chg_qoq": 0.5,
            "fii_chg_qoq": 1.5,
            "mf_chg_qoq": -0.8,
            "pledge_chg_qoq": -2.0,
        }

        tof.upsert_profile("BEL", "2026-07-12", profile, con)

        row = con.execute("""
            SELECT promoter_chg_qoq, fii_chg_qoq, mf_chg_qoq, pledge_chg_qoq
            FROM trendlyne_stock_profile
            WHERE symbol = ?
        """, ("BEL",)).fetchone()
        assert row == (0.5, 1.5, -0.8, -2.0)
    finally:
        con.close()
