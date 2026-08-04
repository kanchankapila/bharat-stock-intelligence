import React, { useState, useMemo } from 'react';
import { trpc } from '../lib/trpc';
import { Card } from './Card';
import {
  Activity, Search, Clock, ArrowUpRight, ArrowDownRight, Radio,
  ChevronUp, ChevronDown, ChevronsUpDown
} from 'lucide-react';
import { cn } from '../lib/utils';
import { format } from 'date-fns';
import { useSignalLedgerSort, type SignalSortKey } from '../hooks/useSignalLedgerSort';

const SortableHeader: React.FC<{
  label: string; sortKey: SignalSortKey; active: SignalSortKey; dir: 'asc' | 'desc';
  onSort: (key: SignalSortKey) => void; align?: 'left' | 'center' | 'right';
}> = ({ label, sortKey, active, dir, onSort, align = 'left' }) => (
  <th
    className={cn(
      'px-4 py-3 cursor-pointer select-none hover:text-slate-200 transition-colors',
      align === 'center' && 'text-center', align === 'right' && 'text-right',
    )}
    onClick={() => onSort(sortKey)}
    title={`Sort by ${label}`}
  >
    <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
      {label}
      {active === sortKey
        ? (dir === 'asc' ? <ChevronUp className="w-3 h-3 text-indigo-400" /> : <ChevronDown className="w-3 h-3 text-indigo-400" />)
        : <ChevronsUpDown className="w-3 h-3 text-slate-600" />}
    </span>
  </th>
);

export const SignalTracking: React.FC = () => {
  const [daysFilter, setDaysFilter] = useState(30);
  const [searchQuery, setSearchQuery] = useState('');

  const { data: signals, isLoading, error } = trpc.getSignalTracking.useQuery({ days: daysFilter });

  // Hooks must run unconditionally on every render -- computed here, above the loading/error
  // early returns below, even though their result is only rendered on the success path.
  const searchFiltered = useMemo(() => (signals || []).filter((s: any) =>
    s.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.signal_source.toLowerCase().includes(searchQuery.toLowerCase())
  ), [signals, searchQuery]);
  const { sorted: filteredSignals, sortKey, sortDir, handleSort } = useSignalLedgerSort(searchFiltered);

  if (isLoading) {
    return (
      <div className="p-6">
        <Card title="Signal Ledger">
          <div className="flex flex-col items-center justify-center min-h-[400px]">
             <Activity className="w-12 h-12 text-indigo-500/20 animate-pulse mb-4" />
             <p className="text-slate-400 text-xs font-black uppercase tracking-[0.2em] animate-pulse">
               Syncing Universal Signal Ledger...
             </p>
          </div>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card title="Signal Ledger">
          <div className="p-8 text-center bg-slate-900/50 border border-rose-500/30 rounded-2xl">
            <p className="text-rose-400 font-mono text-sm">Error loading signals: {error.message}</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Signal Tracking</h1>
          <p className="mt-2 text-sm text-slate-400">Track all generated signals and their live growth performance.</p>
        </div>
        
        <div className="flex flex-col sm:flex-row items-center gap-3">
          {/* Search */}
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input 
              type="text" 
              placeholder="Search symbol or source..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-900/50 border border-slate-800/50 rounded-xl py-2 pl-9 pr-3 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500/50 transition-colors"
            />
          </div>

          {/* Days Filter */}
          <div className="flex items-center bg-slate-900/50 border border-slate-800/50 rounded-xl p-1 shrink-0">
            {[7, 30, 90, 365].map(days => (
              <button
                key={days}
                onClick={() => setDaysFilter(days)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all",
                  daysFilter === days 
                    ? "bg-indigo-600 text-white shadow-md" 
                    : "text-slate-400 hover:text-slate-200"
                )}
              >
                {days}D
              </button>
            ))}
          </div>
        </div>
      </div>

      <Card title="Universal Signal Ledger" icon={Radio}>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm text-left border-separate border-spacing-y-2">
            <thead>
              <tr className="text-slate-400 text-xs uppercase tracking-[0.2em]">
                <SortableHeader label="Generated At" sortKey="signal_generated_at" active={sortKey} dir={sortDir} onSort={handleSort} />
                <SortableHeader label="Symbol" sortKey="symbol" active={sortKey} dir={sortDir} onSort={handleSort} />
                <SortableHeader label="Type / Source" sortKey="signal_type" active={sortKey} dir={sortDir} onSort={handleSort} align="center" />
                <SortableHeader label="Entry Price" sortKey="entry_price" active={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                <SortableHeader label="Current Price" sortKey="current_price" active={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                <SortableHeader label="Growth / PnL" sortKey="growth_pct" active={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {filteredSignals.length > 0 ? (
                filteredSignals.map((sig: any) => {
                  const isPositive = sig.growth_pct != null && sig.growth_pct > 0;
                  const isNegative = sig.growth_pct != null && sig.growth_pct < 0;

                  return (
                    <tr key={sig.id} className="bg-slate-950/60 hover:bg-slate-900 transition-colors even:bg-slate-900/50 group">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 text-slate-300">
                          <Clock className="w-3 h-3 text-slate-500" />
                          <span className="text-[11px] font-medium">
                            {format(new Date(sig.signal_generated_at), 'MMM dd, yyyy HH:mm')}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-semibold text-white">
                        {sig.symbol}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex flex-col items-center justify-center gap-1">
                          <span className={cn(
                            "px-2 py-0.5 rounded text-[9px] font-black tracking-widest uppercase border",
                            sig.signal_type === 'BUY' ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : 
                            sig.signal_type === 'SELL' ? "bg-rose-500/10 text-rose-400 border-rose-500/20" : 
                            "bg-slate-500/10 text-slate-400 border-slate-500/20"
                          )}>
                            {sig.signal_type}
                          </span>
                          <span className="text-[9px] text-slate-400 uppercase font-black tracking-widest">
                            {sig.signal_source}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-300 font-medium">
                        ₹{sig.entry_price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-white">
                        {sig.current_price 
                          ? `₹${sig.current_price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {sig.growth_pct != null ? (
                          <div className={cn(
                            "inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold",
                            isPositive ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" :
                            isNegative ? "bg-rose-500/10 text-rose-400 border border-rose-500/20" :
                            "bg-slate-800 text-slate-300"
                          )}>
                            {isPositive ? <ArrowUpRight className="w-3 h-3" /> : isNegative ? <ArrowDownRight className="w-3 h-3" /> : null}
                            {isPositive ? '+' : ''}{sig.growth_pct.toFixed(2)}%
                          </div>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-slate-500 text-sm">
                    No signals found in the selected timeframe.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};
