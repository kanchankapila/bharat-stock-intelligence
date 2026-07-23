import { fetchWithCache } from './cacheService';
import { dbGet } from './dbAsync';

let _cachedToken: string | null = null;
let _tokenVersion = 0; // bump on invalidation so stale nt_* cache keys are never served

export function invalidateNiftyTraderToken(): void {
  _cachedToken = null;
  _tokenVersion++;
}

export async function getNiftyTraderHeaders(): Promise<Record<string, string>> {
  if (_cachedToken === null) {
    try {
      const row = await dbGet<{ value: string }>("SELECT value FROM app_settings WHERE key = 'niftytrader_auth_token'");
      _cachedToken = row?.value ?? '';
    } catch (err: any) {
      console.error('[NIFTYTRADER] Failed to load token from DB:', err.message);
      _cachedToken = '';
    }
  }

  let token = _cachedToken;
  if (!token) {
    console.warn('[NIFTYTRADER] No auth token in app_settings — set one via saveNiftyTraderToken; requests will fail until then.');
  }

  if (token && !token.startsWith('Bearer ')) {
    token = `Bearer ${token}`;
  }

  return {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9,hi;q=0.8",
    "authorization": token,
    "content-type": "application/json",
    "platform_type": "1",
    "priority": "u=1, i",
    "sec-ch-ua": "\"Google Chrome\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "Referer": "https://www.niftytrader.in/"
  };
}

export interface NiftyTraderData {
  industryData: any;
  analysisData: any;
  financialData: any;
}

export async function fetchNiftyTraderStockData(symbol: string): Promise<NiftyTraderData | null> {
  const normalizedSymbol = symbol.toLowerCase();
  
  try {
    const data = await fetchWithCache(`nt_v${_tokenVersion}_${normalizedSymbol}`, async () => {
      console.log(`[NIFTYTRADER] Fetching fresh data for ${normalizedSymbol}...`);
      const body = JSON.stringify({ symbol: normalizedSymbol });
      const headers = await getNiftyTraderHeaders();

      const [industryRes, analysisRes, financialRes] = await Promise.all([
        fetch("https://webapi.niftytrader.in/webapi/Analysis/stock-industry-data", {
          headers,
          body,
          method: "POST",
          signal: AbortSignal.timeout(25000)
        }),
        fetch("https://webapi.niftytrader.in/webapi/Analysis/stock-analysis-data", {
          headers,
          body,
          method: "POST",
          signal: AbortSignal.timeout(25000)
        }),
        fetch("https://webapi.niftytrader.in/webapi/Analysis/stock-financial-data", {
          headers,
          body,
          method: "POST",
          signal: AbortSignal.timeout(25000)
        })
      ]);

      if (!industryRes.ok || !analysisRes.ok || !financialRes.ok) {
        throw new Error(`Failed to fetch NiftyTrader data. Statuses: industry=${industryRes.status}, analysis=${analysisRes.status}, financial=${financialRes.status}`);
      }

      const [industryJson, analysisJson, financialJson] = await Promise.all([
        industryRes.json(),
        analysisRes.json(),
        financialRes.json()
      ]);

      // Verify success responses
      if (industryJson.result !== 1 || analysisJson.result !== 1 || financialJson.result !== 1) {
        console.warn(`[NIFTYTRADER] Unsuccessful API response: industry=${industryJson.resultMessage}, analysis=${analysisJson.resultMessage}, financial=${financialJson.resultMessage}`);
      }

      return {
        industryData: industryJson.resultData || null,
        analysisData: analysisJson.resultData || null,
        financialData: financialJson.resultData || null
      };
    }, 3600); // 1-hour cache

    return data;
  } catch (error) {
    console.error(`[NIFTYTRADER] Error fetching data for ${symbol}:`, error);
    return null;
  }
}
