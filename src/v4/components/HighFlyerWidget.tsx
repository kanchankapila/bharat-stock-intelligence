import React from 'react';
import { Flame, Target } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';

// "What made yesterday's big movers fly, and who looks similar today" — surfaces
// high_flyer_retrospective.py's recall report + learned precursor watchlist, which had no UI.
export const HighFlyerWidget: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const { data, isLoading } = trpc.getHighFlyerReport.useQuery();
  const flyers: any[] = data?.flyers ?? [];
  const candidates: any[] = data?.candidates ?? [];
  const recall = data?.recall as { hit?: number; total?: number } | undefined;

  if (isLoading) return <Card title="High-Flyer Retrospective" icon={Flame}><div className="text-xs text-slate-500">Loading…</div></Card>;
  if (!data?.date) return null;

  return (
    <Card title="High-Flyer Retrospective" icon={Flame}>
      <div className="text-[10px] text-slate-500 mb-2">
        {data.date}: {data.flyerN} of {data.universeN} stocks flew
        {recall?.total ? ` · model predicted ${recall.hit ?? 0}/${recall.total}` : ''}
      </div>
      {flyers.length > 0 && (
        <div className="space-y-1 mb-3">
          {flyers.slice(0, 5).map((f: any) => (
            <button
              key={f.symbol}
              onClick={() => onSelectStock?.(f.symbol)}
              className="w-full flex items-center justify-between text-[11px] text-slate-300 hover:text-white"
            >
              <span className="font-bold">{f.symbol}</span>
              <span className="text-emerald-400 font-mono">+{Number(f.return_pct).toFixed(1)}% · {Number(f.volume_ratio).toFixed(1)}x vol</span>
            </button>
          ))}
        </div>
      )}
      {candidates.length > 0 && (
        <div className="pt-2 border-t border-slate-800/60">
          <div className="flex items-center gap-1.5 text-[9px] text-slate-500 uppercase tracking-widest mb-1.5">
            <Target className="w-3 h-3" /> Today's Candidates
          </div>
          {/* Measured IC -0.041 (t=-9.02, recurring-bugs.md) despite AUC 0.81 -- the classifier
              identifies who resembles a past flyer, not that today is the day. Never treat this
              list as a trading signal (AF-20260818-36). */}
          <div className="text-[9px] text-slate-600 mb-1.5">Similarity match, not a timing signal — measured IC is negative</div>
          <div className="flex flex-wrap gap-1.5">
            {candidates.slice(0, 8).map((c: any) => (
              <button
                key={c.symbol}
                onClick={() => onSelectStock?.(c.symbol)}
                className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20"
              >
                {c.symbol} · {Math.round(c.score)}
              </button>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
};

export default HighFlyerWidget;
