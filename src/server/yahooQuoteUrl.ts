/**
 * Yahoo Finance v7 quote URL for a batch of NSE symbols, with every parameter URL-encoded.
 *
 * NSE tickers can contain '&' (M&M, J&KBANK, S&SPOWER, ...). Interpolated raw into
 * `?symbols=`, the '&' ends the parameter and every later symbol in the batch is silently
 * dropped while Yahoo still answers 200 -- 287 of 2,550 live symbols, RELIANCE among them,
 * measured 2026-09-11.
 */
export function yahooQuoteUrl(symbols: string[], opts: { fields: string; crumb?: string }): string {
  const params = new URLSearchParams({
    symbols: symbols.map((s) => `${s}.NS`).join(','),
    fields: opts.fields,
  });
  if (opts.crumb) params.set('crumb', opts.crumb);
  return `https://query2.finance.yahoo.com/v7/finance/quote?${params.toString()}`;
}
