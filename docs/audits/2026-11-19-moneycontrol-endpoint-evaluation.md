# Moneycontrol backend endpoints - discovery and evaluation (2026-11-19)

Captured from the network traffic of 30 Moneycontrol pages; 116 endpoint templates, 46 not used by this repo
(checked against `src/` and `scripts/`; the Postgres `market_endpoint_registry` was not reachable from the machine
that ran this and was not checked). Every endpoint below returned HTTP 200 with same-day data to plain curl
(browser User-Agent + Referer, no cookies) on 2026-11-19 ~15:00 IST. Each was then checked against what this
repo already collects (`data-sources.md` RULE ZERO) and against `measurement.md`'s existing verdicts.

## Verdicts

| Endpoint | Data actually returned | Already covered by | Verdict |
|---|---|---|---|
| `getFnoOiTrends` | 224 F&O stocks in ONE call (limit=1000): OI, OI %chg, price, volume, vendor buildup label, last 3 10-min buildup labels. Aggregates ALL expiries. | `mc_stock_futures_oi_fetcher` (~418 calls/day, near month only) | **USE** - see AF-20261119-09: all-expiry OI avoids rollover distortion. Snapshot only (no history). |
| `getAllIndexContribution` | Per index: positive / negative / net points contributed. Accepts past fromDate/toDate (June 2026 verified). | Nothing (breadth exists only as advancers / above-50DMA counts) | **MEASURE** - AF-20261119-10: backfillable cap-weighted breadth-concentration series for the regime experiments. |
| `broker-research/stock-ideas` | ~9,400 broker calls since 2024-02, with recommended price, target and target date. | `mc_broker_reco_fetcher` (getBrokerResearchReco, 33,147 rows) | SKIP - same kind of calls; measurement.md already grades MC broker BUYs at -1.22% 20-session excess (t -2.6). |
| `get-option-details / max-pain-chart / multi-strike-chart` | Full chain with premium + IV per strike; max pain; intraday OI by strike. | `nse_option_chain_source`, `stock_option_chain_fetcher`, Trendlyne `so_option_chain` (max_pain already a feature) | ALTERNATE ONLY - register as fallback if a chain source dies. |
| `totaloi-pcr-chart` | Daily call/put OI and PCR, capped at the current expiry window (10 days; count ignored). | `mc_index_oi_fetcher` (index OI history) | SKIP - cannot unblock measurement.md Experiment 6 (needs PCR history before 2026-06-30). |
| `techCharts/intra` | 1-minute bars, close only (time,value). | `intraday_ohlcv` (15-min OHLCV), techCharts history (daily OHLC) | SKIP - no OHLC/volume. |
| `returns/stock, peers/landing` | Trailing returns; peer list (protobuf). | Derivable from `stock_ohlcv`; sector peers in `nse_stocks` | SKIP |
| `get-bse-reports` | Annual report + quarterly result announcements per stock. | NSE Integrated Filing pipeline (`nse_results_filings`) | SKIP |
| `usMarket/bond, usMarket/currency, getGlobalCurrencyRates, currencyfuture, MCX endpoints, etf/getListingData` | Live G-sec 5Y/10Y, DXY, FX, INR futures, MCX commodities, ETF prices. | `global_macro_fetcher` -> `macro_asset_prices` (INDIA_10Y, DXY, USDINR, CRUDE, GOLD) | ALTERNATE ONLY |
| `get-indicator-details` | 17 India macro indicators - **all values empty** on 2026-11-19. | `india_macro_fetcher` (eco-calendar actuals) | SKIP - empty payload. |
| `ipo/calendar-data` | IPO dates (open/close/allotment/listing). | `nse_ipo_calendar_fetcher` | SKIP |
| `stats/gainer, stats/52-week-high, marketturnover/tabs, multi-asset-info` | Movers / turnover / batch quotes (protobuf; .proto schemas public). | `mover_screener_fetcher` (movers), price feeds | SKIP |
| `market-terminal/category, stock/search` | MC index id catalogue; symbol -> MC id search. | `load_index_map`, `nse_stocks.mcsymbol` | ID-RESOLUTION AID only (never as the first source - data-sources.md). |
| `bonds/list, news/indices, explore-market, HTML widgets (stockaction/*, radar, upwardpotential, prostocklist, changeTableData, get_opt_chain, economic-widget)` | Corporate bonds; index news; page widgets as HTML. | JSON equivalents above or already used | SKIP |

## Key finding: near-month futures OI is distorted around expiry

Same stocks, same minute (2026-11-19, near month expiring 2026-11-23):

| Stock | All expiries (getFnoOiTrends) | Near month (getFuturesData, what the repo stores) |
|---|---|---|
| Vodafone Idea | +4.37% OI, Long Buildup | -4.82%, Short Covering |
| IRFC | +9.07%, Long Buildup | -22.07%, Short Covering |
| Manappuram Fin | +8.93%, Short Buildup | -5.94%, Short Covering |
| KPIT Tech | +11.57%, Short Buildup | -15.21%, Long Unwinding |
| Cochin Shipyard | +4.94%, Short Buildup | -19.43%, Short Covering |

`mc_stock_futures_oi_fetcher.fetch_symbol` keeps `max_expiries=1`, so in the sessions before every monthly expiry
`stock_futures_oi_history.oi_change` / `oi_buildup` record positions ROLLING, not new positioning. The `measurement.md`
"no edge" readings for `oi_change` / `oi_pct_change` (lines ~617, ~985, ~1221) were taken on that near-month series.

## Verified sample URLs

| Endpoint | URL |
|---|---|
| `getFnoOiTrends` | `https://priceapi.moneycontrol.com/technicalCompanyData/oiData/getFnoOiTrends?category=Active%20Buying%2CStrong%20Buying%2CShort%20Covering%2CActive%20Selling%2CStrong%20Selling%2CProfit%20Booking&expiry=ALL&type=ALL&deviceType=W&limit=6` |
| `upwardpotential` | `https://www.moneycontrol.com/mc/widget/upwardpotential?classic=true` |
| `getMostActiveData` | `https://www.moneycontrol.com/mc/widget/marketaction/getMostActiveData?classic=true&show=widget&token=-1` |
| `stockaction/technicalTrends` | `https://www.moneycontrol.com/mc/widget/stockaction/technicalTrends?classic=true&ajax=1` |
| `stockaction/topGainers` | `https://www.moneycontrol.com/mc/widget/stockaction/topGainers?classic=true&show=widget&token=-1` |
| `stockaction/priceShockers` | `https://www.moneycontrol.com/mc/widget/stockaction/priceShockers?classic=true&show=widget&token=-1` |
| `prostocklist` | `https://www.moneycontrol.com/mc/widget/prostocklist` |
| `mc_widgets/radar` | `https://www.moneycontrol.com/techmvc/mc_widgets/radar/?classic=true` |
| `get-bse-reports` | `https://api.moneycontrol.com/marketinsights/v1/markets/get-bse-reports?type=all&scId=RI&limit=5` |
| `peers/landing` | `https://api.moneycontrol.com/swiftapi/v1/stock/peers/landing?scId=RI&deviceType=W&type=mcap&appVersion=170` |
| `returns/stock` | `https://api.moneycontrol.com/swiftapi/v1/returns/stock?scId=RI&type=absolute&exchange=N&responseType=json` |
| `check-forecast` | `https://api.moneycontrol.com/mcapi/v1/stock/estimates/check-forecast?deviceType=W&scId=RI&ex=N` |
| `changeTableData` | `https://www.moneycontrol.com/markets/indian-indices/changeTableData?deviceType=web&exName=N&indicesID=9&selTab=o&subTabOT=o&subTabOPL=cl&selPage=marketTerminal&classic=true` |
| `usMarket/bond` | `https://priceapi.moneycontrol.com/pricefeed/usMarket/bond/GIND5Y:IND` |
| `techCharts/intra` | `https://priceapi.moneycontrol.com/techCharts/intra?symbol=HEROMOTOCO&resolution=1&from=1795059900&to=1795082400` |
| `explore-market` | `https://api.moneycontrol.com/mcapi/v1//explore/explore-market?deviceType=A&version=155&language=EN` |
| `multi-asset-info` | `https://api.moneycontrol.com/swiftapi/v1/markets/multi-asset-info?asset_ids=in;SEN-II,in;NSX-II&responseType=pb` |
| `stats/gainer` | `https://api.moneycontrol.com/swiftapi/v1/markets/stats/gainer?deviceType=W&appVersion=180&ex=N&section=overview&indexId=7&dur=1d&fields=&page=1&sortBy=perChange&orderBy=desc&stocklbl=true` |
| `stats/52-week-high` | `https://api.moneycontrol.com/swiftapi/v1/markets/stats/52-week-high?deviceType=W&appVersion=180&ex=N&section=overview&indexId=7&dur=1d&fields=&page=1&sortBy=perChange&orderBy=desc&stocklbl=true` |
| `get_opt_chain` | `https://www.moneycontrol.com/mccode/fno/get_opt_chain.php?sel_symbol=NIFTY&instrument_type=FUTIDX&sel_exp_date=2026-11-23` |
| `get-option-details` | `https://priceapi.moneycontrol.com/technicalCompanyData/oiData/get-option-details?scId=in;NSX&expiryDate=2026-11-23&assetType=I&deviceType=A` |
| `multi-strike-chart` | `https://priceapi.moneycontrol.com/technicalCompanyData/oiData/multi-strike-chart?scId=in;NSX&assetType=I&deviceType=W&contracts=2026-11-23_25400.00_CE,2026-11-23_25400.00_PE&interval=5MIN` |
| `totaloi-pcr-chart` | `https://priceapi.moneycontrol.com/technicalCompanyData/oiData/totaloi-pcr-chart?scId=in;NSX&expiry=2026-11-23&assetType=I&count=10&deviceType=W` |
| `max-pain-chart` | `https://priceapi.moneycontrol.com/technicalCompanyData/oiData/max-pain-chart?scId=in;NSX&expiry=2026-11-23&assetType=I&count=31&deviceType=W` |
| `stock/search` | `https://api.moneycontrol.com/mcapi/v1/stock/search?type=fno&query=NIFTY%2050` |
| `ipo/calendar-data` | `https://api.moneycontrol.com/mcapi/v1/ipo/calendar-data` |
| `economic-widget` | `https://www.moneycontrol.com/economic-widget?duration=T&startDate=&endDate=&impact=&country=&deviceType=web&classic=true` |
| `get-indicator-details` | `https://api.moneycontrol.com/mcapi/v1/ecalendar/get-indicator-details?country=India&category=Major%20Indicators` |
| `commodityindex` | `https://priceapi.moneycontrol.com/pricefeed/mcx/commodityindex/MCXENRGDEX` |
| `etf/getListingData` | `https://priceapi.moneycontrol.com/technicalCompanyData/etf/getListingData?category=Bullion&subCategory=Gold&deviceType=W&limit=500` |
| `getMajorCommodities` | `https://priceapi.moneycontrol.com/technicalCompanyData/commodity/getMajorCommodities?tabName=MCX&deviceType=W` |
| `commodity/getMarketStats` | `https://priceapi.moneycontrol.com/technicalCompanyData/commodity/getMarketStats?category=bullion&view=overview&deviceType=W` |
| `commodity/abValue` | `https://priceapi.moneycontrol.com/technicalCompanyData/commodity/abValue?category=bullion&deviceType=W` |
| `getGlobalCurrencyRates` | `https://api.moneycontrol.com/mcapi/v1/currency/getGlobalCurrencyRates` |
| `usMarket/currency` | `https://priceapi.moneycontrol.com/pricefeed/usMarket/currency/DXY:CUR` |
| `currencyfuture` | `https://priceapi.moneycontrol.com/pricefeed/nse/currencyfuture/EURINR?expiry=2026-11-26` |
| `bonds/list` | `https://api.moneycontrol.com/mcapi/v1/bonds/list?cat=corporate-bonds&ip_freq=&credit_rating=&yeild=0.00_100.00&dur=2026%2F11%2F19_2080%2F11%2F19` |
| `market-terminal/category` | `https://api.moneycontrol.com/mcapi/v1/indices/market-terminal/category?ex=N` |
| `news/indices` | `https://api.moneycontrol.com/mcapi/v1/news/indices` |
| `getAllIndexContribution` | `https://api.moneycontrol.com/mcapi/v1/indices/getAllIndexContribution?ex=N&fromDate=2026-11-18&toDate=2026-11-19&deviceType=W&indexIds=9,23,27,6,28,49,7,53,31,113,36,136` |
| `broker-research/stock-ideas` | `https://api.moneycontrol.com/mcapi/v1/broker-research/stock-ideas?start=0&limit=24&deviceType=W` |
| `marketturnover/tabs` | `https://api.moneycontrol.com/swiftapi/v1/marketturnover/tabs` |

Protobuf schemas: `https://www.moneycontrol.com/proto/{MarketStatsPackage,MarketTurnoverPackage,StockPeerPackage}.proto`.
