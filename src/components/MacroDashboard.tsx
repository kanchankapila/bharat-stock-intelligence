import React from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { Globe2, TrendingUp, TrendingDown, CalendarClock } from 'lucide-react';

const GROUP_ORDER = ['FX', 'Commodities', 'Rates', 'Volatility', 'Global Indices', 'Flows', 'Pre-Open'];

function formatValue(close: number | null, unit?: string) {
  if (close === null) return '—';
  const formatted = Math.abs(close) >= 1000
    ? close.toLocaleString('en-IN', { maximumFractionDigits: 1 })
    : close.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return unit ? `${unit === '₹Cr' ? unit + ' ' : ''}${formatted}${unit && unit !== '₹Cr' ? ' ' + unit : ''}` : formatted;
}

export const MacroDashboard: React.FC = () => {
  const { data: tiles = [], isLoading: tilesLoading } = trpc.getMacroSnapshot.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
  const { data: events = [], isLoading: eventsLoading } = trpc.getEcoCalendar.useQuery(
    { daysBack: 1, daysForward: 7, minImpact: 2 },
    { staleTime: 15 * 60 * 1000, refetchInterval: 15 * 60 * 1000 }
  );

  const grouped = React.useMemo(() => {
    const map = new Map<string, typeof tiles>();
    for (const t of tiles) {
      if (!map.has(t.group)) map.set(t.group, [] as any);
      (map.get(t.group) as any).push(t);
    }
    return GROUP_ORDER.map(g => ({ group: g, items: map.get(g) || [] })).filter(g => g.items.length > 0);
  }, [tiles]);

  return (
    <div className="space-y-6">
      {/* Macro tiles */}
      <div className="bg-slate-900/40 border border-slate-800/50 rounded-xl p-5 backdrop-blur-sm">
        <div className="flex items-center gap-2 mb-4">
          <Globe2 className="w-5 h-5 text-indigo-400" />
          <h3 className="text-sm font-bold text-slate-100 uppercase tracking-widest">Macro Snapshot</h3>
        </div>
        {tilesLoading ? (
          <p className="text-xs text-slate-500 font-mono">Loading macro data&hellip;</p>
        ) : tiles.length === 0 ? (
          <p className="text-xs text-slate-500 font-mono">Macro data unavailable.</p>
        ) : (
          <div className="space-y-5">
            {grouped.map(({ group, items }) => (
              <div key={group}>
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">{group}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {items.map((t: any) => {
                    const up = (t.ret1d ?? 0) >= 0;
                    return (
                      <div key={t.symbol} className="bg-slate-950/50 border border-slate-800/60 rounded-lg p-3">
                        <p className="text-[9px] text-slate-500 font-bold uppercase tracking-wider truncate">{t.label}</p>
                        <p className="text-sm font-black text-slate-100 font-mono mt-1">{formatValue(t.close, t.unit)}</p>
                        {t.ret1d !== null && (
                          <p className={cn("text-[10px] font-bold font-mono mt-0.5 flex items-center gap-1", up ? "text-emerald-400" : "text-rose-400")}>
                            {up ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
                            {up ? '+' : ''}{t.ret1d.toFixed(2)}%
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Economic calendar */}
      <div className="bg-slate-900/40 border border-slate-800/50 rounded-xl p-5 backdrop-blur-sm">
        <div className="flex items-center gap-2 mb-4">
          <CalendarClock className="w-5 h-5 text-amber-400" />
          <h3 className="text-sm font-bold text-slate-100 uppercase tracking-widest">Economic Calendar — High Impact</h3>
        </div>
        {eventsLoading ? (
          <p className="text-xs text-slate-500 font-mono">Loading calendar&hellip;</p>
        ) : events.length === 0 ? (
          <p className="text-xs text-slate-500 font-mono">No high-impact events in this window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-[10px] text-slate-500 uppercase tracking-wider border-b border-slate-800/50">
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">Country</th>
                  <th className="py-2 pr-3 font-medium">Event</th>
                  <th className="py-2 pr-3 font-medium text-right">Previous</th>
                  <th className="py-2 pr-3 font-medium text-right">Consensus</th>
                  <th className="py-2 font-medium text-right">Actual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/30">
                {events.map((e: any, i: number) => (
                  <tr key={i} className="hover:bg-slate-800/30">
                    <td className="py-2 pr-3 font-mono text-slate-400">{e.event_date}</td>
                    <td className="py-2 pr-3 text-slate-300">{e.country_name}</td>
                    <td className="py-2 pr-3 text-slate-200 font-medium flex items-center gap-1.5">
                      {Number(e.impact) >= 3 && <span className="w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" title="High impact" />}
                      {e.event_name}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-slate-400">{e.previous || '—'}</td>
                    <td className="py-2 pr-3 text-right font-mono text-slate-400">{e.consensus || '—'}</td>
                    <td className="py-2 text-right font-mono text-slate-200">{e.actual || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default MacroDashboard;
