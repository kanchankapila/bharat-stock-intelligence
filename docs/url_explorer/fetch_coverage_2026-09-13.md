# Fetch coverage — catalog endpoints (2026-09-13)

- total endpoint templates: **834**
- **OK — at least one 2xx fetch: 266**
- attempted, all fetches failed: **370**
- never fetched (skipped on capped hosts / id-rendered / valueless): **198**

A template counts as OK if any of its sample fetches returned 2xx. Failure status shown is
the most recent attempt. `404` on synthetic cross-provider paths = proven-phantom discovery
entries; `403` = access-controlled; `0` = transport (unreachable/timeout); `429`/`503` = throttled.

## OK — 266 endpoints

- api.moneycontrol.com: 64
- www.moneycontrol.com: 47
- investsights.in: 21
- trendlyne.com: 14
- www.ndtvprofit.com: 14
- frapi.marketsmojo.com: 13
- webapi.niftytrader.in: 12
- json.bselivefeeds.indiatimes.com: 9
- www.nseindia.com: 8
- analyze.api.tickertape.in: 7
- api.tickertape.in: 6
- priceapi.moneycontrol.com: 6
- www.marketsmojo.com: 5
- api.stockedge.com: 4
- etmarketsapis.indiatimes.com: 4
- api.tapetide.com: 3
- etapi.indiatimes.com: 3
- frapi.trading80.com: 3
- mfapps.indiatimes.com: 3
- appfeeds.moneycontrol.com: 2
- economictimes.indiatimes.com: 2
- etinsights.indiatimes.com: 2
- kayal.trendlyne.com: 2
- marketservices.indiatimes.com: 2
- smartoptions.trendlyne.com: 2
- etpwaapi.economictimes.com: 1
- h: 1
- quotes-api.tickertape.in: 1
- sas.indiatimes.com: 1
- screener-api.tapetide.com: 1
- screener.indiatimes.com: 1
- www.tickertape.in: 1
- www.trading80.com: 1

<details><summary>full OK list</summary>

- `[GET]` https://analyze.api.tickertape.in/faqs/stocks/?sid
- `[GET]` https://analyze.api.tickertape.in/homepage/stocks/?count&offset&type&universe
- `[GET]` https://analyze.api.tickertape.in/stocks/deals
- `[GET]` https://analyze.api.tickertape.in/stocks/deals/?count&order&orderBy
- `[GET]` https://analyze.api.tickertape.in/stocks/deals/insight/?duration&sortBy&type
- `[GET]` https://analyze.api.tickertape.in/stocks/scorecard/{string}/?
- `[GET]` https://analyze.api.tickertape.in/v2/stocks/summary/RLXO/?
- `[GET]` https://api.moneycontrol.com/mcapi/extdata/v2/mc-essentials/?deviceType&scId&type
- `[GET]` https://api.moneycontrol.com/mcapi/extdata/v2/mc-insights/?appVersion&deviceType&scId&type
- `[GET]` https://api.moneycontrol.com/mcapi/technicalpicks/chart-patterns/?deviceType&limit&pattern_type&sc_id&start&version
- `[GET]` https://api.moneycontrol.com/mcapi/technicalpicks/chart-patterns/?deviceType&limit&pattern_type&start&version
- `[GET]` https://api.moneycontrol.com/mcapi/technicals/v2/details/?deviceType&dur&scId
- `[GET]` https://api.moneycontrol.com/mcapi/v1/deals/insight/?action&dealsType&limit&range&start&value
- `[GET]` https://api.moneycontrol.com/mcapi/v1/deals/insight/?action&limit&range&start&value
- `[GET]` https://api.moneycontrol.com/mcapi/v1/deals/largedeals-insight/?deviceType&limit&orderBy&start
- `[GET]` https://api.moneycontrol.com/mcapi/v1/deals/list/?apiVersion&dealType&deviceType&limit&orderBy&sortBy&start
- `[GET]` https://api.moneycontrol.com/mcapi/v1/deals/list/?deviceType&limit&orderBy&scId&sortBy&start
- `[GET]` https://api.moneycontrol.com/mcapi/v1/deals/list/?deviceType&limit&orderBy&sortBy&start
- `[GET]` https://api.moneycontrol.com/mcapi/v1/earnings/estimate-performance/?limit&page&type
- `[GET]` https://api.moneycontrol.com/mcapi/v1/earnings/get-earnings-data/?endDate&indexId&limit&page&sector&startDate
- `[GET]` https://api.moneycontrol.com/mcapi/v1/earnings/get-performers-detailed/?orderBy&page&seq&sortBy&type
- `[GET]` https://api.moneycontrol.com/mcapi/v1/earnings/rapid-results/?category&indexId&limit&page&search&sector&seq&sortBy&subType&type
- `[GET]` https://api.moneycontrol.com/mcapi/v1/earnings/rapid-results/?limit&page&subType&type
- `[GET]` https://api.moneycontrol.com/mcapi/v1/earnings/result-calendar/?fromDate&indexId&sector&toDate
- `[GET]` https://api.moneycontrol.com/mcapi/v1/earnings/{string}/?limit&page
- `[GET]` https://api.moneycontrol.com/mcapi/v1/ecalendar/get-upcoming-event-data/?page&pageSize
- `[GET]` https://api.moneycontrol.com/mcapi/v1/extdata/mc-block-data/?page&scId
- `[GET]` https://api.moneycontrol.com/mcapi/v1/fno/futures/getFuturesData/?expirydate&fut&id
- `[GET]` https://api.moneycontrol.com/mcapi/v1/fno/options/getOptionsData/?expirydate&id&opt&optiontype&strikeprice
- `[GET]` https://api.moneycontrol.com/mcapi/v1/fno/options/getStrikePrice/?expirydate&id&optiontype
- `[GET]` https://api.moneycontrol.com/mcapi/v1/fno/{string}/getExpDts/?id
- `[GET]` https://api.moneycontrol.com/mcapi/v1/indices/ad-ratio/category-wise-list/?categoryId&ex&type
- `[GET]` https://api.moneycontrol.com/mcapi/v1/indices/chart/exchange-advdec/?ex
- `[GET]` https://api.moneycontrol.com/mcapi/v1/indices/fundamentals/graph/{string}/?duration&indId
- `[GET]` https://api.moneycontrol.com/mcapi/v1/indices/fundamentals/{string}/?indId
- `[GET]` https://api.moneycontrol.com/mcapi/v1/indices/get-indices-list/?appVersion
- `[GET]` https://api.moneycontrol.com/mcapi/v1/market/seasonality-analysis/details/?ex&id&type
- `[GET]` https://api.moneycontrol.com/mcapi/v1/market/seasonality-analysis/get-best-month-stocks/?ex&id&limit&month&tab&trend&year
- `[GET]` https://api.moneycontrol.com/mcapi/v1/market/seasonality-analysis/get-best-month-stocks/?ex&id&limit&month&tab&year
- `[GET]` https://api.moneycontrol.com/mcapi/v1/market/seasonality-analysis/search/?ex&text
- `[GET]` https://api.moneycontrol.com/mcapi/v1/market/seasonality-analysis/stock-list/?ex&id&month&type
- `[GET]` https://api.moneycontrol.com/mcapi/v1/marketinfo/getMarketInfo/?criteria&ex&limit
- `[GET]` https://api.moneycontrol.com/mcapi/v1/premarket/article/?limit&slug
- `[GET]` https://api.moneycontrol.com/mcapi/v1/premarket/get-global-marketdata/?section
- `[GET]` https://api.moneycontrol.com/mcapi/v1/premarket/getBrokerResearchReco/?limit&start&sublevel
- `[GET]` https://api.moneycontrol.com/mcapi/v1/premarket/getFllActivityData/?type
- `[GET]` https://api.moneycontrol.com/mcapi/v1/premarket/getMarketNewsData/?limit
- `[GET]` https://api.moneycontrol.com/mcapi/v1/premarket/getMarketViewsData/?cat&limit&start
- `[GET]` https://api.moneycontrol.com/mcapi/v1/premarket/getStockToWatchData/?limit&sortby&sortorder&start
- `[GET]` https://api.moneycontrol.com/mcapi/v1/quarterly-earning/estimates/?deviceType&ex&financialType&scId&type
- `[GET]` https://api.moneycontrol.com/mcapi/v1/quarterly-earning/peers-comparison/?deviceType&sc_id&section
- `[GET]` https://api.moneycontrol.com/mcapi/v1/quarterly-earning/{string}/?deviceType&sc_id
- `[GET]` https://api.moneycontrol.com/mcapi/v1/sector/gainer-loser/?dur&name&section
- `[GET]` https://api.moneycontrol.com/mcapi/v1/sector/get-all-stocks/{string}/?section&slug
- `[GET]` https://api.moneycontrol.com/mcapi/v1/sector/listing/?dur&secName&section
- `[GET]` https://api.moneycontrol.com/mcapi/v1/sector/performance/?dur&limit&section&type
- `[GET]` https://api.moneycontrol.com/mcapi/v1/stock/corporate-action/?appVersion&deviceType&limit&scId&section&start
- `[GET]` https://api.moneycontrol.com/mcapi/v1/stock/corporate-action/?deviceType&limit&scId&section&start
- `[GET]` https://api.moneycontrol.com/mcapi/v1/stock/estimates/earning-forecast/?deviceType&ex&financialType&frequency&scId
- `[GET]` https://api.moneycontrol.com/mcapi/v1/stock/estimates/hits-misses/?deviceType&ex&financialType&scId&type
- `[GET]` https://api.moneycontrol.com/mcapi/v1/stock/estimates/valuation/?appVersion&deviceType&ex&financialType&scId
- `[GET]` https://api.moneycontrol.com/mcapi/v1/stock/estimates/valuation/?deviceType&ex&financialType&scId
- `[GET]` https://api.moneycontrol.com/mcapi/v1/stock/estimates/{string}/?deviceType&ex&scId
- `[GET]` https://api.moneycontrol.com/mcapi/v1/stock/financial-historical/overview/?ex&scId
- `[GET]` https://api.moneycontrol.com/mcapi/v1/stock/market-depth/?scId
- `[GET]` https://api.moneycontrol.com/mcapi/v1/stock/price-volume/?appVersion&ex&scId
- `[GET]` https://api.moneycontrol.com/mcapi/v1/technical-trends/{string}/{string}/?appVersion&deviceType&ex&index&order&page&sort
- `[GET]` https://api.moneycontrol.com/mcapi/v1/{string}/scanner-detail/?catId&scanId
- `[GET]` https://api.moneycontrol.com/mcapi/v1/{string}/{string}/?
- `[GET]` https://api.moneycontrol.com/mcapi/v1/{string}/{string}/?indexId
- `[GET]` https://api.moneycontrol.com/swiftapi/v1/stockvitals/historical/?metric&responseType&scId
- `[GET]` https://api.stockedge.com/Api/MetaDetailDashboardApi/GetMetaDetailByPageName/?PageName&lang
- `[GET]` https://api.stockedge.com/Api/SectorDashboardApi/GetSectorPeerList/20/?lang&page&pageSize
- `[GET]` https://api.stockedge.com/Api/SecurityDashboardApi/GetTechnicalIndicators/229/?lang
- `[GET]` https://api.stockedge.com/Api/{string}/{string}/?lang
- `[GET]` https://api.tapetide.com/api/v1/companies/RELIANCE/{string}/?
- `[GET]` https://api.tapetide.com/api/v1/{string}/{string}/{ticker}/?interval
- `[GET]` https://api.tapetide.com/api/v1/{string}/{ticker}/?
- `[GET]` https://api.tickertape.in/mmi/now/?
- `[GET]` https://api.tickertape.in/stocks/commentaries/RLXO/?keys[]&keys[]&keys[]&keys[]
- `[GET]` https://api.tickertape.in/stocks/financials/income/RLXO/{string}/normal/?count
- `[GET]` https://api.tickertape.in/stocks/quotes/?sids
- `[GET]` https://api.tickertape.in/stocks/{string}/{string}/?
- `[GET]` https://api.tickertape.in/{string}/{string}/{string}/{string}/?
- `[GET]` https://appfeeds.moneycontrol.com/jsonapi/stocks/{string}/?limit&sc_id&start&type_format
- `[GET]` https://appfeeds.moneycontrol.com/jsonapi/{string}/{string}/?
- `[GET]` https://economictimes.indiatimes.com/feed_marketslisting.cms/?callback&curpg&feedtype&msid
- `[GET]` https://economictimes.indiatimes.com/viewandrecofeed.cms/?feedtype
- `[GET]` https://etapi.indiatimes.com/et-screener/sector-listing-data/?sortedField&sortedOrder
- `[GET]` https://etapi.indiatimes.com/et-screener/sector-summary/?sectorId
- `[POST]` https://etapi.indiatimes.com/et-screener/v2/technical-data
- `[GET]` https://etinsights.indiatimes.com/ET_TechnicalIndicator/getPriceBehaviourData/?excludeCovidCrisis&excludeGlobalMeltdown&period&scripCode
- `[GET]` https://etinsights.indiatimes.com/ET_TechnicalIndicator/getTechnicalMobileDetail/?companytype&scripCode
- `[GET]` https://etmarketsapis.indiatimes.com/ET_Stats/mobile/?bType&companyId&events&last
- `[GET]` https://etmarketsapis.indiatimes.com/ET_Stats/sectorperformance/?exchange&marketcap&pageno&pagesize
- `[GET]` https://etmarketsapis.indiatimes.com/ET_TechnicalScreeners/getFilteredData/LONG_WHITE_CANDLE/?
- `[GET]` https://etmarketsapis.indiatimes.com/ET_TechnicalScreeners/topTrendingScreeners/?_&exchangeId&innerPageSize&pageNumber&pageSize
- `[GET]` https://etpwaapi.economictimes.com/api/mercury/indexfilters/?
- `[GET]` https://frapi.marketsmojo.com/Stocks_Returnanalysis/stock_return_beta/?alphabet&cardlist&cid&exchange&period&se&sid
- `[GET]` https://frapi.marketsmojo.com/apiv1/markets/indices/?index_ids
- `[GET]` https://frapi.marketsmojo.com/apiv1/markets/indices/{int_id}/details/?period
- `[GET]` https://frapi.marketsmojo.com/apiv1/markets/screener/?filter_by&filter_type&filter_value&page&per_page&period
- `[GET]` https://frapi.marketsmojo.com/market_marketaction/getData/? --
- `[GET]` https://frapi.marketsmojo.com/market_marketoverview/getGraphData/?indice&period
- `[GET]` https://frapi.marketsmojo.com/market_resultscorner/getStockResult/?sort
- `[GET]` https://frapi.marketsmojo.com/stocks_Returnanalysis/returnAnalysis/?1w&alphabet&cardlist&cards&cid&exchange&page&period&se&sid
- `[GET]` https://frapi.marketsmojo.com/stocks_Stocksid/returnContri_info/?alphabet&cardlist&exchange&period&se&sid&stockID
- `[GET]` https://frapi.marketsmojo.com/stocks_quality/vcardinfo/?sid
- `[GET]` https://frapi.marketsmojo.com/{string}/{string}/?
- `[GET]` https://frapi.marketsmojo.com/{string}/{string}/?exchange&sid
- `[GET]` https://frapi.marketsmojo.com/{string}/{string}/?exchange&type
- `[GET]` https://frapi.trading80.com/callsapi/getCallAlerts/?w
- `[GET]` https://frapi.trading80.com/callsapi/getChart/?
- `[GET]` https://frapi.trading80.com/stocks_stocksid/header_info/?exchange&sid
- `[GET]` https://h/p/?x
- `[GET]` https://investsights.in/api/v2/concall/recent/?limit
- `[GET]` https://investsights.in/api/v2/fundamentals/WEBELSOLAR/analyst-estimates/?period
- `[GET]` https://investsights.in/api/v2/fundamentals/WEBELSOLAR/{string}/?limit&period
- `[GET]` https://investsights.in/api/v2/investors/?limit&only_superstars&page&sort_by
- `[GET]` https://investsights.in/api/v2/market-pulse/items/?dt&limit
- `[GET]` https://investsights.in/api/v2/market-pulse/stock/WEBELSOLAR/corporate-actions/?
- `[GET]` https://investsights.in/api/v2/market-pulse/stock/WEBELSOLAR/documents/?limit
- `[GET]` https://investsights.in/api/v2/market/corporate-actions/?days_ahead&days_back
- `[GET]` https://investsights.in/api/v2/market/economic-events/?days_ahead
- `[GET]` https://investsights.in/api/v2/market/economic-indicators/?years
- `[GET]` https://investsights.in/api/v2/market/index-valuation/?index
- `[GET]` https://investsights.in/api/v2/market/sector-correlation/?period
- `[GET]` https://investsights.in/api/v2/market/sector-rrg/?weeks
- `[GET]` https://investsights.in/api/v2/market/{string}/?days_ahead&days_back&indian_only
- `[GET]` https://investsights.in/api/v2/news/?category&limit
- `[GET]` https://investsights.in/api/v2/news/?limit
- `[GET]` https://investsights.in/api/v2/news/?limit&offset
- `[GET]` https://investsights.in/api/v2/{string}/{ticker}/?
- `[GET]` https://investsights.in/api/v2/{string}/{ticker}/{string}/?limit
- `[GET]` https://investsights.in/api/v2/{string}/{ticker}/{ticker}/?
- `[GET]` https://investsights.in/api/v2/{string}/{ticker}/{ticker}/?days
- `[GET]` https://json.bselivefeeds.indiatimes.com/ET_Community/bsensejson/?callback&companyid
- `[GET]` https://json.bselivefeeds.indiatimes.com/ET_Community/companypagedata/?_&callback&companyid&companytype
- `[GET]` https://json.bselivefeeds.indiatimes.com/ET_Community/holidaylist/?
- `[GET]` https://json.bselivefeeds.indiatimes.com/ET_Community/indexsummary/?callback&exchange&pagesize&sortby&sortorder
- `[GET]` https://json.bselivefeeds.indiatimes.com/ET_Community/industryListingController/?callback&exchange&pageno&pagesize&pid
- `[GET]` https://json.bselivefeeds.indiatimes.com/ET_Community/ratioperformance/?companyid&companytype&default&exchange&pagesize
- `[GET]` https://json.bselivefeeds.indiatimes.com/ET_Community/sectors/?callback&exchange
- `[GET]` https://json.bselivefeeds.indiatimes.com/technicalscreener.json/?_
- `[GET]` https://json.bselivefeeds.indiatimes.com/{string}/?
- `[GET]` https://kayal.trendlyne.com/broker-webview/kayal/all-in-one-screener-data-get/?groupName&groupType&pageNumber&perPageCount&screenpk
- `[GET]` https://kayal.trendlyne.com/clientapi/kayal/content/checklist-bypk/175/?
- `[GET]` https://marketservices.indiatimes.com/marketservices/companyshortdata/?companyid&companytype
- `[GET]` https://marketservices.indiatimes.com/marketservices/shareholding/?companyid
- `[GET]` https://mfapps.indiatimes.com/ET_Calculators/ssy/PennyStocks.htm/?callback&marketcap&pageno&pagesize&sortby&sortorder
- `[GET]` https://mfapps.indiatimes.com/Ulip/mfsInvestingInStock.htm/?callback&companyid&marketcap&pageno&pagesize&sortby
- `[GET]` https://mfapps.indiatimes.com/Ulip/mfsInvestingInStock.htm/?callback&companyid&marketcap&pagesize&sortby
- `[GET]` https://priceapi.moneycontrol.com/pricefeed/{ticker}/{string}/{string}/?
- `[GET]` https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history/?countback&currencyCode&from&resolution&symbol&to
- `[GET]` https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/marks/?from&resolution&symbol&to
- `[GET]` https://priceapi.moneycontrol.com/technicalCompanyData/categoryTechnicalTrend/{string}/{string}/sector/?categoryValue&deviceType&order&sort
- `[GET]` https://priceapi.moneycontrol.com/technicalCompanyData/oiData/oi-change-chart/?assetType&count&deviceType&expiryDate&scId&type
- `[GET]` https://priceapi.moneycontrol.com/technicalCompanyData/oiData/options-expiry-dates/?assetType&deviceType&scId
- `[GET]` https://quotes-api.tickertape.in/quotes/?sids
- `[GET]` https://sas.indiatimes.com/TechnicalsClient/getRSI.htm/?callback&companyid&crossovertype&ctype&ctype&exchange&exchangeid&filtertype&marketcap&pageno&pagesize&sortby&sortorder&year
- `[GET]` https://screener-api.tapetide.com/api/screener/trending/?
- `[POST]` https://screener.indiatimes.com/screener/v2/screenerByScreenerIdForWeb
- `[GET]` https://smartoptions.trendlyne.com/phoenix/api/fno/market/filter/?expDate&instType&mtype&screenType
- `[GET]` https://smartoptions.trendlyne.com/phoenix/api/fno/market/filter/?expDate&mtype&screenType
- `[GET]` https://trendlyne.com/equity/api/market-insight/?rangeType&stockGroup
- `[GET]` https://trendlyne.com/equity/global-indices-analysis/?
- `[GET]` https://trendlyne.com/fundamentals/all-in-one-screener-data-get/?columns&groupName&groupType&order&pageNumber&perPageCount&query&sortBy
- `[GET]` https://trendlyne.com/fundamentals/json-screener/{int_id}/5/0/index/NIFTY500/nifty-500/?
- `[GET]` https://trendlyne.com/fundamentals/tl-all-in-one-screener-data-get/?columns&groupName&groupType&order&perPageCount&query&sortBy
- `[GET]` https://trendlyne.com/fundamentals/tl-all-in-one-screener-data-get/?groupName&groupSlug&groupType&perPageCount&screenpk
- `[GET]` https://trendlyne.com/fundamentals/tl-all-in-one-screener-data-get/?groupName&groupType&perPageCount&screenpk
- `[GET]` https://trendlyne.com/futures-options/{string}/{int_id}/{string}/{string}/?
- `[GET]` https://trendlyne.com/mutual-fund/getMFhome/?category
- `[GET]` https://trendlyne.com/{string}/{string}/175/?
- `[GET]` https://trendlyne.com/{string}/{string}/{int_id}/?
- `[GET]` https://trendlyne.com/{string}/{string}/{int_id}/{int_id}/?
- `[GET]` https://trendlyne.com/{string}/{string}/{int_id}/{string}/{string}/{int_id}/{string}/?
- `[GET]` https://trendlyne.com/{string}/{string}/{string}/{string}/{int_id}/{int_id}/?
- `[GET]` https://webapi.niftytrader.in/webapi/Option/oi-time-range/?end_time&expiry&start_time&symbol
- `[GET]` https://webapi.niftytrader.in/webapi/Option/option-hottest/?category&filter_by
- `[GET]` https://webapi.niftytrader.in/webapi/Option/trending-oi-data-specific/?expiryDate&interval&limit&symbol
- `[GET]` https://webapi.niftytrader.in/webapi/Other/ai-news-pagination/?category&pageNumber&pageSize
- `[GET]` https://webapi.niftytrader.in/webapi/Symbol/stock-iv-data/?exchange&symbol&type
- `[GET]` https://webapi.niftytrader.in/webapi/option/oi-pcr-data/?reqDate&reqType&symbolName
- `[GET]` https://webapi.niftytrader.in/webapi/option/option-chain-data/?atmAbove&atmBelow&exchange&expiryDate&symbol
- `[GET]` https://webapi.niftytrader.in/webapi/option/option-chain-data/?exchange&expiryDate&symbol
- `[GET]` https://webapi.niftytrader.in/webapi/symbol/top-gainers-data/?fno_stock
- `[GET]` https://webapi.niftytrader.in/webapi/{string}/{string}/?
- `[GET]` https://webapi.niftytrader.in/webapi/{string}/{string}/?exchange&symbol
- `[GET]` https://webapi.niftytrader.in/webapi/{string}/{string}/?symbol
- `[GET]` https://www.marketsmojo.com/portfolio-plus/stickeyheader/?
- `[GET]` https://www.marketsmojo.com/portfolio-plus/stickeyheader/?cid
- `[GET]` https://www.marketsmojo.com/technical_card/getCardInfo/?cardlist&cid&pr&se&sid
- `[GET]` https://www.marketsmojo.com/technical_card/getCardInfo/?cardlist&se&sid
- `[GET]` https://www.marketsmojo.com/technical_card/getPeersData/?se&sid
- `[GET]` https://www.moneycontrol.com/mc/widget/bulk-block-deals/?exchange&limit&orderBy&start
- `[GET]` https://www.moneycontrol.com/mc/widget/chart-patterns/?pattern_type&scId
- `[GET]` https://www.moneycontrol.com/mc/widget/concall-transcripts/?exchange&limit
- `[GET]` https://www.moneycontrol.com/mc/widget/delivery-scanners/?exchange&lang
- `[GET]` https://www.moneycontrol.com/mc/widget/dividend-calendar/?scId&section
- `[GET]` https://www.moneycontrol.com/mc/widget/earnings-surprises/?scId&type
- `[GET]` https://www.moneycontrol.com/mc/widget/exchange-filings/?exchange&exchangeSymbol
- `[GET]` https://www.moneycontrol.com/mc/widget/fii-dii-daily/?exchange&type&year_month
- `[GET]` https://www.moneycontrol.com/mc/widget/futures-data/?exchange&expirydate&fut&id
- `[GET]` https://www.moneycontrol.com/mc/widget/gainers-losers/?duration&exchange&marketcap&pagesize
- `[GET]` https://www.moneycontrol.com/mc/widget/historicalrating/?classic&indice_id&period&type
- `[GET]` https://www.moneycontrol.com/mc/widget/historicalrating/ratingPro/?classic&dur&period&sc_did&type
- `[GET]` https://www.moneycontrol.com/mc/widget/history/?currencyCode&from&resolution&symbol&to
- `[GET]` https://www.moneycontrol.com/mc/widget/insider-deals/?dealsType&exchange&range
- `[GET]` https://www.moneycontrol.com/mc/widget/iv-percentile/?symbol&type
- `[GET]` https://www.moneycontrol.com/mc/widget/market-news/?category&exchange&limit
- `[GET]` https://www.moneycontrol.com/mc/widget/mcfinancials/getFinancialData/?cagrReq&classic&device_type&frequency&referenceId&requestType&scId
- `[GET]` https://www.moneycontrol.com/mc/widget/mcfinancials/getFinancialData/?classic&device_type&frequency&referenceId&requestType&scId
- `[GET]` https://www.moneycontrol.com/mc/widget/mcinsightspro/insightPro/?classic&sc_did&sc_id
- `[GET]` https://www.moneycontrol.com/mc/widget/momentum-rankings/?exchange&index&page
- `[GET]` https://www.moneycontrol.com/mc/widget/oi-heatmaps/?exchange&expDate&mtype
- `[GET]` https://www.moneycontrol.com/mc/widget/oi-pcr-trend/?exchange&reqType&symbolName
- `[GET]` https://www.moneycontrol.com/mc/widget/option-chain/?expiryDate&symbol
- `[GET]` https://www.moneycontrol.com/mc/widget/pe-pb-bands/?days&symbol
- `[GET]` https://www.moneycontrol.com/mc/widget/pivot-levels/?classic&period&scId
- `[GET]` https://www.moneycontrol.com/mc/widget/price-forecast/?deviceType&scId
- `[GET]` https://www.moneycontrol.com/mc/widget/pricechart_technicals/pivot_level/?classic&page&period&sc_did
- `[GET]` https://www.moneycontrol.com/mc/widget/pricechart_technicals/{string}/?classic&page&period&period&sc_did
- `[GET]` https://www.moneycontrol.com/mc/widget/proscanner-details/?catId&exchange&scanId
- `[GET]` https://www.moneycontrol.com/mc/widget/quarterly-results/?scId&type_format
- `[GET]` https://www.moneycontrol.com/mc/widget/research-reports/?exchange&path
- `[GET]` https://www.moneycontrol.com/mc/widget/stockdetails/getChartInfo/?classic&scId&type
- `[GET]` https://www.moneycontrol.com/mc/widget/stockvitals/?classic&sc_did&sc_id&slug
- `[GET]` https://www.moneycontrol.com/mc/widget/superstar-portfolios/?exchange&limit&only_superstars
- `[GET]` https://www.moneycontrol.com/mc/widget/trending-screeners/?exchange&exchangeId&pageNumber&pageSize
- `[GET]` https://www.moneycontrol.com/mc/widget/{string}/?classic&sc_did&sc_id
- `[GET]` https://www.moneycontrol.com/mc/widget/{string}/?companyid
- `[GET]` https://www.moneycontrol.com/mc/widget/{string}/?ex&scId
- `[GET]` https://www.moneycontrol.com/mc/widget/{string}/?exchange
- `[GET]` https://www.moneycontrol.com/mc/widget/{string}/?period&scId
- `[GET]` https://www.moneycontrol.com/mc/widget/{string}/?scId
- `[GET]` https://www.moneycontrol.com/mc/widget/{string}/?symbol
- `[GET]` https://www.moneycontrol.com/newsapi/mc_news.php/?limit&query&sortby&sortorder&start
- `[GET]` https://www.moneycontrol.com/newsapi/mc_news.php/?limit&query&start
- `[GET]` https://www.moneycontrol.com/newsapi/mc_news.php/?query
- `[GET]` https://www.moneycontrol.com/stocks/company_info/get_vwap_chart_data.php/?classic&sc_did
- `[GET]` https://www.moneycontrol.com/techmvc/mc_apis/mc_pricechart_homepage/news/?sc_did
- `[GET]` https://www.ndtvprofit.com/api/v2/fuel/city/mumbai/?
- `[GET]` https://www.ndtvprofit.com/api/v2/market-news/?company
- `[GET]` https://www.ndtvprofit.com/api/v2/markets/all-stocks/?exchangeId&instrumentId
- `[GET]` https://www.ndtvprofit.com/api/v2/markets/summary/?indices&limit
- `[GET]` https://www.ndtvprofit.com/api/v2/metals/?cityname&metaltype
- `[GET]` https://www.ndtvprofit.com/api/v2/open-interest/?duration&stock
- `[GET]` https://www.ndtvprofit.com/api/v2/stock-summary/?symbol
- `[GET]` https://www.ndtvprofit.com/api/v2/stocks/announcements/?exchangeSymbol
- `[GET]` https://www.ndtvprofit.com/api/v2/stocks/dashboard/?symbol
- `[GET]` https://www.ndtvprofit.com/api/v2/stocks/graph/?symbol&tab
- `[GET]` https://www.ndtvprofit.com/api/v2/stocks/movers/?exchangeId&filterType&filterValue&moveType&period&topCount
- `[GET]` https://www.ndtvprofit.com/api/v2/{string}/?
- `[GET]` https://www.ndtvprofit.com/api/v2/{string}/{string}/?
- `[GET]` https://www.ndtvprofit.com/api/v2/{string}/{string}/?exchange
- `[GET]` https://www.nseindia.com/api/NextApi/apiClient/?functionName&type
- `[GET]` https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi/?functionName
- `[GET]` https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi/?functionName&symbol
- `[GET]` https://www.nseindia.com/api/NextApi/apiStatic/?functionName&url
- `[GET]` https://www.nseindia.com/api/NextApi/{string}/?functionName
- `[GET]` https://www.nseindia.com/api/market-data-pre-open/?key
- `[GET]` https://www.nseindia.com/api/{string}/?
- `[GET]` https://www.nseindia.com/json/liveMarket/live-preOpen.json/?
- `[GET]` https://www.tickertape.in/market-mood-index/?
- `[GET]` https://www.trading80.com/technical_card/getCardInfo/?cardlist&se&sid

</details>

## FAILED — 370 endpoints

- oxide.sensibull.com: 35
- trendlyne.com: 30
- analyze.api.tickertape.in: 26
- smartoptions.trendlyne.com: 24
- api.niftytrader.in: 22
- api.stockedge.com: 21
- api.tickertape.in: 21
- etmarketsapis.indiatimes.com: 21
- json.bselivefeeds.indiatimes.com: 21
- marketservices.indiatimes.com: 21
- webapi.niftytrader.in: 21
- www.nseindia.com: 21
- api.moneycontrol.com: 20
- priceapi.moneycontrol.com: 20
- quotes-api.tickertape.in: 20
- : 6
- ticker.finology.in: 6
- investsights.in: 5
- ai-chat.tapetide.com: 3
- etspeedapicache.indiatimes.com: 1
- marketapis.indiatimes.com: 1
- mseindia.com: 1
- subscriptions.economictimes.indiatimes.com: 1
- www.bloombergquint.com: 1
- www.niftytrader.in: 1

| host | template | method | last status | error |
| --- | --- | --- | --- | --- |
|  | `https:///api.moneycontrol.com/mcapi/v1/stock/get-stock-price/?scId&scIdList` | GET | 0 | Failed to perform, curl: (3) URL rejected: Unsupported number of slashes followi |
|  | `https:///api.moneycontrol.com/mcapi/v1/{string}/{string}/?scId&type` | GET | 0 | Failed to perform, curl: (3) URL rejected: Unsupported number of slashes followi |
|  | `https:///appfeeds.moneycontrol.com/jsonapi/market/indices&format=json&ind_id=38/?` | GET | 0 | Failed to perform, curl: (3) URL rejected: Unsupported number of slashes followi |
|  | `https:///priceapi.moneycontrol.com/pricefeed/{string}/{string}/{string}/?` | GET | 0 | Failed to perform, curl: (3) URL rejected: Unsupported number of slashes followi |
|  | `https:///www.moneycontrol.com/mc/widget/swot/swotCount/?device_type&scDid&scId&stkname` | GET | 0 | Failed to perform, curl: (3) URL rejected: Unsupported number of slashes followi |
|  | `https:///www.moneycontrol.com/mc/widget/{string}/?sc_did&sc_id` | GET | 0 | Failed to perform, curl: (3) URL rejected: Unsupported number of slashes followi |
| ai-chat.tapetide.com | `https://ai-chat.tapetide.com/insights/RELIANCE/?` | GET | 401 | http 401 |
| ai-chat.tapetide.com | `https://ai-chat.tapetide.com/insights/RELIANCE/?period_type` | GET | 401 | http 401 |
| ai-chat.tapetide.com | `https://ai-chat.tapetide.com/insights/RELIANCE/documents/?` | GET | 401 | http 401 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/bulk-block-deals/?exchange&limit&orderBy&start` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/concall-transcripts/?exchange&limit` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/delivery-scanners/?exchange&lang` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/earnings-surprises/?scId&type` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/exchange-filings/?exchange&exchangeSymbol` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/futures-data/?exchange&expirydate&fut&id` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/gainers-losers/?duration&exchange&marketcap&pagesize` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/iv-percentile/?symbol&type` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/oi-heatmaps/?exchange&expDate&mtype` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/oi-pcr-trend/?exchange&reqType&symbolName` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/option-chain/?expiryDate&symbol` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/pe-pb-bands/?days&symbol` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/proscanner-details/?catId&exchange&scanId` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/quarterly-results/?scId&type_format` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/research-reports/?exchange&path` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/superstar-portfolios/?exchange&limit&only_superstars` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/{string}/?companyid` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/{string}/?ex&scId` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/{string}/?exchange` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/{string}/?period&scId` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/{string}/?scId` | GET | 404 | http 404 |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/{string}/?symbol` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/bulk-block-deals/?exchange&limit&orderBy&start` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/concall-transcripts/?exchange&limit` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/earnings-surprises/?scId&type` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/fii-dii-daily/?exchange&type&year_month` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/futures-data/?exchange&expirydate&fut&id` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/iv-percentile/?symbol&type` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/oi-heatmaps/?exchange&expDate&mtype` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/oi-pcr-trend/?exchange&reqType&symbolName` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/option-chain/?expiryDate&symbol` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/quarterly-results/?scId&type_format` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/stock/financial-historical/overview/?scId` | GET | 422 | http 422 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/superstar-portfolios/?exchange&limit&only_superstars` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/{string}/?ex&scId` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/{string}/?exchange` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/{string}/?period&scId` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/{string}/?scId` | GET | 404 | http 404 |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/{string}/?symbol` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/bulk-block-deals/?exchange&limit&orderBy&start` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/delivery-scanners/?exchange&lang` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/dividend-calendar/?scId&section` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/futures-data/?exchange&expirydate&fut&id` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/insider-deals/?dealsType&exchange&range` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/oi-heatmaps/?exchange&expDate&mtype` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/oi-pcr-trend/?exchange&reqType&symbolName` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/option-chain/?expiryDate&symbol` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/pe-pb-bands/?days&symbol` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/price-forecast/?deviceType&scId` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/proscanner-details/?catId&exchange&scanId` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/quarterly-results/?scId&type_format` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/research-reports/?exchange&path` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/{string}/?exchange` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/{string}/?period&scId` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/{string}/?scId` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/{string}/?symbol` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/{string}/{string}/?` | GET | 404 | http 404 |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/{string}/{string}/?symbol` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/AlertsApi/GetSavedAlertsByType/{int_id}/2021/03/{int_id}/?lang&page&pageSize&relevantListings` | GET | 403 | http 403 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/bulk-block-deals/?exchange&limit&orderBy&start` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/earnings-surprises/?scId&type` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/futures-data/?exchange&expirydate&fut&id` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/insider-deals/?dealsType&exchange&range` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/iv-percentile/?symbol&type` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/momentum-rankings/?exchange&index&page` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/oi-heatmaps/?exchange&expDate&mtype` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/oi-pcr-trend/?exchange&reqType&symbolName` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/option-chain/?expiryDate&symbol` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/pe-pb-bands/?days&symbol` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/proscanner-details/?catId&exchange&scanId` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/quarterly-results/?scId&type_format` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/research-reports/?exchange&path` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/{string}/?exchange` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/{string}/?period&scId` | GET | 404 | http 404 |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/{string}/?symbol` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/bulk-block-deals/?exchange&limit&orderBy&start` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/commentaries/RLXO/?keys[` | GET | 400 | http 400 |
| api.tickertape.in | `https://api.tickertape.in/stocks/concall-transcripts/?exchange&limit` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/delivery-scanners/?exchange&lang` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/earnings-surprises/?scId&type` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/exchange-filings/?exchange&exchangeSymbol` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/futures-data/?exchange&expirydate&fut&id` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/gainers-losers/?duration&exchange&marketcap&pagesize` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/iv-percentile/?symbol&type` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/oi-heatmaps/?exchange&expDate&mtype` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/oi-pcr-trend/?exchange&reqType&symbolName` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/option-chain/?expiryDate&symbol` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/price-forecast/?deviceType&scId` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/proscanner-details/?catId&exchange&scanId` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/research-reports/?exchange&path` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/{string}/?ex&scId` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/{string}/?period&scId` | GET | 404 | http 404 |
| api.tickertape.in | `https://api.tickertape.in/stocks/{string}/?symbol` | GET | 404 | http 404 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/ET_Stats/gainers/?duration&marketcap&pageno&pagesize&sort&sortby&sortorder` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/ET_Stats/gainers/?duration&marketcap&pagesize&sort&sortby&sortorder` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/chart-patterns/?pattern_type&scId` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/delivery-scanners/?exchange&lang` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/dividend-calendar/?scId&section` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/earnings-surprises/?scId&type` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/exchange-filings/?exchange&exchangeSymbol` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/fii-dii-daily/?exchange&type&year_month` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/futures-data/?exchange&expirydate&fut&id` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/history/?currencyCode&from&resolution&symbol&to` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/insider-deals/?dealsType&exchange&range` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/option-chain/?expiryDate&symbol` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/pivot-levels/?classic&period&scId` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/price-forecast/?deviceType&scId` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/research-reports/?exchange&path` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/superstar-portfolios/?exchange&limit&only_superstars` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/{string}/?companyid` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/{string}/?exchange` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/{string}/?period&scId` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/{string}/?scId` | GET | 503 | http 503 |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/{string}/?symbol` | GET | 503 | http 503 |
| etspeedapicache.indiatimes.com | `https://etspeedapicache.indiatimes.com/etspeeds/search.ep/?callback&category&mustHaveCompany&mustHaveCompany&outputtype&pagesize&site&truncate` | GET | 503 | http 503 |
| investsights.in | `https://investsights.in/api/v2/market/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| investsights.in | `https://investsights.in/api/v2/{string}/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| investsights.in | `https://investsights.in/api/v2/{string}/live-quote/?symbol` | GET | 404 | http 404 |
| investsights.in | `https://investsights.in/api/v2/{string}/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| investsights.in | `https://investsights.in/api/v2/{string}/{string}/?period&scId` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/earnings-surprises/?scId&type` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/futures-data/?exchange&expirydate&fut&id` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/insider-deals/?dealsType&exchange&range` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/iv-percentile/?symbol&type` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/oi-pcr-trend/?exchange&reqType&symbolName` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/option-chain/?expiryDate&symbol` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/pe-pb-bands/?days&symbol` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/price-forecast/?deviceType&scId` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/proscanner-details/?catId&exchange&scanId` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/quarterly-results/?scId&type_format` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/research-reports/?exchange&path` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/superstar-portfolios/?exchange&limit&only_superstars` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/{string}/?companyid` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/{string}/?ex&scId` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/{string}/?exchange` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/{string}/?period&scId` | GET | 404 | http 404 |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/{string}/?symbol` | GET | 404 | http 404 |
| marketapis.indiatimes.com | `https://marketapis.indiatimes.com/ET_LivePush/livePriceStock/companyData/?companyid&companytype` | GET | 0 | Failed to perform, curl: (6) Could not resolve host: marketapis.indiatimes.com.  |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/delivery-scanners/?exchange&lang` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/dividend-calendar/?scId&section` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/earnings-surprises/?scId&type` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/futures-data/?exchange&expirydate&fut&id` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/gainers-losers/?duration&exchange&marketcap&pagesize` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/insider-deals/?dealsType&exchange&range` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/market-news/?category&exchange&limit` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/momentum-rankings/?exchange&index&page` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/oi-pcr-trend/?exchange&reqType&symbolName` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/price-forecast/?deviceType&scId` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/proscanner-details/?catId&exchange&scanId` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/quarterly-results/?scId&type_format` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/research-reports/?exchange&path` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/superstar-portfolios/?exchange&limit&only_superstars` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/{string}/?exchange` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/{string}/?period&scId` | GET | 404 | http 404 |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/{string}/?symbol` | GET | 404 | http 404 |
| mseindia.com | `https://mseindia.com/api/ticker/?` | GET | 0 | Failed to perform, curl: (60) SSL certificate problem: unable to get local issue |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/bulk-block-deals/?exchange&limit&orderBy&start` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/cache/fii_dii_daily/?year_month` | GET | 403 | http 403 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/cache/instrument_metacache/2/?` | GET | 403 | http 403 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/concall-transcripts/?exchange&limit` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/delivery-scanners/?exchange&lang` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/dividend-calendar/?scId&section` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/earnings-surprises/?scId&type` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/exchange-filings/?exchange&exchangeSymbol` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/fii-dii-daily/?exchange&type&year_month` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/futures-data/?exchange&expirydate&fut&id` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/gainers-losers/?duration&exchange&marketcap&pagesize` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/insider-deals/?dealsType&exchange&range` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/iv-percentile/?symbol&type` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/market-news/?category&exchange&limit` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/momentum-rankings/?exchange&index&page` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/oi-heatmaps/?exchange&expDate&mtype` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/oi-pcr-trend/?exchange&reqType&symbolName` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/option-chain/?expiryDate&symbol` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/pe-pb-bands/?days&symbol` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/price-forecast/?deviceType&scId` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/proscanner-details/?catId&exchange&scanId` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/quarterly-results/?scId&type_format` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/research-reports/?exchange&path` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/superstar-portfolios/?exchange&limit&only_superstars` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/{string}/?companyid` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/{string}/?ex&scId` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/{string}/?exchange` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/{string}/?period&scId` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/{string}/?scId` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/{string}/?symbol` | GET | 404 | http 404 |
| oxide.sensibull.com | `https://oxide.sensibull.com/v1/compute/{string}/{string}/?` | GET | 403 | http 403 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/delivery-scanners/?exchange&lang` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/dividend-calendar/?scId&section` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/futures-data/?exchange&expirydate&fut&id` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/gainers-losers/?duration&exchange&marketcap&pagesize` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history/?currencyCode&from&resolution&symbol&to` | GET | 403 | http 403 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/iv-percentile/?symbol&type` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/momentum-rankings/?exchange&index&page` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/oi-heatmaps/?exchange&expDate&mtype` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/oi-pcr-trend/?exchange&reqType&symbolName` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/option-chain/?expiryDate&symbol` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/pe-pb-bands/?days&symbol` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/price-forecast/?deviceType&scId` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/research-reports/?exchange&path` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/superstar-portfolios/?exchange&limit&only_superstars` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/{string}/?companyid` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/{string}/?exchange` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/{string}/?period&scId` | GET | 404 | http 404 |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/{string}/?symbol` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/concall-transcripts/?exchange&limit` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/dividend-calendar/?scId&section` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/exchange-filings/?exchange&exchangeSymbol` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/fii-dii-daily/?exchange&type&year_month` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/futures-data/?exchange&expirydate&fut&id` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/insider-deals/?dealsType&exchange&range` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/market-news/?category&exchange&limit` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/momentum-rankings/?exchange&index&page` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/oi-pcr-trend/?exchange&reqType&symbolName` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/option-chain/?expiryDate&symbol` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/proscanner-details/?catId&exchange&scanId` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/{string}/?companyid` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/{string}/?ex&scId` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/{string}/?exchange` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/{string}/?period&scId` | GET | 404 | http 404 |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/{string}/?symbol` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/delivery-scanners/?exchange&lang` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/earnings-surprises/?scId&type` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/fii-dii-daily/?exchange&type&year_month` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/futures-data/?exchange&expirydate&fut&id` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/gainers-losers/?duration&exchange&marketcap&pagesize` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/iv-percentile/?symbol&type` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/market-news/?category&exchange&limit` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/momentum-rankings/?exchange&index&page` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/oi-pcr-trend/?exchange&reqType&symbolName` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/option-chain/?expiryDate&symbol` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/pe-pb-bands/?days&symbol` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/price-forecast/?deviceType&scId` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/proscanner-details/?catId&exchange&scanId` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/quarterly-results/?scId&type_format` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/superstar-portfolios/?exchange&limit&only_superstars` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/{string}/?companyid` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/{string}/?ex&scId` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/{string}/?exchange` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/{string}/?period&scId` | GET | 404 | http 404 |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/{string}/?symbol` | GET | 404 | http 404 |
| subscriptions.economictimes.indiatimes.com | `https://subscriptions.economictimes.indiatimes.com/subscription/growthAnalyitcs/?isGroupUser&merchantCode` | GET | 401 | http 401 |
| ticker.finology.in | `https://ticker.finology.in/GetHouseMaster.ashx/?housecode` | GET | 403 | http 403 |
| ticker.finology.in | `https://ticker.finology.in/GetShares.ashx/?fincode&v` | GET | 403 | http 403 |
| ticker.finology.in | `https://ticker.finology.in/peers.ashx/?fincode&mode&peercount` | GET | 403 | http 403 |
| ticker.finology.in | `https://ticker.finology.in/{string}/?count&fincode&scripcode&stk&symbol&type` | GET | 403 | http 403 |
| ticker.finology.in | `https://ticker.finology.in/{string}/?exc&fincode&top&type` | GET | 403 | http 403 |
| ticker.finology.in | `https://ticker.finology.in/{string}/?fincode` | GET | 403 | http 403 |
| trendlyne.com | `https://trendlyne.com/fundamentals/bulk-block-deals/?exchange&limit&orderBy&start` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/delivery-scanners/?exchange&lang` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/dividend-calendar/?scId&section` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/fii-dii-daily/?exchange&type&year_month` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/futures-data/?exchange&expirydate&fut&id` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/gainers-losers/?duration&exchange&marketcap&pagesize` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/insider-deals/?dealsType&exchange&range` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/iv-percentile/?symbol&type` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/json-screener/79810/5/0/index/NIFTY500/nifty-500/--Relative/?` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/market-news/?category&exchange&limit` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/momentum-rankings/?exchange&index&page` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/oi-heatmaps/?exchange&expDate&mtype` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/oi-pcr-trend/?exchange&reqType&symbolName` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/option-chain/?expiryDate&symbol` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/pe-pb-bands/?days&symbol` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/price-forecast/?deviceType&scId` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/proscanner-details/?catId&exchange&scanId` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/quarterly-results/?scId&type_format` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/research-reports/?exchange&path` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/superstar-portfolios/?exchange&limit&only_superstars` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/{string}/?companyid` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/{string}/?ex&scId` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/{string}/?exchange` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/{string}/?period&scId` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/fundamentals/{string}/?symbol` | GET | 404 | http 404 |
| trendlyne.com | `https://trendlyne.com/{string}/{string}/{string}/{string}/{string}/{int_id}/{string}/?` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/bulk-block-deals/?exchange&limit&orderBy&start` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/exchange-filings/?exchange&exchangeSymbol` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/futures-data/?exchange&expirydate&fut&id` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/gainers-losers/?duration&exchange&marketcap&pagesize` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/market-news/?category&exchange&limit` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/momentum-rankings/?exchange&index&page` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/oi-pcr-trend/?exchange&reqType&symbolName` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/option-chain/?expiryDate&symbol` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/pe-pb-bands/?days&symbol` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/proscanner-details/?catId&exchange&scanId` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/research-reports/?exchange&path` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/{string}/?companyid` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/{string}/?ex&scId` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/{string}/?exchange` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/{string}/?period&scId` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/{string}/?scId` | GET | 404 | http 404 |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/{string}/?symbol` | GET | 404 | http 404 |
| www.bloombergquint.com | `https://www.bloombergquint.com/route-data.json/?path` | GET | 0 | Failed to perform, curl: (6) Could not resolve host: www.bloombergquint.com. See |
| www.niftytrader.in | `https://www.niftytrader.in/_next/data/m-kFYhuh9rPZWx0hL8Fje/gap-ups-gap-downs.json/?` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/earnings-surprises/?scId&type` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/gainers-losers/?duration&exchange&marketcap&pagesize` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/history/?currencyCode&from&resolution&symbol&to` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/quarterly-results/?scId&type_format` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/{string}/?companyid` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/{string}/?scId` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/chart-patterns/?pattern_type&scId` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/delivery-scanners/?exchange&lang` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/fii-dii-daily/?exchange&type&year_month` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/gainers-losers/?duration&exchange&marketcap&pagesize` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/market-news/?category&exchange&limit` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/momentum-rankings/?exchange&index&page` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/pivot-levels/?classic&period&scId` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/price-forecast/?deviceType&scId` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/quarterly-results/?scId&type_format` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/superstar-portfolios/?exchange&limit&only_superstars` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/{string}/?ex&scId` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/{string}/?scId` | GET | 404 | http 404 |
| www.nseindia.com | `https://www.nseindia.com/api/{string}/?symbol` | GET | 404 | http 404 |

## NEVER FETCHED — 198 endpoints

- www.nseindia.com: 43
- api.moneycontrol.com: 15
- api.tickertape.in: 13
- etmarketsapis.indiatimes.com: 13
- json.bselivefeeds.indiatimes.com: 13
- api.niftytrader.in: 12
- api.stockedge.com: 12
- priceapi.moneycontrol.com: 12
- quotes-api.tickertape.in: 12
- marketservices.indiatimes.com: 11
- trendlyne.com: 11
- webapi.niftytrader.in: 11
- smartoptions.trendlyne.com: 8
- analyze.api.tickertape.in: 6
- stocks.sapphirebroking.com: 3
- www.moneycontrol.com: 2
- etapi.indiatimes.com: 1

| host | template | method |
| --- | --- | --- |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/dividend-calendar/?scId&section` | GET |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/fii-dii-daily/?exchange&type&year_month` | GET |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/insider-deals/?dealsType&exchange&range` | GET |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/market-news/?category&exchange&limit` | GET |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/momentum-rankings/?exchange&index&page` | GET |
| analyze.api.tickertape.in | `https://analyze.api.tickertape.in/v2/stocks/price-forecast/?deviceType&scId` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/delivery-scanners/?exchange&lang` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/dividend-calendar/?scId&section` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/exchange-filings/?exchange&exchangeSymbol` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/gainers-losers/?duration&exchange&marketcap&pagesize` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/insider-deals/?dealsType&exchange&range` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/market-news/?category&exchange&limit` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/momentum-rankings/?exchange&index&page` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/pe-pb-bands/?days&symbol` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/price-forecast/?deviceType&scId` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/proscanner-details/?catId&exchange&scanId` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/research-reports/?exchange&path` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/stock/get-stock-price/?scId&scIdList` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/{string}/?companyid` | GET |
| api.moneycontrol.com | `https://api.moneycontrol.com/mcapi/v1/{string}/{string}/?scId&type` | GET |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/concall-transcripts/?exchange&limit` | GET |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/earnings-surprises/?scId&type` | GET |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/exchange-filings/?exchange&exchangeSymbol` | GET |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/fii-dii-daily/?exchange&type&year_month` | GET |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/gainers-losers/?duration&exchange&marketcap&pagesize` | GET |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/iv-percentile/?symbol&type` | GET |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/market-news/?category&exchange&limit` | GET |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/momentum-rankings/?exchange&index&page` | GET |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/superstar-portfolios/?exchange&limit&only_superstars` | GET |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/{string}/?companyid` | GET |
| api.niftytrader.in | `https://api.niftytrader.in/webapi/{string}/?ex&scId` | GET |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/concall-transcripts/?exchange&limit` | GET |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/delivery-scanners/?exchange&lang` | GET |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/dividend-calendar/?scId&section` | GET |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/exchange-filings/?exchange&exchangeSymbol` | GET |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/fii-dii-daily/?exchange&type&year_month` | GET |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/gainers-losers/?duration&exchange&marketcap&pagesize` | GET |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/market-news/?category&exchange&limit` | GET |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/price-forecast/?deviceType&scId` | GET |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/superstar-portfolios/?exchange&limit&only_superstars` | GET |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/{string}/?companyid` | GET |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/{string}/?ex&scId` | GET |
| api.stockedge.com | `https://api.stockedge.com/Api/{string}/{string}/?scId` | GET |
| api.tickertape.in | `https://api.tickertape.in/stocks/dividend-calendar/?scId&section` | GET |
| api.tickertape.in | `https://api.tickertape.in/stocks/fii-dii-daily/?exchange&type&year_month` | GET |
| api.tickertape.in | `https://api.tickertape.in/stocks/financials/income/{tickertape_sid}/annual/normal` | GET |
| api.tickertape.in | `https://api.tickertape.in/stocks/insider-deals/?dealsType&exchange&range` | GET |
| api.tickertape.in | `https://api.tickertape.in/stocks/market-news/?category&exchange&limit` | GET |
| api.tickertape.in | `https://api.tickertape.in/stocks/momentum-rankings/?exchange&index&page` | GET |
| api.tickertape.in | `https://api.tickertape.in/stocks/pe-pb-bands/?days&symbol` | GET |
| api.tickertape.in | `https://api.tickertape.in/stocks/quarterly-results/?scId&type_format` | GET |
| api.tickertape.in | `https://api.tickertape.in/stocks/superstar-portfolios/?exchange&limit&only_superstars` | GET |
| api.tickertape.in | `https://api.tickertape.in/stocks/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET |
| api.tickertape.in | `https://api.tickertape.in/stocks/{string}/?companyid` | GET |
| api.tickertape.in | `https://api.tickertape.in/stocks/{string}/?exchange` | GET |
| api.tickertape.in | `https://api.tickertape.in/stocks/{string}/?scId` | GET |
| etapi.indiatimes.com | `https://etapi.indiatimes.com/et-screener/v2/intraday-stats` | POST |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/bulk-block-deals/?exchange&limit&orderBy&start` | GET |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/concall-transcripts/?exchange&limit` | GET |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/gainers-losers/?duration&exchange&marketcap&pagesize` | GET |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/iv-percentile/?symbol&type` | GET |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/market-news/?category&exchange&limit` | GET |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/momentum-rankings/?exchange&index&page` | GET |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/oi-heatmaps/?exchange&expDate&mtype` | GET |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/oi-pcr-trend/?exchange&reqType&symbolName` | GET |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/pe-pb-bands/?days&symbol` | GET |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/proscanner-details/?catId&exchange&scanId` | GET |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/quarterly-results/?scId&type_format` | GET |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET |
| etmarketsapis.indiatimes.com | `https://etmarketsapis.indiatimes.com/{string}/?ex&scId` | GET |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/ET_Community/bsensejson?companyid={companyid}` | GET |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/ET_Community/companypagedata?companyid={companyid}` | GET |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/bulk-block-deals/?exchange&limit&orderBy&start` | GET |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/concall-transcripts/?exchange&limit` | GET |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/delivery-scanners/?exchange&lang` | GET |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/dividend-calendar/?scId&section` | GET |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/exchange-filings/?exchange&exchangeSymbol` | GET |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/fii-dii-daily/?exchange&type&year_month` | GET |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/gainers-losers/?duration&exchange&marketcap&pagesize` | GET |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/market-news/?category&exchange&limit` | GET |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/momentum-rankings/?exchange&index&page` | GET |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/oi-heatmaps/?exchange&expDate&mtype` | GET |
| json.bselivefeeds.indiatimes.com | `https://json.bselivefeeds.indiatimes.com/{string}/?scId` | GET |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/bulk-block-deals/?exchange&limit&orderBy&start` | GET |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/concall-transcripts/?exchange&limit` | GET |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/exchange-filings/?exchange&exchangeSymbol` | GET |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/fii-dii-daily/?exchange&type&year_month` | GET |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/iv-percentile/?symbol&type` | GET |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/oi-heatmaps/?exchange&expDate&mtype` | GET |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/option-chain/?expiryDate&symbol` | GET |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/pe-pb-bands/?days&symbol` | GET |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/{string}/?companyid` | GET |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/{string}/?ex&scId` | GET |
| marketservices.indiatimes.com | `https://marketservices.indiatimes.com/{string}/?scId` | GET |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/bulk-block-deals/?exchange&limit&orderBy&start` | GET |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/concall-transcripts/?exchange&limit` | GET |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/earnings-surprises/?scId&type` | GET |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/exchange-filings/?exchange&exchangeSymbol` | GET |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/fii-dii-daily/?exchange&type&year_month` | GET |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/insider-deals/?dealsType&exchange&range` | GET |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/market-news/?category&exchange&limit` | GET |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/proscanner-details/?catId&exchange&scanId` | GET |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/quarterly-results/?scId&type_format` | GET |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/trending-screeners/?exchange&exchangeId&pageNumber&pageSize` | GET |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/{string}/?ex&scId` | GET |
| priceapi.moneycontrol.com | `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/{string}/?scId` | GET |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/bulk-block-deals/?exchange&limit&orderBy&start` | GET |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/delivery-scanners/?exchange&lang` | GET |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/earnings-surprises/?scId&type` | GET |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/gainers-losers/?duration&exchange&marketcap&pagesize` | GET |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/iv-percentile/?symbol&type` | GET |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/oi-heatmaps/?exchange&expDate&mtype` | GET |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/pe-pb-bands/?days&symbol` | GET |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/price-forecast/?deviceType&scId` | GET |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/quarterly-results/?scId&type_format` | GET |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/research-reports/?exchange&path` | GET |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/superstar-portfolios/?exchange&limit&only_superstars` | GET |
| quotes-api.tickertape.in | `https://quotes-api.tickertape.in/{string}/?scId` | GET |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/bulk-block-deals/?exchange&limit&orderBy&start` | GET |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/concall-transcripts/?exchange&limit` | GET |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/dividend-calendar/?scId&section` | GET |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/exchange-filings/?exchange&exchangeSymbol` | GET |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/insider-deals/?dealsType&exchange&range` | GET |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/oi-heatmaps/?exchange&expDate&mtype` | GET |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/research-reports/?exchange&path` | GET |
| smartoptions.trendlyne.com | `https://smartoptions.trendlyne.com/phoenix/api/fno/{string}/?scId` | GET |
| stocks.sapphirebroking.com | `https://stocks.sapphirebroking.com/api/market/index/NIFTY%2050/?` | GET |
| stocks.sapphirebroking.com | `https://stocks.sapphirebroking.com/api/market/{string}/?` | GET |
| stocks.sapphirebroking.com | `https://stocks.sapphirebroking.com/api/market/{string}/RELIANCE/{string}/?` | GET |
| trendlyne.com | `https://trendlyne.com/fundamentals/concall-transcripts/?exchange&limit` | GET |
| trendlyne.com | `https://trendlyne.com/fundamentals/earnings-surprises/?scId&type` | GET |
| trendlyne.com | `https://trendlyne.com/fundamentals/exchange-filings/?exchange&exchangeSymbol` | GET |
| trendlyne.com | `https://trendlyne.com/fundamentals/json-screener/{int_id}/5/0/index/NIFTY500/nifty-500/{string}/?` | GET |
| trendlyne.com | `https://trendlyne.com/fundamentals/{string}/?scId` | GET |
| trendlyne.com | `https://trendlyne.com/mutual-fund/getMFdata/?category&category&category&category&category&category&category&category&category&category&category&category&category&category&plan&plan` | GET |
| trendlyne.com | `https://trendlyne.com/mutual-fund/getMFdata/?category&category&category&category&category&category&plan&plan` | GET |
| trendlyne.com | `https://trendlyne.com/mutual-fund/getMFdata/?category&category&category&plan&plan` | GET |
| trendlyne.com | `https://trendlyne.com/mutual-fund/getMFdata/?category&category&plan&plan` | GET |
| trendlyne.com | `https://trendlyne.com/mutual-fund/getMFdata/?category&plan&plan` | GET |
| trendlyne.com | `https://trendlyne.com/mutual-fund/{string}/?pk` | GET |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/concall-transcripts/?exchange&limit` | GET |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/delivery-scanners/?exchange&lang` | GET |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/dividend-calendar/?scId&section` | GET |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/earnings-surprises/?scId&type` | GET |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/fii-dii-daily/?exchange&type&year_month` | GET |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/insider-deals/?dealsType&exchange&range` | GET |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/iv-percentile/?symbol&type` | GET |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/oi-heatmaps/?exchange&expDate&mtype` | GET |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/price-forecast/?deviceType&scId` | GET |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/quarterly-results/?scId&type_format` | GET |
| webapi.niftytrader.in | `https://webapi.niftytrader.in/webapi/superstar-portfolios/?exchange&limit&only_superstars` | GET |
| www.moneycontrol.com | `https://www.moneycontrol.com/mc/widget/swot/swotCount/?device_type&scDid&scId&stkname` | GET |
| www.moneycontrol.com | `https://www.moneycontrol.com/mc/widget/{string}/?sc_did&sc_id` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/bulk-block-deals/?exchange&limit&orderBy&start` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/chart-patterns/?pattern_type&scId` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/concall-transcripts/?exchange&limit` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/delivery-scanners/?exchange&lang` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/dividend-calendar/?scId&section` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/exchange-filings/?exchange&exchangeSymbol` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/fii-dii-daily/?exchange&type&year_month` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/futures-data/?exchange&expirydate&fut&id` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/insider-deals/?dealsType&exchange&range` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/iv-percentile/?symbol&type` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/market-news/?category&exchange&limit` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/momentum-rankings/?exchange&index&page` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/oi-heatmaps/?exchange&expDate&mtype` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/oi-pcr-trend/?exchange&reqType&symbolName` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/option-chain/?expiryDate&symbol` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/pe-pb-bands/?days&symbol` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/pivot-levels/?classic&period&scId` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/price-forecast/?deviceType&scId` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/proscanner-details/?catId&exchange&scanId` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/research-reports/?exchange&path` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/superstar-portfolios/?exchange&limit&only_superstars` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/{string}/?ex&scId` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/{string}/?exchange` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/{string}/?period&scId` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/NextApi/{string}/?symbol` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/bulk-block-deals/?exchange&limit&orderBy&start` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/concall-transcripts/?exchange&limit` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/dividend-calendar/?scId&section` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/earnings-surprises/?scId&type` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/exchange-filings/?exchange&exchangeSymbol` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/futures-data/?exchange&expirydate&fut&id` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/history/?currencyCode&from&resolution&symbol&to` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/insider-deals/?dealsType&exchange&range` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/iv-percentile/?symbol&type` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/oi-heatmaps/?exchange&expDate&mtype` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/oi-pcr-trend/?exchange&reqType&symbolName` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/option-chain/?expiryDate&symbol` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/pe-pb-bands/?days&symbol` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/proscanner-details/?catId&exchange&scanId` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/research-reports/?exchange&path` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/{string}/?companyid` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/{string}/?exchange` | GET |
| www.nseindia.com | `https://www.nseindia.com/api/{string}/?period&scId` | GET |
