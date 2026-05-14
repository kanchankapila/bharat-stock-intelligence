import { fetchWithCache } from './cacheService';

export interface TradebrainsData {
  keyMetrics: any;
  portalScore: any;
  insights: any;
  shareHoldingGraph: any;
  cagrData: any;
  stockReturns: any;
  corporateData: any;
  creditRating: any;
  pivotData: any;
  overviewData: any;
  profile: any;
  serverData: any;
}

export async function fetchTradebrainsData(symbol: string): Promise<TradebrainsData | null> {
  try {
    const url = `https://portal.tradebrains.in/_next/data/lfAyTpIj109Gy_zVNBBu_/stocks/${symbol}.json?symbol=${symbol}`;
    
    // We can use fetchWithCache with a 1 hour cache (3600 seconds) since this data doesn't change rapidly
    const data = await fetchWithCache(`tb_${symbol}`, async () => {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`Tradebrains API returned ${res.status}`);
      }

      const json = await res.json();
      const p = json?.pageProps;
      
      if (!p) return null;

      return {
        keyMetrics: p.keyMetrics || null,
        portalScore: p.portalScore || null,
        insights: p.insights || null,
        shareHoldingGraph: p.shareHoldingGraph || null,
        cagrData: p.cagrData || null,
        stockReturns: p.stockReturns || null,
        corporateData: p.corporateData || null,
        creditRating: p.creditRating || null,
        pivotData: p.pivotData || null,
        overviewData: p.overviewData || null,
        profile: p.profile || null,
        serverData: p.serverData || null,
      };
    }, 3600);

    return data;
  } catch (error) {
    console.error(`Error fetching Tradebrains data for ${symbol}:`, error);
    return null;
  }
}
