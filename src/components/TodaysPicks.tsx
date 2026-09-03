import React from 'react';
import { TrendingUp, TrendingDown, AlertCircle, Target, ShieldAlert, Zap } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { LegacyScoreBanner } from './CanonicalSourceNote';
import { relativeFromNow, formatISTWithLocal } from '../lib/timeFormat';

interface TodaysPicksProps {
  onSelectStock?: (symbol: string) => void;
}

// ponytail: card = the matching v1-card-{up,down,neutral} variant, same colors these tiers
// already used (emerald/amber/rose), so conviction stays visible while the card shape matches
// the rest of v1.
// ponytail: badge = v1-badge-{s,b,c} where a matching tier exists (colors chosen to match, not
// rank -- v1-badge has no "down"/rose slot, so WEAK keeps its own rose badge, same rounded-full
// shape as the rest via the shared v1-badge base class).
const CONVICTION_CONFIG = {
  ELITE:    { label: 'ELITE',    card: 'v1-card-up',      badge: 'v1-badge v1-badge-s',                    text: 'text-emerald-400', dot: 'bg-emerald-400' },
  STRONG:   { label: 'STRONG',   card: 'v1-card-neutral', badge: 'v1-badge v1-badge-b',                    text: 'text-amber-400',   dot: 'bg-amber-400'   },
  MODERATE: { label: 'MODERATE', card: 'v1-card',         badge: 'v1-badge v1-badge-c',                    text: 'text-slate-400',   dot: 'bg-slate-400'   },
  WEAK:     { label: 'WEAK',     card: 'v1-card-down',    badge: 'v1-badge bg-rose-500/10 border-rose-500/30 text-rose-400', text: 'text-rose-400', dot: 'bg-rose-400' },
} as const;

function conviction(level: string | null | undefined) {
  const k = (level ?? 'MODERATE').toUpperCase() as keyof typeof CONVICTION_CONFIG;
  return CONVICTION_CONFIG[k] ?? CONVICTION_CONFIG.MODERATE;
}

export function TodaysPicks({ onSelectStock }: TodaysPicksProps) {
  const today = new Date().toISOString().slice(0, 10);

  const { data, isLoading, error, refetch } = trpc.getTechnicalConfluenceSignals.useQuery(
    { date: today, minUnified: 0.55, minConfluence: 40, limit: 20 },
    { refetchInterval: 5 * 60 * 1000 }
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400 text-sm">
        Scanning signals…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertCircle className="w-8 h-8 text-rose-500" />
        <p className="text-slate-400 text-sm">{error.message}</p>
        <button onClick={() => refetch()} className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300">
          Retry
        </button>
      </div>
    );
  }

  const picks = (data ?? []) as any[];

  // AF-20260827-08: the header previously showed only a client-side `new Date()` — identical
  // whether the underlying job ran seconds ago or has silently stopped for days. Derive an
  // as-of stamp from the rows' own `computed_at` instead.
  const latestComputedAt = picks.reduce<number | null>((max, p) => {
    const t = p?.computed_at ? new Date(p.computed_at).getTime() : NaN;
    return Number.isFinite(t) && (max === null || t > max) ? t : max;
  }, null);

  return (
    <div className="p-6 space-y-4">
      <LegacyScoreBanner note="Computes its own ad-hoc blend (0.4x signal score + 0.4x win probability + 0.2x confluence), unrelated to unified_recommendations -- despite this page's name, it does not read the canonical unified_score. Check Alpha / Buy Recs for the canonical, regime-aware view." />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="v1-title-page flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" />
            Today's Picks
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Multi-engine conviction — signal score + ML win probability + confluence
          </p>
        </div>
        <span
          className="text-xs text-slate-500 bg-slate-800 px-3 py-1 rounded-full"
          title={latestComputedAt ? formatISTWithLocal(latestComputedAt) : undefined}
        >
          {picks.length} picks · {latestComputedAt ? `as of ${relativeFromNow(latestComputedAt)}` : today}
        </span>
      </div>

      {picks.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 gap-3 text-slate-500">
          <AlertCircle className="w-8 h-8" />
          <p className="text-sm">No high-conviction picks for today</p>
          <p className="text-xs">Criteria: composite score ≥ 0.55 AND confluence ≥ 40</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {picks.map((pick) => {
            const cv = conviction(pick.conviction_level);
            const unifiedPct = Math.round((pick.confluence_composite_score ?? 0) * 100);
            const winPct = pick.win_probability != null ? Math.round(pick.win_probability * 100) : null;
            const targets = (() => {
              try {
                const t = typeof pick.targets === 'string' ? JSON.parse(pick.targets) : pick.targets;
                return Array.isArray(t) ? t.slice(0, 2) : [];
              } catch { return []; }
            })();

            return (
              <div
                key={pick.symbol}
                onClick={() => onSelectStock?.(pick.symbol)}
                className={cn(cv.card, 'p-4 space-y-3 cursor-pointer hover:scale-[1.01]')}
              >
                {/* Header */}
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white text-sm">{pick.symbol}</span>
                      <span className={cn('text-[10px]', cv.badge)}>
                        {cv.label}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5 truncate max-w-[160px]">{pick.name}</p>
                    {pick.sector && (
                      <p className="text-[10px] text-slate-500">{pick.sector}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-white font-semibold text-sm">₹{pick.cmp?.toLocaleString('en-IN') ?? '—'}</p>
                    <p className="text-[10px] text-slate-500">{pick.nifty_regime ?? '—'}</p>
                  </div>
                </div>

                {/* Score bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] text-slate-400">
                    <span className="flex items-center gap-1">
                      Unified Score
                      {pick.confluence_composite_partial && (
                        <span
                          className="text-slate-600"
                          title="ML win-probability and/or confluence score were unavailable for this stock -- this score partly used a neutral default, not a real input"
                        >
                          *
                        </span>
                      )}
                    </span>
                    <span className={cv.text}>{unifiedPct}%</span>
                  </div>
                  <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={cn('h-full rounded-full', cv.dot)}
                      style={{ width: `${Math.min(unifiedPct, 100)}%` }}
                    />
                  </div>
                </div>

                {/* Metrics row */}
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-[10px] text-slate-500">Signal</p>
                    <p className="text-xs font-semibold text-white">{pick.signal_score ?? '—'}/10</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-500">ML Win%</p>
                    <p className={cn('text-xs font-semibold', winPct != null && winPct >= 60 ? 'text-emerald-400' : 'text-slate-300')}>
                      {winPct != null ? `${winPct}%` : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-500">Confluence</p>
                    <p className="text-xs font-semibold text-white">{pick.confluence_score ?? '—'}</p>
                  </div>
                </div>

                {/* Stop loss / targets */}
                {(pick.stop_loss || targets.length > 0) && (
                  <div className="flex items-center gap-3 text-[10px]">
                    {pick.stop_loss != null && Number.isFinite(Number(pick.stop_loss)) && (
                      <span className="flex items-center gap-1 text-rose-400">
                        <ShieldAlert className="w-3 h-3" />
                        SL ₹{Number(pick.stop_loss).toLocaleString('en-IN')}
                      </span>
                    )}
                    {targets.map((t: number, i: number) => (
                      <span key={i} className="flex items-center gap-1 text-emerald-400">
                        <Target className="w-3 h-3" />
                        T{i + 1} ₹{Number(t).toLocaleString('en-IN')}
                      </span>
                    ))}
                  </div>
                )}

                {/* AI insight */}
                {pick.ai_insight && (
                  <p className="text-[10px] text-slate-400 italic line-clamp-2">{pick.ai_insight}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default TodaysPicks;
