# URL catalog consolidation report

Generated 2026-09-13T07:07:21.194592+00:00 — APPLIED to the database

- catalog entries: **830** (23 not previously in `url_endpoints`)
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
| `urls.normalized.txt` | 1983 | 248 |

## Enrichment coverage

- endpoints with a named provider: 799/830
- endpoints with feature targets (the alternate-lookup key): 554/830

## External verification evidence

- URLs with recorded status: 3106 (HTTP 200: 2931, non-200: 156, request errors: 19)
- templates with ZERO HTTP-200 evidence (67) — treat as access-controlled or retired, not empty:

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
- `https://api.stockedge.com/Api/AlertsApi/GetSavedAlertsByType/{int_id}/2021/03/{int_id}/?lang&page&pageSize&relevantListings` — {'403': 2}
- `https://api.tickertape.in/stocks/commentaries/RLXO/?keys[` — {'400': 1}
- `https://etmarketsapis.indiatimes.com/ET_Stats/gainers/?duration&marketcap&pageno&pagesize&sort&sortby&sortorder` — {'503': 1}
- `https://etmarketsapis.indiatimes.com/ET_Stats/gainers/?duration&marketcap&pagesize&sort&sortby&sortorder` — {'503': 1}
- `https://etspeedapicache.indiatimes.com/etspeeds/search.ep/?callback&category&mustHaveCompany&mustHaveCompany&outputtype&pagesize&site&truncate` — {'503': 1}
- `https://json.bselivefeeds.indiatimes.com/ET_Community/bsensejson/?callback&companyid` — {'403': 1}
- `https://json.bselivefeeds.indiatimes.com/ET_Community/companypagedata/?_&callback&companyid&companytype` — {'403': 1}
- `https://json.bselivefeeds.indiatimes.com/ET_Community/holidaylist/?` — {'403': 1}
- `https://json.bselivefeeds.indiatimes.com/ET_Community/indexsummary/?callback&exchange&pagesize&sortby&sortorder` — {'403': 1}
- `https://json.bselivefeeds.indiatimes.com/ET_Community/industryListingController/?callback&exchange&pageno&pagesize&pid` — {'403': 1}
- `https://json.bselivefeeds.indiatimes.com/ET_Community/ratioperformance/?companyid&companytype&default&exchange&pagesize` — {'403': 2}
- `https://json.bselivefeeds.indiatimes.com/ET_Community/sectors/?callback&exchange` — {'403': 1}
- `https://json.bselivefeeds.indiatimes.com/technicalscreener.json/?_` — {'403': 1}
- `https://json.bselivefeeds.indiatimes.com/{string}/?` — {'403': 4}
- `https://marketapis.indiatimes.com/ET_LivePush/livePriceStock/companyData/?companyid&companytype` — request errors
- `https://mfapps.indiatimes.com/Ulip/mfsInvestingInStock.htm/?callback&companyid&marketcap&pageno&pagesize&sortby` — request errors
- `https://mseindia.com/api/ticker/?` — request errors
- `https://oxide.sensibull.com/v1/compute/cache/fii_dii_daily/?year_month` — {'403': 2}
- `https://oxide.sensibull.com/v1/compute/cache/instrument_metacache/2/?` — {'403': 1}
- `https://oxide.sensibull.com/v1/compute/{string}/{string}/?` — {'403': 4}
- … +37 more

## New catalog entries (23)

- `https://api.moneycontrol.com/mcapi/technicalpicks/chart-patterns/?deviceType&limit&pattern_type&start&version` — unknown provider, n_urls=1, sources=['unique_urls.txt']
- `https://etapi.indiatimes.com/et-screener/sector-listing-data/?sortedField&sortedOrder` — unknown provider, n_urls=1, sources=['unique_urls.txt']
- `https://etapi.indiatimes.com/et-screener/sector-summary/?sectorId` — unknown provider, n_urls=1, sources=['unique_urls.txt']
- `https://etpwaapi.economictimes.com/api/mercury/indexfilters/?` — unknown provider, n_urls=1, sources=['unique_urls.txt']
- `https://frapi.marketsmojo.com/Stocks_Returnanalysis/stock_return_beta/?alphabet&cardlist&cid&exchange&period&se&sid` — unknown provider, n_urls=1, sources=['unique_urls.txt']
- `https://frapi.marketsmojo.com/apiv1/markets/indices/{int_id}/details/?period` — unknown provider, n_urls=12, sources=['unique_urls.txt']
- `https://frapi.marketsmojo.com/apiv1/markets/screener/?filter_by&filter_type&filter_value&page&per_page&period` — unknown provider, n_urls=3, sources=['unique_urls.txt']
- `https://frapi.marketsmojo.com/stocks_Returnanalysis/returnAnalysis/?1w&alphabet&cardlist&cards&cid&exchange&page&period&se&sid` — unknown provider, n_urls=1, sources=['unique_urls.txt']
- `https://stocks.sapphirebroking.com/api/market/index/NIFTY%2050/?` — unknown provider, n_urls=1, sources=['unique_urls.txt']
- `https://stocks.sapphirebroking.com/api/market/{string}/?` — unknown provider, n_urls=2, sources=['unique_urls.txt']
- `https://stocks.sapphirebroking.com/api/market/{string}/RELIANCE/{string}/?` — unknown provider, n_urls=9, sources=['unique_urls.txt']
- `https://trendlyne.com/fundamentals/json-screener/{int_id}/5/0/index/NIFTY500/nifty-500/{string}/?` — Trendlyne, n_urls=9, sources=['detailed_uls.json', 'unique_urls.txt', 'updated_urls.json', 'updated_urls_verified.json', 'urls.normalized.txt']
- `https://trendlyne.com/mutual-fund/getMFdata/?category&category&category&category&category&category&category&category&category&category&category&category&category&category&plan&plan` — unknown provider, n_urls=1, sources=['unique_urls.txt']
- `https://trendlyne.com/mutual-fund/getMFdata/?category&category&category&category&category&category&plan&plan` — unknown provider, n_urls=1, sources=['unique_urls.txt']
- `https://trendlyne.com/mutual-fund/getMFdata/?category&category&category&plan&plan` — unknown provider, n_urls=1, sources=['unique_urls.txt']
- `https://trendlyne.com/mutual-fund/getMFdata/?category&category&plan&plan` — unknown provider, n_urls=1, sources=['unique_urls.txt']
- `https://trendlyne.com/mutual-fund/getMFdata/?category&plan&plan` — unknown provider, n_urls=1, sources=['unique_urls.txt']
- `https://trendlyne.com/mutual-fund/{string}/?pk` — unknown provider, n_urls=2, sources=['unique_urls.txt']
- `https://trendlyne.com/{string}/{string}/{int_id}/?` — Trendlyne, n_urls=48, sources=['ai_endpoint_registry', 'detailed_uls.json', 'unique_urls.txt', 'updated_urls.json', 'updated_urls_verified.json', 'urls.normalized.txt']
- `https://trendlyne.com/{string}/{string}/{int_id}/{string}/{string}/{int_id}/{string}/?` — Trendlyne, n_urls=23, sources=['detailed_uls.json', 'unique_urls.txt', 'updated_urls.json', 'updated_urls_verified.json', 'urls.normalized.txt']
- `https://www.marketsmojo.com/technical_card/getCardInfo/?cardlist&cid&pr&se&sid` — unknown provider, n_urls=1, sources=['unique_urls.txt']
- `https://www.marketsmojo.com/technical_card/getCardInfo/?cardlist&se&sid` — unknown provider, n_urls=28, sources=['unique_urls.txt']
- `https://www.marketsmojo.com/technical_card/getPeersData/?se&sid` — unknown provider, n_urls=1, sources=['unique_urls.txt']

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
