import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { Repeat, Search, TrendingDown, TrendingUp, Minus } from 'lucide-react';

const TAG_META: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  SHORT_ROLL: { label: 'Short Roll', color: 'text-rose-400 bg-rose-500/10 border-rose-500/20', icon: TrendingDown },
  LONG_ROLL:  { label: 'Long Roll',  color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', icon: TrendingUp },
  NEUTRAL:    { label: 'Neutral',    color: 'text-slate-400 bg-slate-500/10 border-slate-700', icon: Minus },
};

function formatOI(n: number | null) {
  if (n === null) return '—';
  if (n >= 10000000) return (n / 10000000).toFixed(2) + 'Cr';
  if (n >= 100000) return (n / 100000).toFixed(2) + 'L';
  return n.toLocaleString('en-IN');
}

export const RolloverPositioningPanel: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const { data = [], isLoading, isError } = trpc.getRolloverPositioning.useQuery(undefined, {
    staleTime: 30 * 60 * 1000,
  });

  const filtered = data.filter((d: any) =>
    d.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (d.name || '').toLowerCase().includes(searchQuery.toLowerCase())
  );
  const latestDate = data[0]?.date;

  return (
    <div className="flex flex-col h-[580px] glass border border-slate-800/50 rounded-2xl p-5 text-slate-200">
      <div className="flex-shrink-0 mb-5">
        <h2 className="text-xl font-bold font-['Rajdhani'] flex items-center gap-2">
          <Repeat className="w-5 h-5 text-sky-400" />
          F&amp;O Rollover Positioning
        </h2>
        <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mt-0.5">
          Rollover% + cost-of-carry as of {latestDate || '—'} — the local proxy for short/long positioning rolling into the next series
        </p>
      </div>

      <div className="relative mb-4 flex-shrink-0">
        <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-500" />
        <input
          type="text"
          placeholder="Search stocks by symbol or name..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-slate-950/60 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs font-medium text-slate-200 placeholder-slate-650 focus:outline-none focus:border-slate-700 transition-colors"
        />
      </div>

      <div className="flex-grow overflow-y-auto pr-1 terminal-scrollbar min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-bold">Loading rollover data&hellip;</div>
        ) : isError ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-bold">Failed to load rollover data.</div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-bold">No rollover data available.</div>
        ) : (
          <div className="space-y-2">
            {filtered.map((r: any) => {
              const meta = TAG_META[r.positioning] || TAG_META.NEUTRAL;
              const Icon = meta.icon;
              return (
                <div
                  key={r.symbol}
                  onClick={() => onSelectStock?.(r.symbol)}
                  className="p-3 bg-slate-950/45 border border-slate-900 hover:border-slate-800/80 rounded-xl transition-all cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="space-y-0.5 sm:w-1/4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-black text-white uppercase tracking-wider">{r.symbol}</span>
                      <span className={cn("text-[8px] font-black px-1.5 py-0.5 rounded border uppercase flex items-center gap-1", meta.color)}>
                        <Icon className="w-2.5 h-2.5" /> {meta.label}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-500 font-bold leading-tight truncate">{r.name || r.symbol}</p>
                  </div>

                  <div className="grid grid-cols-4 gap-3 flex-grow text-center sm:text-left">
                    <div>
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">Rollover %</span>
                      <span className="text-xs font-bold text-slate-200 font-mono">{r.rollover_pct !== null ? `${r.rollover_pct.toFixed(1)}%` : '—'}</span>
                    </div>
                    <div>
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">Cost of Carry</span>
                      <span className={cn("text-xs font-bold font-mono", (r.cost_of_carry_ann ?? 0) < 0 ? "text-rose-400" : "text-emerald-400")}>
                        {r.cost_of_carry_ann !== null ? `${r.cost_of_carry_ann >= 0 ? '+' : ''}${r.cost_of_carry_ann.toFixed(1)}%` : '—'}
                      </span>
                    </div>
                    <div>
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">Near OI</span>
                      <span className="text-xs font-bold text-slate-300 font-mono">{formatOI(r.near_oi)}</span>
                    </div>
                    <div>
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">Next OI</span>
                      <span className="text-xs font-bold text-slate-300 font-mono">{formatOI(r.next_oi)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default RolloverPositioningPanel;
