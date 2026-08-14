import React, { useState } from 'react';
import { Zap } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

const DAY_OPTIONS = [1, 3, 7, 14, 30] as const;

function fmtPrice(n: number | null | undefined) {
  return n == null || !Number.isFinite(n) ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

/**
 * screener_signal_generator.py's SCREENER_SURFACING entries in unified_signals -- a stock
 * newly crossing a screener-momentum threshold (screener_bull_count > screener_bear_count,
 * screener_momentum_score above a floor), distinct from the leaderboard's per-screener
 * reliability stats above. getScreenerSurfacingSignals had zero UI consumers until the
 * 2026-08-14 canonical-read-audit; wired in here since screener_signal_generator.py genuinely
 * writes this data nightly -- it just had nowhere to be seen. Not the canonical
 * unified_recommendations ranking -- see CanonicalSourceNote for that distinction.
 */
export const ScreenerSurfacingSignalsPanel: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const [days, setDays] = useState<typeof DAY_OPTIONS[number]>(7);
  const { data, isLoading } = trpc.getScreenerSurfacingSignals.useQuery(
    { days, limit: 100 },
    { refetchInterval: 5 * 60_000 },
  );
  const rows = (data ?? []) as any[];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-2 border-b border-slate-800/40 flex-shrink-0">
        <span className="text-[10px] text-slate-500">Last:</span>
        {DAY_OPTIONS.map(d => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={cn(
              'text-[10px] px-2 py-0.5 rounded-full transition-colors',
              days === d ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200',
            )}
          >{d}d</button>
        ))}
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} signal{rows.length === 1 ? '' : 's'}</span>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-slate-500 text-sm">Loading surfacing signals…</div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-slate-500 text-sm">
            <Zap className="w-6 h-6 text-slate-700" />
            No screener-surfacing signals in this window.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-900/95 backdrop-blur z-10">
              <tr className="text-[10px] text-slate-500 border-b border-slate-800/50">
                <th className="px-3 py-2 text-left">Symbol</th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-right">Confidence</th>
                <th className="px-3 py-2 text-right">Entry</th>
                <th className="px-3 py-2 text-right">Target</th>
                <th className="px-3 py-2 text-right">Stop</th>
                <th className="px-3 py-2 text-right">Momentum</th>
                <th className="px-3 py-2 text-right">Tier-1</th>
                <th className="px-3 py-2 text-left">Reasoning</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {rows.map((r, i) => (
                <tr
                  key={`${r.symbol}-${r.signal_date}-${i}`}
                  className={cn('hover:bg-slate-800/30', onSelectStock && 'cursor-pointer')}
                  onClick={() => onSelectStock?.(r.symbol)}
                >
                  <td className="px-3 py-2 font-semibold text-slate-100">{r.symbol}</td>
                  <td className="px-3 py-2 text-slate-400">{fmtDate(r.signal_date)}</td>
                  <td className="px-3 py-2 text-slate-400">{String(r.signal_type ?? '—').replace(/_/g, ' ')}</td>
                  <td className="px-3 py-2 text-right text-slate-300 tabular-nums">
                    {r.confidence_score != null ? `${Math.round(r.confidence_score * 100)}%` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300 tabular-nums">{fmtPrice(r.entry_price)}</td>
                  <td className="px-3 py-2 text-right text-emerald-400 tabular-nums">{fmtPrice(r.target_price)}</td>
                  <td className="px-3 py-2 text-right text-rose-400 tabular-nums">{fmtPrice(r.stop_loss)}</td>
                  <td className="px-3 py-2 text-right text-slate-300 tabular-nums">{r.screener_momentum_score ?? '—'}</td>
                  <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{r.screener_tier1_count ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-500 max-w-xs truncate" title={r.reasoning ?? undefined}>{r.reasoning ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default ScreenerSurfacingSignalsPanel;
