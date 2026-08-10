import React from 'react';
import { Microscope } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';

// Reports screener_combo_finder.py's reverse-engineered screener-combination result: which
// precursor screens (gap up/down, open=high/low, top gainers/losers, live/EOD screener
// membership) best predict a stock making a big move the NEXT session. Research status,
// same discipline as ModelBacktestStatusCard -- Tier 1 has real multi-year statistical
// power; Tier 2 is explicitly low-data and rendered with a visibly different, muted
// treatment so it can never be mistaken for an equally-reliable finding.
export const ScreenerComboFinderCard: React.FC = () => {
  const tier1 = trpc.getScreenerComboFinderStatus.useQuery({ tier: 1 });
  const tier2 = trpc.getScreenerComboFinderStatus.useQuery({ tier: 2 });

  if (tier1.isLoading) return <Card title="Screener Combination Finder" icon={Microscope}><div className="text-xs text-slate-500">Loading…</div></Card>;
  if (!tier1.data) return null;

  const best = tier1.data.best;
  const t2best = tier2.data?.best;

  return (
    <Card title="Screener Combination Finder" icon={Microscope}>
      <div className="text-[10px] text-slate-500 mb-2">
        As of {tier1.data.as_of} · {tier1.data.n_days_history} trading days · next-session open→close, {tier1.data.cost_pct_used}% cost
      </div>

      <div className="mb-3">
        <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">Tier 1 — validated (deep history)</div>
        {best ? (
          <>
            <div className={`text-xs font-bold mb-1 ${tier1.data.is_edge ? 'text-emerald-400' : 'text-amber-400'}`}>
              {tier1.data.is_edge ? 'REAL EDGE' : 'NO PROVEN EDGE'}
            </div>
            <div className="text-[11px] text-slate-400 leading-relaxed">
              Best combination: <span className="text-slate-200 font-mono">{best.filters.join(' + ')}</span>
              {' '}— {best.spread_pct.toFixed(3)}% spread vs. universe (t={best.t_stat.toFixed(2)}, p={best.p_value.toFixed(4)}),
              {' '}{best.n_signals} signals across {best.n_days} days.
            </div>
          </>
        ) : (
          <div className="text-[11px] text-slate-500">No combination cleared the minimum sample thresholds.</div>
        )}
      </div>

      {tier2.data && (
        <div className="pt-2 border-t border-slate-800/60 opacity-70">
          <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">Tier 2 — LOW-DATA, directional only</div>
          <div className="text-[10px] text-slate-500 italic">
            {tier2.data.n_days_history} days of live/EOD screener history — not enough to trust a significance
            test either way.
            {t2best && ` Best so far: ${t2best.filters.join(' + ')} (p=${t2best.p_value.toFixed(3)}, not significant).`}
          </div>
        </div>
      )}
    </Card>
  );
};