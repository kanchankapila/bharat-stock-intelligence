import React, { useState, useMemo } from 'react';
import { trpc } from '../lib/trpc';
import { Search, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

interface Props {
  onSelectStock?: (symbol: string) => void;
}

interface PlaybookRow {
  scId: string;
  companyName: string;
  resultDate: string;
  epsActual: string | null;
  epsEstimate: string | null;
  surprisePct: number | null;
}

// Was previously 100% hardcoded fake EPS/IV numbers presented as live data (TCS/INFY/WIPRO/
// RELIANCE with static values that never changed). Rewired to real data: getEarnings() already
// carries the upcoming results calendar and actual-vs-estimate EPS figures for the earnings page
// — this reuses the same aggregate instead of a second, competing fetch.
// Note: `scId` here is Moneycontrol's internal id, not the NSE symbol, so rows are not wired to
// onSelectStock (no verified NSE-symbol mapping available for these rows without a second call).
export const EarningsPlaybook: React.FC<Props> = ({ onSelectStock: _onSelectStock }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const { data, isLoading } = trpc.getEarnings.useQuery({});

  const rows = useMemo<PlaybookRow[]>(() => {
    const calendar: any[] = data?.calendar?.data?.resultCalendar ?? [];
    const estimates: any[] = data?.actualEstimate?.data?.list ?? [];

    const epsBySymbol = new Map<string, { actual: string; estimate: string; actualVal: number; estimateVal: number }>();
    estimates.forEach((e: any) => {
      if (e?.metric && /eps/i.test(e.metric) && e.symbol && !epsBySymbol.has(e.symbol)) {
        epsBySymbol.set(e.symbol, { actual: e.actual, estimate: e.estimate, actualVal: e.actualVal, estimateVal: e.estimateVal });
      }
    });

    return calendar
      .filter((c: any) => c.symbol)
      .map((c: any) => {
        const eps = epsBySymbol.get(c.symbol);
        const surprisePct = eps && eps.estimateVal ? ((eps.actualVal - eps.estimateVal) / Math.abs(eps.estimateVal)) * 100 : null;
        return {
          scId: c.symbol,
          companyName: c.companyName || c.name || c.symbol,
          resultDate: c.resultDate || c.date || '—',
          epsActual: eps?.actual ?? null,
          epsEstimate: eps?.estimate ?? null,
          surprisePct,
        };
      });
  }, [data]);

  const filtered = rows.filter(r =>
    r.companyName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex flex-col h-[580px] glass border border-slate-800/50 rounded-2xl p-5 text-slate-200">
      <div className="flex-shrink-0 mb-5">
        <h2 className="text-xl font-bold font-['Rajdhani'] flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-amber-400" />
          Earnings Calendar & Actual-vs-Estimate
        </h2>
        <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mt-0.5">
          Live result calendar with EPS actual vs consensus, where reported
        </p>
      </div>

      <div className="relative mb-4 flex-shrink-0">
        <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-500" />
        <input
          type="text"
          placeholder="Filter by company name..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-slate-950/60 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs font-medium text-slate-200 placeholder-slate-650 focus:outline-none focus:border-slate-700 transition-colors"
        />
      </div>

      <div className="flex-grow overflow-y-auto pr-1 terminal-scrollbar min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-bold">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-bold">
            No earnings calendar items found.
          </div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence mode="popLayout">
              {filtered.map((item) => (
                <motion.div
                  key={item.scId}
                  layout
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.2 }}
                  className="p-4 bg-slate-950/45 border border-slate-900 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="space-y-1 sm:w-2/5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-black text-white uppercase tracking-wider truncate">{item.companyName}</span>
                      <span className="text-[8px] font-black px-1.5 py-0.5 rounded border border-slate-800 bg-slate-900 text-slate-400 font-mono shrink-0">
                        {item.resultDate}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-4 flex-grow max-w-xs text-center sm:text-left">
                    <div>
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">EPS Est.</span>
                      <span className="text-xs font-bold text-slate-200 font-mono">{item.epsEstimate ?? '—'}</span>
                    </div>
                    <div>
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">EPS Actual</span>
                      <span className="text-xs font-bold text-slate-200 font-mono">{item.epsActual ?? 'Not reported'}</span>
                    </div>
                    <div>
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">Surprise</span>
                      <span className={cn(
                        'text-xs font-black font-mono',
                        item.surprisePct == null ? 'text-slate-500' : item.surprisePct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      )}>
                        {item.surprisePct != null ? `${item.surprisePct > 0 ? '+' : ''}${item.surprisePct.toFixed(1)}%` : '—'}
                      </span>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
};
export default EarningsPlaybook;
