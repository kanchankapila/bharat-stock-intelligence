import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, ArrowRight } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';
import { cn } from '../../lib/utils';
import { ConvictionPill } from '../../components/StockTagRow';
import { AddToPortfolioButton } from '../../components/AddToPortfolioButton';
import { CanonicalBadge } from '../../components/CanonicalSourceNote';
import { relativeFromNow } from '../../lib/timeFormat';

// Command Center teaser for the canonical unified_recommendations ranking (same query as
// /alpha's CommandCenterDashboard/getBuyRecommendations) -- so a user sees the platform's actual
// highest-conviction picks on the very first screen, not just index/sector/mover context.
export const TopPicksWidget: React.FC<{ onSelectStock?: (symbol: string) => void; userId?: string | null }> = ({ onSelectStock, userId }) => {
  const navigate = useNavigate();
  const { data, isLoading } = trpc.getBuyRecommendations.useQuery(
    { conviction: 'ALL', horizon: 'ALL', limit: 6 },
    { refetchInterval: 5 * 60_000 }
  );
  const picks = data?.picks ?? [];
  // data-honesty-review, 2026-08-14: no as-of indicator anywhere a user could spot a stalled
  // ranker. Backend already returns lastComputedAt (commandCenter.router.ts); just wasn't read.
  const lastComputedAt = data?.lastComputedAt ?? null;

  return (
    <Card
      title="Today's Top Picks"
      icon={Zap}
      onClick={() => navigate('/alpha')}
      action={
        <div className="flex items-center gap-2">
          {lastComputedAt && (
            <span className="text-[10px] text-slate-500" title={`Ranker computed_at: ${lastComputedAt}`}>
              {relativeFromNow(lastComputedAt)}
            </span>
          )}
          <CanonicalBadge />
          <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
        </div>
      }
    >
      {isLoading ? (
        <div className="text-xs text-slate-500 py-6 text-center animate-pulse">Loading canonical picks…</div>
      ) : picks.length === 0 ? (
        <div className="text-xs text-slate-500 py-6 text-center">No ranked picks yet today — run the unified ranker.</div>
      ) : (
        <div className="space-y-1.5">
          {picks.map((p: any) => {
            const winPct = p.win_probability != null ? Math.round(p.win_probability * 100) : null;
            return (
              <div key={p.symbol} className="flex items-center gap-1">
                <button
                  onClick={(e) => { e.stopPropagation(); onSelectStock ? onSelectStock(p.symbol) : navigate('/stock-intelligence-hub'); }}
                  className="flex-1 min-w-0 flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-800/60 transition-colors text-left"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-bold text-slate-100 shrink-0">{p.symbol}</span>
                    <ConvictionPill level={p.conviction_level} />
                    {p.sector && <span className="text-[10px] text-slate-500 truncate">{p.sector}</span>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {p.engine_coverage_count != null && (
                      <span
                        className="text-[10px] text-slate-500"
                        title="How many of the ranker's 8 component engines (screener/ml/confluence/technical/dl/cs/breakout/smart_money) had data for this stock — a better at-a-glance confidence signal than the blended score alone"
                      >
                        {p.engine_coverage_count}/8
                      </span>
                    )}
                    {winPct != null && (
                      <span className={cn('text-[10px] font-semibold', winPct >= 55 ? 'text-emerald-400' : 'text-amber-400')}>{winPct}% win</span>
                    )}
                    <span className="text-xs font-mono font-bold text-slate-300">{Math.round(p.unified_score ?? 0)}</span>
                  </div>
                </button>
                <AddToPortfolioButton symbol={p.symbol} userId={userId} />
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
};

export default TopPicksWidget;
