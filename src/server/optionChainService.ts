export interface OptionChainData {
  success: boolean;
  data: {
    optionChain: any[];
    expiryDates: string[];
    spotPrice: number;
    totalCallOi: number;
    totalPutOi: number;
    pcr: number;
    marketSentiment: {
      overall: string;
      ivRank: number;
      ivPercentile: number;
      maxPain?: number;
      oiTrend?: string;
    };
  };
}

export async function fetchFnoSymbols(): Promise<string[]> {
  const url = 'https://webapi.niftytrader.in/webapi/symbol/psymbol-list';
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.niftytrader.in/',
        'authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjU0MzM4IiwiaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS93cy8yMDA4LzA2L2lkZW50aXR5L2NsYWltcy9yb2xlIjoiMCIsIlNlc3Npb25JZCI6IjQ5NDQiLCJleHAiOjE3ODA2NzUyNTUsImlzcyI6InByb2QtbmlmdHl0cmFkZXIuaW4iLCJhdWQiOiJwcm9kLW5pZnR5dHJhZGVyLmluIn0.VaWV3jFHcpP4y7UOmWzVzVwBjzK1AfHx9Qgj8vZPQGs',
        'platform_type': '1'
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return [];
    const json = await response.json();
    
    // psymbol-list returns data in resultData array
    if (json.result === 1 && Array.isArray(json.resultData)) {
      const symbols = json.resultData.map((d: any) => String(d.symbol_name).toUpperCase());
      return Array.from(new Set(symbols));
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
        callOi: row.calls_oi || 0,
        callOiChange: row.calls_change_oi || 0,
        callLtp: row.calls_ltp || 0,
        callVol: row.calls_volume || 0,
        callIv: row.calls_iv || 0,
        callDelta: row.call_delta || 0,
        callTheta: row.call_theta || 0,
        callVega: row.call_vega || 0,
        callGamma: row.call_gamma || 0,
        callBuiltup: row.calls_builtup || "No Conclusion",
        callBid: row.calls_bid_price || 0,
        callAsk: row.calls_ask_price || 0,
        
        strikePrice: row.strike_price,
        
        putLtp: row.puts_ltp || 0,
        putOiChange: row.puts_change_oi || 0,
        putOi: row.puts_oi || 0,
        putVol: row.puts_volume || 0,
        putIv: row.puts_iv || 0,
        putDelta: row.put_delta || 0,
        putTheta: row.put_theta || 0,
        putVega: row.put_vega || 0,
        putGamma: row.put_gamma || 0,
        putBuiltup: row.puts_builtup || "No Conclusion",
        putBid: row.puts_bid_price || 0,
        putAsk: row.puts_ask_price || 0,
        
        expiryDate: row.expiry_date
      }));

      // Calculate PCR if volume_pcr is missing
      const totals = rd.opTotals?.total_calls_puts || {};
      const totalCallOi = totals.total_calls_oi || 0;
      const totalPutOi = totals.total_puts_oi || 0;
      const pcr = totals.volume_pcr || (totalCallOi > 0 ? totalPutOi / totalCallOi : 0);

      // Calculate Max Pain
      let maxPain = spotPrice;
      let minPainValue = Infinity;

      // Only consider strikes with significant OI to save computation
      const strikes = oc.map((r: any) => r.strike_price);
      
      for (const strike of strikes) {
        let totalPain = 0;
        for (const row of oc) {
          const s = row.strike_price;
          // Payout for Call holders if price is 'strike'
          if (strike > s) {
            totalPain += (row.calls_oi || 0) * (strike - s);
          }
          // Payout for Put holders if price is 'strike'
          if (strike < s) {
            totalPain += (row.puts_oi || 0) * (s - strike);
          }
        }
        
        if (totalPain < minPainValue) {
          minPainValue = totalPain;
          maxPain = strike;
        }
      }

      return {
        success: true,
        data: {
          optionChain: mappedChain,
          expiryDates: rd.expiryDates || [],
          spotPrice: spotPrice,
          pcr: pcr,
          marketSentiment: {
            overall: pcr > 1.2 ? 'Bullish' : pcr < 0.7 ? 'Bearish' : 'Neutral',
            ivRank: 0, // Removed dummy data
            ivPercentile: 0, // Removed dummy data
            maxPain: maxPain
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
