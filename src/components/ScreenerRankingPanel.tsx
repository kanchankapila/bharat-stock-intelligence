import React from 'react';
import { trpc } from '../lib/trpc';

export function ScreenerRankingPanel({ timeframe = 'short', runId, screenerId }: { timeframe?: 'intraday'|'short'|'medium'|'long'; runId?: string; screenerId?: string }) {
  const q = trpc.getTimeframeRanking.useQuery({ timeframe, runId, screenerId, limit: 50 });

  if (q.isLoading) return <div className="p-4 text-slate-500 text-sm">Loading rankings…</div>;
  if (q.error) return <div className="p-4 text-rose-400 text-sm">Error: {q.error.message}</div>;

  const rows = q.data || [];
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Top {timeframe} rankings</h3>
        <span className="text-[11px] text-slate-500">{rows.length} symbols</span>
      </div>
      {/* This score is computeTimeframeScores' own ad-hoc weighted blend (momentum 0.4 +
          technical 0.4 + fundamental 0.2), written to timeframe_scores -- not blended into
          unified_recommendations and not backtested. See scoring-authority.md. */}
      <p className="text-[11px] text-amber-400/80">
        Ad-hoc composite score, not the canonical unified model and not backtested for edge --
        see Alpha / Buy Recs for the canonical, regime-aware view.
      </p>
      <div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/50">
        <table className="min-w-full text-xs text-slate-300">
          <thead className="bg-slate-900/80 text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Symbol</th>
              <th className="px-3 py-2 text-right">Score</th>
              <th className="px-3 py-2 text-right">Confidence</th>
              <th className="px-3 py-2 text-left">Domains</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.symbol} className="border-t border-slate-800/50 hover:bg-slate-900/60">
                <td className="px-3 py-2 font-medium text-slate-100">{r.symbol}</td>
                <td className="px-3 py-2 text-right">{(r.score || 0).toFixed(3)}</td>
                <td className="px-3 py-2 text-right">{(r.confidence || 0).toFixed(2)}</td>
                <td className="px-3 py-2 text-left text-[11px] text-slate-400">{r.domains_json ? JSON.stringify(JSON.parse(r.domains_json)) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default ScreenerRankingPanel;
