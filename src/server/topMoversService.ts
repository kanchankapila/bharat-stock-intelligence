// Removed axios import

export interface TopMoversData {
  symbol_name: string;
  today_open: number;
  today_high: number;
  today_low: number;
  today_close: number;
  prev_close: number;
  today_volume: number;
  change_value: number;
  change_percent: number;
}

export interface TopMoversResponse {
  success: boolean;
  topGainers: TopMoversData[];
  topLosers: TopMoversData[];
  topWatchList: TopMoversData[];
  gapUp: TopMoversData[];
  gapDown: TopMoversData[];
  sameOpenAndLow: TopMoversData[];
  sameOpenAndHigh: TopMoversData[];
  error?: string;
}

export async function fetchTopMovers(): Promise<TopMoversResponse> {
  try {
    const url = `https://www.niftytrader.in/api/niftytrader/symbol/top-gainers-data?fno_stock=false`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });

    const data = await response.json();

    if (data?.result === 1 && data?.resultData) {
      const rd = data.resultData;
      return {
        success: true,
        topGainers: rd.topGainers || [],
        topLosers: rd.topLosers || [],
        topWatchList: rd.topWatchList || [],
        gapUp: rd.gapUp || [],
        gapDown: rd.gapDown || [],
        sameOpenAndLow: rd.sameOpenAndLow || [],
        sameOpenAndHigh: rd.sameOpenAndHigh || []
      };
    }

    return {
      success: false,
      topGainers: [],
      topLosers: [],
      topWatchList: [],
      gapUp: [],
      gapDown: [],
      sameOpenAndLow: [],
      sameOpenAndHigh: [],
      error: 'Invalid response format from NiftyTrader'
    };
  } catch (error) {
    console.error('Error fetching top movers:', error);
    return {
      success: false,
      topGainers: [],
      topLosers: [],
      topWatchList: [],
      gapUp: [],
      gapDown: [],
      sameOpenAndLow: [],
      sameOpenAndHigh: [],
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
