import { useMemo, useState } from 'react';

export type SignalSortKey = 'signal_generated_at' | 'symbol' | 'signal_type' | 'entry_price' | 'current_price' | 'growth_pct';
export type SignalSortDir = 'asc' | 'desc';

// Growth/PnL defaults ascending (worst performers first) rather than the usual "biggest first"
// descending -- for risk triage ("which open positions are bleeding right now") that's the more
// useful default first click, per the original UX audit's finding that the ledger had no way to
// answer that question at all.
const DEFAULT_DIR: Record<SignalSortKey, SignalSortDir> = {
  signal_generated_at: 'desc',
  symbol: 'asc',
  signal_type: 'asc',
  entry_price: 'desc',
  current_price: 'desc',
  growth_pct: 'asc',
};

function sortValue(sig: any, key: SignalSortKey): number | string {
  switch (key) {
    case 'signal_generated_at': return new Date(sig.signal_generated_at).getTime() || 0;
    case 'symbol': return sig.symbol ?? '';
    case 'signal_type': return `${sig.signal_type ?? ''}-${sig.signal_source ?? ''}`;
    case 'entry_price': return sig.entry_price ?? -Infinity;
    case 'current_price': return sig.current_price ?? -Infinity;
    case 'growth_pct': return sig.growth_pct ?? -Infinity;
    default: return '';
  }
}

/** Pure sort function, split out from the hook so it's testable without React. */
export function sortSignals(rows: any[] | undefined | null, key: SignalSortKey, dir: SignalSortDir): any[] {
  const list = [...(rows || [])];
  list.sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    const cmp = typeof va === 'string' && typeof vb === 'string' ? va.localeCompare(vb) : (va as number) - (vb as number);
    return dir === 'asc' ? cmp : -cmp;
  });
  return list;
}

/** Which direction a column defaults to on its first click. Exported for the hook + tests. */
export function defaultSortDir(key: SignalSortKey): SignalSortDir {
  return DEFAULT_DIR[key];
}

/**
 * Shared sort state + comparator for the Signal Ledger, used by both SignalTracking.tsx (v1)
 * and V2SignalTracking.tsx (v2) -- the two views render very different markup/styling but
 * should never have two independently-maintained copies of the sort comparator itself.
 */
export function useSignalLedgerSort(rows: any[] | undefined | null) {
  const [sortKey, setSortKey] = useState<SignalSortKey>('signal_generated_at');
  const [sortDir, setSortDir] = useState<SignalSortDir>('desc');

  const handleSort = (key: SignalSortKey) => {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(defaultSortDir(key));
    }
  };

  const sorted = useMemo(() => sortSignals(rows, sortKey, sortDir), [rows, sortKey, sortDir]);

  return { sorted, sortKey, sortDir, handleSort };
}
