import React from 'react';
import { Star } from 'lucide-react';
import { trpc } from '../../../lib/trpc';
import { Card } from '../../../components/Card';
import { cn } from '../../../lib/utils';

const CHANGE_STYLE: Record<string, { color: string; label: string }> = {
  entry:    { color: 'text-emerald-400', label: 'New Entry' },
  increase: { color: 'text-emerald-300', label: 'Increased' },
  decrease: { color: 'text-amber-400',   label: 'Decreased' },
  exit:     { color: 'text-rose-400',    label: 'Exited' },
};

// Market-wide superstar-investor (Ashish Kacholia, Vijay Kedia, et al.) holding-change feed --
// getSuperstarActivityFeed (fundamentals.router.ts), previously only reachable per-symbol from a
// stock detail page. This is the discovery surface: what are they doing right now, across the
// whole universe, without already knowing which stock to check.
export const SuperstarActivityFeed: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const { data, isLoading } = trpc.getSuperstarActivityFeed.useQuery({ limit: 8 }, { refetchInterval: 30 * 60_000 });
  const rows = data ?? [];

  return (
    <Card title="Superstar Investor Activity" icon={Star}>
      {isLoading ? (
        <div className="text-xs text-slate-500 py-6 text-center animate-pulse">Loading investor activity…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-slate-500 py-6 text-center">No superstar-investor activity recorded yet.</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r: any, i: number) => {
            const style = CHANGE_STYLE[r.change_type] ?? { color: 'text-slate-400', label: r.change_type };
            return (
              <button
                key={`${r.symbol}-${r.investor_slug}-${i}`}
                onClick={() => onSelectStock?.(r.symbol)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-slate-800 bg-slate-950 hover:border-slate-700 transition-colors text-left"
              >
                <div className="min-w-0">
                  <div className="text-xs font-bold text-slate-100">{r.symbol}</div>
                  <div className="text-[10px] text-slate-500 truncate">{r.investor_name ?? r.investor_slug}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className={cn('text-[10px] font-black uppercase tracking-wide', style.color)}>{style.label}</div>
                  {r.curr_pct_holding != null && (
                    <div className="text-[9px] text-slate-500">{Number(r.curr_pct_holding).toFixed(2)}% held</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
};

export default SuperstarActivityFeed;
