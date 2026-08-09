import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Info } from 'lucide-react';
import { cn } from '../lib/utils';

// Scoring is split across several independently-computed systems (see CLAUDE.md
// "Scoring Authority & Signal Model"): unified_recommendations (canonical, blends every
// engine + regime weighting) vs stock_scores / quant_scores / the ad-hoc screener-count
// formula in InvestmentStrategy (all legacy, computed separately, can disagree with the
// canonical view for the same stock). These two components make that distinction visible
// on-screen instead of leaving users to guess which number to trust.

/** Small pill for pages that DO read unified_recommendations -- Alpha, Buy Recs, Command Center. */
export function CanonicalBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
      title="This page reads the unified ranker's canonical cross-source score (unified_recommendations) -- the platform's single most-blended, regime-aware prediction."
    >
      <ShieldCheck size={11} /> Canonical model
    </span>
  );
}

/** Banner for pages that read a legacy/independent scoring table, linking to the canonical page. */
export function LegacyScoreBanner({ note }: { note?: string }) {
  const navigate = useNavigate();
  return (
    <div className={cn(
      'flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200/90'
    )}>
      <Info size={14} className="mt-0.5 shrink-0 text-amber-400" />
      <div className="flex-1 min-w-0">
        <span className="font-semibold text-amber-300">Independent scoring model.</span>{' '}
        {note ?? 'This page ranks stocks with its own methodology, computed separately from the canonical unified model -- scores here can differ from Alpha/Buy Recs for the same stock.'}
      </div>
      <button
        onClick={() => navigate('/alpha')}
        className="shrink-0 px-2 py-1 rounded-md bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-200 font-medium transition-colors"
      >
        View canonical picks →
      </button>
    </div>
  );
}
