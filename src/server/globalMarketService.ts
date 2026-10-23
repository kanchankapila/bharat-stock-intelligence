
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

interface MoneycontrolGlobalRow {
  name?: string;
  symbol?: string;
  ltp?: string;
  chg?: string;
  chgper?: string;
  market_state?: string;
  updatedDate?: string;
  market_time?: string;
}

interface MoneycontrolGlobalResponse {
  success?: number;
  data?: MoneycontrolGlobalRow[];
}

function countryFor(row: MoneycontrolGlobalRow): string {
  const key = `${row.symbol ?? ''} ${row.name ?? ''}`.toLowerCase();
  if (/jp;|nikkei/.test(key)) return 'Japan';
  if (/cn;hsi|hang seng/.test(key)) return 'Hong Kong';
  if (/indu|ccmp|spx|dow jones|nasdaq|s&p/.test(key)) return 'US';
  if (/kr;|kospi/.test(key)) return 'South Korea';
  if (/in;|gift nifty/.test(key)) return 'India';
  return row.name ?? 'Unknown';
}

export async function fetchGlobalMarketData(): Promise<GlobalMarketData[]> {
  try {
    const response = await fetch(
      'https://api.moneycontrol.com/mcapi/v1/premarket/get-global-marketdata?section=mi',
      { signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch global market data: ${response.statusText}`);
    }
    const data = await response.json() as MoneycontrolGlobalResponse;
    if (data.success !== 1 || !Array.isArray(data.data)) return [];
    return data.data.map(row => ({
      country: countryFor(row),
      symbol: row.symbol ?? '',
      current_price: row.ltp ?? '',
      change_value: row.chg ?? '',
      change_per: row.chgper ?? '',
      market_status: String(row.market_state ?? '').toLowerCase() === 'open',
      created_at: row.updatedDate ?? '',
      timestamp: row.market_time ?? '',
    }));
  } catch (error) {
    console.error("Error fetching global market data:", error);
    return [];
  }
}
