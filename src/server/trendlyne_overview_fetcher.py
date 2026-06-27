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
import time
from datetime import date, datetime

import requests

from db_compat import connect

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
        "ALTER TABLE technical_signals ADD COLUMN pledge_pct REAL",
        "ALTER TABLE technical_signals ADD COLUMN rev_growth_yoy_q REAL",
        "ALTER TABLE technical_signals ADD COLUMN np_growth_yoy_q REAL",
        "ALTER TABLE technical_signals ADD COLUMN days_since_dividend INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN last_dividend_amt REAL",
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

    # Persist all reports
    if recent:
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
        "promoter_pct": _latest(ac(["shareholdingMetrics", "PROMPCT"])),
        "fii_pct":      _latest(ac(["shareholdingMetrics", "FIIHOLD"])),
        "mf_pct":       _latest(ac(["shareholdingMetrics", "MFHOLD"])),
        "pledge_pct":   _latest(ac(["shareholdingMetrics", "PROMPLEDGE"])),
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
            rev_cagr_5y, np_cagr_5y,
            rev_growth_yoy_q, np_growth_yoy_q,
            analyst_target_mean, analyst_count, analyst_buy_pct, analyst_upside_pct,
            last_dividend_amt, last_ex_date, days_since_dividend
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
        _safe(profile.get("rev_cagr_5y")), _safe(profile.get("np_cagr_5y")),
        _safe(profile.get("rev_growth_yoy_q")), _safe(profile.get("np_growth_yoy_q")),
        _safe(profile.get("analyst_target_mean")),
        int(profile.get("analyst_count") or 0),
        _safe(profile.get("analyst_buy_pct")), _safe(profile.get("analyst_upside_pct")),
        _safe(profile.get("last_dividend_amt")), profile.get("last_ex_date"),
        int(profile.get("days_since_dividend") or 0) if profile.get("days_since_dividend") is not None else None,
    ))
    con.commit()


def backfill_technical_signals(symbol: str, profile: dict, con) -> None:
    if not profile:
        return
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            analyst_upside_pct  = COALESCE(?, analyst_upside_pct),
            analyst_count       = COALESCE(?, analyst_count),
            analyst_buy_pct     = COALESCE(?, analyst_buy_pct),
            roe_annual          = COALESCE(?, roe_annual),
            roce_annual         = COALESCE(?, roce_annual),
            ebitda_margin       = COALESCE(?, ebitda_margin),
            np_margin           = COALESCE(?, np_margin),
            promoter_pct        = COALESCE(?, promoter_pct),
            fii_pct             = COALESCE(?, fii_pct),
            pledge_pct          = COALESCE(?, pledge_pct),
            rev_growth_yoy_q    = COALESCE(?, rev_growth_yoy_q),
            np_growth_yoy_q     = COALESCE(?, np_growth_yoy_q),
            days_since_dividend = COALESCE(?, days_since_dividend),
            last_dividend_amt   = COALESCE(?, last_dividend_amt)
        WHERE symbol = ?
    """, (
        _safe(profile.get("analyst_upside_pct")),
        int(profile.get("analyst_count") or 0) if profile.get("analyst_count") is not None else None,
        _safe(profile.get("analyst_buy_pct")),
        _safe(profile.get("roe")),   _safe(profile.get("roce")),
        _safe(profile.get("ebitda_margin")), _safe(profile.get("np_margin")),
        _safe(profile.get("promoter_pct")), _safe(profile.get("fii_pct")),
        _safe(profile.get("pledge_pct")),
        _safe(profile.get("rev_growth_yoy_q")), _safe(profile.get("np_growth_yoy_q")),
        int(profile.get("days_since_dividend") or 0) if profile.get("days_since_dividend") is not None else None,
        _safe(profile.get("last_dividend_amt")),
        symbol,
    ))
    con.commit()


# â”€â”€ Stock list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _load_stocks(symbol_filter: str | None, con) -> list[tuple[str, str]]:
    """Return [(symbol, tlid), ...].
    Primary: nse_stocks.tlid (canonical). Fallback: trendlyne_screener_stocks.stock_id.
    """
    cur = con.cursor()
    cur.execute("""
        SELECT symbol, tlid::TEXT AS tlid FROM nse_stocks
        WHERE symbol IS NOT NULL AND tlid IS NOT NULL AND tlid::TEXT != ''
        UNION
        SELECT tss.symbol, MAX(tss.stock_id)::TEXT AS tlid
        FROM trendlyne_screener_stocks tss
        WHERE tss.stock_id IS NOT NULL AND tss.stock_id::TEXT != ''
          AND NOT EXISTS (SELECT 1 FROM nse_stocks ns WHERE ns.symbol = tss.symbol AND ns.tlid IS NOT NULL)
        GROUP BY tss.symbol
        ORDER BY symbol
    """)
    rows = [(r[0], str(r[1])) for r in cur.fetchall() if r[0]]
    if symbol_filter:
        rows = [(s, t) for s, t in rows if s.upper() == symbol_filter.upper()]
    return rows


# â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=None)
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = _load_stocks(args.symbol, con)
    if not stocks:
        print("[TLOverview] No stocks with tlid found.")
        return

    print(f"[TLOverview] Processing {len(stocks)} stocks â€” analyst + fundamentalsâ€¦")
    session = requests.Session()
    session.headers.update(HEADERS)
    today = date.today().isoformat()
    ok = 0

    for i, (symbol, tlid) in enumerate(stocks, 1):
        profile: dict = {}

        # â”€â”€ 1. overview-second-part (analyst targets + events) â”€â”€
        overview_body = _fetch(OVERVIEW_URL.format(tlid=tlid), session)
        if overview_body is not None:
            analyst = extract_analyst_data(overview_body, symbol, today, con)
            events  = extract_event_data(overview_body)
            profile.update(analyst)
            profile.update(events)
        time.sleep(RATE_LIMIT_SEC)

        # â”€â”€ 2. fundamental-profile (financials + shareholding) â”€â”€
        fp_body = _fetch(PROFILE_URL.format(tlid=tlid), session)
        if fp_body is not None:
            fp = extract_profile_data(fp_body)
            profile.update(fp)
        time.sleep(RATE_LIMIT_SEC)

        if profile:
            upsert_profile(symbol, today, profile, con)
            backfill_technical_signals(symbol, profile, con)
            ok += 1

        upside_str  = f"Upside={profile.get('analyst_upside_pct','?')}% n={profile.get('analyst_count','?')}"
        margin_str  = f"EBITDA={profile.get('ebitda_margin','?')}% ROE={profile.get('roe','?')}%"
        prom_str    = f"Prom={profile.get('promoter_pct','?')}% FII={profile.get('fii_pct','?')}%"
        print(f"  [{i}/{len(stocks)}] {symbol}: {upside_str} | {margin_str} | {prom_str}")

    print(f"[TLOverview] Done. {ok}/{len(stocks)} stocks processed.")
    con.close()


if __name__ == "__main__":
    main()
