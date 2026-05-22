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
  return { largeDeal, topStock, sectorWise, all, insightBuy, insightSell,
           insiderBuy, insiderSell, investorBuy, investorSell, largeInsight };
}

// ─── Earnings ─────────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

export async function fetchEarningsDashboard() {
  return mcFetchJson('https://api.moneycontrol.com/mcapi/v1/earnings/result-dashboard');
}

export async function fetchEarningsCalendar(date?: string) {
  const d = date || todayISO();
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/earnings/result-calendar?indexId=All&fromDate=${d}&toDate=${d}&sector=`
  );
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
  const [dashboard, calendar, earningsData, rapidLR, rapidBP, priceShockers, actualEstimate] = await Promise.all([
    fetchEarningsDashboard(),
    fetchEarningsCalendar(date),
    fetchEarningsData(date),
    fetchEarningsRapidResults('LR'),
    fetchEarningsRapidResults('BP'),
    fetchEarningsPriceShockers(),
    fetchEarningsActualEstimate(),
  ]);
  return { dashboard, calendar, earningsData, rapidLR, rapidBP, priceShockers, actualEstimate };
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
