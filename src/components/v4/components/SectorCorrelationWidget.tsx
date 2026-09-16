import React from 'react';
import { Network } from 'lucide-react';
import { trpc } from '../../../lib/trpc';
import { Card } from '../../../components/Card';
import { cn } from '../../../lib/utils';

// Sector x sector correlation matrix -- same query as SectorRotationGraph (getSectorRotationIntel,
// React Query dedupes the fetch), surfacing the "diversifier"/"redundant" pairs the third-party
// feed itself tags. Direct answer to "am I actually diversified across these sector bets" --
// unified_ranker's own MAX_SECTOR_EXPOSURE cap is a name-count proxy, this is the real correlation.
export const SectorCorrelationWidget: React.FC = () => {
  const { data, isLoading } = trpc.getSectorRotationIntel.useQuery(undefined, { refetchInterval: 30 * 60_000 });
  const pairs = data?.correlationPairs ?? [];
  const summary = data?.summary;
  const diversifiers = pairs.filter((p: any) => p.pair_type === 'diversifier').slice(0, 4);
  const redundant = pairs.filter((p: any) => p.pair_type === 'redundant').slice(0, 4);

  return (
    <Card title="Sector Correlation" icon={Network}>
      {isLoading ? (
        <div className="text-xs text-slate-500 py-6 text-center animate-pulse">Loading correlation data…</div>
      ) : pairs.length === 0 ? (
        <div className="text-xs text-slate-500 py-6 text-center">No sector correlation data yet.</div>
      ) : (
        <div className="space-y-3">
          {summary?.takeaway && (
            <p className="text-[11px] text-slate-400 leading-relaxed border-b border-slate-800/50 pb-2">{summary.takeaway}</p>
          )}
          {redundant.length > 0 && (
            <div>
              <div className="text-[9px] text-amber-400 uppercase tracking-widest mb-1">Redundant pairs (move together)</div>
              {redundant.map((p: any) => (
                <div key={`${p.sector_a}-${p.sector_b}`} className="flex items-center justify-between text-[11px] py-1">
                  <span className="text-slate-300 truncate">{p.sector_a} ↔ {p.sector_b}</span>
                  <span className="font-mono font-bold text-amber-400 shrink-0">{Number(p.correlation).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
          {diversifiers.length > 0 && (
            <div className={cn(redundant.length > 0 && 'pt-2 border-t border-slate-800/50')}>
              <div className="text-[9px] text-emerald-400 uppercase tracking-widest mb-1">Diversifier pairs (move independently)</div>
              {diversifiers.map((p: any) => (
                <div key={`${p.sector_a}-${p.sector_b}`} className="flex items-center justify-between text-[11px] py-1">
                  <span className="text-slate-300 truncate">{p.sector_a} ↔ {p.sector_b}</span>
                  <span className="font-mono font-bold text-emerald-400 shrink-0">{Number(p.correlation).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
};

export default SectorCorrelationWidget;
