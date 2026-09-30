import { useEffect, useState } from 'react';
import type { NSEStock } from './nseStocks';
import type { StockMapping } from './stocklist';

// nseStocks.ts + stocklist.ts are ~1MB of source. Statically imported from the always-mounted
// shell (AppShell search, CommandPalette, SlideOutDrawer) they landed in the main chunk and every
// visitor downloaded the whole stock master before first paint (AF-20260930-22). Components on
// the startup path load them on first use instead; each module is fetched once per session.
let nsePromise: Promise<NSEStock[]> | null = null;
let stockListPromise: Promise<StockMapping[]> | null = null;

export function loadNseStocks(): Promise<NSEStock[]> {
  return (nsePromise ??= import('./nseStocks').then(m => m.nseStocksData));
}

export function loadStockList(): Promise<StockMapping[]> {
  return (stockListPromise ??= import('./stocklist').then(m => m.default));
}

function useLazy<T>(load: () => Promise<T>, enabled: boolean): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!enabled || data) return;
    let live = true;
    load().then(d => { if (live) setData(d); });
    return () => { live = false; };
  }, [enabled, data, load]);
  return data;
}

/** null until loaded; loading starts the first time `enabled` is true. */
export const useNseStocks = (enabled: boolean) => useLazy(loadNseStocks, enabled);
export const useStockList = (enabled: boolean) => useLazy(loadStockList, enabled);
