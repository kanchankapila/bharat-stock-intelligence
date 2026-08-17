#!/usr/bin/env python3
"""
Trendlyne Overview Fetcher â€” Events + Fundamental Profile
=========================================================
Two calls per stock (weekly):

  overview-second-part  â†’ analyst broker targets, board meetings, dividends
  fundamental-profile   â†’ annual financials, ratios, shareholding, quarterly data

ML features produced:
  analyst_upside_pct    consensus target upside vs latest price (%)
  analyst_count         number of distinct broker reports (last 365d)
  analyst_buy_pct       fraction of recent reports that are BUY (0-100)
  roe_annual            Return on Equity % (latest annual)
  roce_annual           Return on Capital Employed % (latest annual)
  ebitda_margin         EBITDA margin % (latest annual)
  np_margin             Net profit margin % (latest annual)
  promoter_pct          Promoter holding % (latest quarter)
  fii_pct               FII holding % (latest quarter)
  pledge_pct            Promoter pledge % (risk signal)
  rev_growth_yoy_q      Revenue YoY growth % (latest quarter, REV4Q_Q field)
  np_growth_yoy_q       Net profit YoY growth % (latest quarter)
  days_since_dividend   Calendar days since most recent ex-dividend date
  last_dividend_amt     Most recent dividend per share (â‚¹)

Endpoints:
  https://trendlyne.com/equity/overview-second-part/{tlid}/?format=json
  https://trendlyne.com/equity/chart/fundamental-profile/{tlid}/?format=json
  ?format=json required â€” DRF returns HTML without it.

Run:
  python trendlyne_overview_fetcher.py           # all stocks with tlid
  python trendlyne_overview_fetcher.py --symbol BEL
"""

import argparse
import hashlib
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta

import requests

from db_compat import connect
from fetch_utils import filter_numeric_tlids, TRENDLYNE_MAX_CONCURRENT, cap_to_run_budget
from as_of import logical_write_floor

OVERVIEW_URL = "https://trendlyne.com/equity/overview-second-part/{tlid}/"
PROFILE_URL  = "https://trendlyne.com/equity/chart/fundamental-profile/{tlid}/"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Referer": "https://trendlyne.com/",
}

RATE_LIMIT_SEC = 0.5
# Was 15 -- AWS WAF returns 405/captcha for the rest of the run when more than 3
# requests are in flight at once. Measured, see TRENDLYNE_MAX_CONCURRENT in fetch_utils.py.
BATCH_SIZE = TRENDLYNE_MAX_CONCURRENT
BATCH_GAP_SEC  = 0.5

# SEBI LODR Reg 31: the shareholding pattern is filed within 21 days of each period end.
# Use 30 to stay safely on the late side so a disclosure never back-fills onto rows that
# predate it (same anti-look-ahead discipline as the MF + ET_Stats fetchers).
SHAREHOLDING_DISCLOSURE_LAG_DAYS = 30


# â”€â”€ Schema â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def ensure_schema(con) -> None:
    cur = con.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_analyst_targets (
            symbol      TEXT NOT NULL,
            reco_date   TEXT NOT NULL,
            broker      TEXT NOT NULL,
            target_price REAL,
            reco_price   REAL,
            rating       TEXT,
            fetched_at   TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, reco_date, broker)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_tlat_sym ON trendlyne_analyst_targets(symbol, reco_date DESC)
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_stock_profile (
            symbol          TEXT NOT NULL,
            date            TEXT NOT NULL,
            company_description TEXT,
            -- P&L annual
            np_annual       REAL,
            ebitda_annual   REAL,
            revenue_annual  REAL,
            eps_annual      REAL,
            ebitda_margin   REAL,
            np_margin       REAL,
            cfo_annual      REAL,
            -- Ratios
            roe             REAL,
            roce            REAL,
            ltde_ratio      REAL,
            current_ratio   REAL,
            -- Shareholding
            promoter_pct    REAL,
            fii_pct         REAL,
            mf_pct          REAL,
            pledge_pct      REAL,
            promoter_chg_qoq REAL,
            fii_chg_qoq      REAL,
            mf_chg_qoq       REAL,
            pledge_chg_qoq   REAL,
            -- CAGR
            rev_cagr_5y     REAL,
            np_cagr_5y      REAL,
            -- Quarterly
            rev_growth_yoy_q REAL,
            np_growth_yoy_q  REAL,
            -- Analyst consensus
            analyst_target_mean REAL,
            analyst_count       INTEGER,
            analyst_buy_pct     REAL,
            analyst_upside_pct  REAL,
            -- Dividends
            last_dividend_amt   REAL,
            last_ex_date        TEXT,
            days_since_dividend INTEGER,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    con.commit()

    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN analyst_upside_pct REAL",
        "ALTER TABLE technical_signals ADD COLUMN analyst_count INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN analyst_buy_pct REAL",
        "ALTER TABLE technical_signals ADD COLUMN roe_annual REAL",
        "ALTER TABLE technical_signals ADD COLUMN roce_annual REAL",
        "ALTER TABLE technical_signals ADD COLUMN ebitda_margin REAL",
        "ALTER TABLE technical_signals ADD COLUMN np_margin REAL",
        "ALTER TABLE technical_signals ADD COLUMN promoter_pct REAL",
        "ALTER TABLE technical_signals ADD COLUMN fii_pct REAL",
        "ALTER TABLE technical_signals ADD COLUMN mf_pct REAL",
        "ALTER TABLE technical_signals ADD COLUMN pledge_pct REAL",
        "ALTER TABLE technical_signals ADD COLUMN promoter_chg_qoq REAL",
        "ALTER TABLE technical_signals ADD COLUMN fii_chg_qoq REAL",
        "ALTER TABLE technical_signals ADD COLUMN mf_chg_qoq REAL",
        "ALTER TABLE technical_signals ADD COLUMN pledge_chg_qoq REAL",
        "ALTER TABLE technical_signals ADD COLUMN rev_growth_yoy_q REAL",
        "ALTER TABLE technical_signals ADD COLUMN np_growth_yoy_q REAL",
        "ALTER TABLE technical_signals ADD COLUMN days_since_dividend INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN last_dividend_amt REAL",
        "ALTER TABLE trendlyne_stock_profile ADD COLUMN company_description TEXT",
        "ALTER TABLE trendlyne_stock_profile ADD COLUMN promoter_chg_qoq REAL",
        "ALTER TABLE trendlyne_stock_profile ADD COLUMN fii_chg_qoq REAL",
        "ALTER TABLE trendlyne_stock_profile ADD COLUMN mf_chg_qoq REAL",
        "ALTER TABLE trendlyne_stock_profile ADD COLUMN pledge_chg_qoq REAL",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# â”€â”€ Fetch helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _fetch(url: str, session: requests.Session) -> dict | None:
    try:
        r = session.get(url, params={"format": "json"}, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json()
        body = data.get("body") if isinstance(data, dict) else None
        return body
    except Exception as e:
        print(f"  fetch error {url}: {e}")
        return None


# â”€â”€ Extraction helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _latest(chart_data: list, key: str = "value") -> float | None:
    for row in chart_data or []:
        v = row.get(key)
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                continue
    return None


def _change(chart_data: list, periods: int = 1, key: str = "value") -> float | None:
    vals = []
    for row in chart_data or []:
        v = _safe(row.get(key))
        if v is not None:
            vals.append(v)
    if len(vals) <= periods:
        return None
    return round(vals[0] - vals[periods], 4)


def _period_end(chart_data: list) -> str | None:
    """Most-recent period-end ISO date (yearStrTrim/quarterStrTrim) from a chart series."""
    for row in chart_data or []:
        raw = row.get("yearStrTrim") or row.get("quarterStrTrim")
        if raw:
            try:
                return date.fromisoformat(str(raw)[:10]).isoformat()
            except ValueError:
                continue
    return None


def _sh_floor(as_of_date: str | None, fallback: str | None = None) -> str:
    """First date on which a shareholding disclosure was public. Rows older than this must
    not receive the snapshot (look-ahead). Defaults to `fallback` when the period end is
    unknown, which confines the stamp to the current row only — conservative, never leaky.
    `fallback` must be the last completed trading session, not date.today(): this job runs
    daily including weekends (company-profiles-sync), and a bare date.today() floor on a
    non-trading day matches zero existing technical_signals rows, silently dropping the value."""
    try:
        d = date.fromisoformat(as_of_date) if as_of_date else None
    except ValueError:
        d = None
    if d:
        return (d + timedelta(days=SHAREHOLDING_DISCLOSURE_LAG_DAYS)).isoformat()
    return fallback if fallback else date.today().isoformat()


def _cagr(chart_data: list, n: int = 5) -> float | None:
    if not chart_data or len(chart_data) <= n:
        return None
    latest = chart_data[0].get("value")
    prior  = chart_data[n].get("value")
    if not latest or not prior or prior == 0:
        return None
    try:
        return round(((float(latest) / float(prior)) ** (1.0 / n) - 1) * 100, 2)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _q(chart_data: list, key: str = "value") -> float | None:
    for row in chart_data or []:
        v = row.get(key)
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                continue
    return None


def _safe(v) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# â”€â”€ Extract analyst data from overview-second-part â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def extract_analyst_data(body: dict, symbol: str, today: str, con) -> dict:
    reports = body.get("researchReports", {}).get("tableData", [])
    cutoff  = date.today().replace(year=date.today().year - 1).isoformat()
    recent  = [r for r in reports if isinstance(r, dict) and r.get("recoDate", "") >= cutoff]

    # Persist all reports. `con` is None when called from a worker thread (see main()'s
    # comment: DB writes must happen on the main thread with a real connection) -- this used
    # to call con.cursor() unconditionally, crashing _fetch_one (and the whole batch, since
    # nothing catches the exception from fut.result()) for every stock with >=1 recent analyst
    # report -- i.e. almost every actively-covered stock. That silently prevented this function
    # from ever returning its extracted dict, which is what feeds analyst_upside_pct/
    # analyst_count/analyst_buy_pct into backfill_technical_signals downstream.
    if recent and con is not None:
        cur = con.cursor()
        for r in recent:
            try:
                cur.execute("""
                    INSERT INTO trendlyne_analyst_targets
                        (symbol, reco_date, broker, target_price, reco_price, rating)
                    VALUES (?,?,?,?,?,?)
                    ON CONFLICT(symbol, reco_date, broker) DO UPDATE SET
                        target_price = excluded.target_price,
                        reco_price   = excluded.reco_price,
                        rating       = excluded.rating,
                        fetched_at   = CURRENT_TIMESTAMP
                """, (
                    symbol,
                    r.get("recoDate", today),
                    r.get("postAuthor", ""),
                    _safe(r.get("targetPrice")),
                    _safe(r.get("recoPrice")),
                    r.get("rec", ""),
                ))
            except Exception:
                pass
        con.commit()

    if not recent:
        return {}

    targets = [_safe(r.get("targetPrice")) for r in recent if r.get("targetPrice")]
    targets = [t for t in targets if t and t > 0]
    target_mean = round(sum(targets) / len(targets), 2) if targets else None

    buy_count = sum(1 for r in recent if str(r.get("rec", "")).upper() in ("BUY", "STRONG BUY", "OUTPERFORM", "OVERWEIGHT"))
    buy_pct   = round(buy_count / len(recent) * 100, 1) if recent else None

    # Use most recent reco_price as proxy for CMP
    reco_prices = [_safe(r.get("recoPrice")) for r in recent if r.get("recoPrice")]
    cmp_proxy   = reco_prices[0] if reco_prices else None
    upside = None
    if target_mean and cmp_proxy and cmp_proxy > 0:
        upside = round((target_mean / cmp_proxy - 1) * 100, 2)

    return {
        "analyst_target_mean": target_mean,
        "analyst_count":       len(recent),
        "analyst_buy_pct":     buy_pct,
        "analyst_upside_pct":  upside,
    }


def extract_event_data(body: dict) -> dict:
    events = body.get("eventsData", {})

    # Dividends
    divs = events.get("dividendTableData", [])
    last_div_amt  = None
    last_ex_date  = None
    days_since_div = None
    if divs and isinstance(divs[0], dict):
        last_div_amt = _safe(divs[0].get("dividendAmount"))
        raw_date     = divs[0].get("exDate")
        if raw_date:
            last_ex_date = raw_date
            try:
                ex_dt = datetime.strptime(raw_date, "%Y-%m-%d").date()
                days_since_div = (date.today() - ex_dt).days
            except ValueError:
                pass

    return {
        "last_dividend_amt":   last_div_amt,
        "last_ex_date":        last_ex_date,
        "days_since_dividend": days_since_div,
    }


def extract_company_description(body: dict) -> str | None:
    return body.get("companyProfileData", {}).get("companyDescription") or None


# â”€â”€ Extract fundamental-profile data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def extract_profile_data(body: dict) -> dict:
    try:
        fd = body.get("financialsData", {})
    except AttributeError:
        return {}

    ann = fd.get("annualDataDump", {})
    qrt = fd.get("quarterlyDataDump", {})
    fin = ann.get("financials", {})
    rat = ann.get("financialsRatio", {})
    sha = ann.get("shareholdingMetrics", {})

    def ac(key_path: list) -> list:
        obj = ann
        for k in key_path:
            obj = obj.get(k, {}) if isinstance(obj, dict) else {}
        return obj.get("annualChartData", []) if isinstance(obj, dict) else []

    def qc(key_path: list) -> list:
        obj = qrt
        for k in key_path:
            obj = obj.get(k, {}) if isinstance(obj, dict) else {}
        return obj.get("qtrChartData", []) if isinstance(obj, dict) else []

    promoter_hist = ac(["shareholdingMetrics", "PROMPCT"])
    fii_hist = ac(["shareholdingMetrics", "FIIHOLD"])
    mf_hist = ac(["shareholdingMetrics", "MFHOLD"])
    pledge_hist = ac(["shareholdingMetrics", "PROMPLEDGE"])

    return {
        # Annual P&L
        "np_annual":     _latest(ac(["financials", "NP_A"])),
        "ebitda_annual": _latest(ac(["financials", "EBIDT_A"])),
        "revenue_annual": _latest(ac(["financials", "SR_A"])),
        "eps_annual":    _latest(ac(["financials", "EPS_adj_A"])),
        "ebitda_margin": _latest(ac(["financials", "PBDITMargin_A"])),
        "np_margin":     _latest(ac(["financials", "NETPCT_A"])),
        "cfo_annual":    _latest(ac(["financials", "CFO_A"])),
        # Ratios
        "roe":           _latest(ac(["financialsRatio", "ROE_A"])),
        "roce":          _latest(ac(["financialsRatio", "ROCE_A"])),
        "ltde_ratio":    _latest(ac(["financialsRatio", "LTDE_A"])),
        "current_ratio": _latest(ac(["financialsRatio", "CRATIO_A"])),
        # Shareholding
        "promoter_pct": _latest(promoter_hist),
        "fii_pct":      _latest(fii_hist),
        "mf_pct":       _latest(mf_hist),
        "pledge_pct":   _latest(pledge_hist),
        "promoter_chg_qoq": _change(promoter_hist),
        "fii_chg_qoq":      _change(fii_hist),
        "mf_chg_qoq":       _change(mf_hist),
        "pledge_chg_qoq":   _change(pledge_hist),
        # Latest period end across the shareholding series → drives the point-in-time floor.
        "shareholding_as_of": max(
            (p for p in (_period_end(promoter_hist), _period_end(fii_hist),
                         _period_end(mf_hist), _period_end(pledge_hist)) if p),
            default=None,
        ),
        # CAGR
        "rev_cagr_5y": _cagr(ac(["financials", "SR_A"]), n=5),
        "np_cagr_5y":  _cagr(ac(["financials", "NP_A"]), n=5),
        # Quarterly growth
        "rev_growth_yoy_q": _q(qc(["REV4Q_Q"])),
        "np_growth_yoy_q":  _q(qc(["NP_Q_GROWTH"])),
    }


# â”€â”€ Persist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def upsert_profile(symbol: str, today: str, profile: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        INSERT INTO trendlyne_stock_profile (
            symbol, date,
            np_annual, ebitda_annual, revenue_annual, eps_annual,
            ebitda_margin, np_margin, cfo_annual,
            roe, roce, ltde_ratio, current_ratio,
            promoter_pct, fii_pct, mf_pct, pledge_pct,
            promoter_chg_qoq, fii_chg_qoq, mf_chg_qoq, pledge_chg_qoq,
            rev_cagr_5y, np_cagr_5y,
            rev_growth_yoy_q, np_growth_yoy_q,
            analyst_target_mean, analyst_count, analyst_buy_pct, analyst_upside_pct,
            last_dividend_amt, last_ex_date, days_since_dividend, company_description
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, date) DO UPDATE SET
            np_annual           = excluded.np_annual,
            ebitda_annual       = excluded.ebitda_annual,
            revenue_annual      = excluded.revenue_annual,
            eps_annual          = excluded.eps_annual,
            ebitda_margin       = excluded.ebitda_margin,
            np_margin           = excluded.np_margin,
            cfo_annual          = excluded.cfo_annual,
            roe                 = excluded.roe,
            roce                = excluded.roce,
            ltde_ratio          = excluded.ltde_ratio,
            current_ratio       = excluded.current_ratio,
            promoter_pct        = excluded.promoter_pct,
            fii_pct             = excluded.fii_pct,
            mf_pct              = excluded.mf_pct,
            pledge_pct          = excluded.pledge_pct,
            promoter_chg_qoq    = excluded.promoter_chg_qoq,
            fii_chg_qoq         = excluded.fii_chg_qoq,
            mf_chg_qoq          = excluded.mf_chg_qoq,
            pledge_chg_qoq      = excluded.pledge_chg_qoq,
            rev_cagr_5y         = excluded.rev_cagr_5y,
            np_cagr_5y          = excluded.np_cagr_5y,
            rev_growth_yoy_q    = excluded.rev_growth_yoy_q,
            np_growth_yoy_q     = excluded.np_growth_yoy_q,
            analyst_target_mean = excluded.analyst_target_mean,
            analyst_count       = excluded.analyst_count,
            analyst_buy_pct     = excluded.analyst_buy_pct,
            analyst_upside_pct  = excluded.analyst_upside_pct,
            last_dividend_amt   = excluded.last_dividend_amt,
            last_ex_date        = excluded.last_ex_date,
            days_since_dividend = excluded.days_since_dividend,
            company_description = excluded.company_description,
            fetched_at          = CURRENT_TIMESTAMP
    """, (
        symbol, today,
        _safe(profile.get("np_annual")), _safe(profile.get("ebitda_annual")),
        _safe(profile.get("revenue_annual")), _safe(profile.get("eps_annual")),
        _safe(profile.get("ebitda_margin")), _safe(profile.get("np_margin")),
        _safe(profile.get("cfo_annual")),
        _safe(profile.get("roe")), _safe(profile.get("roce")),
        _safe(profile.get("ltde_ratio")), _safe(profile.get("current_ratio")),
        _safe(profile.get("promoter_pct")), _safe(profile.get("fii_pct")),
        _safe(profile.get("mf_pct")), _safe(profile.get("pledge_pct")),
        _safe(profile.get("promoter_chg_qoq")), _safe(profile.get("fii_chg_qoq")),
        _safe(profile.get("mf_chg_qoq")), _safe(profile.get("pledge_chg_qoq")),
        _safe(profile.get("rev_cagr_5y")), _safe(profile.get("np_cagr_5y")),
        _safe(profile.get("rev_growth_yoy_q")), _safe(profile.get("np_growth_yoy_q")),
        _safe(profile.get("analyst_target_mean")),
        int(profile.get("analyst_count") or 0),
        _safe(profile.get("analyst_buy_pct")), _safe(profile.get("analyst_upside_pct")),
        _safe(profile.get("last_dividend_amt")), profile.get("last_ex_date"),
        int(profile.get("days_since_dividend") or 0) if profile.get("days_since_dividend") is not None else None,
        profile.get("company_description"),
    ))
    con.commit()


def backfill_technical_signals(symbol: str, today: str, profile: dict, con) -> None:
    if not profile:
        return
    # Point-in-time: shareholding + its QoQ deltas apply only to rows on/after the disclosure
    # was public (date >= floor), NULL on older rows — never smear the latest ownership snapshot
    # onto history the model trains on. Same discipline as mf_stock_holdings + the ET_Stats fetchers.
    sh_floor = _sh_floor(profile.get("shareholding_as_of"), fallback=today)
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            analyst_upside_pct  = CASE WHEN date >= ? THEN COALESCE(?, analyst_upside_pct)  ELSE NULL END,
            analyst_count       = CASE WHEN date >= ? THEN COALESCE(?, analyst_count)       ELSE NULL END,
            analyst_buy_pct     = CASE WHEN date >= ? THEN COALESCE(?, analyst_buy_pct)     ELSE NULL END,
            roe_annual          = CASE WHEN date >= ? THEN COALESCE(?, roe_annual)          ELSE NULL END,
            roce_annual         = CASE WHEN date >= ? THEN COALESCE(?, roce_annual)         ELSE NULL END,
            ebitda_margin       = CASE WHEN date >= ? THEN COALESCE(?, ebitda_margin)       ELSE NULL END,
            np_margin           = CASE WHEN date >= ? THEN COALESCE(?, np_margin)           ELSE NULL END,
            promoter_pct        = CASE WHEN date >= ? THEN COALESCE(?, promoter_pct)     ELSE NULL END,
            fii_pct             = CASE WHEN date >= ? THEN COALESCE(?, fii_pct)          ELSE NULL END,
            mf_pct              = CASE WHEN date >= ? THEN COALESCE(?, mf_pct)           ELSE NULL END,
            pledge_pct          = CASE WHEN date >= ? THEN COALESCE(?, pledge_pct)       ELSE NULL END,
            promoter_chg_qoq    = CASE WHEN date >= ? THEN COALESCE(?, promoter_chg_qoq) ELSE NULL END,
            fii_chg_qoq         = CASE WHEN date >= ? THEN COALESCE(?, fii_chg_qoq)      ELSE NULL END,
            mf_chg_qoq          = CASE WHEN date >= ? THEN COALESCE(?, mf_chg_qoq)       ELSE NULL END,
            pledge_chg_qoq      = CASE WHEN date >= ? THEN COALESCE(?, pledge_chg_qoq)   ELSE NULL END,
            rev_growth_yoy_q    = CASE WHEN date >= ? THEN COALESCE(?, rev_growth_yoy_q)    ELSE NULL END,
            np_growth_yoy_q     = CASE WHEN date >= ? THEN COALESCE(?, np_growth_yoy_q)     ELSE NULL END,
            days_since_dividend = CASE WHEN date >= ? THEN COALESCE(?, days_since_dividend) ELSE NULL END,
            last_dividend_amt   = CASE WHEN date >= ? THEN COALESCE(?, last_dividend_amt)   ELSE NULL END
        WHERE symbol = ?
    """, (
        today, _safe(profile.get("analyst_upside_pct")),
        today, int(profile.get("analyst_count") or 0) if profile.get("analyst_count") is not None else None,
        today, _safe(profile.get("analyst_buy_pct")),
        today, _safe(profile.get("roe")),   today, _safe(profile.get("roce")),
        today, _safe(profile.get("ebitda_margin")), today, _safe(profile.get("np_margin")),
        sh_floor, _safe(profile.get("promoter_pct")),
        sh_floor, _safe(profile.get("fii_pct")),
        sh_floor, _safe(profile.get("mf_pct")),
        sh_floor, _safe(profile.get("pledge_pct")),
        sh_floor, _safe(profile.get("promoter_chg_qoq")),
        sh_floor, _safe(profile.get("fii_chg_qoq")),
        sh_floor, _safe(profile.get("mf_chg_qoq")),
        sh_floor, _safe(profile.get("pledge_chg_qoq")),
        today, _safe(profile.get("rev_growth_yoy_q")), today, _safe(profile.get("np_growth_yoy_q")),
        today, int(profile.get("days_since_dividend") or 0) if profile.get("days_since_dividend") is not None else None,
        today, _safe(profile.get("last_dividend_amt")),
        symbol,
    ))
    con.commit()


# â”€â”€ Stock list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _load_stocks(symbol_filter: str | None, con, only_unsynced: bool = True) -> list[tuple[str, str]]:
    """Return [(symbol, tlid), ...] scoped to the NSE master list only (nse_stocks.tlid).
    No trendlyne_screener_stocks fallback — that table carries non-NSE-master symbols
    (junk/delisted/BSE-only tickers) which pulled the universe well past NSE coverage.

    Company profile/description/fundamentals data is near-static — there's no reason to
    re-scrape the same NSE stock over and over. With only_unsynced=True (the default), a
    symbol that already has ANY row in trendlyne_stock_profile (any date) is excluded, so
    each NSE stock gets scraped once, ever; subsequent runs only pick up stocks that have
    never been synced (new listings). --resync-all bypasses this to force a full refresh
    of the whole universe when one is genuinely needed.
    """
    cur = con.cursor()
    unsynced_clause = (
        "AND NOT EXISTS (SELECT 1 FROM trendlyne_stock_profile tsp WHERE tsp.symbol = symbol)"
        if only_unsynced else ""
    )
    cur.execute(f"""
        SELECT symbol, tlid FROM (
            SELECT symbol, tlid::TEXT AS tlid FROM nse_stocks
            WHERE symbol IS NOT NULL AND tlid IS NOT NULL AND tlid::TEXT != ''
        ) universe(symbol, tlid)
        WHERE 1=1 {unsynced_clause}
        ORDER BY symbol
    """)
    rows = [(r[0], str(r[1])) for r in cur.fetchall() if r[0]]
    if symbol_filter:
        rows = [(s, t) for s, t in rows if s.upper() == symbol_filter.upper()]
    # Same permanent-404 filter as the adv_tech/price_analysis sibling loaders. Matters more
    # here: only_unsynced means a ticker-shaped tlid never gets a trendlyne_stock_profile row,
    # so it stays "unsynced" and is retried on every single run, forever.
    rows, _ = filter_numeric_tlids(rows, "TLOverview")
    return rows


# â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _shard(stocks: list[tuple[str, str]], index: int, count: int) -> list[tuple[str, str]]:
    """Deterministic ~1/count slice of the universe, stable across runs (independent of DB
    row order so the same symbol always lands in the same shard). Used to spread the full
    scrape (~3.6h) across several days instead of one run that blows a 70-min budget."""
    if count <= 1:
        return stocks
    return [
        (s, t) for s, t in stocks
        if int(hashlib.md5(s.encode()).hexdigest(), 16) % count == index
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=None)
    parser.add_argument("--shard-index", type=int, default=None,
                         help="0-based shard to process this run (with --shard-count)")
    parser.add_argument("--shard-count", type=int, default=None,
                         help="Total number of shards the universe is split across")
    parser.add_argument("--resync-all", action="store_true",
                         help="Re-scrape the whole universe, including symbols already synced "
                              "at least once (default only fetches never-synced symbols)")
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = _load_stocks(args.symbol, con, only_unsynced=not args.resync_all)
    if not stocks:
        print("[TLOverview] No stocks with tlid found (or the whole universe is already synced — "
              "pass --resync-all to force a full refresh).")
        return

    if args.shard_count and args.shard_index is not None:
        full_count = len(stocks)
        stocks = _shard(stocks, args.shard_index, args.shard_count)
        print(f"[TLOverview] Shard {args.shard_index}/{args.shard_count}: "
              f"{len(stocks)}/{full_count} stocks this run.")

    stocks = cap_to_run_budget(stocks, "TLOverview", requests_per_row=2)
    print(f"[TLOverview] Processing {len(stocks)} stocks in batches of {BATCH_SIZE} ({BATCH_GAP_SEC}s gap) - analyst + fundamentals...")
    session = requests.Session()
    session.headers.update(HEADERS)
    today = date.today().isoformat()
    # Separate anchor for the technical_signals UPDATE below: this job runs DAILY including
    # weekends (company-profiles-sync, '0 4 * * *') -- on a Sat/Sun `today` has no grid-ensurer
    # row yet, so "date >= today" would match zero rows while nulling every existing row via the
    # ELSE branch. Same bug/fix as trendlyne_fundamentals_fetcher.py and others. `today` itself is
    # left untouched for extract_analyst_data()'s own use, which is a real-calendar-date concept.
    ts_anchor = logical_write_floor(con, fallback=today)
    ok = 0
    done = 0

    def _fetch_one(args):
        symbol, tlid = args
        profile = {}
        overview_body = _fetch(OVERVIEW_URL.format(tlid=tlid), session)
        if overview_body is not None:
            profile.update(extract_analyst_data(overview_body, symbol, today, None))
            profile.update(extract_event_data(overview_body))
            desc = extract_company_description(overview_body)
            if desc:
                profile["company_description"] = desc
        fp_body = _fetch(PROFILE_URL.format(tlid=tlid), session)
        if fp_body is not None:
            profile.update(extract_profile_data(fp_body))
        return symbol, tlid, profile

    for batch_start in range(0, len(stocks), BATCH_SIZE):
        batch = stocks[batch_start:batch_start + BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = [pool.submit(_fetch_one, item) for item in batch]
            for fut in as_completed(futures):
                symbol, tlid, profile = fut.result()
                done += 1
                if profile:
                    # analyst_data writes to DB — do that on main thread with real con
                    overview_body2 = None  # analyst_data already extracted in worker
                    upsert_profile(symbol, today, profile, con)
                    backfill_technical_signals(symbol, ts_anchor, profile, con)
                    ok += 1
                upside_str = f"Upside={profile.get('analyst_upside_pct','?')}% n={profile.get('analyst_count','?')}"
                margin_str = f"EBITDA={profile.get('ebitda_margin','?')}% ROE={profile.get('roe','?')}%"
                prom_str   = f"Prom={profile.get('promoter_pct','?')}% FII={profile.get('fii_pct','?')}%"
                print(f"  [{done}/{len(stocks)}] {symbol}: {upside_str} | {margin_str} | {prom_str}")
        time.sleep(BATCH_GAP_SEC)

    print(f"[TLOverview] Done. {ok}/{len(stocks)} stocks processed.")
    con.close()


if __name__ == "__main__":
    main()