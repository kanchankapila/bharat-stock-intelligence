/**
 * Yahoo v7 quote URLs must URL-encode their symbols.
 *
 * NSE has tickers containing '&' (M&M, M&MFIN, ARE&M, J&KBANK, GET&D, GMRP&UI, IL&FSENGG,
 * IL&FSTRANS, SURANAT&P, GVT&D, S&SPOWER). Interpolated raw into `?symbols=`, the '&' ends the
 * parameter: every symbol after it in the same 50-symbol batch vanished while Yahoo still
 * answered 200. Measured 2026-09-11: 287 of the 2,550-symbol live universe -- RELIANCE among
 * them -- had no live quote, all 287 exactly the symbols sitting after an '&' in their batch.
 */
import { describe, expect, it } from 'vitest';
import { yahooQuoteUrl } from '../yahooQuoteUrl';

describe('yahooQuoteUrl', () => {
  it('keeps every symbol, including ones after an ampersand ticker', () => {
    const url = new URL(yahooQuoteUrl(['ABB', 'M&M', 'RELIANCE', 'S&SPOWER', 'TCS'], { fields: 'regularMarketPrice' }));
    expect(url.searchParams.get('symbols')).toBe('ABB.NS,M&M.NS,RELIANCE.NS,S&SPOWER.NS,TCS.NS');
    expect(url.searchParams.get('fields')).toBe('regularMarketPrice');
  });

  it('encodes the crumb too', () => {
    const url = new URL(yahooQuoteUrl(['TCS'], { fields: 'a,b', crumb: 'ab/c+d=' }));
    expect(url.searchParams.get('crumb')).toBe('ab/c+d=');
    expect(url.searchParams.get('fields')).toBe('a,b');
  });

  it('omits the crumb when there is none', () => {
    expect(new URL(yahooQuoteUrl(['TCS'], { fields: 'x' })).searchParams.has('crumb')).toBe(false);
  });
});
