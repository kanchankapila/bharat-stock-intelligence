import fetch from "node-fetch";

export interface GlobalMarketData {
  country: string;
  symbol: string;
  current_price: string;
  change_value: string;
  change_per: string;
  market_status: boolean;
  created_at: string;
  timestamp: string;
}

export interface GlobalMarketResponse {
  result: number;
  resultMessage: string;
  resultData: GlobalMarketData[];
}

export async function fetchGlobalMarketData(): Promise<GlobalMarketData[]> {
  try {
    const response = await fetch("https://webapi.niftytrader.in/webapi/usstock/global-market");
    if (!response.ok) {
      throw new Error(`Failed to fetch global market data: ${response.statusText}`);
    }
    const data = await response.json() as GlobalMarketResponse;
    if (data.result === 1 && data.resultData) {
      return data.resultData;
    }
    return [];
  } catch (error) {
    console.error("Error fetching global market data:", error);
    return [];
  }
}
