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

GRAPH_RANGES = ["1d", "5d", "1m", "3m", "6m", "1yr", "2yr", "5yr"]
TECH_PERIODS = ["D", "W", "M"]
HIST_RATING_PERIODS = ["D", "W"]


def _enc(symbol):
    """URL-encode index symbol: 'in;NSX' -> 'in%3BNSX'."""
    return quote(symbol, safe="")


def build_index_urls():
    specs = []

    specs.append({"domain": "moneycontrol", "category": "indices",
                  "subcategory": "indices_list",
                  "url": "https://api.moneycontrol.com/mcapi/v1/indices/get-indices-list"})
    specs.append({"domain": "moneycontrol", "category": "indices",
                  "subcategory": "indices_list",
                  "url": "https://api.moneycontrol.com/mcapi/v1/indices/get-indian-indices"})
    specs.append({"domain": "moneycontrol", "category": "indices",
                  "subcategory": "advance_decline",
                  "url": "https://api.moneycontrol.com/mcapi/v1/indices/chart/exchange-advdec?ex=N"})

    for idx in INDICES:
        sym = idx["symbol"]
        ind_id = idx["id"]
        enc = _enc(sym)

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

        for rng in GRAPH_RANGES:
            specs.append({"domain": "moneycontrol", "category": "indices",
                          "subcategory": "index_graph",
                          "url": f"https://appfeeds.moneycontrol.com/jsonapi/market/graph&format=json&ind_id={ind_id}&range={rng}&type=line"})

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
        print(f"  HTTP {status} → {cnt} URLs")

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
