import { getStockMapping } from './stockMapping';

export interface StockInsight {
  classification: {
    name: string;
    color: string;
    longDesc: string;
    stockScore: number;
    flag: number;
    displayLock: string;
  };
  swot?: {
    s: string[];
    w: string[];
    o: string[];
    t: string[];
  };
  fundamentals?: {
    quality: string;
    valuation: string;
    financialTrend: string;
  };
  investmentIdea?: {
    title: string;
    description: string;
  };
  displayLock: string;
}

export interface MoneycontrolInsightsResponse {
  success: boolean;
  data?: StockInsight;
  error?: string;
}

/**
 * Fetches stock insights from Moneycontrol API.
 * Maps stock name or symbol to scId (mcsymbol) using stocklist.ts
 * 
 * @param query Stock name or symbol (e.g. "RELIANCE" or "Reliance Industries")
 * @returns Structured insights data
 */
export async function getMoneycontrolInsights(query: string): Promise<MoneycontrolInsightsResponse> {
  try {
    const mapping = getStockMapping(query);

    if (!mapping) {
      return {
        success: false,
        error: `Could not find mapping for stock: ${query}`
      };
    }

    const scId = mapping.mcsymbol;
    if (!scId || scId === '#N/A') {
      return {
        success: false,
        error: `Invalid or missing scId for stock: ${query}`
      };
    }

    const url = `https://api.moneycontrol.com/mcapi/extdata/v2/mc-insights?scId=${scId}&type=c&deviceType=W&appVersion=185`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      return {
        success: false,
        error: `External API error: ${response.status} ${response.statusText}`
      };
    }

    const json = await response.json();

    if (json.success !== 1 || !json.data) {
      return {
        success: false,
        error: 'API returned unsuccessful status or empty data'
      };
    }

    // Attempt to also fetch SWOT if it's not in the main response
    // Some MC APIs return combined data, others don't.
    // Based on the endpoint extdata/v2/mc-insights, it usually returns classification and SWOT.
    
    return {
      success: true,
      data: json.data as StockInsight
    };
  } catch (error) {
    console.error(`Error in getMoneycontrolInsights for query "${query}":`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'An unexpected error occurred'
    };
  }
}
