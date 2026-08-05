import { getNiftyTraderHeaders } from './niftytraderService';
import { dbAll } from './dbAsync';
import { parseNtOptionChainResponse, type NtOptionChainRow, type NtOptionChainTotals } from './contracts/marketFeeds';

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
    const headers = await getNiftyTraderHeaders();
    const response = await fetch(url, {
      headers,
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

    const json = parseNtOptionChainResponse(await response.json());

    if (json.result === 1 && json.resultData) {
      const rd = json.resultData;
      const oc = rd.opDatas;
      
      // Extract spot price from the first item if not found in root or first item index_close
      // Typed as Partial<NtOptionChainRow> (not the bare `{}` a naive fallback would infer):
      // an untyped `{}` fallback makes every property access below error at the type level,
      // since TS requires a property to exist on every member of the resulting union.
      const firstItem: Partial<NtOptionChainRow> = oc[0] || {};
      const spotPrice = rd.spotPrice || firstItem.index_close || firstItem.last_price || 0;
      
      // The live NiftyTrader feed doesn't populate Greeks/IV (always 0) for individual stock
      // options. so_option_chain_fetcher.py computes real per-strike Greeks for equity F&O
      // names (not indices) into so_option_chain — enrich from there when available.
      let greeksByStrike = new Map<number, any>();
      try {
        const greekRows = await dbAll<any>(
          `SELECT strike, ce_delta, ce_gamma, ce_theta, ce_vega, ce_iv,
                  pe_delta, pe_gamma, pe_theta, pe_vega, pe_iv
           FROM so_option_chain
           WHERE symbol = ? AND date = (SELECT MAX(date) FROM so_option_chain WHERE symbol = ?)`,
          [normalizedSymbol, normalizedSymbol]
        );
        for (const r of greekRows || []) greeksByStrike.set(Number(r.strike), r);
      } catch (e) {
        console.error(`[OPTION CHAIN] Greeks enrichment lookup failed for ${normalizedSymbol}:`, e);
      }

      // Map the chain data, handling underscored or camelCase fields
      const mappedChain = oc.map((row: any) => {
        const g = greeksByStrike.get(Number(row.strike_price));
        return {
        callOi: row.calls_oi || 0,
        callOiChange: row.calls_change_oi || 0,
        callLtp: row.calls_ltp || 0,
        callVol: row.calls_volume || 0,
        callIv: row.calls_iv || g?.ce_iv || 0,
        callDelta: row.call_delta || g?.ce_delta || 0,
        callTheta: row.call_theta || g?.ce_theta || 0,
        callVega: row.call_vega || g?.ce_vega || 0,
        callGamma: row.call_gamma || g?.ce_gamma || 0,
        callBuiltup: row.calls_builtup || "No Conclusion",
        callBid: row.calls_bid_price || 0,
        callAsk: row.calls_ask_price || 0,

        strikePrice: row.strike_price,

        putLtp: row.puts_ltp || 0,
        putOiChange: row.puts_change_oi || 0,
        putOi: row.puts_oi || 0,
        putVol: row.puts_volume || 0,
        putIv: row.puts_iv || g?.pe_iv || 0,
        putDelta: row.put_delta || g?.pe_delta || 0,
        putTheta: row.put_theta || g?.pe_theta || 0,
        putVega: row.put_vega || g?.pe_vega || 0,
        putGamma: row.put_gamma || g?.pe_gamma || 0,
        putBuiltup: row.puts_builtup || "No Conclusion",
        putBid: row.puts_bid_price || 0,
        putAsk: row.puts_ask_price || 0,

        expiryDate: row.expiry_date
      };
      });

      // Calculate PCR if volume_pcr is missing (same {} -> Partial<T> typing fix as firstItem)
      const totals: Partial<NtOptionChainTotals> = rd.opTotals?.total_calls_puts || {};
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
