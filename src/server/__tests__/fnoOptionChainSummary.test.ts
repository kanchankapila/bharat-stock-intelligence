import { describe, it, expect } from 'vitest';
import { parseFnoChainBody } from '../fnoService';

// Minimal fixture shaped like a real smartoptions.trendlyne.com/phoenix/api/fno/option/chain/
// response (headers use `unique_name`, matching so_option_chain_fetcher.py's own convention).
function fixtureBody() {
  return {
    maxPain: 58000,
    atTheMoney: 57700,
    expiryLevelPCRValues: { pcr_oi: 0.8851, pcr_volume: 0.9914 },
    stockLevelData: { stockCurrentPrice: 57746.45 },
    tableHeaders: [
      { unique_name: 'current_price_call', name: 'Price (Call)' },
      { unique_name: 'open_interest_call', name: 'OI (Call)' },
      { unique_name: 'implied_volatility_call', name: 'IV (Call)' },
      { unique_name: 'get_built_up_str_call', name: 'Buildup (Call)' },
      { unique_name: 'strike_price', name: 'Strike' },
      { unique_name: 'current_price_put', name: 'Price (Put)' },
      { unique_name: 'open_interest_put', name: 'OI (Put)' },
      { unique_name: 'implied_volatility_put', name: 'IV (Put)' },
      { unique_name: 'get_built_up_str_put', name: 'Buildup (Put)' },
    ],
    tableData: [
      // [ce_price, ce_oi, ce_iv, ce_buildup, strike, pe_price, pe_oi, pe_iv, pe_buildup]
      [120, 500000, 14.2, 'Short Build Up', 57700, 90, 800000, 13.1, 'Long Build Up'],
      [60, 900000, 12.5, 'Short Build Up', 58000, 150, 300000, 15.0, 'Long Build Up'],
      [0, 0, null, null, 57500, 40, 100000, 11.8, 'Short Covering'],
    ],
  };
}

describe('parseFnoChainBody', () => {
  it('resolves columns by unique_name and computes PCR/max-pain/key strikes for any symbol', () => {
    const result = parseFnoChainBody('BANKNIFTY', '2026-08-25', fixtureBody());
    expect(result).not.toBeNull();
    expect(result!.pcr).toBeCloseTo(0.8851);
    expect(result!.maxPain).toBe(58000);
    expect(result!.atm).toBe(57700);
    expect(result!.spot).toBe(57746.45);
    expect(result!.callTotalOI).toBe(1_400_000); // 500000 + 900000 + 0
    expect(result!.putTotalOI).toBe(1_200_000);  // 800000 + 300000 + 100000
    expect(result!.top3Calls[0]).toMatchObject({ strike: 58000, oi: 900000 });
    expect(result!.top3Puts[0]).toMatchObject({ strike: 57700, oi: 800000 });
  });

  it('returns null when the response shape does not match (Trendlyne column layout changed)', () => {
    expect(parseFnoChainBody('NIFTY', '2026-08-25', { tableHeaders: [], tableData: [] })).toBeNull();
  });
});
