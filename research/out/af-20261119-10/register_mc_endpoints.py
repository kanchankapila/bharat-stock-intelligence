"""Register the Moneycontrol endpoints from docs/audits/2026-11-19-moneycontrol-endpoint-evaluation.md
in market_endpoint_registry (AF-20261119-10), using a live probe for status/bytes/latency/fields.

market_endpoint_registry is rebuilt from scratch by urls-explorer's scratch/build_pg_registry.py
(DROP TABLE), so these rows (uid prefix GET::) are lost on a rebuild: re-run this script afterwards.

    python research/out/af-20261119-10/register_mc_endpoints.py <probe.json>
"""
import json
import sys

sys.path.insert(0, "src/server")
import db_compat  # noqa: E402

# name -> (data_domain, category, scope, update_frequency, verdict/use_case)
META = {
    "getFnoOiTrends": ("FNO_DERIVATIVES", "Derivatives & F&O Analytics", "MARKET_WIDE", "INTRADAY_STREAM",
                       "All F&O stocks in one call (limit=1000): OI, OI % change, price, volume, buildup label, ALL expiries summed. Verdict USE if AF-20261119-09 shows near-month OI is rollover-distorted; snapshot only."),
    "upwardpotential": ("EQUITY", "News & Sentiment", "MARKET_WIDE", "EVENT_DRIVEN",
                        "HTML widget: broker BUY recos with upside. Same calls as broker-research; SKIP (MC broker BUYs graded -1.22% 20d excess)."),
    "getMostActiveData": ("EQUITY", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM",
                          "HTML widget: most active stocks by traded value. Covered by movers/turnover feeds; SKIP."),
    "stockaction/technicalTrends": ("EQUITY", "Technical Indicators & Intraday", "MARKET_WIDE", "INTRADAY_STREAM",
                                    "HTML widget: current vs previous MC technical trend label per stock. MC technical ratings already read via mcApiService; SKIP."),
    "stockaction/topGainers": ("EQUITY", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM", "HTML widget: top gainers. Covered by mover_screener_fetcher; SKIP."),
    "stockaction/priceShockers": ("EQUITY", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM", "HTML widget: price shockers. Covered by the MC price-shockers JSON feed; SKIP."),
    "prostocklist": ("EQUITY", "Screener & Quantitative Scans", "MARKET_WIDE", "DAILY_EOD", "HTML widget: MC Pro stock lists (styling + list names). SKIP."),
    "mc_widgets/radar": ("EQUITY", "News & Sentiment", "MARKET_WIDE", "INTRADAY_STREAM", "HTML widget: stocks in news / last visited. SKIP."),
    "get-bse-reports": ("EQUITY", "Corporate Actions & Governance", "SINGLE_STOCK", "EVENT_DRIVEN",
                        "Annual report + quarterly result announcements per stock (scId). Covered by NSE Integrated Filing (nse_results_filings); SKIP."),
    "peers/landing": ("EQUITY", "Fundamental Financials & Valuation", "SINGLE_STOCK", "DAILY_EOD", "Peer list by market cap (protobuf). Sector peers in nse_stocks; SKIP."),
    "returns/stock": ("EQUITY", "Price & Technical Charts", "SINGLE_STOCK", "DAILY_EOD", "Trailing absolute returns (9 windows). Derivable from stock_ohlcv; SKIP."),
    "check-forecast": ("EQUITY", "Fundamental Financials & Valuation", "SINGLE_STOCK", "EVENT_DRIVEN",
                       "Boolean only ({data:true}): whether MC has analyst estimates for the stock. No data; SKIP."),
    "changeTableData": ("EQUITY", "Indices & Market Breadth", "INDEX", "INTRADAY_STREAM",
                        "HTML: index constituents with LTP, %chg, volume, bid/ask and MC technical rating. Covered by price feeds; SKIP."),
    "usMarket/bond": ("MACRO", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM", "Live India G-sec yield (GIND5Y/10Y). ALTERNATE for global_macro_fetcher INDIA_10Y."),
    "techCharts/intra": ("EQUITY", "Price & Technical Charts", "SINGLE_STOCK", "INTRADAY_STREAM", "1-minute bars, close only (time,value). No OHLC/volume; SKIP."),
    "explore-market": ("EQUITY", "Market Data", "MARKET_WIDE", "DAILY_EOD", "App navigation tiles. SKIP."),
    "multi-asset-info": ("EQUITY", "Indices & Market Breadth", "MARKET_WIDE", "INTRADAY_STREAM", "Batch index quotes (protobuf; schema public). Covered by price feeds; SKIP."),
    "stats/gainer": ("EQUITY", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM", "Index gainers with OHLC/VWAP (protobuf). Covered by mover_screener_fetcher; SKIP."),
    "stats/52-week-high": ("EQUITY", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM", "52-week highs (protobuf). Derivable from stock_ohlcv; SKIP."),
    "get_opt_chain": ("FNO_DERIVATIVES", "Derivatives & F&O Analytics", "INDEX", "INTRADAY_STREAM", "HTML option chain. JSON get-option-details is better; SKIP."),
    "get-option-details": ("FNO_DERIVATIVES", "Derivatives & F&O Analytics", "INDEX", "INTRADAY_STREAM",
                           "Full option chain with premium + IV per strike (indices and stocks via scId/assetType). ALTERNATE for nse_option_chain_source / stock_option_chain_fetcher."),
    "multi-strike-chart": ("FNO_DERIVATIVES", "Derivatives & F&O Analytics", "INDEX", "INTRADAY_STREAM", "Intraday price by contract (5-min). ALTERNATE only."),
    "totaloi-pcr-chart": ("FNO_DERIVATIVES", "Derivatives & F&O Analytics", "INDEX", "DAILY_EOD",
                          "Daily call/put OI and PCR, last ~10 sessions of the current expiry only (count ignored). Cannot backfill PCR before 2026-06-30; SKIP."),
    "max-pain-chart": ("FNO_DERIVATIVES", "Derivatives & F&O Analytics", "INDEX", "INTRADAY_STREAM", "Pain per strike + max pain. ALTERNATE for so_option_chain max_pain."),
    "stock/search": ("EQUITY", "Market Data", "MARKET_WIDE", "EVENT_DRIVEN", "Symbol -> MC id search. ID-resolution aid only, never the first source (data-sources.md)."),
    "ipo/calendar-data": ("EQUITY", "Corporate Actions & Governance", "MARKET_WIDE", "EVENT_DRIVEN", "IPO open/close/allotment/listing dates (dates are YYYY-DD-MM). Covered by nse_ipo_calendar_fetcher; SKIP."),
    "economic-widget": ("MACRO", "News & Sentiment", "MARKET_WIDE", "EVENT_DRIVEN", "HTML economic calendar. Covered by india_macro_fetcher; SKIP."),
    "get-indicator-details": ("MACRO", "Market Data", "MARKET_WIDE", "EVENT_DRIVEN", "17 India macro indicators; values empty on 2026-11-19. SKIP."),
    "commodityindex": ("COMMODITY", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM", "MCX commodity index quote. ALTERNATE only."),
    "etf/getListingData": ("EQUITY", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM", "ETF prices by category (gold, etc.) with ISIN. ALTERNATE only."),
    "getMajorCommodities": ("COMMODITY", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM", "MCX major commodity futures. ALTERNATE for macro_asset_prices CRUDE/GOLD."),
    "commodity/getMarketStats": ("COMMODITY", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM", "MCX market stats tab list. ALTERNATE only."),
    "commodity/abValue": ("COMMODITY", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM", "MCX contracts with OI and OI change. ALTERNATE only."),
    "getGlobalCurrencyRates": ("MACRO", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM", "Global FX rates. ALTERNATE for macro_asset_prices USDINR."),
    "usMarket/currency": ("MACRO", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM", "DXY and currency quotes. ALTERNATE for macro_asset_prices DXY."),
    "currencyfuture": ("MACRO", "Derivatives & F&O Analytics", "MARKET_WIDE", "INTRADAY_STREAM", "NSE currency futures quote. ALTERNATE only."),
    "bonds/list": ("MACRO", "Market Data", "MARKET_WIDE", "DAILY_EOD", "Corporate bond list with price, yield, rating, coupon. SKIP (no consumer)."),
    "market-terminal/category": ("EQUITY", "Indices & Market Breadth", "MARKET_WIDE", "EVENT_DRIVEN", "MC index id catalogue. ID-resolution aid (load_index_map)."),
    "news/indices": ("EQUITY", "News & Sentiment", "MARKET_WIDE", "INTRADAY_STREAM", "Index news headlines. SKIP."),
    "getAllIndexContribution": ("EQUITY", "Indices & Market Breadth", "INDEX", "DAILY_EOD",
                                "Per index: positive / negative / net points contributed. fromDate=previous session, toDate=session gives one day; history reaches ~late 2023 (2023-12-05 ok, 2023-09-05 refused). MEASURE as a regime conditioner (AF-20261119-10)."),
    "broker-research/stock-ideas": ("EQUITY", "News & Sentiment", "MARKET_WIDE", "EVENT_DRIVEN",
                                    "~9,400 broker calls since 2024-02 with recommended price, target, target date. Same calls as mc_broker_reco_fetcher; SKIP (graded -1.22% 20d excess)."),
    "marketturnover/tabs": ("EQUITY", "Market Data", "MARKET_WIDE", "INTRADAY_STREAM", "Market turnover tab list (protobuf). SKIP."),
}

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
           "Referer": "https://www.moneycontrol.com/", "Accept": "application/json, text/plain, */*"}

probe = json.load(open(sys.argv[1], encoding="utf-8"))
missing = [p["name"] for p in probe if p["name"] not in META]
assert not missing, missing
assert all(p.get("status") == 200 for p in probe), [p["name"] for p in probe if p.get("status") != 200]

conn = db_compat.connect()
n = 0
for p in probe:
    dom, cat, scope, freq, use = META[p["name"]]
    url = p["url"]
    params = sorted({kv.split("=")[0] for kv in url.split("?", 1)[1].split("&")}) if "?" in url else []
    fields = p.get("item_keys") or (p["top_keys"] if isinstance(p.get("top_keys"), list) else [])
    fmt = {"JSON": "JSON", "HTML": "HTML", "PROTOBUF": "PROTOBUF"}.get(p.get("format"), "TEXT")
    sample = (f"list {p.get('list_path')} n={p.get('list_len')}; dates {p.get('date_range')}" if fmt == "JSON"
              else (p.get("text_sample") or "")[:200])
    n += conn.execute(
        """INSERT INTO market_endpoint_registry
           (uid, endpoint_name, provider, data_domain, category, sub_category, scope, update_frequency, use_case,
            http_method, target_url, url_template, required_params, request_headers, output_data_format, output_fields,
            auth_type, http_status_code, is_working, response_bytes, response_kb, latency_ms, sample_info, validated_at)
           VALUES (?, ?, 'Moneycontrol', ?, ?, 'mc_endpoint_evaluation_2026_11_19', ?, ?, ?, 'GET', ?, ?, ?, CAST(? AS jsonb), ?, ?,
                   'NONE', 200, true, ?, ?, ?, ?, now())
           ON CONFLICT (uid) DO UPDATE SET use_case = EXCLUDED.use_case, response_bytes = EXCLUDED.response_bytes,
             response_kb = EXCLUDED.response_kb, latency_ms = EXCLUDED.latency_ms, sample_info = EXCLUDED.sample_info,
             output_fields = EXCLUDED.output_fields, validated_at = now()""",
        (f"GET::{url}", p["name"], dom, cat, scope, freq, use, url, url.split("?")[0], params, json.dumps(HEADERS),
         fmt, fields, p["bytes"], round(p["bytes"] / 1024, 2), p["latency_ms"], sample),
    ).rowcount
conn.commit()
print(n, "rows upserted")
