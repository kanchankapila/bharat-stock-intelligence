import { describe, it, expect, afterEach } from 'vitest';
import { resolveMoneycontrolSymbol } from '../stockMapping';

// MoneyControl's autosuggestion_solr.php always concatenates a second literal
// "No Result Available" JSON array directly after the real one, with no separator —
// `res.json()`/`JSON.parse` throws `Unexpected non-whitespace character after JSON` on it.
// Reproduced live 2026-08-29 (curl against the real endpoint) for every query tried:
// `[{...real match...}][{"pdt_dis_nm":"No Result Available",...}]`.
const CONCATENATED_RESPONSE = JSON.stringify([
  {
    link_src: 'https://www.moneycontrol.com/india/stockpricequote/test/testco/TESTID1',
    pdt_dis_nm: 'Test Company <span>INE000000000, ZZZTESTSYM, 999999</span>',
    sc_id: 'TESTID1',
    name: 'Test Company',
  },
]) + JSON.stringify([
  { link_src: '', link_track: '', pdt_dis_nm: 'No Result Available', sc_id: '', stock_name: '', name: 'ZZZTESTSYM' },
]);

describe("resolveMoneycontrolSymbol against MoneyControl's real concatenated-JSON response shape", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('extracts the real match\'s sc_id instead of silently swallowing it as a parse error', async () => {
    global.fetch = (async () =>
      new Response(CONCATENATED_RESPONSE, { status: 200 })) as unknown as typeof fetch;

    // A symbol guaranteed absent from stocklist.ts's hardcoded mcsymbol map, and not yet cached,
    // so the function is forced down the live autocomplete-API fallback path being tested.
    const result = await resolveMoneycontrolSymbol('ZZZTESTSYM');

    expect(result).toBe('TESTID1');
  });
});

describe('resolveMoneycontrolSymbol never guesses (AF-20261118-06)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns null when no suggestion carries the symbol, instead of the first suggestion', async () => {
    // A query whose only suggestion is ANOTHER company: the old "best effort" fallback returned its
    // code, which is how Bilcare (BI) came to carry Britannia's MoneyControl code.
    global.fetch = (async () =>
      new Response(JSON.stringify([{ pdt_dis_nm: 'Britannia Industries <span>INE216A01030, BRITANNIA, 500825</span>', sc_id: 'BI' }]),
        { status: 200 })) as unknown as typeof fetch;
    expect(await resolveMoneycontrolSymbol('ZZZNOMATCH')).toBeNull();
  });
});
