import React from 'react';
import { FlaskConical } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';

// Research-status card, NOT a recommendation surface. Renders the go/no-go return-alpha
// backtest result for a forward-return classifier (flyer_classifier.py /
// breakout_classifier.py) -- a good purged-CV AUC is classification skill, not proof of
// tradeable edge, and this platform has already found that gap matters in practice (see
// scripts/{flyer,breakout}_return_alpha_backtest.py). Keeps the finding visible instead of
// it silently disappearing after the session that found it. Must never be styled or worded
// like a trading signal, whatever is_edge says.
export const ModelBacktestStatusCard: React.FC<{
  modelKey: 'flyer_classifier' | 'breakout_classifier';
  title: string;
}> = ({ modelKey, title }) => {
  const { data, isLoading } = trpc.getModelBacktestStatus.useQuery({ modelKey });

  if (isLoading) return <Card title={title} icon={FlaskConical}><div className="text-xs text-slate-500">Loading…</div></Card>;
  if (!data) return null;

  return (
    <Card title={title} icon={FlaskConical}>
      <div className="text-[10px] text-slate-500 mb-2">
        As of {data.as_of} · purged-CV held-out AUC {(data.test_auc * 100).toFixed(1)}% · horizon {data.horizon_label}
      </div>
      <div className={`text-xs font-bold mb-2 ${data.is_edge ? 'text-emerald-400' : 'text-amber-400'}`}>
        {data.is_edge ? 'REAL EDGE' : 'NO PROVEN RETURN EDGE'}
      </div>
      <div className="text-[11px] text-slate-400 leading-relaxed">
        Top-{data.top_n} basket by predicted probability, realistic entry, vs. the
        equal-weight tradeable universe: {data.spread_pct.toFixed(3)}% spread
        (t={data.spread_t_stat.toFixed(2)}, p={data.spread_p_value.toFixed(4)}) at
        {' '}{data.cost_pct_used}% round-trip cost, across {data.n_backtest_signals} out-of-sample dates.
      </div>
      {!data.is_edge && (
        <div className="mt-2 text-[10px] text-slate-500 italic">
          The model correctly ranks which stocks are likely to move, but that move is not
          reliably captured by acting on the signal — not a trading recommendation.
        </div>
      )}
      {data.note && <div className="mt-1 text-[10px] text-slate-600 italic">{data.note}</div>}
    </Card>
  );
};