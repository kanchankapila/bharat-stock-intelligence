import { fetchWithCache } from './cacheService';
import { dbGet } from './dbAsync';

let _cachedToken: string | null = null;
let _tokenVersion = 0; // bump on invalidation so stale nt_* cache keys are never served

export function invalidateNiftyTraderToken(): void {
  _cachedToken = null;
  _tokenVersion++;
}

export async function getNiftyTraderHeaders(): Promise<Record<string, string>> {
  // Auto-refresh (2026-08-07) deliberately does NOT live on this hot path -- an earlier
  // version called ensureNiftyTraderToken() here on every single invocation, which broke the
  // whole point of _cachedToken (settingsCache.test.ts caught this: 3 calls -> 4 DB reads
  // instead of 1) by adding its own independent dbGet() call regardless of cache state.
  // The refresh check instead runs on a periodic background timer -- see
  // niftytraderAuthService.ts's startNiftyTraderTokenRefreshTimer(), started once at server
  // boot -- which calls invalidateNiftyTraderToken() only when it actually writes a fresh
  // token, so this function's cache-hit path is completely unaffected the rest of the time.
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
    // 2026-09-08 live probe: NiftyTrader's WAF 403s any request that lacks BOTH `Origin` AND
    // `sec-fetch-site: same-origin` (tested 8 header variants against live-market-filter-data via
    // requests with the exact TS header set + the same Bearer token: exact TS copy -> 403, +Origin
    // alone -> 403, +Origin + same-origin -> 200). This broke live-screener-collect on 2026-09-08
    // (45/45 filters 403) while the Python sibling (niftytrader_live_screener_job.py) kept
    // working — its NT_HEADERS already carry both. The Python `sec-fetch-site: same-site` this
    // file used to send was the last difference to flip.
    "origin": "https://www.niftytrader.in",
    "referer": "https://www.niftytrader.in/",
    "sec-ch-ua": "\"Google Chrome\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
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
        fetch("https://www.niftytrader.in/api/niftytrader/Analysis/stock-industry-data", {
          headers,
          body,
          method: "POST",
          signal: AbortSignal.timeout(25000)
        }),
        fetch("https://www.niftytrader.in/api/niftytrader/Analysis/stock-analysis-data", {
          headers,
          body,
          method: "POST",
          signal: AbortSignal.timeout(25000)
        }),
        fetch("https://www.niftytrader.in/api/niftytrader/Analysis/stock-financial-data", {
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
