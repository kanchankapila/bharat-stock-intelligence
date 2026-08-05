import { mcFetchJson } from './mcApiService';
import { getNiftyTraderHeaders } from './niftytraderService';
import { parseNtOptionChainResponse } from './contracts/marketFeeds';

// ─── Premarket ────────────────────────────────────────────────────────────────

export async function fetchPremarketArticle(slug: string) {
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/premarket/article?slug=${slug}&limit=1`
  );
}

export async function fetchPremarketGlobalMarkets() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/premarket/get-global-marketdata?section=mi'
  );
}

export async function fetchPremarketEcalendar() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/ecalendar/get-upcoming-event-data?page=1&pageSize=7'
  );
}

export async function fetchPremarketMarketViews() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/premarket/getMarketViewsData?cat=all&start=0&limit=9'
  );
}

export async function fetchPremarketFllActivity() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/premarket/getFllActivityData?type=cash'
  );
}

export async function fetchPremarketStocksToWatch() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/premarket/getStockToWatchData?start=0&limit=6&sortby=rank&sortorder=asc'
  );
}

export async function fetchPremarketNews() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/premarket/getMarketNewsData?limit=8'
  );
}

export async function fetchPremarketBrokerReco() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/premarket/getBrokerResearchReco?sublevel=stocks&start=0&limit=12'
  );
}

export async function fetchPremarketAll() {
  const [globalMarkets, ecalendar, marketViews, fllActivity, stocksToWatch, news, brokerReco,
         articleMarketCues, articleAsian, articleInternational] = await Promise.all([
    fetchPremarketGlobalMarkets(),
    fetchPremarketEcalendar(),
    fetchPremarketMarketViews(),
    fetchPremarketFllActivity(),
    fetchPremarketStocksToWatch(),
    fetchPremarketNews(),
    fetchPremarketBrokerReco(),
    fetchPremarketArticle('market-cues'),
    fetchPremarketArticle('asian-markets'),
    fetchPremarketArticle('international-markets'),
  ]);
  return { globalMarkets, ecalendar, marketViews, fllActivity, stocksToWatch, news, brokerReco,
           articles: { marketCues: articleMarketCues, asian: articleAsian, international: articleInternational } };
}

// ─── Deals ────────────────────────────────────────────────────────────────────

function mapDealItem(item: any) {
  if (!item) return null;
  const quantity = parseFloat(item.quantity) || 0;
  const value = parseFloat(item.dealValue || item.dealsValue || 0);
  const price = parseFloat(item.tradedPrice || item.deal_price || 0);
  const chg = parseFloat(item.tradedPer || item.perTraded || item.percentChange || item.pChange || 0);

  return {
    symbol: item.sc_nseid || item.sc_id || item.symbol || '',
    companyName: item.stockName || item.sc_comp || item.company || '',
    dealType: item.deal_type || item.dealType || 'Deal',
    buyerName: item.boughtBy || item.party || '—',
    sellerName: item.action === 'Sell' ? item.boughtBy : '—',
    party: item.boughtBy || '—',
    dealsValue: value,
    value: value,
    dealDate: item.deal_date || item.date || '—',
    date: item.deal_date || item.date || '—',
    pChange: chg,
    percentChange: chg,
    quantity,
    price
  };
}

function mapSectorItem(item: any) {
  if (!item) return null;
  const value = parseFloat(item.dealValue || item.dealsValue || 0);
  return {
    sector: item.stock_sector || item.sectorName || 'Other',
    sectorName: item.stock_sector || item.sectorName || 'Other',
    dealsValue: value,
    value: value
  };
}

export async function fetchDeals(dealType: 'large' | 'topStock' | 'topStockSectorWise' | 'all' = 'large', limit = 24) {
  if (dealType === 'all') {
    return mcFetchJson(
      `https://api.moneycontrol.com/mcapi/v1/deals/list?start=0&limit=${limit}&orderBy=deal_date&sortBy=DESC&deviceType=W`
    );
  }
  const orderBy = dealType === 'large' ? 'deal_date' : 'dealsValue';
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/deals/list?start=0&limit=${limit}&orderBy=${orderBy}&sortBy=DESC&dealType=${dealType}&deviceType=W&apiVersion=177`
  );
}

export async function fetchDealsInsight(
  action: 'buy' | 'sell',
  dealsType: 'topDeal' | 'topInsider' | 'topInvestor',
  limit = 9
) {
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/deals/insight?start=0&limit=${limit}&value=value&range=1W&action=${action}&dealsType=${dealsType}`
  );
}

export async function fetchLargeDealsInsight() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/deals/largedeals-insight?start=0&limit=6&orderBy=dealsValue&deviceType=W'
  );
}

export async function fetchDealsAll() {
  const [largeDeal, topStock, sectorWise, all, insightBuy, insightSell,
         insiderBuy, insiderSell, investorBuy, investorSell, largeInsight] = await Promise.all([
    fetchDeals('large'),
    fetchDeals('topStock'),
    fetchDeals('topStockSectorWise'),
    fetchDeals('all'),
    fetchDealsInsight('buy', 'topDeal'),
    fetchDealsInsight('sell', 'topDeal'),
    fetchDealsInsight('buy', 'topInsider'),
    fetchDealsInsight('sell', 'topInsider'),
    fetchDealsInsight('buy', 'topInvestor'),
    fetchDealsInsight('sell', 'topInvestor'),
    fetchLargeDealsInsight(),
  ]);

  const normalizeList = (res: any, mapper: (x: any) => any) => {
    const list = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : (Array.isArray(res?.data?.list) ? res.data.list : []));
    return { data: { list: list.map(mapper).filter(Boolean) } };
  };

  const normalizeInsight = (res: any, key: string, mapper: (x: any) => any) => {
    const list = Array.isArray(res?.data?.[key]) ? res.data[key] : [];
    return { data: { list: list.map(mapper).filter(Boolean) } };
  };

  return {
    largeDeal: normalizeList(largeDeal, mapDealItem),
    topStock: normalizeList(topStock, mapDealItem),
    sectorWise: normalizeList(sectorWise, mapSectorItem),
    all: normalizeList(all, mapDealItem),
    insightBuy: insightBuy,
    insightSell: insightSell,
    insiderBuy: normalizeInsight(insiderBuy, 'topInsider', mapDealItem),
    insiderSell: normalizeInsight(insiderSell, 'topInsider', mapDealItem),
    investorBuy: normalizeInsight(investorBuy, 'topInvestor', mapDealItem),
    investorSell: normalizeInsight(investorSell, 'topInvestor', mapDealItem),
    largeInsight
  };
}

// ─── Earnings ─────────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function parseRapidRow(row: any) {
  if (!Array.isArray(row) || row.length < 7) return null;
  const [date, stockName, seoString, ltp, changeP, quarterData, scId, exchange, financialType] = row;
  
  let revenue = '—';
  let netProfit = '—';
  let revGrowth = 0;
  let profitGrowth = 0;

  if (Array.isArray(quarterData)) {
    const revRow = quarterData.find(r => r[0] === 'Revenue');
    if (revRow) {
      revenue = revRow[1];
      revGrowth = parseFloat(revRow[3]) || 0;
    }
    const npRow = quarterData.find(r => r[0] === 'Net Profit');
    if (npRow) {
      netProfit = npRow[1];
      profitGrowth = parseFloat(npRow[3]) || 0;
    }
  }

  let resultStatus = 'neutral';
  if (profitGrowth > 10) resultStatus = 'beat';
  else if (profitGrowth < -5) resultStatus = 'miss';

  return {
    companyName: stockName,
    companyShortName: stockName,
    name: stockName,
    symbol: scId,
    scId: scId,
    revenue,
    netProfit,
    revGrowth,
    revenueGrowth: revGrowth,
    profitGrowth,
    netProfitGrowth: profitGrowth,
    resultStatus,
    date,
    ltp: parseFloat(ltp) || 0,
    change: parseFloat(changeP) || 0,
    actual: profitGrowth,
    actualGrowth: profitGrowth,
    estimate: 0,
    estimateGrowth: 0
  };
}

function parsePriceShockerRow(row: any) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [scId, exchange, name, resultDate, ltp, chgPercent, gainLossSinceResult, stockAnalysis, stockUrl] = row;
  const chg = parseFloat(chgPercent) || 0;
  return {
    symbol: scId,
    companyName: name,
    companyShortName: name,
    price: ltp,
    lastPrice: ltp,
    pChange: chg,
    change: chg,
    resultDate
  };
}

function parseActualEstimateRow(row: any) {
  if (!Array.isArray(row) || row.length < 10) return [];
  const [scId, stockName, stockUrl, currentPrice, perChange, mtgdate, currMktcap, expectations, expectationsPer, quarterData] = row;
  
  const results: any[] = [];
  if (Array.isArray(quarterData)) {
    quarterData.forEach(q => {
      const [metric, actualVal, estimateVal] = q;
      const actual = parseFloat(actualVal?.replace(/,/g, '')) || 0;
      const estimate = parseFloat(estimateVal?.replace(/,/g, '')) || 0;
      results.push({
        symbol: scId,
        companyName: stockName,
        companyShortName: stockName,
        metric,
        actual: actualVal || '—',
        estimate: estimateVal || '—',
        actualVal: actual,
        estimateVal: estimate,
        expectations
      });
    });
  }
  return results;
}

export async function fetchEarningsDashboard() {
  return mcFetchJson('https://api.moneycontrol.com/mcapi/v1/earnings/result-dashboard');
}

export async function fetchEarningsCalendar(date?: string) {
  const d = date || todayISO();
  // The raw result-calendar endpoint only returns counts of earnings per day.
  // Instead, fetch get-earnings-data for the date and map it to a company calendar.
  const earningsData = await fetchEarningsData(d);
  const calendarItems = Array.isArray(earningsData?.data?.list)
    ? earningsData.data.list.map((item: any) => ({
        companyName: item.stockName || item.stockShortName || '',
        name: item.stockShortName || item.stockName || '',
        symbol: item.scId || '',
        resultDate: item.date || '',
        date: item.date || '',
        boardMeetingPurpose: item.resultType || 'Quarterly Results'
      }))
    : [];
  return { data: { resultCalendar: calendarItems } };
}

export async function fetchEarningsData(date?: string, limit = 18) {
  const d = date || todayISO();
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/earnings/get-earnings-data?indexId=All&page=1&startDate=${d}&endDate=${d}&sector=&limit=${limit}`
  );
}

export async function fetchEarningsRapidResults(type: 'LR' | 'BP' = 'BP') {
  if (type === 'LR') {
    return mcFetchJson(
      'https://api.moneycontrol.com/mcapi/v1/earnings/rapid-results?limit=9&page=1&type=LR&subType=yoy'
    );
  }
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/earnings/rapid-results?limit=21&page=1&type=BP&subType=yoy&category=all&sortBy=growth&indexId=N&sector=&search=&seq=desc'
  );
}

export async function fetchEarningsPriceShockers(limit = 8) {
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/earnings/price-shockers?limit=${limit}&page=1`
  );
}

export async function fetchEarningsActualEstimate(limit = 6) {
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/earnings/actual-estimate?page=1&limit=${limit}`
  );
}

export async function fetchEarningsAll(date?: string) {
  const [dashboard, calendarRes, earningsData, rapidLR, rapidBP, priceShockers, actualEstimate] = await Promise.all([
    fetchEarningsDashboard(),
    fetchEarningsCalendar(date),
    fetchEarningsData(date),
    fetchEarningsRapidResults('LR'),
    fetchEarningsRapidResults('BP'),
    fetchEarningsPriceShockers(),
    fetchEarningsActualEstimate(),
  ]);

  // Normalize dashboard stats
  let normalizedDashboard = null;
  if (dashboard?.success === 1 && dashboard.data) {
    const dbd = dashboard.data;
    const earningsCount = Array.isArray(earningsData?.data?.list) ? earningsData.data.list.length : 0;
    normalizedDashboard = {
      ...dbd,
      totalResults: earningsCount || dbd.declaredNSE || 0,
      todayCount: earningsCount || dbd.declaredNSE || 0,
      beat: dbd.postiveGrowth || 0,
      miss: dbd.negativeGrowth || 0,
      missed: dbd.negativeGrowth || 0,
      inline: 0,
      neutral: 0
    };
  }

  // Parse actual vs estimate
  const parsedActualEstimate = Array.isArray(actualEstimate?.data?.list)
    ? actualEstimate.data.list.flatMap(parseActualEstimateRow).filter(Boolean)
    : [];

  const beatMissChartItems = parsedActualEstimate.map((ae: any) => ({
    companyShortName: ae.companyName,
    companyName: ae.companyName,
    symbol: ae.symbol,
    actual: ae.actualVal,
    actualGrowth: ae.actualVal,
    estimate: ae.estimateVal,
    estimateGrowth: ae.estimateVal
  }));

  // Parse rapid results
  const parsedRapidBP = Array.isArray(rapidBP?.data?.list)
    ? rapidBP.data.list.map(parseRapidRow).filter(Boolean)
    : [];
  const parsedRapidLR = Array.isArray(rapidLR?.data?.list)
    ? rapidLR.data.list.map(parseRapidRow).filter(Boolean)
    : [];

  // Populate declared list
  const combinedEarnings: any[] = [];
  const seenSymbols = new Set<string>();
  [...parsedRapidBP, ...parsedRapidLR].forEach((item: any) => {
    if (item && !seenSymbols.has(item.symbol)) {
      seenSymbols.add(item.symbol);
      combinedEarnings.push(item);
    }
  });

  // Parse price shockers
  const parsedShockers = Array.isArray(priceShockers?.data?.list)
    ? priceShockers.data.list.map(parsePriceShockerRow).filter(Boolean)
    : [];

  return {
    dashboard: normalizedDashboard ? { data: normalizedDashboard } : null,
    calendar: calendarRes,
    earningsData: {
      data: {
        list: combinedEarnings,
        earningsData: combinedEarnings
      }
    },
    rapidLR: { data: { list: parsedRapidLR } },
    rapidBP: { data: { list: beatMissChartItems.length > 0 ? beatMissChartItems : parsedRapidBP } },
    priceShockers: { data: { list: parsedShockers } },
    actualEstimate: { data: { list: parsedActualEstimate } }
  };
}

// ─── Index F&O ────────────────────────────────────────────────────────────────

const FNO_INDEX_IDS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'] as const;
export type FnoIndexId = typeof FNO_INDEX_IDS[number];

export async function fetchIndexFnoFutures(id: FnoIndexId) {
  return mcFetchJson(
    `https://appfeeds.moneycontrol.com/jsonapi/fno/overview&format=json&inst_type=Futures&id=${id}&ExpiryDate=`
  );
}

export async function fetchIndexFnoOptions(id: FnoIndexId, optionType: 'CE' | 'PE') {
  return mcFetchJson(
    `https://appfeeds.moneycontrol.com/jsonapi/fno/overview&format=json&inst_type=Options&option_type=${optionType}&id=${id}&ExpiryDate=`
  );
}

export async function fetchIndexFnoAll(id: FnoIndexId) {
  const [futures, optionsCE, optionsPE] = await Promise.all([
    fetchIndexFnoFutures(id),
    fetchIndexFnoOptions(id, 'CE'),
    fetchIndexFnoOptions(id, 'PE'),
  ]);
  return { id, futures, optionsCE, optionsPE };
}

export async function fetchStockFnoExpiry(scId: string) {
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/fno/futures/getExpDts?id=${scId}`
  );
}

export async function fetchStockFnoFutures(scId: string, expiry: string) {
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/fno/futures/getFuturesData?fut=FUTSTK&id=${scId}&expirydate=${expiry}`
  );
}

export async function fetchStockFnoOptions(scId: string, optionType: 'CE' | 'PE', expiry: string) {
  // Leaving strikeprice blank to fetch all or we can use the overview endpoint
  // Actually, the overview endpoint works for stocks as well!
  return mcFetchJson(
    `https://appfeeds.moneycontrol.com/jsonapi/fno/overview&format=json&inst_type=Options&option_type=${optionType}&id=${scId}&ExpiryDate=${expiry}`
  );
}

export async function fetchStockEarningsSummary(scId: string) {
  return mcFetchJson(
    `https://appfeeds.moneycontrol.com/jsonapi/market/market_action?format=json&type=earnings&sc_id=${scId}`
  );
}

export async function fetchFNOSymbols() {
  const headers = await getNiftyTraderHeaders();
  const res = await fetch("https://webapi.niftytrader.in/webapi/symbol/psymbol-list", {
    headers: { ...headers, "platform_type": "1" },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error('Failed to fetch FNO symbols');
  return res.json();
}

export async function fetchOptionChain(symbol: string) {
  const url = `https://webapi.niftytrader.in/webapi/option/option-chain-data?symbol=${encodeURIComponent(symbol)}&exchange=nse&expiryDate=&atmBelow=0&atmAbove=0`;
  const headers = await getNiftyTraderHeaders();
  const res = await fetch(url, {
    headers: { ...headers, "platform_type": "1" },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error('Failed to fetch option chain');
  const raw = await res.json();
  const parsed = parseNtOptionChainResponse(raw);
  if (parsed.result !== 1 || !parsed.resultData) {
    throw new Error('Failed to parse option chain response');
  }
  return raw;
}

export async function fetchIndexAdvanceDecline() {
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/indices/chart/exchange-advdec?ex=N`
  );
}

export async function fetchIndicesList() {
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/indices/get-indices-list`
  );
}

export async function fetchIndiaVix() {
  const url = `https://webapi.niftytrader.in/webapi/Symbol/other-stock-spot-data?symbol=INDIA+VIX`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('Vix fetch error');
  return res.json();
}

export async function fetchLiveMarketScreener(filters: Record<string, boolean>) {
  const defaultPayload = {
    "todayNR7": false, "yesterdayNR7": false, "todayGapUP": false, "todayGapDown": false, "yesterdayGapUP": false, "yesterdayGapDown": false,
    "todayStockOpenHigh": false, "todayStockOpenLow": false, "yesterdayStockOpenHigh": false, "yesterdayStockOpenLow": false,
    "weeklyStockOpenHigh": false, "weeklyStockOpenLow": false, "orb5minHigh": false, "orb5minLow": false, "prevOrb5minLow": false, "prevOrb5minHigh": false,
    "range20DayUP": false, "range50DayUP": false, "range200DayUP": false, "range52WeekHigh": false, "range20DayDown": false, "range50DayDown": false,
    "range200DayDown": false, "range52WeekLow": false, "higherHighHigherLow": false, "lowerHighLowerLow": false, "insideDay": false, "outsideDay": false,
    "range0To100": false, "range100To500": false, "range500To1000": false, "range1000To2000": false, "rangeAbove2000": false, "todayBullishHigh": false,
    "todayBearishLow": false, "todayNetural": false, "yesterdayBullishHigh": false, "yesterdayBearishLow": false, "yesterdayNetural": false,
    "todayAbove20SMA": false, "todayBelow20SMA": false, "todayAbove50SMA": false, "todayBelow50SMA": false, "todayAbove200SMA": false, "todayBelow200SMA": false,
    "yesterdayAbove20SMA": false, "yesterdayBelow20SMA": false, "yesterdayAbove50SMA": false, "yesterdayBelow50SMA": false, "yesterdayAbove200SMA": false, "yesterdayBelow200SMA": false,
    "todayHighVolumeDay": false, "vwapAbove": false, "vwapBelow": false, "marketCapBelow1000": false, "marketCap5000To20000": false, "marketCapAbove50000": false,
    "marketCap1000To5000": false, "marketCap20000To50000": false, "stockPEBelow5": false, "stockPE10To20": false, "stockPE50To100": false, "stockPE5To10": false,
    "stockPE20To50": false, "stockPEAbove100": false, "dividendYield0To1": false, "dividendYield2To5": false, "dividendYield1To2": false, "dividendYieldAbove5": false,
    "roceBelow5": false, "roce10To20": false, "roce50To70": false, "roce5To10": false, "roce20To50": false, "roce70To100": false, "roeBelow0": false, "roe10To20": false,
    "roeAbove50": false, "roe0To10": false, "roe20To50": false, "salesGrowthBelow0": false, "salesGrowth5To10": false, "salesGrowth15To20": false, "salesGrowth0To5": false,
    "salesGrowth10To15": false, "salesGrowthAbove20": false, "piotroskiScore0To2": false, "piotroskiScore3To7": false, "piotroskiScore8To9": false, "nifty50Stocks": false,
    "fnoStocks": false, "financial": false, "nonFinancial": false, "industry": "", "maxPainAbove": false, "maxPainBelow": false, "watchlistName": "",
    "aboveCPR": false, "belowCPR": false, "insideCPR": false, "screenerGroupName": ""
  };

  const payload = { ...defaultPayload, ...filters };

  const url = `https://webapi.niftytrader.in/webapi/Screener/live-market-filter-data`;
  const headers = await getNiftyTraderHeaders();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) throw new Error(`Live Market Screener fetch error: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchEODMarketScreener(filters: Record<string, boolean>) {
  const defaultPayload = {
    "_20_day_sma_below": false, "_20_day_sma_above": false, "_50_day_sma_below": false, "_50_day_sma_above": false, "_100_day_sma_below": false, "_100_day_sma_above": false,
    "_200_day_sma_below": false, "_200_day_sma_above": false, "_5_day_ema_below": false, "_5_day_ema_above": false, "_8_day_ema_below": false, "_8_day_ema_above": false,
    "_20_day_ema_below": false, "_20_day_ema_above": false, "_26_day_ema_below": false, "_26_day_ema_above": false, "_50_day_ema_below": false, "_50_day_ema_above": false,
    "_200_day_ema_below": false, "_200_day_ema_above": false, "_5_20_sma_crossover_below": false, "_5_20_sma_crossover_above": false, "_20_50_sma_crossover_below": false,
    "_20_50_sma_crossover_above": false, "_20_100_sma_crossover_below": false, "_20_100_sma_crossover_above": false, "_50_100_sma_crossover_below": false, "_50_100_sma_crossover_above": false,
    "_50_200_sma_crossover_below": false, "_50_200_sma_crossover_above": false, "_5_20_ema_crossover_below": false, "_5_20_ema_crossover_above": false, "_8_20_ema_crossover_below": false,
    "_8_20_ema_crossover_above": false, "_12_26_ema_crossover_below": false, "_12_26_ema_crossover_above": false, "_9_30_ema_crossover_below": false, "_9_30_ema_crossover_above": false,
    "_20_50_ema_crossover_below": false, "_20_50_ema_crossover_above": false, "_50_200_ema_crossover_below": false, "_50_200_ema_crossover_above": false, "ema5_sma20_cross_below": false,
    "ema5_sma20_cross_above": false, "ema20_sma50_cross_below": false, "ema20_sma50_cross_above": false, "ema50_sma100_cross_below": false, "ema50_sma100_cross_above": false,
    "nr4": false, "nr7": false, "_5_days_high_above": false, "_5_days_high_below": false, "_5_days_high_2_above": false, "_5_days_high_2_below": false, "new_5_days_high_above": false,
    "new_5_days_low_below": false, "_20_days_high_above": false, "_20_days_high_below": false, "_20_days_high_2_above": false, "_20_days_high_2_below": false, "new_20_days_high_above": false,
    "new_20_days_low_below": false, "_50_days_high_above": false, "_50_days_high_below": false, "_50_days_high_2_above": false, "_50_days_high_2_below": false, "new_50_days_high_above": false,
    "new_50_days_low_below": false, "_100_days_high_above": false, "_100_days_high_below": false, "_100_days_high_2_above": false, "_100_days_high_2_below": false, "new_100_days_high_above": false,
    "new_100_days_low_below": false, "_200_days_high_above": false, "_200_days_high_below": false, "_200_days_high_2_above": false, "_200_days_high_2_below": false, "new_200_days_high_above": false,
    "new_200_days_low_below": false, "cci_100_above": false, "cci_100_below": false, "cci_200_above": false, "cci_200_below": false, "cci_cross_100_above": false, "cci_cross_100_below": false,
    "cci_cross_neg_100_above": false, "cci_cross_neg_100_below": false, "rsi_cross_30_below": false, "rsi_cross_70_above": false, "rsi_cross_20_below": false, "rsi_cross_80_above": false,
    "rsi_2_70_above": false, "rsi_2_70_below": false, "macd_cross_below": false, "macd_cross_above": false, "macd_cross_above_zero": false, "macd_cross_below_zero": false, "mfi_above_80": false,
    "mfi_below_20": false, "mfi_above_90": false, "mfi_below_10": false, "up_adx_between_25_50": false, "strong_up_adx_above_50": false, "down_adx_between_25_50": false, "strong_down_adx_above_50": false,
    "adx_below_50": false, "supr_buy": false, "supr_sell": false, "upper_bb_below": false, "upper_bb_above": false, "lower_bb_below": false, "lower_bb_above": false, "atr_inc_3": false,
    "atr_dec_3": false, "atr_inc_5": false, "atr_dec_5": false, "close_gainers": false, "close_losers": false, "close_more_5_gain": false, "close_more_5_down": false, "same_open_high": false,
    "same_open_low": false, "same_approx_open_high": false, "same_approx_open_low": false, "close_nearday_high": false, "close_nearday_low": false, "close_near_open": false, "higher_high": false,
    "higher_low": false, "higher_high_higher_low": false, "lower_high": false, "lower_low": false, "lower_high_lower_low": false, "inside_day": false, "outside_day": false, "high_delivery_age": false,
    "lower_high_delivery_qty": false, "high_delivery_age_qty": false, "high_trade_qty": false, "above_r2": false, "between_r1_r2": false, "above_pivot": false, "below_pivot": false, "between_s2_s1": false,
    "s2_support": false, "gap_up_opening": false, "gap_up_opening_fill": false, "gap_up_opening_unfill": false, "gap_down_opening": false, "gap_down_opening_fill": false, "gap_down_opening_unfill": false,
    "watchlist": false, "watchlist_id": 0, "watchlist_name": "", "doji_bullish": false, "doji_bearish": false, "doji_star_bullish": false, "doji_star_bearish": false, "engul_fing_bullish": false,
    "engul_fing_bearish": false, "harami_bullish": false, "harami_bearish": false, "harami_cross_bullish": false, "harami_cross_bearish": false, "evening_star_bearish": false, "inverted_hammer_bullish": false,
    "inverted_hammer_bearish": false, "hammer_bullish": false, "hammer_bearish": false, "marubozu_bullish": false, "marubozu_bearish": false, "morning_star_bullish": false, "dark_cloud_cover_bearish": false,
    "tasuki_gap_bullish": false, "tasuki_gap_bearish": false, "dragon_fly_doji_bullish": false, "dragon_fly_doji_bearish": false, "piercing_line_bullish": false, "piercing_line_bearish": false,
    "grave_stone_doji_bullish": false, "grave_stone_doji_bearish": false, "three_black_crows_bearish": false, "three_white_soldiers_bullish": false, "screener_group_id": 0, "screener_group_name": "",
    "screener_group": false, "is_candle": false
  };

  const payload = { ...defaultPayload, ...filters };
  const url = `https://webapi.niftytrader.in/webapi/Screener/advance-eod-screener-filter`;
  const headers = await getNiftyTraderHeaders();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) throw new Error('EOD Market Screener fetch error');
  return res.json();
}
