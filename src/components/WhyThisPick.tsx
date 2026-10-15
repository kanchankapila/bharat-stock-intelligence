import React from 'react';
import { BrainCircuit, ChevronDown, ChevronUp } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

const ENGINE_LABELS: Record<string, string> = {
  screener_stock_score: 'Screener', ml_score: 'ML', confluence_score: 'Confluence',
  technical_score: 'Technical', dl_score: 'Deep learning', cs_score: 'Cross-sectional',
  breakout_score: 'Breakout', smart_money_score: 'Smart money', fundamental_score: 'Fundamental',
};

const CLASS_COLORS: Record<string, string> = {
  'Strong Buy': 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  Buy: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  Hold: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  Sell: 'text-rose-400 bg-rose-500/10 border-rose-500/20',
  'Strong Sell': 'text-rose-400 bg-rose-500/10 border-rose-500/20',
};

/** Explain the same canonical unified_recommendations row shown by the stock page. */
export const WhyThisPick: React.FC<{ symbol: string; timeframe?: 'long_term' | 'intraday' }> = ({ symbol }) => {
  const [expanded, setExpanded] = React.useState(false);
  const { data, isLoading, isError } = trpc.getUnifiedScoreForSymbol.useQuery(
    { symbol }, { staleTime: 10 * 60 * 1000 },
  );
  if (isLoading) return null;
  if (isError) return <div className="rounded-xl border border-rose-500/30 p-3 text-xs text-rose-400" role="alert">Could not load the canonical score explanation.</div>;
  if (!data) return null;

  const score = data as Record<string, any>;
  const engines = Object.entries(ENGINE_LABELS)
    .filter(([key]) => score[key] != null)
    .map(([key, label]) => ({ key, label, value: Number(score[key]) }))
    .filter((engine) => Number.isFinite(engine.value));
  if (!score.trade_reasoning && engines.length === 0) return null;

  return (
    <div className="bg-terminal-panel border border-terminal-border rounded-2xl overflow-hidden">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="w-full flex items-center justify-between px-6 py-4 hover:bg-slate-900/40 transition-colors">
        <span className="text-xs font-black text-slate-300 font-display uppercase tracking-widest font-data flex items-center gap-2">
          <BrainCircuit className="w-4 h-4 text-indigo-400" /> Why This Unified Score
          {score.classification && <span className={cn('text-[9px] px-2 py-0.5 rounded border font-bold normal-case tracking-normal', CLASS_COLORS[score.classification] || 'text-slate-400 bg-slate-500/10 border-slate-700')}>{score.classification}</span>}
        </span>
        {expanded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
      </button>

      {expanded && <div className="px-6 pb-6 space-y-5">
        <p className="text-[10px] text-slate-500">Canonical ranking snapshot {score.computed_at ?? 'time unavailable'} · score {score.unified_score ?? 'n/a'} is a rank, not a probability.</p>
        {score.trade_reasoning && <div>
          <p className="text-[9px] font-bold text-slate-500 font-display uppercase tracking-wider mb-2">Ranker reasoning</p>
          <p className="text-[11px] leading-relaxed text-slate-300">{score.trade_reasoning}</p>
        </div>}
        {engines.length > 0 && <div>
          <p className="text-[9px] font-bold text-slate-500 font-display uppercase tracking-wider mb-2">Available engine scores{score.engine_coverage_count != null && <span className="normal-case text-slate-600"> · {score.engine_coverage_count} active engines contributed</span>}</p>
          <div className="space-y-2">{engines.map((engine) => <div key={engine.key} className="flex items-center gap-3">
            <span className="text-[10px] text-slate-400 w-28 shrink-0">{engine.label}</span>
            <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.max(0, Math.min(100, engine.value))}%` }} /></div>
            <span className="text-[10px] font-data w-10 text-right text-slate-300">{engine.value.toFixed(1)}</span>
          </div>)}</div>
        </div>}
      </div>}
    </div>
  );
};

export default WhyThisPick;
