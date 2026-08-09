import React from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { BrainCircuit, ChevronDown, ChevronUp } from 'lucide-react';

const FACTOR_LABELS: Record<string, string> = {
  technical: 'Technical',
  fundamental: 'Fundamental',
  momentum: 'Momentum',
  valuation: 'Valuation',
  delivery: 'Delivery',
  news: 'News Sentiment',
};

const CLASS_COLORS: Record<string, string> = {
  'Strong Buy': 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  'Buy': 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  'Hold': 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  'Sell': 'text-rose-400 bg-rose-500/10 border-rose-500/20',
  'Strong Sell': 'text-rose-400 bg-rose-500/10 border-rose-500/20',
};

interface ReasonItem {
  name: string;
  sentiment?: string;
  source?: string;
  category?: string;
}

/**
 * Per-stock score explanation. Two honestly-distinct sources, not blended into one number:
 *  - "This stock's factors" is real, per-symbol data (stock_scores.reasons + stock_factor_breakdown)
 *    that was already computed but had no UI consumer. Factor values are signed weighted
 *    contributions (not 0-100 scores), and "reasons" are the individual news/screener/technical
 *    items that fed the composite — not a generic bullet list.
 *  - "Model-wide drivers" is the ensemble's global feature_importance_log — the same features
 *    matter for every stock, so it's context, not a per-prediction explanation (no SHAP here).
 */
export const WhyThisPick: React.FC<{ symbol: string; timeframe?: 'long_term' | 'intraday' }> = ({ symbol, timeframe = 'long_term' }) => {
  const [expanded, setExpanded] = React.useState(false);
  const { data, isLoading } = trpc.getStockScoreDetail.useQuery({ symbol, timeframe }, {
    staleTime: 10 * 60 * 1000,
  });
  const { data: globalDrivers } = trpc.getFeatureImportance.useQuery(
    { modelName: 'ensemble', topN: 6 },
    { staleTime: 30 * 60 * 1000, enabled: expanded }
  );

  if (isLoading || !data) return null;

  const { score, factors } = data as any;
  const reasons: ReasonItem[] = Array.isArray(score?.reasons)
    ? score.reasons.filter((r: any) => r && typeof r === 'object' && r.name)
    : [];
  const factorEntries = Object.entries(FACTOR_LABELS)
    .map(([key, label]) => ({ key, label, value: Number(factors?.[key] ?? 0) }))
    .filter(f => factors?.[f.key] !== undefined && factors?.[f.key] !== null);
  const maxAbs = Math.max(1, ...factorEntries.map(f => Math.abs(f.value)));

  if (reasons.length === 0 && factorEntries.length === 0) return null;

  return (
    <div className="bg-terminal-panel border border-terminal-border rounded-2xl overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-slate-900/40 transition-colors"
      >
        <span className="text-xs font-black text-slate-300 uppercase tracking-widest font-mono flex items-center gap-2">
          <BrainCircuit className="w-4 h-4 text-indigo-400" /> Why This Score
          {score?.classification && (
            <span className={cn("text-[9px] px-2 py-0.5 rounded border font-bold normal-case tracking-normal", CLASS_COLORS[score.classification] || "text-slate-400 bg-slate-500/10 border-slate-700")}>
              {score.classification}
            </span>
          )}
        </span>
        {expanded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
      </button>

      {expanded && (
        <div className="px-6 pb-6 space-y-5">
          {factorEntries.length > 0 && (
            <div>
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-2">{symbol}'s Factor Contributions</p>
              <div className="space-y-2">
                {factorEntries.map(f => {
                  const isPos = f.value >= 0;
                  const widthPct = (Math.abs(f.value) / maxAbs) * 50; // half-width max, diverging from center
                  return (
                    <div key={f.key} className="flex items-center gap-3">
                      <span className="text-[10px] text-slate-400 w-28 shrink-0">{f.label}</span>
                      <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden relative">
                        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-slate-700" />
                        <div
                          className={cn("absolute top-0 bottom-0 rounded-full", isPos ? "bg-emerald-500 left-1/2" : "bg-rose-500 right-1/2")}
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                      <span className={cn("text-[10px] font-mono w-14 text-right", isPos ? "text-emerald-400" : "text-rose-400")}>
                        {isPos ? '+' : ''}{f.value.toFixed(1)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {reasons.length > 0 && (
            <div>
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-2">
                Items Feeding This Score
                {(score?.positive_count != null || score?.negative_count != null) && (
                  <span className="normal-case text-slate-600"> — {score.positive_count ?? 0} positive, {score.negative_count ?? 0} negative</span>
                )}
              </p>
              <ul className="space-y-1.5">
                {reasons.slice(0, 8).map((r, i) => {
                  // scoring_engine.py writes two vocabularies into `reasons`: news-derived
                  // entries use positive/negative, screener-derived entries use bullish/bearish.
                  const isUp = r.sentiment === 'positive' || r.sentiment === 'bullish';
                  const isDown = r.sentiment === 'negative' || r.sentiment === 'bearish';
                  return (
                  <li key={i} className="text-[11px] text-slate-300 flex items-start gap-2">
                    <span className={cn("shrink-0 mt-0.5", isUp ? "text-emerald-400" : isDown ? "text-rose-400" : "text-slate-500")}>
                      {isUp ? '▲' : isDown ? '▼' : '•'}
                    </span>
                    <span>
                      {r.name}
                      {r.source && <span className="text-slate-500"> — {r.source}</span>}
                    </span>
                  </li>
                  );
                })}
              </ul>
            </div>
          )}

          {globalDrivers && Array.isArray(globalDrivers) && globalDrivers.length > 0 && (
            <div>
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-2">
                Model-Wide Top Drivers <span className="normal-case text-slate-600">(same for every stock — context, not specific to {symbol})</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {globalDrivers.map((d: any, i: number) => (
                  <span key={i} className="text-[10px] font-mono px-2 py-1 rounded bg-slate-800/60 text-slate-400 border border-slate-800">
                    {d.feature_name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default WhyThisPick;
