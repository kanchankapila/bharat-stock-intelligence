export interface OptionChainData {
  success: boolean;
  data: {
    optionChain: any[];
    expiryDates: string[];
    spotPrice: number;
    totalCallOi: number;
    totalPutOi: number;
    pcr: number;
  };
}

export async function fetchFnoSymbols(): Promise<string[]> {
  // Use a more comprehensive symbol list (Nifty includes most major F&O stocks in its discovery response)
  const url = 'https://webapi.niftytrader.in/webapi/Symbol/symbol-expiry-all?symbol=nifty&exchange=nse';
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.niftytrader.in/'
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return [];
    const json = await response.json();
    
    // NiftyTrader usually returns a list of symbols in resultData
    if (json.result === 1 && Array.isArray(json.resultData)) {
      const symbols = json.resultData.map((d: any) => d.symbol_name.toUpperCase());
      // Add common indices just in case
      const allSymbols = [...symbols, 'NIFTY', 'BANKNIFTY', 'FINNIFTY'];
      return [...new Set(allSymbols)];
    }
    return [];
  } catch (error) {
    console.error('[OPTION CHAIN] Error fetching FNO symbols:', error);
    return [];
  }
}

export async function fetchOptionChain(symbol: string): Promise<any> {
  // Normalize symbol for NiftyTrader
  const normalizedSymbol = symbol.toUpperCase() === 'NIFTY 50' ? 'NIFTY' : 
                          symbol.toUpperCase() === 'NIFTY BANK' ? 'BANKNIFTY' : 
                          symbol.toUpperCase() === 'NIFTY FIN SERVICE' ? 'FINNIFTY' :
                          symbol.toUpperCase();

  const url = `https://webapi.niftytrader.in/webapi/option/option-chain-data?symbol=${normalizedSymbol}&exchange=nse&expiryDate=&atmBelow=0&atmAbove=0`;
  
  console.log(`[OPTION CHAIN] Fetching for ${normalizedSymbol}...`);
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.niftytrader.in/',
        'Origin': 'https://www.niftytrader.in'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`NiftyTrader API returned ${response.status}`);
    }

    const json = await response.json();
    
    if (json.result === 1 && json.resultData) {
      const rd = json.resultData;
      // Handle both old 'optionChain' and new 'opDatas' keys
      const oc = rd.opDatas || rd.optionChain || [];
      
      // Extract spot price from the first item if not found in root or first item index_close
      const firstItem = oc[0] || {};
      const spotPrice = rd.spotPrice || firstItem.index_close || firstItem.last_price || 0;
      
      // Map the chain data, handling underscored or camelCase fields
      const mappedChain = oc.map((row: any) => ({
        callOi: row.calls_oi || row.callOi || 0,
        callOiChange: row.calls_change_oi || row.callOiChange || 0,
        callLtp: row.calls_ltp || row.callLtp || 0,
        strikePrice: row.strike_price || row.strikePrice,
        putLtp: row.puts_ltp || row.putLtp || 0,
        putOiChange: row.puts_change_oi || row.putOiChange || 0,
        putOi: row.puts_oi || row.putOi || 0,
        expiryDate: row.expiry_date || row.expiryDate
      }));

      // Calculate PCR if volume_pcr is missing
      const totals = rd.opTotals?.total_calls_puts || {};
      const totalCallOi = totals.total_calls_oi || 0;
      const totalPutOi = totals.total_puts_oi || 0;
      const pcr = totals.volume_pcr || (totalCallOi > 0 ? totalPutOi / totalCallOi : 0);

      return {
        success: true,
        data: {
          optionChain: mappedChain,
          expiryDates: rd.expiryDates || [],
          spotPrice: spotPrice,
          pcr: pcr,
          marketSentiment: {
            overall: pcr > 1.2 ? 'Bullish' : pcr < 0.7 ? 'Bearish' : 'Neutral',
            ivRank: 42,
            ivPercentile: 68
          }
        }
      };
    }
    
    return { success: false, data: null };
  } catch (error) {
    console.error(`Error fetching option chain for ${symbol}:`, error);
    return { success: false, data: null };
  }
}
