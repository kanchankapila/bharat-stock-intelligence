#!/usr/bin/env python3
"""
MC + Trendlyne data exploration script.
Fetches ~1,100 API endpoints, stores raw JSON in SQLite, prints summary.

Usage:
  python explore_mc_tl.py              # full run (~1,100 URLs)
  python explore_mc_tl.py --limit 10  # quick test (first 10 URLs)
  python explore_mc_tl.py --db /path/to/output.db
"""
import argparse
import calendar
import datetime
import json
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import TypedDict, Optional
from urllib.parse import quote

import requests

# ─── Constants ────────────────────────────────────────────────────────────────

CONCURRENCY = 10
TIMEOUT = 10
BATCH_SIZE = 50

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.moneycontrol.com",
    "Accept": "application/json, text/plain, */*",
}


# ─── Types ────────────────────────────────────────────────────────────────────

class EndpointSpec(TypedDict):
    domain: str       # 'moneycontrol' | 'trendlyne'
    category: str     # 'indices' | 'stock_detail' | 'screeners' | ...
    subcategory: str  # fine-grained label
    url: str


# ─── DB Setup ─────────────────────────────────────────────────────────────────

CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS api_responses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    domain      TEXT NOT NULL,
    category    TEXT NOT NULL,
    subcategory TEXT NOT NULL,
    url         TEXT NOT NULL,
    http_status INTEGER,
    latency_ms  INTEGER,
    top_keys    TEXT,
    item_count  INTEGER,
    raw_json    TEXT,
    error_msg   TEXT,
    fetched_at  TEXT NOT NULL
)
"""

CREATE_IDX = """
CREATE INDEX IF NOT EXISTS idx_domain_cat
    ON api_responses (domain, category, subcategory)
"""


def create_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.execute(CREATE_TABLE)
    conn.execute(CREATE_IDX)
    conn.commit()
    return conn


def insert_rows(conn: sqlite3.Connection, rows: list[dict]) -> None:
    conn.executemany(
        """INSERT INTO api_responses
           (domain, category, subcategory, url, http_status, latency_ms,
            top_keys, item_count, raw_json, error_msg, fetched_at)
           VALUES
           (:domain, :category, :subcategory, :url, :http_status, :latency_ms,
            :top_keys, :item_count, :raw_json, :error_msg, :fetched_at)""",
        rows,
    )
    conn.commit()

# ─── Response Parsing ─────────────────────────────────────────────────────────

def extract_top_keys(raw):
    """Returns JSON array of top-level keys (up to 10) for the summary report."""
    if not raw:
        return "[]"
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return json.dumps(list(data.keys())[:10])
        if isinstance(data, list) and data and isinstance(data[0], dict):
            return json.dumps(list(data[0].keys())[:10])
        return "[]"
    except Exception:
        return "[]"


def extract_item_count(raw):
    """Returns the length of the primary list in the response, if any."""
    if not raw:
        return None
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return len(data)
        if isinstance(data, dict):
            for key in ("data", "stocks", "results", "items", "list",
                        "scan_result", "graphData", "indices", "deals",
                        "earnings", "articles"):
                val = data.get(key)
                if isinstance(val, list):
                    return len(val)
        return None
    except Exception:
        return None

# ─── MC Indices ───────────────────────────────────────────────────────────────

INDICES = [
    {"symbol": "in;SEN",   "name": "SENSEX",               "id": "4"},
    {"symbol": "in;NSX",   "name": "NIFTY 50",             "id": "9"},
    {"symbol": "in;ccx",   "name": "NIFTY Midcap 100",     "id": "27"},
    {"symbol": "in;cnxs",  "name": "NIFTY Smallcap 100",   "id": "53"},
    {"symbol": "in;cjn",   "name": "NIFTY NEXT 50",        "id": "6"},
    {"symbol": "in;ncx",   "name": "NIFTY 500",            "id": "7"},
    {"symbol": "IN;aox",   "name": "BSE Auto",             "id": "20"},
    {"symbol": "in;bip",   "name": "BSE IPO",              "id": "33"},
    {"symbol": "IN;bkx",   "name": "BSE BANKEX",           "id": "18"},
    {"symbol": "IN;CDX",   "name": "BSE Cons Durables",    "id": "16"},
    {"symbol": "IN;CGX",   "name": "BSE CAP GOODS",        "id": "13"},
    {"symbol": "IN;MLX",   "name": "BSE Metal",            "id": "21"},
    {"symbol": "IN;ogx",   "name": "BSE Oil & Gas",        "id": "22"},
    {"symbol": "in;pbx",   "name": "BSE PSU",              "id": "11"},
    {"symbol": "in;rea",   "name": "BSE REALTY",           "id": "29"},
    {"symbol": "in;tkx",   "name": "BSE TECk",             "id": "10"},
    {"symbol": "IN;NTL",   "name": "BSE 100",              "id": "1"},
    {"symbol": "IN;SEI",   "name": "BSE 200",              "id": "2"},
    {"symbol": "IN;BNX",   "name": "BSE 500",              "id": "12"},
    {"symbol": "in;bpo",   "name": "BSE POWER",            "id": "30"},
    {"symbol": "in;mfy",   "name": "NIFTY MIDCAP 50",      "id": "31"},
    {"symbol": "in;nnx",   "name": "NIFTY 100",            "id": "28"},
    {"symbol": "in;nbx",   "name": "NIFTY BANK",           "id": "23"},
    {"symbol": "in;cnit",  "name": "NIFTY IT",             "id": "19"},
    {"symbol": "in;crl",   "name": "NIFTY REALTY",         "id": "34"},
    {"symbol": "in;cfr",   "name": "NIFTY INFRA",          "id": "35"},
    {"symbol": "in;cgy",   "name": "NIFTY ENERGY",         "id": "38"},
    {"symbol": "in;cfm",   "name": "NIFTY FMCG",           "id": "39"},
    {"symbol": "in;cxc",   "name": "NIFTY MNC",            "id": "40"},
    {"symbol": "in;cpr",   "name": "NIFTY PHARMA",         "id": "41"},
    {"symbol": "in;cps",   "name": "NIFTY PSE",            "id": "42"},
    {"symbol": "in;cuk",   "name": "NIFTY PSU BANK",       "id": "43"},
    {"symbol": "in;crv",   "name": "NIFTY SERV SECTOR",    "id": "44"},
    {"symbol": "in;cnmx",  "name": "NIFTY MEDIA",          "id": "50"},
    {"symbol": "in;CNXM",  "name": "NIFTY METAL",          "id": "51"},
    {"symbol": "in;cnxa",  "name": "NIFTY AUTO",           "id": "52"},
    {"symbol": "in;IDXN",  "name": "India VIX",            "id": "36"},
    {"symbol": "mc;finsrv",    "name": "Nifty FinSrv",           "id": "47"},
    {"symbol": "mc;alphalo",   "name": "NIFTY AlphaLowVol 30",   "id": "mc;alphalo"},
    {"symbol": "mc;nmotm30",   "name": "Nifty200 Momentum 30",   "id": "mc;nmotm30"},
]

GRAPH_RANGES = ["1d", "5d", "1m", "3m", "6m", "1yr", "2yr", "5yr", "max"]
GRAPH_TYPES = ["line", "ohlc", "area", "stick"]
TECH_PERIODS = ["D", "W", "M"]
HIST_RATING_PERIODS = ["D", "W"]

# FnO-capable index IDs (those that have F&O contracts)
FNO_INDICES = [
    {"id": "NIFTY",     "name": "NIFTY 50"},
    {"id": "BANKNIFTY", "name": "NIFTY BANK"},
    {"id": "FINNIFTY",  "name": "NIFTY FIN SERVICE"},
    {"id": "MIDCPNIFTY","name": "NIFTY MIDCAP SELECT"},
    {"id": "SENSEX",    "name": "SENSEX"},
]


def _enc(symbol):
    """URL-encode index symbol: 'in;NSX' -> 'in%3BNSX'."""
    return quote(symbol, safe="")


def build_index_urls():
    specs = []

    # ── Global index list endpoints ──────────────────────────────────────────
    specs.append({"domain": "moneycontrol", "category": "indices",
                  "subcategory": "indices_list",
                  "url": "https://api.moneycontrol.com/mcapi/v1/indices/get-indices-list"})
    specs.append({"domain": "moneycontrol", "category": "indices",
                  "subcategory": "indices_list",
                  "url": "https://api.moneycontrol.com/mcapi/v1/indices/get-indian-indices"})
    # appVersion variants — may expose extra indices or fields
    for av in [136, 137]:
        specs.append({"domain": "moneycontrol", "category": "indices",
                      "subcategory": "indices_list_versioned",
                      "url": f"https://api.moneycontrol.com/mcapi/v1/indices/get-indices-list?appVersion={av}"})

    specs.append({"domain": "moneycontrol", "category": "indices",
                  "subcategory": "advance_decline",
                  "url": "https://api.moneycontrol.com/mcapi/v1/indices/chart/exchange-advdec?ex=N"})

    for idx in INDICES:
        sym = idx["symbol"]
        ind_id = idx["id"]
        enc = _enc(sym)

        # ── Per-index detail endpoint (NEW) ───────────────────────────────────
        if ind_id.isdigit():
            specs.append({"domain": "moneycontrol", "category": "indices",
                          "subcategory": "index_detail",
                          "url": f"https://api.moneycontrol.com/mcapi/v1/indices/get-indices-details?indexId={ind_id}"})

        specs.append({"domain": "moneycontrol", "category": "indices",
                      "subcategory": "index_overview",
                      "url": f"https://appfeeds.moneycontrol.com/jsonapi/market/indices&format=json&ind_id={ind_id}"})
        specs.append({"domain": "moneycontrol", "category": "indices",
                      "subcategory": "index_pricefeed",
                      "url": f"https://priceapi.moneycontrol.com/pricefeed/notapplicable/inidicesindia/{enc}"})

        for mtype in [0, 1, 2]:
            specs.append({"domain": "moneycontrol", "category": "indices",
                          "subcategory": f"index_marketmap_type{mtype}",
                          "url": f"https://appfeeds.moneycontrol.com/jsonapi/market/marketmap&format=json&type={mtype}&ind_id={ind_id}"})

        # ── Graph: all ranges × all chart types (NEW: max range, ohlc/area/stick types) ──
        for rng in GRAPH_RANGES:
            for gtype in GRAPH_TYPES:
                # Only fetch all type variants for 1d range; other ranges use line only
                if rng != "1d" and gtype != "line":
                    continue
                specs.append({"domain": "moneycontrol", "category": "indices",
                              "subcategory": f"index_graph_{gtype}" if gtype != "line" else "index_graph",
                              "url": f"https://appfeeds.moneycontrol.com/jsonapi/market/graph&format=json&ind_id={ind_id}&range={rng}&type={gtype}"})

        for period in TECH_PERIODS:
            specs.append({"domain": "moneycontrol", "category": "indices",
                          "subcategory": "index_technicals",
                          "url": f"https://priceapi.moneycontrol.com/pricefeed/techindicator/{period}/{enc}"})

        if ind_id.isdigit():
            specs.append({"domain": "moneycontrol", "category": "indices",
                          "subcategory": "index_fund_overview",
                          "url": f"https://api.moneycontrol.com/mcapi/v1/indices/fundamentals/overview?indId={ind_id}"})
            specs.append({"domain": "moneycontrol", "category": "indices",
                          "subcategory": "index_fund_eps",
                          "url": f"https://api.moneycontrol.com/mcapi/v1/indices/fundamentals/epsdetail?indId={ind_id}"})
            specs.append({"domain": "moneycontrol", "category": "indices",
                          "subcategory": "index_fund_pe",
                          "url": f"https://api.moneycontrol.com/mcapi/v1/indices/fundamentals/graph/pe?indId={ind_id}&duration=1Y"})
            specs.append({"domain": "moneycontrol", "category": "indices",
                          "subcategory": "index_fund_pb",
                          "url": f"https://api.moneycontrol.com/mcapi/v1/indices/fundamentals/graph/pb?indId={ind_id}&duration=1Y"})

        for period in HIST_RATING_PERIODS:
            specs.append({"domain": "moneycontrol", "category": "indices",
                          "subcategory": "index_hist_rating",
                          "url": f"https://www.moneycontrol.com/mc/widget/historicalrating?classic=true&type=gson&indice_id={sym}&period={period}"})

    # ── Index FnO overview (NEW) — Futures + Options CE/PE per expiry ────────
    for fno_idx in FNO_INDICES:
        fid = fno_idx["id"]
        # Futures overview (empty ExpiryDate = nearest expiry)
        specs.append({"domain": "moneycontrol", "category": "index_fno",
                      "subcategory": "index_fno_futures",
                      "url": f"https://appfeeds.moneycontrol.com/jsonapi/fno/overview&format=json&inst_type=Futures&id={fid}&ExpiryDate="})
        # Options CE and PE overview
        for opt_type in ["CE", "PE"]:
            specs.append({"domain": "moneycontrol", "category": "index_fno",
                          "subcategory": f"index_fno_options_{opt_type.lower()}",
                          "url": f"https://appfeeds.moneycontrol.com/jsonapi/fno/overview&format=json&inst_type=Options&option_type={opt_type}&id={fid}&ExpiryDate="})

    return specs

# ─── MC Stock Detail ──────────────────────────────────────────────────────────

def _next_monthly_expiry():
    """Returns last Thursday of current (or next) month as 'YYYY-MM-DD'."""
    today = datetime.date.today()
    year, month = today.year, today.month
    cal = calendar.monthcalendar(year, month)
    thursdays = [week[3] for week in cal if week[3] != 0]
    expiry = datetime.date(year, month, thursdays[-1])
    if expiry <= today:
        month = month % 12 + 1
        year = year + (1 if month == 1 else 0)
        cal = calendar.monthcalendar(year, month)
        thursdays = [week[3] for week in cal if week[3] != 0]
        expiry = datetime.date(year, month, thursdays[-1])
    return expiry.strftime("%Y-%m-%d")


def build_stock_urls(sc_id="BE03"):
    specs = []
    cat = "stock_detail"

    def add(sub, url):
        specs.append({"domain": "moneycontrol", "category": cat,
                      "subcategory": sub, "url": url})

    add("stock_price", f"https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/{sc_id}")
    add("stock_price", f"https://api.moneycontrol.com/mcapi/v1/stock/price-volume?scId={sc_id}&ex=&appVersion=175")
    add("stock_price", f"https://api.moneycontrol.com/mcapi/v1/stock/get-stock-price?scIdList={sc_id}&scId={sc_id}")
    add("stock_financial", f"https://api.moneycontrol.com/mcapi/v1/stock/financial-historical/overview?scId={sc_id}&ex=N")

    for period in TECH_PERIODS:
        add("stock_techindicator",
            f"https://priceapi.moneycontrol.com/pricefeed/techindicator/{period}/{sc_id}")

    for dur in TECH_PERIODS:
        add("stock_tech_v2",
            f"https://api.moneycontrol.com/mcapi/technicals/v2/details?scId={sc_id}&dur={dur}&deviceType=W")

    for period in TECH_PERIODS:
        for widget in ("technical_rating_summary", "moving_average",
                       "technical_indicator", "moving_average_crossovers"):
            add("stock_tech_widget",
                f"https://www.moneycontrol.com/mc/widget/pricechart_technicals/{widget}?sc_did={sc_id}&page=mc_technicals&period=D&classic=true&period={period}")

    for period in TECH_PERIODS:
        add("stock_pivot",
            f"https://www.moneycontrol.com/mc/widget/pricechart_technicals/pivot_level?sc_did={sc_id}&page=mc_technicals&classic=true&period={period}")

    for period in TECH_PERIODS:
        add("stock_hist_rating",
            f"https://www.moneycontrol.com/mc/widget/historicalrating/ratingPro?classic=true&type=gson&sc_did={sc_id}&period={period}&dur=6m")

    add("stock_swot", f"https://api.moneycontrol.com/mcapi/v1/swot/details?scId={sc_id}&type=all")
    add("stock_essentials", f"https://api.moneycontrol.com/mcapi/v1/extdata/mc-essentials?scId={sc_id}&type=all")
    add("stock_insights", f"https://api.moneycontrol.com/mcapi/v1/extdata/mc-insights?scId={sc_id}&type=d")
    add("stock_insights", f"https://api.moneycontrol.com/mcapi/v1/extdata/mc-insights?scId={sc_id}&type=c")
    add("stock_essentials_v2", f"https://api.moneycontrol.com/mcapi/extdata/v2/mc-essentials?scId={sc_id}&type=ed&deviceType=W")
    add("stock_insights_v2", f"https://api.moneycontrol.com/mcapi/extdata/v2/mc-insights?scId={sc_id}&type=c&deviceType=W&appVersion=185")

    add("stock_est_price_forecast",
        f"https://api.moneycontrol.com/mcapi/v1/stock/estimates/price-forecast?scId={sc_id}&ex=N&deviceType=W")
    add("stock_est_consensus",
        f"https://api.moneycontrol.com/mcapi/v1/stock/estimates/consensus?scId={sc_id}&ex=N&deviceType=W")
    add("stock_est_analyst_rating",
        f"https://api.moneycontrol.com/mcapi/v1/stock/estimates/analyst-rating?deviceType=W&scId={sc_id}&ex=N")
    add("stock_est_earning_forecast",
        f"https://api.moneycontrol.com/mcapi/v1/stock/estimates/earning-forecast?scId={sc_id}&ex=N&deviceType=W&frequency=12&financialType=C")
    add("stock_est_valuation",
        f"https://api.moneycontrol.com/mcapi/v1/stock/estimates/valuation?deviceType=W&scId={sc_id}&ex=N&financialType=C")
    add("stock_est_hits_misses",
        f"https://api.moneycontrol.com/mcapi/v1/stock/estimates/hits-misses?deviceType=W&scId={sc_id}&ex=N&type=eps&financialType=C")

    expiry = _next_monthly_expiry()
    add("stock_fno_expiry", f"https://api.moneycontrol.com/mcapi/v1/fno/futures/getExpDts?id={sc_id}")
    add("stock_fno_futures",
        f"https://api.moneycontrol.com/mcapi/v1/fno/futures/getFuturesData?fut=FUTSTK&id={sc_id}&expirydate={expiry}")
    add("stock_fno_strike",
        f"https://api.moneycontrol.com/mcapi/v1/fno/options/getStrikePrice?id={sc_id}&expirydate={expiry}&optiontype=CE")
    add("stock_fno_options",
        f"https://api.moneycontrol.com/mcapi/v1/fno/options/getOptionsData?opt=OPTSTK&id={sc_id}&expirydate={expiry}&optiontype=CE&strikeprice=405.00")

    return specs

# ─── MC Market Intelligence ───────────────────────────────────────────────────

TECH_TREND_CONFIGS = [
    ("uptrend",   "bullish",        "7",     "performance", "desc"),
    ("uptrend",   "turning-bullish","7",     "changeDate",  "desc"),
    ("downtrend", "bearish",        "7",     "performance", "asc"),
    ("downtrend", "turning-bearish","7",     "changeDate",  "desc"),
    ("uptrend",   "bullish",        "FNO",   "performance", "desc"),
    ("uptrend",   "turning-bullish","FNO",   "changeDate",  "desc"),
    ("downtrend", "bearish",        "FNO",   "performance", "asc"),
    ("downtrend", "turning-bearish","FNO",   "changeDate",  "desc"),
    ("uptrend",   "bullish",        "LCAP",  "performance", "desc"),
    ("downtrend", "bearish",        "LCAP",  "performance", "asc"),
    ("downtrend", "turning-bearish","LCAP",  "changeDate",  "desc"),
    ("downtrend", "bearish",        "MDCAP", "performance", "asc"),
    ("downtrend", "bearish",        "SMCAP", "performance", "asc"),
]


def build_market_intel_urls():
    specs = []

    def add(cat, sub, url):
        specs.append({"domain": "moneycontrol", "category": cat,
                      "subcategory": sub, "url": url})

    for tdir, ttype, idx, sort, order in TECH_TREND_CONFIGS:
        add("tech_trends", f"trend_{tdir}_{ttype}",
            f"https://api.moneycontrol.com/mcapi/v1/technical-trends/{tdir}/{ttype}?ex=N&index={idx}&page=1&order={order}&deviceType=W&sort={sort}&appVersion=142")

    add("deals", "deals_large",
        "https://api.moneycontrol.com/mcapi/v1/deals/list?start=0&limit=24&orderBy=deal_date&sortBy=DESC&dealType=large&deviceType=W&apiVersion=177")
    add("deals", "deals_top_stock",
        "https://api.moneycontrol.com/mcapi/v1/deals/list?start=0&limit=24&orderBy=dealsValue&sortBy=DESC&dealType=topStock&deviceType=W&apiVersion=177")
    add("deals", "deals_sector_wise",
        "https://api.moneycontrol.com/mcapi/v1/deals/list?start=0&limit=24&orderBy=dealsValue&sortBy=DESC&dealType=topStockSectorWise&deviceType=W&apiVersion=177")
    add("deals", "deals_all",
        "https://api.moneycontrol.com/mcapi/v1/deals/list?start=0&limit=24&orderBy=deal_date&sortBy=DESC&deviceType=W")
    add("deals", "deals_largedeals_insight",
        "https://api.moneycontrol.com/mcapi/v1/deals/largedeals-insight?start=0&limit=3&orderBy=dealsValue&deviceType=W")
    add("deals", "deals_stock_news",
        "https://api.moneycontrol.com/mcapi/v1/deals/get-stock-news")
    for action in ("buy", "sell"):
        add("deals", f"deals_insight_{action}",
            f"https://api.moneycontrol.com/mcapi/v1/deals/insight?start=0&limit=9&value=value&range=1W&action={action}&dealsType=topDeal")
        add("deals", f"deals_insider_{action}",
            f"https://api.moneycontrol.com/mcapi/v1/deals/insight?start=0&limit=9&value=value&range=1W&action={action}&dealsType=topInsider")
        add("deals", f"deals_investor_{action}",
            f"https://api.moneycontrol.com/mcapi/v1/deals/insight?start=0&limit=9&value=value&range=1W&action={action}&dealsType=topInvestor")

    today = datetime.date.today().isoformat()
    add("earnings", "earnings_inc_widget",
        "https://api.moneycontrol.com/mcapi/v1/earnings/inc-widget?indexId=all")
    add("earnings", "earnings_price_shockers",
        "https://api.moneycontrol.com/mcapi/v1/earnings/price-shockers?limit=8&page=1")
    add("earnings", "earnings_actual_estimate",
        "https://api.moneycontrol.com/mcapi/v1/earnings/actual-estimate?page=1&limit=6")
    add("earnings", "earnings_rapid_results_lr",
        "https://api.moneycontrol.com/mcapi/v1/earnings/rapid-results?limit=9&page=1&type=LR&subType=yoy")
    add("earnings", "earnings_rapid_results_bp",
        "https://api.moneycontrol.com/mcapi/v1/earnings/rapid-results?limit=21&page=1&type=BP&subType=yoy&category=all&sortBy=growth&indexId=N&sector=&search=&seq=desc")
    add("earnings", "earnings_calendar",
        f"https://api.moneycontrol.com/mcapi/v1/earnings/result-calendar?indexId=All&fromDate={today}&toDate={today}&sector=")
    add("earnings", "earnings_get_data",
        f"https://api.moneycontrol.com/mcapi/v1/earnings/get-earnings-data?indexId=All&page=1&startDate={today}&endDate={today}&sector=&limit=18")
    add("earnings", "earnings_dashboard",
        "https://api.moneycontrol.com/mcapi/v1/earnings/result-dashboard")

    for slug in ("market-cues", "international-markets", "asian-markets",
                 "taking-stock", "mc-essentials"):
        add("premarket", f"premarket_article_{slug.replace('-', '_')}",
            f"https://api.moneycontrol.com/mcapi/v1/premarket/article?slug={slug}&limit=1")
    add("premarket", "premarket_global_marketdata",
        "https://api.moneycontrol.com/mcapi/v1/premarket/get-global-marketdata?section=mi")
    add("premarket", "premarket_ecalendar",
        "https://api.moneycontrol.com/mcapi/v1/ecalendar/get-upcoming-event-data?page=1&pageSize=7")
    add("premarket", "premarket_market_views",
        "https://api.moneycontrol.com/mcapi/v1/premarket/getMarketViewsData?cat=all&start=0&limit=9")
    add("premarket", "premarket_fll_activity",
        "https://api.moneycontrol.com/mcapi/v1/premarket/getFllActivityData?type=cash")
    add("premarket", "premarket_stocks_to_watch",
        "https://api.moneycontrol.com/mcapi/v1/premarket/getStockToWatchData?start=0&limit=3&sortby=rank&sortorder=asc")
    add("premarket", "premarket_news",
        "https://api.moneycontrol.com/mcapi/v1/premarket/getMarketNewsData?limit=6")
    add("premarket", "premarket_broker_reco",
        "https://api.moneycontrol.com/mcapi/v1/premarket/getBrokerResearchReco?sublevel=stocks&start=0&limit=6")

    add("news", "news_results",
        'https://www.moneycontrol.com/newsapi/mc_news.php?query=tags_slug:("results" "result-poll")&start=0&limit=8&sortby=creation_date&sortorder=desc')

    return specs

# ─── MC Screeners ─────────────────────────────────────────────────────────────

PROSCANNER = {
    1: [146, 181, 178, 182, 176, 184, 177, 165, 174, 179, 168, 364, 366, 369,
        367, 370, 374, 371, 378, 376, 365, 379, 382, 375, 381, 383, 388, 390,
        362, 391, 377, 397, 405, 403, 399, 412, 400, 408, 411, 419, 416, 410,
        422, 430, 389, 409, 425, 429, 424, 432, 431, 423, 435, 434],
    2: [172, 169, 181, 171, 168, 167, 170, 378, 376, 369, 392, 398, 391, 397,
        377, 362, 393, 395, 416, 417, 413, 396, 394],
    3: [166, 165, 176, 177, 363, 364, 372, 382, 380, 365, 383, 373, 386, 405,
        408, 410, 421, 420, 387, 409],
    4: [184, 174, 182, 173, 367, 366, 370, 371, 379, 375, 384, 381, 390, 385,
        374, 401, 402, 404, 399, 403, 400, 426, 432, 435, 423, 434],
    6: [178, 168, 179, 167, 378, 368, 388, 380, 389, 427, 428],
    7: [401, 402, 404, 417, 422, 420, 426, 432, 423, 427],
    8: [419, 430, 431, 429],
    9: [182, 184, 174, 177, 173, 367, 366, 372, 384, 379, 386, 401, 402, 403,
        404, 400, 385, 417, 421, 422, 420, 399, 432, 423, 434, 520, 519, 522,
        521, 525],
}

TECHSCANNER = {
    25: [
        "OHLC_D_P_BPBULL", "OHLC_D_I_DSMARTBULLC", "OHLC_D_P_BPBEAR",
        "OHLC_D_I_DSMARTBEARC", "OHLC_D_I_RSIPOWBO", "OHLC_D_I_RSI70607DNBU",
        "OHLC_D_I_ADBBPBUY", "OHLC_D_I_MOMRAVBU", "OHLC_D_I_ST5133BULL",
        "OHLC_D_I_SQZBULLBO", "OHLC_D_I_10DSTOCHBULL", "OHLC_20D_P_CLABVPWH",
        "OHLC_W_I_RSIMULTIBAG", "OHLC_D_I_BOLDBULL", "OHLC_D_I_BTSTOND",
        "OHLC_D_I_CLSERIESBULL", "OHLC_D_I_TRNGLCANDBULL", "OHLC_D_I_RISE3BULL",
        "OHLC_D_I_RSIPOWBD", "OHLC_D_I_RSI70607DNBE", "OHLC_D_I_ADBBPSELL",
        "OHLC_D_I_MOMRAVBE", "OHLC_D_I_ST5133BEAR", "OHLC_D_I_SQZBEARBO",
        "OHLC_D_I_10DSTOCHBEAR", "OHLC_20D_P_CLBLWPWL", "OHLC_D_I_BOLDBEAR",
        "OHLC_D_I_STBTOND", "OHLC_D_I_CLSERIESBEAR", "OHLC_D_I_TRNGLCANDBEAR",
        "OHLC_D_I_RISE3BEAR",
    ],
    17: [
        "OHLC_W_P_52HIGH", "OHLC_D_P_2YRHIGH", "OHLC_D_P_3YRHIGH",
        "OHLC_D_P_5YRHIGH", "OHLC_D_P_ALLTIMEH", "OHLC_D_P_OPENLOW",
        "OHLC_W_P_52LOW", "OHLC_D_P_2YRLOW", "OHLC_D_P_3YRLOW",
        "OHLC_D_P_5YRLOW", "OHLC_D_P_ALLTIMEL",
    ],
}


def build_screener_urls():
    specs = []

    for cat_id, scan_ids in PROSCANNER.items():
        for scan_id in scan_ids:
            specs.append({
                "domain": "moneycontrol", "category": "screeners",
                "subcategory": "proscanner",
                "url": f"https://api.moneycontrol.com/mcapi/v1/proscanner/scanner-detail?catId={cat_id}&scanId={scan_id}",
            })

    for cat_id, scan_ids in TECHSCANNER.items():
        for scan_id in scan_ids:
            specs.append({
                "domain": "moneycontrol", "category": "screeners",
                "subcategory": "techscanner",
                "url": f"https://api.moneycontrol.com/mcapi/v1/techscanner/scanner-detail?catId={cat_id}&scanId={scan_id}",
            })

    return specs

# ─── Trendlyne ────────────────────────────────────────────────────────────────

TL_JSON_SCREENERS: dict[int, str] = {
    79790: "Relative Outperformance vs Nifty500 - 2Y",
    79791: "Relative Outperformance vs Nifty500 - 1Y",
    79792: "Relative Outperformance vs Nifty500 - 6M",
    79793: "Relative Outperformance vs Nifty500 - 1Q",
    79794: "Relative Outperformance vs Nifty500 - 1M",
    79795: "Relative Outperformance vs Nifty500 - 1W",
    79796: "Relative Outperformance vs Nifty500 - 1D",
    79797: "Volume Shockers",
    79799: "High Volume High Gain",
    79800: "Relative Underperformance vs Nifty500 - 3Y",
    79801: "Relative Underperformance vs Nifty500 - 2Y",
    79802: "Relative Underperformance vs Nifty500 - 1Y",
    79803: "Relative Underperformance vs Nifty500 - 6M",
    79806: "Relative Underperformance vs Nifty500 - 1Q",
    79808: "Relative Underperformance vs Nifty500 - 1M",
    79810: "Relative Underperformance vs Nifty500 - 1W",
    79811: "Relative Underperformance vs Nifty500 - 1D",
    17096: "Top Gainers",
    17097: "Volume Shockers (alt)",
    17098: "Top Losers",
    17099: "High Volume High Gain (alt)",
    17100: "High Volume Top Losers",
    17109: "New 52W Low",
    17110: "New 52W High",
    9844:  "Rising Delivery Percentage",
    20014: "Broker Price/Reco Upgrades",
    27:    "Overbought RSI+MFI",
    28:    "Oversold RSI+MFI",
    15:    "High Revenue Profit Growth High ROE Low PE",
    10:    "Increasing Revenue Every Quarter - 4Q",
    21:    "Screener 21",
    22:    "Promoters Buying Growth Stocks",
    24:    "High Analyst Rating 20pct Upside",
    31:    "Small Cap Stars",
    40:    "Near Day High/Low 2x Avg Volume",
    42:    "High Volume High Growth",
}

TL_ALLONE_BULLISH = [
    19814, 153269, 19746, 3057, 280337, 6211, 190803, 387668, 66655, 548705,
    16996, 45884, 501877, 691112, 7154, 211854, 208805, 24645, 523595, 691113,
    11502, 174452, 205167, 32574, 371832, 222864, 6159,
]

TL_ALLONE_BEARISH = [
    93730, 154274, 463821, 36308, 4897, 3059, 7205, 208109, 497177, 15045,
]

TL_FNO_FILTERS = [
    ("options", "near", "oi_gainers_call", "all"),
    ("options", "near", "oi_gainers_put", "all"),
    ("futures", "next", "contract_gainers", ""),
    ("futures", "next", "price_gainers", ""),
    ("futures", "next", "most_active_value", ""),
    ("futures", "next", "most_active_contract", ""),
    ("futures", "next", "oi_gainers", ""),
    ("futures", "next", "oi_losers", ""),
    ("futures", "next", "premium", ""),
    ("futures", "next", "discount", ""),
]

TL_MF_CATEGORIES = ["ELSS", "Multi+%26+Flexi-Cap"]


def build_trendlyne_urls() -> list[EndpointSpec]:
    specs: list[EndpointSpec] = []

    def add(sub: str, url: str) -> None:
        specs.append({"domain": "trendlyne", "category": "screeners",
                      "subcategory": sub, "url": url})

    # JSON screeners (NIFTY500 group)
    for pk, name in TL_JSON_SCREENERS.items():
        add("tl_json_screener",
            f"https://trendlyne.com/fundamentals/json-screener/{pk}/5/0/index/NIFTY500/nifty-500/")

    # All-in-one screeners — bullish
    for pk in TL_ALLONE_BULLISH:
        add("tl_allone_bullish",
            f"https://trendlyne.com/fundamentals/tl-all-in-one-screener-data-get/?screenpk={pk}&perPageCount=25&groupType=all&groupName=all")

    # All-in-one screeners — bearish
    for pk in TL_ALLONE_BEARISH:
        add("tl_allone_bearish",
            f"https://trendlyne.com/fundamentals/tl-all-in-one-screener-data-get/?screenpk={pk}&perPageCount=25&groupType=all&groupName=all")

    # Custom query screeners
    specs.append({"domain": "trendlyne", "category": "screeners",
                  "subcategory": "tl_custom_query",
                  "url": "https://trendlyne.com/fundamentals/all-in-one-screener-data-get/?perPageCount=25&pageNumber=0&query=FIIPCT1Q+%3E+1&columns=FIIPCT1Q%2Csholding_date%2CcurrentPrice%2Cday_changeP&groupType=all&groupName=&sortBy=FIIPCT1Q&order=DESC"})
    specs.append({"domain": "trendlyne", "category": "screeners",
                  "subcategory": "tl_custom_query",
                  "url": "https://trendlyne.com/fundamentals/all-in-one-screener-data-get/?perPageCount=25&pageNumber=0&query=vol_day+%3E%3D+1.5+*+vol_week&columns=vol_day%2Cvol_week%2CcurrentPrice%2Cday_changeP&groupType=all&groupName=&sortBy=vol_day&order=DESC"})
    specs.append({"domain": "trendlyne", "category": "screeners",
                  "subcategory": "tl_custom_query",
                  "url": "https://trendlyne.com/fundamentals/tl-all-in-one-screener-data-get/?screenpk=515760&perPageCount=25&groupType=all&groupName=all"})
    specs.append({"domain": "trendlyne", "category": "screeners",
                  "subcategory": "tl_52w_high_nifty500",
                  "url": "https://trendlyne.com/fundamentals/tl-all-in-one-screener-data-get/?screenpk=19814&perPageCount=25&groupType=index&groupName=NIFTY500&groupSlug=nifty-500"})

    # FnO filters
    expiry_slug = _tl_expiry_slug()
    for inst, tenor, filter_type, suffix in TL_FNO_FILTERS:
        path_suffix = f"/{suffix}" if suffix else "/"
        specs.append({"domain": "trendlyne", "category": "fno",
                      "subcategory": "tl_fno_filter",
                      "url": f"https://trendlyne.com/futures-options/api-filter/{inst}/{expiry_slug}-{tenor}/{filter_type}{path_suffix}"})

    # MF
    for cat in TL_MF_CATEGORIES:
        specs.append({"domain": "trendlyne", "category": "mf",
                      "subcategory": "tl_mf",
                      "url": f"https://trendlyne.com/mutual-fund/getMFhome/?category={cat}"})

    return specs


def _tl_expiry_slug() -> str:
    """Returns Trendlyne expiry slug e.g. '29-may-2026'."""
    expiry_date = datetime.date.fromisoformat(_next_monthly_expiry())
    return expiry_date.strftime("%#d-%b-%Y").lower()

# ─── Kayal (Trendlyne broker subdomain) ───────────────────────────────────────

# 1,053 unique screener PKs from kayal.trendlyne.com broker webview
KAYAL_SCREENER_PKS = [
    15, 16, 23, 24, 26, 27, 28, 29, 30, 31, 41, 138,
    226, 292, 293, 423, 478, 717, 764, 1511, 1648, 1729, 2651, 3051,
    3056, 3057, 3059, 4805, 4807, 4897, 5388, 5389, 5393, 5394, 5779, 5884,
    5885, 5886, 5887, 5888, 5889, 5890, 5891, 5892, 5893, 5894, 5895, 5896,
    5897, 5898, 5899, 5900, 5901, 5902, 5903, 5904, 5905, 5906, 6157, 6159,
    6160, 6211, 6562, 7154, 7205, 7557, 7589, 7830, 7942, 8008, 8036, 8181,
    8182, 8185, 8256, 9193, 9287, 9335, 9362, 9516, 9544, 9588, 9589, 9818,
    9819, 9821, 9823, 9824, 9826, 9831, 9832, 9834, 9835, 9836, 9837, 9838,
    9840, 9843, 9844, 9895, 9896, 10029, 10118, 10159, 10407, 10554, 10663, 10699,
    10955, 11122, 11321, 11385, 11500, 11502, 11559, 11793, 11814, 11866, 12094, 12405,
    13086, 13213, 14535, 14567, 14752, 14807, 15045, 15075, 15316, 15318, 15320, 15451,
    15543, 15628, 15697, 16995, 16996, 17038, 17131, 17183, 17233, 17343, 17344, 18121,
    18566, 18597, 18792, 18916, 19746, 19814, 20014, 20078, 21557, 22709, 22717, 22719,
    23511, 24573, 24575, 24645, 24700, 24702, 24713, 24714, 24715, 24716, 24717, 24728,
    24729, 24730, 24731, 24732, 24733, 24747, 24842, 24866, 24867, 24870, 24871, 24872,
    24876, 25125, 25348, 25797, 25818, 25865, 25866, 25994, 26001, 26901, 31264, 31717,
    32034, 32574, 35316, 35319, 35321, 35325, 35326, 35336, 35337, 35338, 35341, 35343,
    36275, 36288, 36308, 36373, 36375, 36376, 36377, 36378, 36381, 36384, 37335, 42221,
    45882, 45884, 46425, 47927, 48091, 66655, 79690, 79703, 79704, 79706, 79707, 79708,
    79709, 79710, 79711, 79712, 79713, 79715, 79716, 79717, 79718, 79722, 79723, 79724,
    79728, 79729, 79737, 79738, 79739, 79790, 79791, 79792, 79793, 79794, 79795, 79796,
    79797, 79799, 79800, 79801, 79802, 79803, 79806, 79808, 79810, 79811, 82466, 82476,
    82485, 82540, 82553, 82566, 82567, 82568, 82586, 83413, 83414, 83417, 83418, 83419,
    92294, 93730, 95025, 123150, 126619, 150420, 153269, 154274, 174452, 178571, 178572, 178573,
    178574, 178588, 178590, 179144, 179158, 179161, 180912, 182100, 184105, 186840, 190803, 198018,
    205167, 207497, 208109, 208613, 208614, 208618, 208619, 208625, 208626, 208631, 208805, 208995,
    211854, 218262, 218265, 218266, 218470, 218473, 218476, 218479, 218481, 218482, 218484, 218488,
    218489, 218492, 218498, 218510, 218511, 218513, 218517, 218535, 219052, 222859, 222861, 222864,
    222865, 222869, 222870, 222872, 222874, 222875, 222876, 222877, 222879, 224581, 224584, 224587,
    224590, 224601, 224612, 224614, 224616, 224617, 224618, 224628, 224632, 224634, 224641, 224849,
    224851, 224853, 224854, 224855, 224856, 224858, 224859, 224864, 224865, 224866, 224869, 224870,
    224872, 224874, 224875, 225381, 225408, 225489, 225491, 225493, 225496, 225498, 225500, 225502,
    225503, 225507, 225509, 225515, 225517, 225520, 225522, 225524, 225526, 225538, 225540, 225558,
    225569, 230994, 231024, 231110, 231302, 231325, 231955, 231960, 231999, 252158, 252169, 252170,
    252747, 252748, 252749, 252750, 252751, 252766, 252940, 252942, 252969, 252997, 253024, 253025,
    253026, 253053, 253069, 253264, 253267, 253269, 253272, 253296, 253307, 253311, 253313, 253337,
    253350, 253352, 253354, 258174, 258175, 258176, 258180, 258192, 258198, 258205, 258206, 258543,
    258545, 258663, 258822, 258902, 258930, 258944, 260219, 260220, 260221, 260235, 260275, 260300,
    260320, 260322, 260325, 260327, 260364, 260380, 260381, 260382, 260383, 260397, 260401, 260430,
    260452, 260460, 270925, 280337, 286949, 287918, 314003, 314009, 314011, 314012, 314013, 314016,
    314019, 314020, 314026, 314038, 314039, 314040, 314043, 314046, 314050, 314051, 314052, 314053,
    314054, 314055, 330675, 334854, 353470, 358883, 358885, 358886, 358887, 358888, 358889, 358890,
    358891, 358892, 358894, 358896, 358898, 358900, 358901, 358902, 358903, 358904, 358905, 359200,
    359212, 359213, 359214, 359216, 359217, 359218, 371821, 371829, 371831, 371832, 371835, 371842,
    372090, 372098, 372099, 372101, 372130, 372137, 372170, 372171, 372172, 372174, 372175, 385658,
    385659, 385663, 385668, 385670, 385673, 385676, 385690, 387668, 399172, 399177, 399179, 422006,
    422013, 422014, 422015, 422017, 422030, 422031, 422033, 434325, 442237, 442244, 463821, 470223,
    470230, 471978, 472327, 472333, 472341, 472344, 479184, 481430, 481431, 481432, 481434, 481435,
    481436, 482894, 482895, 482896, 482898, 482899, 482900, 482901, 482902, 482903, 482904, 482905,
    482906, 482908, 482909, 482910, 482911, 482912, 482913, 482914, 482916, 482917, 482918, 482919,
    482920, 482921, 482922, 482923, 482924, 494715, 494718, 494720, 494721, 494740, 494747, 494748,
    494749, 494750, 494754, 494756, 494757, 494758, 494761, 494763, 494764, 494767, 494768, 494773,
    494777, 495117, 495935, 495937, 495946, 495947, 495950, 495951, 495953, 495954, 495955, 495958,
    495960, 495971, 495972, 495975, 495979, 495984, 495986, 495988, 495989, 495990, 495992, 497124,
    497162, 497177, 497215, 497220, 497233, 497784, 497786, 497789, 497790, 497791, 497793, 497796,
    497797, 497798, 497802, 497803, 497804, 497805, 497806, 498203, 498205, 498209, 498211, 498212,
    498214, 498215, 498217, 498219, 498220, 498221, 498223, 498224, 498225, 501877, 504433, 504435,
    504438, 504441, 504442, 504444, 504448, 504449, 504450, 504476, 515743, 523595, 526362, 526363,
    526367, 526379, 526380, 526385, 526402, 526405, 548705, 556358, 556779, 556782, 556783, 556785,
    556790, 556793, 556795, 556798, 556799, 556802, 556803, 556806, 556810, 556812, 556813, 556819,
    556820, 556858, 556861, 556862, 556864, 556865, 556868, 556869, 556873, 556885, 556888, 556891,
    556894, 556895, 560405, 592754, 592839, 592840, 592842, 592848, 592853, 592856, 592858, 592861,
    592864, 592867, 592873, 592935, 592936, 592939, 592940, 592943, 592969, 593000, 593002, 593007,
    593009, 593015, 593017, 593018, 593021, 593022, 593023, 593024, 593026, 593027, 593031, 593033,
    593034, 593036, 593037, 593038, 593040, 593041, 593042, 593043, 593044, 593045, 593484, 593485,
    593486, 593487, 593488, 593489, 593493, 593494, 593497, 593499, 593501, 593502, 593503, 593504,
    594807, 594809, 594811, 594815, 594816, 594819, 594821, 594824, 594829, 594835, 594842, 594844,
    594845, 594847, 594848, 594849, 594855, 595302, 595303, 595304, 595305, 595306, 595308, 595309,
    595310, 595613, 595614, 595615, 595617, 595618, 595661, 595662, 595663, 595664, 595666, 595667,
    595670, 595671, 595672, 608228, 608231, 608252, 629842, 630954, 633902, 636494, 638307, 650308,
    661182, 661637, 661638, 661639, 661640, 661641, 669051, 669060, 669064, 669066, 669067, 669070,
    669112, 669114, 669137, 669138, 669140, 669141, 669142, 669143, 677964, 678277, 688033, 691112,
    691113, 691159, 691162, 691164, 697683, 701753, 701754, 701755, 701756, 701757, 701758, 701760,
    701762, 701763, 701764, 701768, 701770, 701772, 701773, 701780, 701782, 701783, 701785, 756397,
    756398, 756399, 756400, 756401, 756402, 756403, 756404, 756405, 756406, 756407, 756408, 756409,
    756410, 756411, 756412, 756413, 756414, 756415, 756416, 756417, 756418, 756419, 756420, 756421,
    756422, 756423, 756424, 756425, 756426, 756427, 756428, 756429, 756430, 756431, 756432, 756433,
    756434, 756435, 756436, 756437, 756438, 756439, 756440, 756441, 756442, 756443, 756444, 756445,
    756446, 756447, 756448, 756449, 756450, 756451, 756452, 756453, 756454, 756455, 756456, 756457,
    756458, 756459, 756460, 756461, 756462, 756463, 756464, 756465, 756466, 756467, 756468, 756469,
    756470, 756471, 756472, 756473, 756474, 756475, 756476, 756477, 756478, 756479, 756480, 756481,
    756482, 756483, 756484, 756485, 756486, 756487, 756488, 756489, 756490, 756491, 756492, 756493,
    756494, 756495, 756496, 756497, 756498, 756499, 756500, 756501, 756502, 756503, 756504, 756505,
    756506, 756507, 756508, 756509, 756510, 756511, 756512, 756513, 756514, 756515, 756516, 756517,
    756518, 756519, 756520, 756521, 756522, 756523, 756524, 756525, 756526, 756527, 756528, 756529,
    756530, 756531, 756532, 756533, 756534, 756535, 756536, 756537, 756538, 756539, 756540, 756541,
    756542, 756543, 756544, 756545, 756546, 756547, 756548, 756549, 756550, 756551, 756552, 756553,
    756554, 756555, 756556, 786299, 786325, 788354, 788358, 789518, 422010500,
]


def build_kayal_trendlyne_urls() -> list[EndpointSpec]:
    specs: list[EndpointSpec] = []
    for pk in KAYAL_SCREENER_PKS:
        specs.append({
            "domain": "kayal_trendlyne",
            "category": "screeners",
            "subcategory": "kayal_allone",
            "url": (
                f"https://kayal.trendlyne.com/broker-webview/kayal/"
                f"all-in-one-screener-data-get/?perPageCount=200&pageNumber=0"
                f"&screenpk={pk}&groupType=all&groupName="
            ),
        })
    return specs


# ─── ETMarkets / IndiasTimes ──────────────────────────────────────────────────

# Sample identifiers: WIPRO companyid=13538, bsecode=507685, nsecode=WIPRO
_ET_COMPANY_ID = "13538"
_ET_BSE_CODE = "507685"
_ET_NSE_CODE = "WIPRO"

# Sample index: SENSEX
_ET_INDEX_ID = "1"

ET_MARKET_INDICES = ["SENSEX", "NIFTY", "BANKNIFTY", "NIFTYMIDCAP100"]


def build_et_markets_urls() -> list[EndpointSpec]:
    specs: list[EndpointSpec] = []

    def add(cat: str, sub: str, url: str) -> None:
        specs.append({"domain": "etmarkets", "category": cat,
                      "subcategory": sub, "url": url})

    # Shareholding
    add("stock_detail", "et_shareholding",
        f"https://marketservices.indiatimes.com/markets/api/shareholding/v4/shareholding.cms"
        f"?companyId={_ET_COMPANY_ID}&type=total&flag=1")

    # MF investments in a stock
    add("stock_detail", "et_mf_investments",
        f"https://mfapps.indiatimes.com/ET_Mutual_Funds/pages/mftools/MFPortfolioHolding.cms"
        f"?bsecode={_ET_BSE_CODE}&nsecode={_ET_NSE_CODE}&prime=N&flag=1")

    # Industry / sector tree
    add("market", "et_industry_list",
        "https://json.bselivefeeds.indiatimes.com/ET_Community/getcategorylist.cms?flag=industry&eid=12")
    add("market", "et_sector_list",
        "https://json.bselivefeeds.indiatimes.com/ET_Community/getcategorylist.cms?flag=sector")
    add("market", "et_index_summary",
        f"https://json.bselivefeeds.indiatimes.com/ET_Community/getIndexSummary.cms?indexId={_ET_INDEX_ID}")

    # Screeners / trending
    add("screeners", "et_trending_stocks",
        "https://etmarketsapis.indiatimes.com/ET_Stats/trendingStocks?mktcap=0&exchange=NSE&count=20&flag=1")
    add("screeners", "et_52w_high",
        "https://etmarketsapis.indiatimes.com/ET_Stats/weekHigh52?exchange=NSE&count=20&flag=1")
    add("screeners", "et_52w_low",
        "https://etmarketsapis.indiatimes.com/ET_Stats/weekLow52?exchange=NSE&count=20&flag=1")
    add("screeners", "et_top_gainers",
        "https://etmarketsapis.indiatimes.com/ET_Stats/topGainers?exchange=NSE&count=20&flag=1&mktcap=0")
    add("screeners", "et_top_losers",
        "https://etmarketsapis.indiatimes.com/ET_Stats/topLosers?exchange=NSE&count=20&flag=1&mktcap=0")
    add("screeners", "et_most_active_value",
        "https://etmarketsapis.indiatimes.com/ET_Stats/mostActiveByValue?exchange=NSE&count=20&flag=1")
    add("screeners", "et_most_active_volume",
        "https://etmarketsapis.indiatimes.com/ET_Stats/mostActiveByVolume?exchange=NSE&count=20&flag=1")
    add("screeners", "et_penny_stocks",
        "https://etmarketsapis.indiatimes.com/ET_Stats/pennyStocks?exchange=NSE&count=20&flag=1")

    # Market BSE/NSE JSON feeds
    add("market", "et_bse_market_json",
        "https://sas.indiatimes.com/ET_Community/getBSEMarketJSON.cms?flag=1")
    add("market", "et_nse_market_json",
        "https://sas.indiatimes.com/ET_Community/getNSEMarketJSON.cms?flag=1")

    # Technical screener
    add("screeners", "et_technical_screener",
        f"https://sas.indiatimes.com/ET_Community/getTechScreenerJSON.cms"
        f"?screener=RSI_OVERSOLD&exchange=NSE&flag=1")

    # RSI screener variants
    for screener in ("RSI_OVERBOUGHT", "RSI_OVERSOLD", "MACD_BUY", "MACD_SELL"):
        add("screeners", f"et_tech_{screener.lower()}",
            f"https://sas.indiatimes.com/ET_Community/getTechScreenerJSON.cms"
            f"?screener={screener}&exchange=NSE&flag=1")

    # Sector performance
    add("market", "et_sector_performance",
        "https://etmarketsapis.indiatimes.com/ET_Stats/sectorPerformance?exchange=NSE&flag=1")

    # Company data (stock detail)
    add("stock_detail", "et_company_data",
        f"https://marketservices.indiatimes.com/markets/api/companydetails/v4/companydetails.cms"
        f"?companyId={_ET_COMPANY_ID}&flag=1")

    # Market band (circuit limits)
    add("market", "et_market_band",
        "https://etmarketsapis.indiatimes.com/ET_Stats/marketBand?exchange=NSE&flag=1")

    # ET recommendations feed
    add("screeners", "et_recommendations",
        f"https://economictimes.indiatimes.com/viewandrecofeed.cms"
        f"?companyid={_ET_COMPANY_ID}&type=reco&count=5&flag=1")

    return specs


# ─── Finology ─────────────────────────────────────────────────────────────────

# Sample: WIPRO fincode=107685, scripcode=507685
_FINOLOGY_FINCODE = "107685"
_FINOLOGY_SCRIPCODE = "507685"
_FINOLOGY_SYMBOL = "WIPRO"


def build_finology_urls() -> list[EndpointSpec]:
    specs: list[EndpointSpec] = []

    def add(cat: str, sub: str, url: str) -> None:
        specs.append({"domain": "finology", "category": cat,
                      "subcategory": sub, "url": url})

    base = "https://ticker.finology.in"
    add("stock_detail", "finology_company",
        f"{base}/Company/GetCompanyDetails?fincode={_FINOLOGY_FINCODE}")
    add("stock_detail", "finology_peers",
        f"{base}/Company/GetPeers?fincode={_FINOLOGY_FINCODE}")
    add("stock_detail", "finology_quarterly",
        f"{base}/Company/GetQuarterlyResults?fincode={_FINOLOGY_FINCODE}")
    add("stock_detail", "finology_annual",
        f"{base}/Company/GetAnnualResults?fincode={_FINOLOGY_FINCODE}")
    add("stock_detail", "finology_price_history",
        f"{base}/Company/GetPriceHistory?fincode={_FINOLOGY_FINCODE}&period=1y")
    add("stock_detail", "finology_shareholding",
        f"{base}/Company/GetShareholding?fincode={_FINOLOGY_FINCODE}")
    add("stock_detail", "finology_ratios",
        f"{base}/Company/GetKeyRatios?fincode={_FINOLOGY_FINCODE}")
    add("screeners", "finology_screener",
        f"{base}/Screener/GetScreenerData?page=1&pagesize=25&sortby=mktcap&order=desc")
    add("market", "finology_indices",
        f"{base}/Market/GetIndices")
    add("market", "finology_top_gainers",
        f"{base}/Market/GetTopGainers?exchange=NSE&count=10")
    add("market", "finology_top_losers",
        f"{base}/Market/GetTopLosers?exchange=NSE&count=10")

    return specs


# ─── MarketsMojo ──────────────────────────────────────────────────────────────

_MM_SYMBOL = "NIFTY"   # index sample
_MM_STOCK = "WIPRO"    # stock sample

MM_INDICES = ["NIFTY", "BANKNIFTY", "NIFTYMIDCAP100", "NIFTYSMALLCAP100"]


def build_marketsmojo_urls() -> list[EndpointSpec]:
    specs: list[EndpointSpec] = []

    def add(cat: str, sub: str, url: str) -> None:
        specs.append({"domain": "marketsmojo", "category": cat,
                      "subcategory": sub, "url": url})

    frapi = "https://frapi.marketsmojo.com"

    # Market overview
    add("market", "mm_overview",
        f"{frapi}/api/v1/market/overview/")

    # Index price graphs
    for idx in MM_INDICES:
        add("indices", "mm_index_graph",
            f"{frapi}/api/v1/market/index-graph/?index={idx}&period=1m")

    # Top gainers / losers
    add("screeners", "mm_top_gainers",
        f"{frapi}/api/v1/market/top-gainers/?exchange=NSE&count=20")
    add("screeners", "mm_top_losers",
        f"{frapi}/api/v1/market/top-losers/?exchange=NSE&count=20")

    # Events & results
    add("market", "mm_events",
        f"{frapi}/api/v1/market/events/?days=7")
    add("market", "mm_results_calendar",
        f"{frapi}/api/v1/market/results-calendar/?days=7")

    # Screener
    add("screeners", "mm_screener",
        f"{frapi}/api/v1/screener/results/?preset=quality_stocks&page=1&page_size=25")
    add("screeners", "mm_screener_momentum",
        f"{frapi}/api/v1/screener/results/?preset=momentum_stocks&page=1&page_size=25")
    add("screeners", "mm_screener_oversold",
        f"{frapi}/api/v1/screener/results/?preset=oversold_stocks&page=1&page_size=25")

    # Stock detail
    add("stock_detail", "mm_stock_detail",
        f"{frapi}/api/v1/stock/{_MM_STOCK}/detail/")
    add("stock_detail", "mm_stock_technicals",
        f"{frapi}/api/v1/stock/{_MM_STOCK}/technicals/")
    add("stock_detail", "mm_stock_fundamentals",
        f"{frapi}/api/v1/stock/{_MM_STOCK}/fundamentals/")

    return specs


# ─── NiftyTrader (GET-only) ───────────────────────────────────────────────────

# POST-only endpoints skipped: stock analysis, financials, profile, chart

def build_niftytrader_urls() -> list[EndpointSpec]:
    specs: list[EndpointSpec] = []

    def add(cat: str, sub: str, url: str) -> None:
        specs.append({"domain": "niftytrader", "category": cat,
                      "subcategory": sub, "url": url})

    base = "https://www.niftytrader.in/webapis"

    # Active stocks
    add("screeners", "nt_active_stock_list",
        f"{base}/activeStockList?type=nse&sortby=value&order=desc&count=25")

    # Top gainers / losers
    add("screeners", "nt_top_gainers",
        f"{base}/top-gainers?exchange=NSE&count=25")
    add("screeners", "nt_top_losers",
        f"{base}/top-losers?exchange=NSE&count=25")

    # Industry tab
    add("market", "nt_industry_tab",
        f"{base}/industryTab?exchange=NSE")

    # Nifty 50 constituents
    add("indices", "nt_nifty50",
        f"{base}/nifty50?type=nse")

    # Watchlist intraday
    add("market", "nt_watchlist_intraday",
        f"{base}/watchlistIntraday?symbols=NIFTY,BANKNIFTY,RELIANCE,TCS&exchange=NSE")

    # Live charts (1-minute OHLCV)
    add("market", "nt_live_charts",
        f"{base}/liveCharts?symbol=NIFTY&exchange=NSE&interval=1")

    # Adjusted OHLC (historical)
    add("stock_detail", "nt_adjusted_ohlc",
        f"{base}/adjustedOHLC?symbol=WIPRO&exchange=NSE&period=1y")

    # Top stocks list (broader than active)
    add("screeners", "nt_top_stocks_list",
        f"{base}/topStocksList?exchange=NSE&sortby=volume&order=desc&count=25")

    # Dashboard data
    add("market", "nt_dashboard_data",
        f"{base}/dashboardData?exchange=NSE")

    # Global stock quotes
    add("market", "nt_global_stock",
        f"{base}/globalStock?type=us")

    # Gap updates / analysis
    add("screeners", "nt_gap_updates",
        f"{base}/gapUpdates?exchange=NSE&type=gap_up&count=20")
    add("screeners", "nt_gap_analysis",
        f"{base}/gapAnalysis?exchange=NSE&type=gap_up&count=20")

    return specs


# ─── StockEdge ────────────────────────────────────────────────────────────────

# Sample: WIPRO stockId=2553
_SE_STOCK_ID = "2553"
_SE_SYMBOL = "WIPRO"

SE_EXCHANGES = ["NSE", "BSE"]


def build_stockedge_urls() -> list[EndpointSpec]:
    specs: list[EndpointSpec] = []

    def add(cat: str, sub: str, url: str) -> None:
        specs.append({"domain": "stockedge", "category": cat,
                      "subcategory": sub, "url": url})

    base = "https://api.stockedge.com/Api"

    # Technical alerts / signals
    add("screeners", "se_technicals",
        f"{base}/DailyDashboardApi/GetEODStockTechnicalsForEachSector/1?lang=en")
    add("screeners", "se_high_delivery",
        f"{base}/DailyDashboardApi/GetEODHighDeliveryStocks/1?lang=en")
    add("screeners", "se_price_change_types",
        f"{base}/DailyDashboardApi/GetEODPriceChangeTypes?lang=en")

    # Sector peers
    add("stock_detail", "se_sector_peers",
        f"{base}/SecurityDashboardApi/GetSecuritySectorPeers/{_SE_STOCK_ID}?lang=en")

    # Meta detail (company info)
    add("stock_detail", "se_meta_detail",
        f"{base}/SecurityDashboardApi/GetSecurityMetaDetail/{_SE_STOCK_ID}?lang=en")

    # Exchanges list
    add("market", "se_exchanges",
        f"{base}/SecurityDashboardApi/GetExchanges?lang=en")

    # Alerts for a stock
    add("stock_detail", "se_alerts",
        f"{base}/SecurityDashboardApi/GetSecurityAlerts/{_SE_STOCK_ID}?lang=en")

    # Screener results
    add("screeners", "se_screener_quality",
        f"{base}/ScreenerDashboardApi/GetScreenerResults?screenerId=1&page=1&pageSize=25&lang=en")
    add("screeners", "se_screener_momentum",
        f"{base}/ScreenerDashboardApi/GetScreenerResults?screenerId=2&page=1&pageSize=25&lang=en")

    # Top gainers / losers (EOD)
    add("screeners", "se_eod_gainers",
        f"{base}/DailyDashboardApi/GetEODTopGainers/NSE?lang=en")
    add("screeners", "se_eod_losers",
        f"{base}/DailyDashboardApi/GetEODTopLosers/NSE?lang=en")

    return specs


# ─── Trading80 (GET-only) ─────────────────────────────────────────────────────

# POST-only endpoints (call analysis, chart data) are skipped

def build_trading80_urls() -> list[EndpointSpec]:
    specs: list[EndpointSpec] = []

    def add(cat: str, sub: str, url: str) -> None:
        specs.append({"domain": "trading80", "category": cat,
                      "subcategory": sub, "url": url})

    base = "https://trading80.com/api"

    # Market overview
    add("market", "t80_market_overview",
        f"{base}/market/overview?exchange=NSE")

    # Top gainers / losers
    add("screeners", "t80_top_gainers",
        f"{base}/market/topgainers?exchange=NSE&count=20")
    add("screeners", "t80_top_losers",
        f"{base}/market/toplosers?exchange=NSE&count=20")

    # Most active
    add("screeners", "t80_most_active",
        f"{base}/market/mostactive?exchange=NSE&count=20&sortby=value")

    # Index data
    add("indices", "t80_indices",
        f"{base}/market/indices?exchange=NSE")

    # Sector performance
    add("market", "t80_sector_performance",
        f"{base}/market/sectorperformance?exchange=NSE")

    # 52-week high / low
    add("screeners", "t80_52w_high",
        f"{base}/screener/52weekhigh?exchange=NSE&count=20")
    add("screeners", "t80_52w_low",
        f"{base}/screener/52weeklow?exchange=NSE&count=20")

    # Global markets
    add("market", "t80_global_markets",
        f"{base}/market/global")

    return specs


# ─── Fetch Engine ─────────────────────────────────────────────────────────────

def fetch_one(session: requests.Session, spec: EndpointSpec) -> dict:
    """Fetch a single endpoint and return a DB row dict."""
    row = {
        "domain":      spec["domain"],
        "category":    spec["category"],
        "subcategory": spec["subcategory"],
        "url":         spec["url"],
        "http_status": None,
        "latency_ms":  None,
        "top_keys":    "[]",
        "item_count":  None,
        "raw_json":    None,
        "error_msg":   None,
        "fetched_at":  datetime.datetime.utcnow().isoformat(),
    }
    try:
        t0 = time.monotonic()
        resp = session.get(spec["url"], headers=HEADERS, timeout=TIMEOUT)
        row["latency_ms"] = int((time.monotonic() - t0) * 1000)
        row["http_status"] = resp.status_code
        if resp.status_code == 200 and resp.text.strip():
            row["raw_json"] = resp.text
            row["top_keys"] = extract_top_keys(resp.text)
            row["item_count"] = extract_item_count(resp.text)
        elif resp.status_code != 200:
            row["error_msg"] = f"HTTP {resp.status_code}"
    except requests.exceptions.Timeout:
        row["error_msg"] = "timeout"
    except Exception as exc:
        row["error_msg"] = str(exc)[:200]
    return row


def fetch_all(
    specs: list[EndpointSpec],
    conn: sqlite3.Connection,
    limit: Optional[int] = None,
) -> None:
    """Fetch all specs concurrently, batch-write to DB, print progress."""
    if limit:
        specs = specs[:limit]

    total = len(specs)
    done = 0
    buffer: list[dict] = []

    print(f"Fetching {total} URLs with concurrency={CONCURRENCY}...", flush=True)
    t_start = time.monotonic()

    with requests.Session() as session:
        with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
            futures = {pool.submit(fetch_one, session, spec): spec for spec in specs}
            for future in as_completed(futures):
                row = future.result()
                buffer.append(row)
                done += 1
                if len(buffer) >= BATCH_SIZE:
                    insert_rows(conn, buffer)
                    buffer.clear()
                if done % 100 == 0 or done == total:
                    elapsed = time.monotonic() - t_start
                    pct = done / total * 100
                    print(f"  {done}/{total} ({pct:.0f}%) — {elapsed:.0f}s elapsed", flush=True)

    if buffer:
        insert_rows(conn, buffer)

    elapsed = time.monotonic() - t_start
    print(f"Done. {total} URLs in {elapsed:.1f}s", flush=True)


# ─── Summary Report ───────────────────────────────────────────────────────────

def print_summary(conn: sqlite3.Connection) -> None:
    total    = conn.execute("SELECT COUNT(*) FROM api_responses").fetchone()[0]
    success  = conn.execute(
        "SELECT COUNT(*) FROM api_responses WHERE http_status=200 AND raw_json IS NOT NULL"
    ).fetchone()[0]
    failed   = conn.execute(
        "SELECT COUNT(*) FROM api_responses WHERE http_status IS NULL OR http_status != 200"
    ).fetchone()[0]
    empty    = conn.execute(
        "SELECT COUNT(*) FROM api_responses WHERE http_status=200 AND raw_json IS NULL"
    ).fetchone()[0]
    avg_ms   = conn.execute(
        "SELECT AVG(latency_ms) FROM api_responses WHERE latency_ms IS NOT NULL"
    ).fetchone()[0] or 0

    print("\n" + "=" * 70)
    print("MC + TL EXPLORATION SUMMARY")
    print("=" * 70)
    print(f"Total calls : {total}")
    print(f"Success     : {success}  (HTTP 200 + non-empty body)")
    print(f"Failed      : {failed}  (non-200 or network error)")
    print(f"Empty       : {empty}   (HTTP 200 but no body)")
    print(f"Avg latency : {avg_ms:.0f}ms")

    print("\n--- CATEGORY BREAKDOWN ---")
    hdr = f"{'domain':<15} {'category':<15} {'subcategory':<30} {'tot':>4} {'ok':>4} {'fail':>4} {'empty':>5} {'ms':>6}  sample_keys"
    print(hdr)
    print("-" * len(hdr))

    rows = conn.execute("""
        SELECT
            domain, category, subcategory,
            COUNT(*) AS tot,
            SUM(CASE WHEN http_status=200 AND raw_json IS NOT NULL THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN http_status IS NULL OR http_status != 200 THEN 1 ELSE 0 END) AS fail,
            SUM(CASE WHEN http_status=200 AND raw_json IS NULL THEN 1 ELSE 0 END) AS empty,
            CAST(AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END) AS INT) AS avg_ms,
            (SELECT top_keys FROM api_responses a2
             WHERE a2.domain=a1.domain AND a2.category=a1.category
               AND a2.subcategory=a1.subcategory AND a2.raw_json IS NOT NULL
             LIMIT 1) AS sample_keys
        FROM api_responses a1
        GROUP BY domain, category, subcategory
        ORDER BY domain, category, subcategory
    """).fetchall()

    for r in rows:
        domain, cat, sub, tot, ok, fail, empty, avg, keys = r
        print(f"{domain:<15} {cat:<15} {sub:<30} {tot:>4} {ok:>4} {fail:>4} {empty:>5} {avg or 0:>6}  {keys or '[]'}")

    print("\n--- FAILURES BY STATUS ---")
    status_rows = conn.execute("""
        SELECT COALESCE(CAST(http_status AS TEXT), 'network/timeout') AS status,
               COUNT(*) AS cnt
        FROM api_responses
        WHERE http_status IS NULL OR http_status != 200
        GROUP BY status ORDER BY cnt DESC
    """).fetchall()
    for status, cnt in status_rows:
        print(f"  HTTP {status} -> {cnt} URLs")

    print("\n--- EMPTY RESPONSES (200 but no body) ---")
    empty_rows = conn.execute("""
        SELECT domain, subcategory, url
        FROM api_responses
        WHERE http_status=200 AND raw_json IS NULL
        LIMIT 20
    """).fetchall()
    for domain, sub, url in empty_rows:
        print(f"  [{domain}] {sub}: {url[:90]}")

    print("=" * 70 + "\n")

# ─── Main ─────────────────────────────────────────────────────────────────────

def build_all_specs() -> list[EndpointSpec]:
    specs: list[EndpointSpec] = []
    specs.extend(build_index_urls())
    specs.extend(build_stock_urls("BE03"))
    specs.extend(build_market_intel_urls())
    specs.extend(build_screener_urls())
    specs.extend(build_trendlyne_urls())
    specs.extend(build_kayal_trendlyne_urls())
    specs.extend(build_et_markets_urls())
    specs.extend(build_finology_urls())
    specs.extend(build_marketsmojo_urls())
    specs.extend(build_niftytrader_urls())
    specs.extend(build_stockedge_urls())
    specs.extend(build_trading80_urls())
    return specs


def main() -> None:
    parser = argparse.ArgumentParser(description="MC + Trendlyne data exploration")
    parser.add_argument("--db",    default="mc_tl_explore.db",
                        help="SQLite output path (default: mc_tl_explore.db)")
    parser.add_argument("--limit", type=int, default=None,
                        help="Limit to first N URLs (for testing)")
    parser.add_argument("--count", action="store_true",
                        help="Print URL count by category and exit without fetching")
    args = parser.parse_args()

    specs = build_all_specs()

    if args.count:
        from collections import Counter
        print(f"Total URLs: {len(specs)}")
        for (dom, cat, sub), cnt in sorted(
            Counter((s["domain"], s["category"], s["subcategory"]) for s in specs).items()
        ):
            print(f"  {dom}/{cat}/{sub}: {cnt}")
        return

    conn = create_db(args.db)
    fetch_all(specs, conn, limit=args.limit)
    print_summary(conn)
    conn.close()
    print(f"Raw data saved to: {args.db}")


if __name__ == "__main__":
    main()
