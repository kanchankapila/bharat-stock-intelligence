import { mcFetchJson } from './mcApiService';

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
