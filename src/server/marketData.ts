import { getStockMapping } from './stockMapping';
import { fetchTrendlyneFundamentals } from './trendlyneService';
import { mcFetchJson } from './mcApiService';

export { fetchTrendlyneFundamentals };

export async function fetchTechIndicators(symbol: string, dur: 'D' | 'W' | 'M' = 'D') {
  const map = getStockMapping(symbol);
  if (!map) throw new Error("Stock mapping not found for symbol: " + symbol);
  
  console.log(`[MONEYCONTROL] Fetching tech indicators for ${symbol} using scId: ${map.mcsymbol}`);
  console.log(`[MONEYCONTROL] Fetching tech indicators for ${symbol} using scId: ${map.mcsymbol}`);
  const url = `https://priceapi.moneycontrol.com/pricefeed/techindicator/${dur}/${map.mcsymbol}?fields=sentiments,pivotLevels,sma,ema,indicators,crossover`;
  return mcFetchJson(url, 3, symbol);
}

export async function fetchETCompanyData(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;

  console.log(`[ET] Fetching company data for ${symbol} using companyid: ${map.companyid}`);
  // https://json.bselivefeeds.indiatimes.com/ET_Community/companypagedata?companyid=8581&companytype=&callback=...
  const url = `https://json.bselivefeeds.indiatimes.com/ET_Community/companypagedata?companyid=${map.companyid}&companytype=`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchMarketMap(indId: string = '38') {
  // https://appfeeds.moneycontrol.com/jsonapi/market/marketmap?format=json&type=1&ind_id=38
  const url = `https://appfeeds.moneycontrol.com/jsonapi/market/marketmap?format=json&type=1&ind_id=${indId}`;
  return mcFetchJson(url);
}

export async function fetchAllIndianIndices() {
  // https://api.moneycontrol.com/mcapi/v1/indices/get-indian-indices
  // https://api.moneycontrol.com/mcapi/v1/indices/get-indian-indices
  const url = `https://api.moneycontrol.com/mcapi/v1/indices/get-indian-indices`;
  return mcFetchJson(url);
}

export async function fetchMCRatios(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) throw new Error("Stock mapping not found for symbol: " + symbol);
  
  console.log(`[MONEYCONTROL] Fetching ratios for ${symbol} using scId: ${map.mcsymbol}`);
  // https://www.moneycontrol.com/mc/widget/mcfinancials/getFinancialData?classic=true&referenceId=ratios&requestType=S&scId=BE03&frequency=3
  console.log(`[MONEYCONTROL] Fetching ratios for ${symbol} using scId: ${map.mcsymbol}`);
  // https://www.moneycontrol.com/mc/widget/mcfinancials/getFinancialData?classic=true&referenceId=ratios&requestType=S&scId=${map.mcsymbol}&frequency=3
  const url = `https://www.moneycontrol.com/mc/widget/mcfinancials/getFinancialData?classic=true&referenceId=ratios&requestType=S&scId=${map.mcsymbol}&frequency=3`;
  return mcFetchJson(url, 3, symbol);
}

export async function fetchETShareholding(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;

  console.log(`[ET] Fetching shareholding for ${symbol} using companyid: ${map.companyid}`);
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
  try {
    const map = getStockMapping(symbol);
    const mcSymbol = map?.symbol || symbol.split(';').pop() || symbol;

    console.log(`[OHLC] Fetching historical OHLC for ${symbol} via Moneycontrol (${mcSymbol})`);

    // Calculate timestamps
    const to = Math.floor(Date.now() / 1000);
    let from = to;
    let resolution = '1D';

    if (dur.toLowerCase() === '1d') {
      from = to - (24 * 60 * 60);
      resolution = '1'; // 1 minute resolution for intraday
    } else if (dur.toLowerCase() === '5d') {
      from = to - (5 * 24 * 60 * 60);
      resolution = '5'; // 5 minute
    } else if (dur.toLowerCase() === '1m') {
      from = to - (30 * 24 * 60 * 60);
      resolution = '30'; // 30 min
    } else if (dur.toLowerCase() === '3m') {
      from = to - (90 * 24 * 60 * 60);
      resolution = '1D';
    } else if (dur.toLowerCase() === '6m') {
      from = to - (180 * 24 * 60 * 60);
      resolution = '1D';
    } else if (dur.toLowerCase() === '1y') {
      from = to - (365 * 24 * 60 * 60);
      resolution = '1D';
    } else if (dur.toLowerCase() === '5y') {
      from = to - (5 * 365 * 24 * 60 * 60);
      resolution = '1W';
    }

    const url = `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=${encodeURIComponent(mcSymbol)}&resolution=${resolution}&from=${from}&to=${to}&countback=329&currencyCode=INR`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`[OHLC] Moneycontrol returned ${response.status} for ${mcSymbol}`);
      return { success: 0, data: [] };
    }

    const data = await response.json();
    if (data.s !== 'ok' || !data.t) {
      return { success: 0, data: [] };
    }

    const mappedData = data.t.map((ts: number, i: number) => ({
      time: ts, // Moneycontrol provides timestamp in seconds, which is what lightweight-charts prefers
      open: data.o[i],
      high: data.h[i],
      low: data.l[i],
      close: data.c[i],
      c: data.c[i], // For backward compatibility if any component relies on 'c'
      volume: data.v ? data.v[i] : 0,
    }));

    return { success: 1, data: mappedData };
  } catch (error) {
    console.error(`[OHLC] Error fetching OHLC for ${symbol}:`, error);
    return { success: 0, data: [] };
  }
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
  // https://api.moneycontrol.com/mcapi/v1/sector/performance?dur=1d&type=top&section=sector
  // https://api.moneycontrol.com/mcapi/v1/sector/performance?dur=1d&type=top&section=sector
  const url = `https://api.moneycontrol.com/mcapi/v1/sector/performance?dur=1d&type=top&section=sector`;
  return mcFetchJson(url);
}


export async function fetchGlobalIndices() {
  const url = `https://api.moneycontrol.com/mcapi/v1/indices/get-global-indices`;
  return mcFetchJson(url);
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
  return mcFetchJson(url);
}

export async function fetchETStats(type: 'gainers' | 'losers', duration: string = '1 day') {
  const url = `https://etmarketsapis.indiatimes.com/ET_Stats/${type}?pagesize=25&marketcap=largecap%2Cmidcap%2Csmallcap&duration=${encodeURIComponent(duration)}&sort=intraday&sortby=percentchange&sortorder=desc`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

const MC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// Full index details: OHLC, period returns (YTD/1W/1M/.../5Y), moving averages
export async function fetchIndexFullDetails(indId: string) {
  const url = `https://appfeeds.moneycontrol.com/jsonapi/market/indices&format=json&ind_id=${indId}`;
  return mcFetchJson(url);
}

// Stocks (type=0) or industries (type=1) constituent list for an index
export async function fetchIndexStocksList(indId: string, type: '0' | '1' = '0') {
  const url = `https://appfeeds.moneycontrol.com/jsonapi/market/marketmap&format=json&type=${type}&ind_id=${indId}`;
  return mcFetchJson(url);
}

// Detailed price feed for an index via bridgeSymbol (e.g. "in;NSX")
export async function fetchIndexPriceFeed(bridgeSymbol: string) {
  const encoded = encodeURIComponent(bridgeSymbol);
  const url = `https://priceapi.moneycontrol.com/pricefeed/notapplicable/inidicesindia/${encoded}`;
  return mcFetchJson(url);
}

// Technical indicators for an index (D/W/M period)
export async function fetchIndexTechnicals(period: 'D' | 'W' | 'M', bridgeSymbol: string) {
  const encoded = encodeURIComponent(bridgeSymbol);
  const url = `https://priceapi.moneycontrol.com/pricefeed/techindicator/${period}/${encoded}`;
  return mcFetchJson(url);
}

export async function fetchIndexGraph(indId: string, range: string = '1d', type: string = 'line') {
  const url = `https://appfeeds.moneycontrol.com/jsonapi/market/graph&format=json&ind_id=${indId}&range=${range}&type=${type}`;
  return mcFetchJson(url);
}

export async function fetchNiftyTraderBreakouts() {
  const url = `https://webapi.niftytrader.in/webapi/Resource/nse-break-out-data`;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
      },
    });
    if (!response.ok) return { success: false, data: [] };
    const data = await response.json();
    return { success: true, data: data.resultData || [] };
  } catch (error) {
    console.error(`[NIFTYTRADER] Error fetching breakouts:`, error);
    return { success: false, data: [] };
  }
}

