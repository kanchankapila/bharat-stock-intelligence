# URL catalog consolidation report

Generated 2026-09-13T11:33:06.933100+00:00 — APPLIED to the database

- catalog entries: **830** (6 not previously in `url_endpoints`)
- rows written this run: 830

## Per-source contribution

| source | records | templates represented |
|---|---:|---:|

| `ai_endpoint_memory.json` | 1024 | 549 |
| `detailed_uls.json` | 919 | 246 |
| `et-marketstats-post-requests.json` | 91 | 2 |
| `et_screeners.json` | 438 | 1 |
| `unique_urls.txt` | 3119 | 267 |
| `updated_urls.json` | 919 | 246 |
| `updated_urls_verified.json` | 919 | 246 |
| `urls-explorer/report_success.csv` | 10 | 4 |
| `urls-explorer/successful_urls.csv` | 419 | 151 |
| `urls.normalized.txt` | 1983 | 248 |

## Enrichment coverage

- endpoints with a named provider: 799/830
- endpoints with feature targets (the alternate-lookup key): 554/830

## External verification evidence

- URLs with recorded status: 3123 (HTTP 200: 2980, non-200: 127, request errors: 16)
- templates with ZERO HTTP-200 evidence (49) — treat as access-controlled or retired, not empty:

- `https://ai-chat.tapetide.com/insights/RELIANCE/?` — {'401': 1}
- `https://ai-chat.tapetide.com/insights/RELIANCE/?period_type` — {'401': 2}
- `https://ai-chat.tapetide.com/insights/RELIANCE/documents/?` — {'401': 1}
- `https://api.moneycontrol.com/mcapi/v1/earnings/estimate-performance/?limit&page&type` — {'204': 2}
- `https://api.moneycontrol.com/mcapi/v1/fno/options/getOptionsData/?expirydate&id&opt&optiontype&strikeprice` — {'204': 2}
- `https://api.moneycontrol.com/mcapi/v1/stock/financial-historical/overview/?scId` — {'422': 1}
- `https://api.moneycontrol.com/mcapi/v1/stock/get-stock-price/?scId&scIdList` — request errors
- `https://api.moneycontrol.com/mcapi/v1/{string}/{string}/?scId&type` — request errors
- `https://api.niftytrader.in/webapi/{string}/{string}/?` — {'404': 12}
- `https://api.niftytrader.in/webapi/{string}/{string}/?symbol` — {'404': 3}
- `https://api.tickertape.in/stocks/commentaries/RLXO/?keys[` — {'400': 1}
- `https://etspeedapicache.indiatimes.com/etspeeds/search.ep/?callback&category&mustHaveCompany&mustHaveCompany&outputtype&pagesize&site&truncate` — {'503': 1}
- `https://json.bselivefeeds.indiatimes.com/ET_Community/holidaylist/?` — {'403': 1}
- `https://json.bselivefeeds.indiatimes.com/ET_Community/ratioperformance/?companyid&companytype&default&exchange&pagesize` — {'403': 2}
- `https://marketapis.indiatimes.com/ET_LivePush/livePriceStock/companyData/?companyid&companytype` — request errors
- `https://mseindia.com/api/ticker/?` — request errors
- `https://oxide.sensibull.com/v1/compute/cache/fii_dii_daily/?year_month` — {'403': 2}
- `https://oxide.sensibull.com/v1/compute/cache/instrument_metacache/2/?` — {'403': 1}
- `https://oxide.sensibull.com/v1/compute/{string}/{string}/?` — {'403': 4}
- `https://stocks.sapphirebroking.com/api/market/index/NIFTY%2050/?` — {'403': 1}
- `https://stocks.sapphirebroking.com/api/market/{string}/?` — {'403': 2}
- `https://stocks.sapphirebroking.com/api/market/{string}/RELIANCE/{string}/?` — {'403': 9}
- `https://subscriptions.economictimes.indiatimes.com/subscription/growthAnalyitcs/?isGroupUser&merchantCode` — {'401': 1}
- `https://trendlyne.com/equity/api/market-insight/?rangeType&stockGroup` — {'405': 1}
- `https://trendlyne.com/equity/global-indices-analysis/?` — {'405': 1}
- `https://trendlyne.com/mutual-fund/getMFdata/?category&category&category&category&category&category&category&category&category&category&category&category&category&category&plan&plan` — {'405': 1}
- `https://trendlyne.com/mutual-fund/getMFdata/?category&category&category&category&category&category&plan&plan` — {'405': 1}
- `https://trendlyne.com/mutual-fund/getMFdata/?category&category&category&plan&plan` — {'405': 1}
- `https://trendlyne.com/mutual-fund/getMFdata/?category&category&plan&plan` — {'405': 1}
- `https://trendlyne.com/mutual-fund/getMFdata/?category&plan&plan` — {'405': 1}
- … +19 more

## New catalog entries (6)

- `https:///api.moneycontrol.com/mcapi/v1/stock/get-stock-price/?scId&scIdList` — Market Data Service, n_urls=3, sources=['detailed_uls.json', 'updated_urls.json', 'updated_urls_verified.json']
- `https:///api.moneycontrol.com/mcapi/v1/{string}/{string}/?scId&type` — Market Data Service, n_urls=15, sources=['detailed_uls.json', 'updated_urls.json', 'updated_urls_verified.json']
- `https:///appfeeds.moneycontrol.com/jsonapi/market/indices&format=json&ind_id=38/?` — Market Data Service, n_urls=4, sources=['detailed_uls.json', 'updated_urls.json', 'updated_urls_verified.json', 'urls-explorer/successful_urls.csv']
- `https:///priceapi.moneycontrol.com/pricefeed/{string}/{string}/{string}/?` — Market Data Service, n_urls=13, sources=['detailed_uls.json', 'updated_urls.json', 'updated_urls_verified.json', 'urls-explorer/successful_urls.csv']
- `https:///www.moneycontrol.com/mc/widget/swot/swotCount/?device_type&scDid&scId&stkname` — Market Data Service, n_urls=3, sources=['detailed_uls.json', 'updated_urls.json', 'updated_urls_verified.json']
- `https:///www.moneycontrol.com/mc/widget/{string}/?sc_did&sc_id` — Market Data Service, n_urls=9, sources=['detailed_uls.json', 'updated_urls.json', 'updated_urls_verified.json']

## Single-provider feature targets — NO alternate exists

- `ext_dii_holding_pct` — only ETNow / Economic Times
- `ext_dii_qoq_chg` — only ETNow / Economic Times
- `ext_fii_holding_pct` — only ETNow / Economic Times
- `ext_fii_qoq_chg` — only ETNow / Economic Times
- `ext_is_overall_score` — only InvestSights
- `ext_is_percentile_rank` — only InvestSights
- `ext_mojo_financial_pts` — only MarketsMojo
- `ext_mojo_quality_rank` — only MarketsMojo
- `ext_mojo_valuation_rank` — only MarketsMojo
- `ext_t80_financial_pts` — only MarketsMojo
- `ext_t80_quality_rank` — only MarketsMojo
- `ext_t80_tech_score` — only MarketsMojo
- `ext_t80_valuation_rank` — only MarketsMojo
- `ext_tt_score` — only TapeTide

## Multi-provider feature targets — alternates available

- `action_type` — ETNow / Economic Times, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `analyst_rating` — ETNow / Economic Times, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `announcement_date` — ETNow / Economic Times, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `breakout_flag` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `call_oi` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `confidence` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `day_high` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `day_low` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `debt_to_equity` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `delivery_pct` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `dii_net_flow` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `eps_estimate` — ETNow / Economic Times, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `ex_date` — ETNow / Economic Times, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `exchange` — ETNow / Economic Times, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `fii_net_flow` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `futures_basis` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `headline` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `iv_skew` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `last_price` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `market_cap` — ETNow / Economic Times, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `momentum_score` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `net_income` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `ohlc_vector` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `open_interest` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `pb_ratio` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `pcr` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `pe_ratio` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `pledged_pct` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `promoter_holding` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `put_oi` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `rank` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `ratio` — ETNow / Economic Times, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `relevance` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `revenue` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `sector_id` — ETNow / Economic Times, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `sentiment_score` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `symbol` — ETNow / Economic Times, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `target_price` — ETNow / Economic Times, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `upside_pct` — ETNow / Economic Times, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `volume` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
- `vwap` — ETNow / Economic Times, InvestSights, MoneyControl, NSE India, NiftyTrader, Sensibull, StockEdge, Tickertape, Trendlyne
