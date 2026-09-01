import React from 'react';
import { Compass } from 'lucide-react';
import { trpc } from '../../../lib/trpc';
import { Card } from '../../../components/Card';
import { cn } from '../../../lib/utils';

// Relative Rotation Graph (Leading/Improving/Weakening/Lagging) -- sourced from
// investsights_sector_intel_fetcher.py (sector_rrg_history), had zero frontend surface until
// this widget (2026-08-09). Answers "which sectors to rotate into/out of", a question no other
// panel in this app answers -- SectorHeatmap shows today's move, this shows the trend regime.
const QUADRANT_STYLE: Record<string, { color: string; bg: string; hint: string }> = {
  Leading:   { color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', hint: 'Strong & improving' },
  Improving: { color: 'text-sky-400',     bg: 'bg-sky-500/10 border-sky-500/20',         hint: 'Weak but improving' },
  Weakening: { color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20',     hint: 'Strong but fading' },
  Lagging:   { color: 'text-rose-400',    bg: 'bg-rose-500/10 border-rose-500/20',       hint: 'Weak & fading' },
};

export const SectorRotationGraph: React.FC = () => {
  const { data, isLoading } = trpc.getSectorRotationIntel.useQuery(undefined, { refetchInterval: 30 * 60_000 });
  const rrg = data?.rrg ?? [];

  return (
    <Card title="Sector Rotation Graph" icon={Compass}>
      {isLoading ? (
        <div className="text-xs text-slate-500 py-6 text-center animate-pulse">Loading rotation data…</div>
      ) : rrg.length === 0 ? (
        <div className="text-xs text-slate-500 py-6 text-center">No sector rotation data yet.</div>
      ) : (
        <div className="space-y-1.5">
          {rrg.map((r: any) => {
            const style = QUADRANT_STYLE[r.quadrant] ?? { color: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/20', hint: 'Unclassified' };
            return (
              <div key={r.sector} className={cn('flex items-center justify-between gap-2 px-3 py-2 rounded-xl border', style.bg)}>
                <div className="min-w-0">
                  <div className="text-xs font-bold text-slate-100 truncate">{r.sector}</div>
                  <div className={cn('text-[9px] uppercase tracking-widest', style.color)}>{r.quadrant ?? 'Unclassified'} · {style.hint}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className={cn('text-xs font-mono font-bold', r.sector_return == null ? 'text-slate-400' : r.sector_return >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                    {r.sector_return == null ? '—' : `${r.sector_return >= 0 ? '+' : ''}${Number(r.sector_return).toFixed(2)}%`}
                  </div>
                  <div className="text-[9px] text-slate-500">RS {r.rs_ratio == null ? '—' : Number(r.rs_ratio).toFixed(1)} / Mom {r.rs_momentum == null ? '—' : Number(r.rs_momentum).toFixed(1)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
};

export default SectorRotationGraph;
