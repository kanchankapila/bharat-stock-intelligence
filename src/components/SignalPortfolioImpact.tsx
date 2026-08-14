import React from 'react';
import { ShieldAlert, TrendingUp, Minus } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

const RISK_STYLE: Record<string, string> = {
  high: 'text-rose-400 bg-rose-500/10 border-rose-500/20',
  moderate: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  low: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
};

const LEVEL_TEXT: Record<string, string> = {
  high: 'text-emerald-400',
  moderate: 'text-amber-400',
  low: 'text-slate-400',
};

/**
 * Correlates one signal against the logged-in user's real open holdings --
 * getPortfolioSignalAlignment / getSignalCorrelationMetrics (correlationService.ts,
 * signal_portfolio_correlation table). Both procedures existed with zero UI consumers until
 * the 2026-08-14 canonical-read-audit found them; wired in here rather than deleted since
 * they're real, working, actively-computed logic (Pearson correlation against real OHLCV,
 * not a stub). See signals.router.ts's getPortfolioSignalAlignment for a sequencing bug fixed
 * in the same pass -- the alignment score read raced the correlation write on a signal's
 * first-ever lookup, so this component always awaits the alignment query before firing the
 * metrics query, matching the server-side fix rather than assuming it.
 */
export const SignalPortfolioImpact: React.FC<{ signalId: number; signalSymbol: string }> = ({ signalId, signalSymbol }) => {
  const { data: insights, isLoading: loadingPortfolio } = trpc.getPortfolioInsights.useQuery();

  const portfolio = React.useMemo(() => {
    const holdings = insights?.openHoldings ?? [];
    const totalValue = insights?.totals?.currentValue ?? 0;
    return holdings
      .filter((h: any) => h.currentPrice != null && h.symbol !== signalSymbol)
      .map((h: any) => ({
        symbol: h.symbol as string,
        weight: totalValue > 0 ? (h.currentValue ?? 0) / totalValue : 0,
        quantity: h.quantity as number,
        avgCost: h.buyPrice as number,
        currentPrice: h.currentPrice as number,
      }));
  }, [insights, signalSymbol]);

  const alignmentQ = trpc.getPortfolioSignalAlignment.useQuery(
    { signalId, signalSymbol, portfolio },
    { enabled: portfolio.length > 0 },
  );

  // Only fires once the alignment query (which writes signal_portfolio_correlation) has
  // actually resolved -- see the server-side fix this mirrors.
  const metricsQ = trpc.getSignalCorrelationMetrics.useQuery(
    { signalId },
    { enabled: alignmentQ.isSuccess },
  );

  if (loadingPortfolio) {
    return <p className="text-[11px] text-slate-500 py-3 text-center">Loading portfolio…</p>;
  }
  if (portfolio.length === 0) {
    return (
      <p className="text-[11px] text-slate-500 py-3 text-center">
        No open holdings with a resolved live price to correlate against.
      </p>
    );
  }
  if (alignmentQ.isLoading) {
    return (
      <div className="py-6 flex flex-col items-center justify-center gap-2">
        <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-[10px] text-slate-400 uppercase tracking-wider">
          Correlating against {portfolio.length} holding{portfolio.length === 1 ? '' : 's'}…
        </p>
      </div>
    );
  }
  if (alignmentQ.error || !alignmentQ.data) {
    return <p className="text-[11px] text-rose-400 py-3 text-center">Could not compute portfolio alignment.</p>;
  }

  const { alignmentScore, recommendation, concentrationRisk, hedges } = alignmentQ.data;
  const metrics = (metricsQ.data?.metrics ?? []) as Array<Record<string, any>>;
  const stats = metricsQ.data?.stats;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <div className="glass border border-white/[0.08] rounded-xl p-2.5 text-center">
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Alignment</p>
          <p className="text-lg font-black text-slate-100 tabular-nums">{Math.round(alignmentScore)}</p>
          <p className={cn('text-[9px] font-bold uppercase mt-0.5', LEVEL_TEXT[recommendation.alignmentLevel] ?? 'text-slate-400')}>
            {recommendation.alignmentLevel}
          </p>
        </div>
        <div className={cn('rounded-xl p-2.5 text-center border', RISK_STYLE[recommendation.riskLevel] ?? RISK_STYLE.low)}>
          <p className="text-[9px] font-bold uppercase tracking-wider opacity-80">Concentration</p>
          <p className="text-lg font-black tabular-nums">{concentrationRisk}</p>
          <p className="text-[9px] font-bold uppercase mt-0.5">{recommendation.riskLevel} risk</p>
        </div>
        <div className="glass border border-white/[0.08] rounded-xl p-2.5 text-center">
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Hedges</p>
          <p className="text-lg font-black text-slate-100 tabular-nums">{hedges.length}</p>
          <p className="text-[9px] font-bold uppercase mt-0.5 text-slate-400">{recommendation.isHedge ? 'available' : 'none'}</p>
        </div>
      </div>

      {metricsQ.isLoading && (
        <p className="text-[10px] text-slate-500 text-center py-1">Loading per-holding detail…</p>
      )}

      {metrics.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[9px] text-slate-500 uppercase tracking-wider border-b border-white/[0.06]">
                <th className="text-left py-1.5 pr-2">Holding</th>
                <th className="text-right py-1.5 px-2">Weight</th>
                <th className="text-right py-1.5 px-2">Correlation</th>
                <th className="text-right py-1.5 px-2">Co-move</th>
                <th className="text-center py-1.5 pl-2">Flag</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => {
                const corr = (m.correlation_score as number) ?? 0;
                return (
                  <tr key={m.portfolio_symbol} className="border-b border-white/[0.04]">
                    <td className="py-1.5 pr-2 font-semibold text-slate-200">{m.portfolio_symbol}</td>
                    <td className="py-1.5 px-2 text-right text-slate-400 tabular-nums">{((m.weight ?? 0) * 100).toFixed(1)}%</td>
                    <td className={cn('py-1.5 px-2 text-right font-bold tabular-nums', corr > 0.2 ? 'text-emerald-400' : corr < -0.2 ? 'text-rose-400' : 'text-slate-400')}>
                      {corr.toFixed(2)}
                    </td>
                    <td className="py-1.5 px-2 text-right text-slate-400 tabular-nums">{((m.co_movement_pct as number) ?? 0).toFixed(0)}%</td>
                    <td className="py-1.5 pl-2 text-center">
                      {m.hedge_potential ? (
                        <span title="Hedge candidate (negative correlation)"><ShieldAlert className="w-3.5 h-3.5 text-sky-400 inline" /></span>
                      ) : m.momentum_alignment ? (
                        <span title="Momentum-aligned"><TrendingUp className="w-3.5 h-3.5 text-emerald-400 inline" /></span>
                      ) : (
                        <Minus className="w-3 h-3 text-slate-600 inline" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {stats && (
            <p className="text-[10px] text-slate-500 mt-2">
              Avg |correlation| {Math.abs(stats.avgCorrelation).toFixed(2)} across {stats.totalHoldings} holding{stats.totalHoldings === 1 ? '' : 's'} —
              {' '}{stats.positiveCorr} aligned, {stats.negativeCorr} inverse.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default SignalPortfolioImpact;
