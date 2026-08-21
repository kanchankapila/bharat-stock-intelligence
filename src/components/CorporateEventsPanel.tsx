import React from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ShieldCheck, CalendarDays, FileCheck2 } from 'lucide-react';

const ACTION_COLORS: Record<string, string> = {
  DIVIDEND: 'text-emerald-400 bg-emerald-500/10',
  SPLIT: 'text-sky-400 bg-sky-500/10',
  BONUS: 'text-indigo-400 bg-indigo-500/10',
  BUYBACK: 'text-amber-400 bg-amber-500/10',
};

const RATING_COLORS: Record<string, string> = {
  UPGRADE: 'text-emerald-400 bg-emerald-500/10',
  DOWNGRADE: 'text-rose-400 bg-rose-500/10',
  REAFFIRM: 'text-slate-400 bg-slate-500/10',
};

export const CorporateEventsPanel: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const { data: actions = [], isLoading: actionsLoading } = trpc.getCorporateActionsCalendar.useQuery(
    { daysBack: 2, daysForward: 21 },
    { staleTime: 30 * 60 * 1000 }
  );
  const { data: ratings = [], isLoading: ratingsLoading } = trpc.getCreditRatingEvents.useQuery(
    { limit: 40 },
    { staleTime: 30 * 60 * 1000 }
  );
  // Market-wide, NSE-filing-sourced corporate actions (2026-08-07 urls.txt open-source
  // sourcing pass) — the completeness cross-check for the ratio calendar to the left, not a
  // duplicate: every row here links back to a real exchange filing PDF.
  const { data: filedActions = [], isLoading: filedLoading } = trpc.getFiledCorporateActionsCalendar.useQuery(
    { daysBack: 14, daysForward: 60 },
    { staleTime: 30 * 60 * 1000 }
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Corporate actions calendar */}
      <div className="v1-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <CalendarDays className="w-5 h-5 text-sky-400" />
          <h3 className="v1-title-card uppercase tracking-widest">Corporate Actions Calendar</h3>
        </div>
        {actionsLoading ? (
          <p className="text-xs text-slate-500 font-data">Loading&hellip;</p>
        ) : actions.length === 0 ? (
          <p className="text-xs text-slate-500 font-data">No corporate actions in this window.</p>
        ) : (
          <div className="overflow-y-auto max-h-96 -mx-1">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-900/90">
                <tr className="text-[10px] text-slate-500 font-display uppercase tracking-wider">
                  <th className="text-left px-2 py-2 font-medium">Ex-Date</th>
                  <th className="text-left px-2 py-2 font-medium">Symbol</th>
                  <th className="text-left px-2 py-2 font-medium">Type</th>
                  <th className="text-right px-2 py-2 font-medium">Ratio / Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/30">
                {actions.map((a: any, i: number) => (
                  <tr key={i} className="hover:bg-slate-800/40 cursor-pointer" onClick={() => onSelectStock?.(a.symbol)}>
                    <td className="px-2 py-1.5 font-data text-slate-400">{a.ex_date}</td>
                    <td className="px-2 py-1.5 font-bold text-slate-200">{a.symbol}</td>
                    <td className="px-2 py-1.5">
                      <span className={cn("text-[9px] px-2 py-0.5 rounded font-bold uppercase", ACTION_COLORS[a.action_type] || "text-slate-400 bg-slate-500/10")}>
                        {a.action_type}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-data text-slate-300">
                      {a.ratio != null ? `1:${a.ratio}` : a.amount != null ? `₹${Number(a.amount).toFixed(2)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Credit rating events */}
      <div className="v1-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck className="w-5 h-5 text-amber-400" />
          <h3 className="v1-title-card uppercase tracking-widest">Credit Rating Actions</h3>
        </div>
        {ratingsLoading ? (
          <p className="text-xs text-slate-500 font-data">Loading&hellip;</p>
        ) : ratings.length === 0 ? (
          <p className="text-xs text-slate-500 font-data">No recent rating actions.</p>
        ) : (
          <div className="overflow-y-auto max-h-96 space-y-2 -mx-1 px-1">
            {ratings.map((r: any, i: number) => (
              <div
                key={i}
                className="p-2.5 bg-slate-950/50 border border-slate-800/60 rounded-lg cursor-pointer hover:border-slate-700"
                onClick={() => r.symbol && onSelectStock?.(r.symbol)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={cn("text-[9px] px-2 py-0.5 rounded font-bold uppercase shrink-0", RATING_COLORS[r.action] || "text-slate-400 bg-slate-500/10")}>
                    {r.action}
                  </span>
                  <span className="text-[10px] text-slate-500 font-data shrink-0">{r.announcement_date}</span>
                </div>
                <p className="text-xs text-slate-200 mt-1.5 leading-snug">{r.headline}</p>
                <p className="text-[10px] text-slate-500 mt-1">{r.rating_agency}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* NSE-filed corporate actions — real exchange filings, not a derived ratio */}
      <div className="v1-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <FileCheck2 className="w-5 h-5 text-emerald-400" />
          <h3 className="v1-title-card uppercase tracking-widest">Filed with NSE</h3>
        </div>
        {filedLoading ? (
          <p className="text-xs text-slate-500 font-data">Loading&hellip;</p>
        ) : filedActions.length === 0 ? (
          <p className="text-xs text-slate-500 font-data">No filed corporate actions in this window.</p>
        ) : (
          <div className="overflow-y-auto max-h-96 space-y-2 -mx-1 px-1">
            {filedActions.map((f: any, i: number) => (
              <div key={f.source_url || i} className="p-2.5 bg-slate-950/50 border border-slate-800/60 rounded-lg hover:border-slate-700">
                <div className="flex items-center justify-between gap-2">
                  <button
                    onClick={() => onSelectStock?.(f.symbol)}
                    className="text-[9px] px-2 py-0.5 rounded font-bold uppercase text-emerald-400 bg-emerald-500/10 shrink-0 hover:bg-emerald-500/20"
                  >
                    {f.symbol}
                  </button>
                  <span className="text-[10px] text-slate-500 font-data shrink-0">{f.filing_date}</span>
                </div>
                <p className="text-xs text-slate-200 mt-1.5 leading-snug line-clamp-2">{f.headline}</p>
                <a href={f.source_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-emerald-400 hover:underline mt-1 inline-block">
                  View filing →
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default CorporateEventsPanel;
