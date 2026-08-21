import React from 'react';
import { RefreshCw, ShieldCheck, Info, TrendingDown, Clock } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

// This page shows the ONE setup on this platform with a validated, cost-aware, positive
// forward edge -- see .claude/rules/measurement.md's "capitulation triple" entry: gapped down
// AND opened at the day's low AND already among the day's biggest losers -> a next-session
// open->close bounce. Re-confirmed 2026-08-20 (t=+3.48, p=0.0005, 430 days, 5/6 years positive).
//
// Deliberately NOT another "top picks" list: unified_score/AlphaQuant/screener consensus/every
// classic factor tested on this platform have been measured null-to-negative net of costs (see
// measurement.md). Rather than add a 2nd/3rd/Nth score to the pile the user is already confused
// by, this page shows the ONE thing that has cleared that bar, with the actual backtest numbers
// next to it instead of a badge -- and says so plainly when nothing is currently matching,
// since this setup fires on roughly one stock a day, not every cycle.

interface Combo {
  filters: string[];
  n_days: number;
  n_signals: number;
  spread_pct: number;
  t_stat: number;
  p_value: number;
}

interface Evidence {
  as_of: string;
  n_days_history: number;
  cost_pct_used: number;
  best: Combo;
  is_edge: boolean;
}

interface Match {
  symbol: string;
  price: number;
  change_per: number;
  volume: number;
}

function fmtPrice(n: number) {
  return n > 0 ? `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—';
}

function daysStale(asOf: string): number {
  return Math.floor((Date.now() - new Date(asOf).getTime()) / 86_400_000);
}

function EvidenceCard({ evidence }: { evidence: Evidence | null }) {
  if (!evidence) {
    return (
      <div className="v1-card p-5 flex items-start gap-3">
        <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <p className="text-xs text-slate-400">
          Backtest evidence not yet computed on this environment. Run{' '}
          <code className="text-[10px] bg-slate-800/60 px-1.5 py-0.5 rounded">
            python screener_combo_finder.py --tier1 --persist
          </code>{' '}
          to populate it.
        </p>
      </div>
    );
  }

  const { best } = evidence;
  const stale = daysStale(evidence.as_of);

  return (
    <div className="v1-card p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-2.5">
          <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <h2 className="v1-title-card">Validated Edge</h2>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Setup: <code className="text-[10px] bg-slate-800/60 px-1.5 py-0.5 rounded text-indigo-300">
                {best.filters.join(' + ')}
              </code>{' '}
              — gapped down, opened at the day's low, already among today's biggest losers.
              Buy next session's open, exit next session's close.
            </p>
          </div>
        </div>
        <span className="text-[10px] text-slate-500 whitespace-nowrap flex items-center gap-1">
          <Clock className="w-3 h-3" />
          Computed {evidence.as_of}{stale > 30 ? ` (${stale}d ago — may be stale)` : ''}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-slate-900/40 rounded-xl p-4">
        <div className="text-center">
          <div className="text-sm font-black text-emerald-400">+{best.spread_pct.toFixed(2)}%</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mt-0.5">Net spread/day</div>
        </div>
        <div className="text-center">
          <div className="text-sm font-black text-white">{best.t_stat.toFixed(2)}</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mt-0.5">t-stat</div>
        </div>
        <div className="text-center">
          <div className="text-sm font-black text-white">{best.n_days}</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mt-0.5">Days tested</div>
        </div>
        <div className="text-center">
          <div className="text-sm font-black text-white">{best.n_signals}</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mt-0.5">Signal-days</div>
        </div>
      </div>

      <div className="text-[10px] text-slate-500 border-t border-slate-800/50 pt-3 leading-relaxed">
        Net of {evidence.cost_pct_used}% round-trip cost, over {evidence.n_days_history} days of history.
        Capacity is genuinely small — median ~₹0.5cr deployable per signal, usually one qualifying
        stock a day. This is not a scalable "top picks" list; it's a narrow, real edge. Every other
        score on this platform (unified/Alpha, AlphaQuant, screener consensus) has been measured
        null-to-negative net of costs — see <code className="bg-slate-800/60 px-1 rounded">measurement.md</code>.
      </div>
    </div>
  );
}

function MatchCard({ m, onSelectStock }: { m: Match; onSelectStock?: (s: string) => void }) {
  return (
    <div className="v1-card-down p-4 cursor-pointer" onClick={() => onSelectStock?.(m.symbol)}>
      <div className="flex justify-between items-start">
        <div>
          <h3 className="font-display text-lg font-bold text-white tracking-wide">{m.symbol}</h3>
          <div className="flex items-center gap-1 font-data text-[11px] mt-1 font-bold text-rose-400">
            <TrendingDown className="w-3 h-3" />
            {m.change_per.toFixed(2)}%
          </div>
        </div>
        <div className="text-right">
          <div className="font-data text-lg font-bold text-slate-100">{fmtPrice(m.price)}</div>
          <div className="font-data text-[9px] text-slate-500 mt-1 uppercase">Vol: {m.volume?.toLocaleString('en-IN')}</div>
        </div>
      </div>
      <div className="text-[10px] text-slate-500 border-t border-slate-800/50 pt-3 mt-3">
        Capitulation match — consider at tomorrow's open, per the validated setup above.
      </div>
    </div>
  );
}

export function HighConvictionPage({
  onSelectStock,
}: {
  onSelectStock?: (s: string) => void;
}) {
  const { data, isLoading, refetch, isRefetching } = trpc.getCapitulationSignal.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  const matches: Match[] = data?.matches ?? [];
  const evidence: Evidence | null = data?.evidence ?? null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="v1-title-page">Highest-Conviction Signal</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            The one setup on this platform with a measured, cost-aware edge — not another score to guess between.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data?.asOf && (
            <span className="text-[10px] text-slate-500">
              Scan as of {new Date(data.asOf).toLocaleTimeString('en-IN')}
            </span>
          )}
          <button
            onClick={() => refetch()}
            disabled={isRefetching || isLoading}
            className="p-2 glass-strong border border-slate-800/50 rounded-xl text-slate-400 hover:text-white transition-all disabled:opacity-50"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', (isRefetching || isLoading) && 'animate-spin')} />
          </button>
        </div>
      </div>

      <EvidenceCard evidence={evidence} />

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="glass border border-slate-800/50 rounded-2xl p-5 h-32 animate-pulse" />
          ))}
        </div>
      ) : matches.length === 0 ? (
        <div className="v1-card p-8 text-center">
          <p className="text-sm text-slate-400">No capitulation match this scan cycle.</p>
          <p className="text-xs text-slate-600 mt-1.5">
            Expected most of the time — this setup fires on roughly one stock a day on average.
            The live scan refreshes every 15 minutes during market hours.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {matches.map(m => <MatchCard key={m.symbol} m={m} onSelectStock={onSelectStock} />)}
        </div>
      )}
    </div>
  );
}
