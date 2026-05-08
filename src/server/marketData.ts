import { getStockMapping } from './stockMapping';

export async function fetchTechIndicators(symbol: string, dur: 'D' | 'W' | 'M' = 'D') {
  const map = getStockMapping(symbol);
  if (!map) throw new Error("Stock mapping not found for symbol: " + symbol);
  
  // Example URL from user list: https://priceapi.moneycontrol.com/pricefeed/techindicator/W/BE03?field=RSI
  // Better one: https://api.moneycontrol.com/mcapi/technicals/v2/details?scId={mcsymbol}&dur=D&deviceType=W
  const url = `https://api.moneycontrol.com/mcapi/technicals/v2/details?scId=${map.mcsymbol}&dur=${dur}&deviceType=W`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchETCompanyData(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;

  // https://json.bselivefeeds.indiatimes.com/ET_Community/companypagedata?companyid=8581&companytype=&callback=...
  const url = `https://json.bselivefeeds.indiatimes.com/ET_Community/companypagedata?companyid=${map.companyid}&companytype=`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchMarketMap(indId: string = '38') {
  // https://appfeeds.moneycontrol.com/jsonapi/market/marketmap&format=json&type=1&ind_id=38
  const url = `https://appfeeds.moneycontrol.com/jsonapi/market/marketmap&format=json&type=1&ind_id=${indId}`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchAllIndianIndices() {
  // https://api.moneycontrol.com/mcapi/v1/indices/get-indian-indices
  const url = `https://api.moneycontrol.com/mcapi/v1/indices/get-indian-indices`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchMCRatios(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) throw new Error("Stock mapping not found for symbol: " + symbol);
  
  // https://www.moneycontrol.com/mc/widget/mcfinancials/getFinancialData?classic=true&referenceId=ratios&requestType=S&scId=BE03&frequency=3
  const url = `https://www.moneycontrol.com/mc/widget/mcfinancials/getFinancialData?classic=true&referenceId=ratios&requestType=S&scId=${map.mcsymbol}&frequency=3`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchETShareholding(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;

  // https://marketservices.indiatimes.com/marketservices/shareholding?companyid=11945
  const url = `https://marketservices.indiatimes.com/marketservices/shareholding?companyid=${map.companyid}`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchETCorporateActions(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;

  // https://json.bselivefeeds.indiatimes.com/ET_Community/companypagedata?companyid=8581&companytype=&callback=...
  // This often contains actions. Alternatively, using a more specific one if found.
  const url = `https://json.bselivefeeds.indiatimes.com/ET_Community/companypagedata?companyid=${map.companyid}&companytype=`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchHistoricalOHLC(symbol: string, dur: string = '1y') {
  const map = getStockMapping(symbol);
  if (!map) throw new Error("Stock mapping not found for symbol: " + symbol);
  
  // Using a common MC charting endpoint that provides OHLC data
  const url = `https://www.moneycontrol.com/mcapi/v1/stock/chart?scId=${map.mcsymbol}&dur=${dur}`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchSectorPerformance(indId?: string) {
  if (indId) {
    const data = await fetchMarketMap(indId);
    if (!data || !data.item) return null;
    return {
      success: 1,
      data: data.item.map((s: any) => ({
        sectorName: s.shortname,
        percentChange: s.percentchange,
        stocksCount: s.stocksCount || 0
      }))
    };
  }
  // https://api.moneycontrol.com/mcapi/v1/sector/performance
  const url = `https://api.moneycontrol.com/mcapi/v1/sector/performance`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchTrendlyneFundamentals(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;

  // https://trendlyne.com/fundamentals/get-fundamental_results/346/
  const url = `https://trendlyne.com/fundamentals/get-fundamental_results/${map.tlid}/`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchGlobalIndices() {
  const url = `https://api.moneycontrol.com/mcapi/v1/indices/get-global-indices`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchMFInvestments(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;
  const url = `https://mfapps.indiatimes.com/Ulip/mfsInvestingInStock.htm?pagesize=25&sortby=numberOfSharesHeld&companyid=${map.companyid}&marketcap=&callback=ajaxResponse`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const text = await response.text();
  // Handle JSONP callback if necessary, or just extract JSON
  try {
    const jsonStr = text.substring(text.indexOf('(') + 1, text.lastIndexOf(')'));
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

export async function fetchTrendingScreeners() {
  const url = `https://etmarketsapis.indiatimes.com/ET_TechnicalScreeners/topTrendingScreeners?exchangeId=50&pageNumber=1&pageSize=6&innerPageSize=3`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchETPennyStocks() {
  const url = `https://mfapps.indiatimes.com/ET_Calculators/ssy/PennyStocks.htm?pagesize=25&sortby=weekPercentChange&sortorder=desc&marketcap=&callback=ajaxResponse&pageno=1`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const text = await response.text();
  try {
    const jsonStr = text.substring(text.indexOf('(') + 1, text.lastIndexOf(')'));
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

export async function fetchTechnicalTrends(type: 'bullish' | 'bearish' | 'turning-bullish' | 'turning-bearish', index: string = 'FNO') {
  const base = type.includes('bullish') ? 'uptrend' : 'downtrend';
  const url = `https://api.moneycontrol.com/mcapi/v1/technical-trends/${base}/${type}?ex=N&index=${index}&page=1&order=desc&deviceType=W&sort=performance&appVersion=142`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchETStats(type: 'gainers' | 'losers', duration: string = '1 day') {
  const url = `https://etmarketsapis.indiatimes.com/ET_Stats/${type}?pagesize=25&marketcap=largecap%2Cmidcap%2Csmallcap&duration=${encodeURIComponent(duration)}&sort=intraday&sortby=percentchange&sortorder=desc`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}
