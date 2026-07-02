import { mcFetchJson } from './mcApiService';

export interface MCScreenerItem {
  stkname: string;
  ltp: string;
  perChg: string;
  stkId: string;
  scUrl: string;
  columns: { name: string; value: string }[];
}

export interface MCScreenerResponse {
  success: number;
  data: {
    list: {
      scannerName: string;
      scannerDescription: string;
      scannerDetails: MCScreenerItem[];
      catName: string;
    }
  }
}

// --- Simple In-Memory Cache for Screeners (30 mins) ---
const screenerCache: Record<string, { data: MCScreenerResponse, timestamp: number }> = {};
const CACHE_DURATION = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(screenerCache)) {
    if (now - screenerCache[key].timestamp > CACHE_DURATION) {
      delete screenerCache[key];
    }
  }
}, 30 * 60_000); // sweep every 30 min

export async function fetchMCScreener(type: 'proscanner' | 'techscanner' | 'technical-trends', catId: string | number, scanId: string | number): Promise<MCScreenerResponse> {
  const cacheKey = `${type}:${catId}:${scanId}`;
  const cached = screenerCache[cacheKey];
  if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
    return cached.data;
  }

  let url = '';
  if (type === 'technical-trends') {
    // catId used as 'trendType' (e.g. uptrend/bullish), scanId used as indexId
    url = `https://api.moneycontrol.com/mcapi/v1/technical-trends/${catId}?ex=N&index=${scanId}&page=1&order=desc&deviceType=W&sort=performance&appVersion=142`;
  } else {
    url = `https://api.moneycontrol.com/mcapi/v1/${type}/scanner-detail?catId=${catId}&scanId=${scanId}`;
  }
  
  const json = await mcFetchJson(url);
  if (!json) return { success: 0, data: { list: { scannerName: '', scannerDescription: '', scannerDetails: [], catName: '' } } } as any;
  
  if (type === 'technical-trends' && json.success === 1 && Array.isArray(json.data)) {
    const response: MCScreenerResponse = {
      success: 1,
      data: {
        list: {
          scannerName: catId.toString().split('/').pop()?.toUpperCase() || 'Technical Trend',
          scannerDescription: 'Live technical trends analysis from Moneycontrol Intelligence.',
          catName: 'Technical Trends',
          scannerDetails: json.data.map((item: any) => ({
            stkname: item.companyName || item.ticker,
            ltp: item.last_rate || item.lastPrice,
            perChg: item.percent_change || item.percentageChange,
            stkId: item.scId || item.symbol,
            scUrl: '',
            columns: [
              { name: 'Trend Price', value: item.trendPrice || '-' },
              { name: 'Change Status', value: item.changeStatus || '-' }
            ]
          }))
        }
      }
    };
    screenerCache[cacheKey] = { data: response, timestamp: Date.now() };
    return response;
  }
  
  if (json.success === 1) {
    screenerCache[cacheKey] = { data: json, timestamp: Date.now() };
  }
  return json;
}
