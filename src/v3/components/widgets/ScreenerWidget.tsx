import React, { useState, useMemo } from 'react';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { Filter, Search, TrendingUp, TrendingDown, Minus, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export const ScreenerWidget: React.FC = () => {
  const [search, setSearch] = useState('');
  const [selectedScreener, setSelectedScreener] = useState<{ screenpk: string; screenerName: string } | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const { data: screenerList, isLoading: loadingList } = trpc.getTrendlyneScreenerNames.useQuery(undefined, {
    onSuccess: (data: any[]) => {
      if (data?.length > 0 && !selectedScreener) {
        setSelectedScreener({ screenpk: data[0].screenpk, screenerName: data[0].screener_name });
      }
    },
  } as any);

  const { data: screenerData, isLoading: loadingData } = trpc.getTrendlyneScreener.useQuery(
    selectedScreener ?? { screenpk: '', screenerName: '' },
    {
      enabled: !!selectedScreener?.screenpk,
      refetchInterval: 60000,
    }
  );

  const stocks = screenerData?.data ?? [];

  const filteredStocks = useMemo(() =>
    stocks.filter(s => {
      const sym = (s.symbol || s.stockId || s.name || '').toLowerCase();
      return sym.includes(search.toLowerCase());
    }),
    [stocks, search]
  );

  const isLoading = loadingList || loadingData;
  const screeners: any[] = screenerList ?? [];

  return (
    <div className="bg-slate-900/50 backdrop-blur-md border border-slate-800 rounded-xl flex flex-col h-[500px] shadow-lg overflow-hidden">
      {/* Header */}
      <div className="p-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center gap-3 bg-slate-800/20">
        <div className="flex items-center gap-3 flex-1">
          <div className="p-2 bg-indigo-500/10 rounded-lg shrink-0">
            <Filter className="w-5 h-5 text-indigo-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-slate-100">Live Screener</h2>
            <p className="text-xs text-slate-400 truncate">
              {selectedScreener?.screenerName ?? 'Select a screener'}
              {screenerData?.totalResults ? ` · ${screenerData.totalResults} stocks` : ''}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Screener selector */}
          <div className="relative">
            <button
              onClick={() => setDropdownOpen(o => !o)}
              className="flex items-center gap-2 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-300 hover:border-indigo-500/50 transition-colors"
            >
              <span className="max-w-[160px] truncate">
                {loadingList ? 'Loading...' : selectedScreener?.screenerName ?? 'Choose screener'}
              </span>
              <ChevronDown className={cn('w-4 h-4 transition-transform shrink-0', dropdownOpen && 'rotate-180')} />
            </button>
            <AnimatePresence>
              {dropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="absolute right-0 top-full mt-1 w-64 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-30 max-h-56 overflow-y-auto custom-scrollbar"
                >
                  {screeners.map((s: any) => (
                    <button
                      key={s.screenpk}
                      onClick={() => {
                        setSelectedScreener({ screenpk: s.screenpk, screenerName: s.screener_name });
                        setDropdownOpen(false);
                      }}
                      className={cn(
                        'w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-slate-800',
                        selectedScreener?.screenpk === s.screenpk
                          ? 'text-indigo-400 bg-indigo-500/10'
                          : 'text-slate-300'
                      )}
                    >
                      {s.screener_name}
                    </button>
                  ))}
                  {screeners.length === 0 && (
                    <p className="px-4 py-3 text-sm text-slate-500">No screeners loaded yet.</p>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Filter symbols..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-44 bg-slate-900/80 border border-slate-700 rounded-lg py-2 pl-9 pr-4 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto custom-scrollbar" onClick={() => dropdownOpen && setDropdownOpen(false)}>
        {isLoading ? (
          <div className="space-y-3 p-5">
            {[1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className="h-11 w-full bg-slate-800/50 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 bg-slate-900/95 backdrop-blur z-10 border-b border-slate-800">
              <tr>
                <th className="py-3 px-5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Symbol</th>
                <th className="py-3 px-5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Company</th>
                <th className="py-3 px-5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-right">LTP</th>
                <th className="py-3 px-5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-right">Change %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              <AnimatePresence>
                {filteredStocks.map((stock, idx) => {
                  const symbol = stock.symbol || stock.stockId || '—';
                  const name = stock.name || symbol;
                  const ltp = stock.ltp ?? 0;
                  const changePct = stock.changePercent ?? stock.change ?? 0;
                  const isGainer = changePct > 0;
                  const isLoser = changePct < 0;

                  return (
                    <motion.tr
                      key={symbol + idx}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ delay: Math.min(idx * 0.02, 0.3) }}
                      className="hover:bg-slate-800/30 transition-colors group"
                    >
                      <td className="py-3 px-5">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-300 group-hover:bg-indigo-500/20 group-hover:text-indigo-300 transition-colors shrink-0">
                            {symbol.substring(0, 2)}
                          </div>
                          <span className="font-semibold text-slate-200 text-sm">{symbol}</span>
                        </div>
                      </td>
                      <td className="py-3 px-5 text-sm text-slate-400 max-w-[180px] truncate">{name}</td>
                      <td className="py-3 px-5 text-right font-medium text-slate-200 tabular-nums text-sm">
                        {ltp > 0
                          ? `₹${ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : '—'}
                      </td>
                      <td className="py-3 px-5 text-right">
                        <div className={cn(
                          'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold tabular-nums',
                          isGainer
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : isLoser
                            ? 'bg-rose-500/10 text-rose-400'
                            : 'bg-slate-700/50 text-slate-400'
                        )}>
                          {isGainer
                            ? <TrendingUp className="w-3 h-3" />
                            : isLoser
                            ? <TrendingDown className="w-3 h-3" />
                            : <Minus className="w-3 h-3" />}
                          {changePct !== 0 ? `${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%` : '0.00%'}
                        </div>
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>

              {!isLoading && filteredStocks.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-12 text-center text-slate-500 text-sm">
                    {selectedScreener
                      ? search
                        ? 'No stocks match your filter.'
                        : 'No stocks in this screener yet — run a screener sync to populate.'
                      : 'Select a screener from the dropdown above.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
