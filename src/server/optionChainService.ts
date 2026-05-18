import { calculateBSM, calculateImpliedVolatility } from './optionsMath';

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
      
      // Calculate time to expiry in years
      const firstRow = oc[0] || {};
      const expiryStr = firstRow.expiry_date || rd.expiryDate || '';
      let t = 30 / 365; // default 30 days
      if (expiryStr) {
        const expiryTime = new Date(expiryStr).getTime();
        const diffMs = expiryTime - Date.now();
        t = Math.max(0.0001, diffMs / (365 * 24 * 60 * 60 * 1000));
      }

      // Map the chain data, enriching with native BSM options Greeks & Implied Volatility
      const mappedChain = oc.map((row: any) => {
        const strike = row.strike_price;
        const callLtp = row.calls_ltp || 0;
        const putLtp = row.puts_ltp || 0;

        // Calculate call IV and Greeks
        let callIv = (row.calls_iv || 0) / 100;
        if ((callIv <= 0 || isNaN(callIv)) && callLtp > 0) {
          callIv = calculateImpliedVolatility(true, callLtp, spotPrice, strike, t);
        }
        const callGreeks = calculateBSM(true, spotPrice, strike, t, callIv);

        // Calculate put IV and Greeks
        let putIv = (row.puts_iv || 0) / 100;
        if ((putIv <= 0 || isNaN(putIv)) && putLtp > 0) {
          putIv = calculateImpliedVolatility(false, putLtp, spotPrice, strike, t);
        }
        const putGreeks = calculateBSM(false, spotPrice, strike, t, putIv);

        return {
          callOi: row.calls_oi || 0,
          callOiChange: row.calls_change_oi || 0,
          callLtp: callLtp,
          callVol: row.calls_volume || 0,
          callIv: Number((callIv * 100).toFixed(2)),
          callDelta: Number(callGreeks.delta.toFixed(3)),
          callTheta: Number(callGreeks.theta.toFixed(3)),
          callVega: Number(callGreeks.vega.toFixed(3)),
          callGamma: Number(callGreeks.gamma.toFixed(5)),
          callBuiltup: row.calls_builtup || "No Conclusion",
          callBid: row.calls_bid_price || 0,
          callAsk: row.calls_ask_price || 0,
          
          strikePrice: strike,
          
          putLtp: putLtp,
          putOiChange: row.puts_change_oi || 0,
          putOi: row.puts_oi || 0,
          putVol: row.puts_volume || 0,
          putIv: Number((putIv * 100).toFixed(2)),
          putDelta: Number(putGreeks.delta.toFixed(3)),
          putTheta: Number(putGreeks.theta.toFixed(3)),
          putVega: Number(putGreeks.vega.toFixed(3)),
          putGamma: Number(putGreeks.gamma.toFixed(5)),
          putBuiltup: row.puts_builtup || "No Conclusion",
          putBid: row.puts_bid_price || 0,
          putAsk: row.puts_ask_price || 0,
          
          expiryDate: row.expiry_date
        };
      });

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
