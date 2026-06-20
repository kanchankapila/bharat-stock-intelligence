import { fetchWithCache } from './cacheService';

const NIFTYTRADER_HEADERS = {
  "accept": "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9,hi;q=0.8",
  "authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjU0MzM4IiwiaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS93cy8yMDA4LzA2L2lkZW50aXR5L2NsYWltcy9yb2xlIjoiMCIsIlNlc3Npb25JZCI6IjUwODkiLCJleHAiOjE3ODQ0OTAzNDEsImlzcyI6InByb2QtbmlmdHl0cmFkZXIuaW4iLCJhdWQiOiJwcm9kLW5pZnR5dHJhZGVyLmluIn0.pIFSPRIal82Wxd9tSs2YOr0ipJEjz0f7tow4NrXEwt0",
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

export interface NiftyTraderData {
  industryData: any;
  analysisData: any;
  financialData: any;
}

export async function fetchNiftyTraderStockData(symbol: string): Promise<NiftyTraderData | null> {
  const normalizedSymbol = symbol.toLowerCase();
  
  try {
    const data = await fetchWithCache(`nt_${normalizedSymbol}`, async () => {
      console.log(`[NIFTYTRADER] Fetching fresh data for ${normalizedSymbol}...`);
      const body = JSON.stringify({ symbol: normalizedSymbol });

      const [industryRes, analysisRes, financialRes] = await Promise.all([
        fetch("https://webapi.niftytrader.in/webapi/Analysis/stock-industry-data", {
          headers: NIFTYTRADER_HEADERS,
          body,
          method: "POST"
        }),
        fetch("https://webapi.niftytrader.in/webapi/Analysis/stock-analysis-data", {
          headers: NIFTYTRADER_HEADERS,
          body,
          method: "POST"
        }),
        fetch("https://webapi.niftytrader.in/webapi/Analysis/stock-financial-data", {
          headers: NIFTYTRADER_HEADERS,
          body,
          method: "POST"
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
