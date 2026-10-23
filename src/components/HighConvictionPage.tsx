import React from 'react';
import {
  AlertTriangle, ArrowRight, BarChart3, CheckCircle2, Clock, FlaskConical,
  RefreshCw, ShieldCheck, Target, TrendingDown,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

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

interface CanonicalPick {
  symbol: string;
  unified_score?: number | null;
  classification?: string | null;
  timeframe?: string | null;
  sector?: string | null;
  livePrice?: number | null;
  changePercent?: number | null;
  entry_zone_low?: number | null;
  entry_zone_high?: number | null;
  target_1?: number | null;
  stop_loss?: number | null;
  valid_until?: string | null;
  planStatus?: string | null;
  trade_reasoning?: string | null;
  engine_coverage_count?: number | null;
  days_to_next_results?: number | null;
}

const money = (value?: number | null) => value == null || !Number.isFinite(value)
  ? '—'
  : `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const signedPct = (value?: number | null) => value == null || !Number.isFinite(value)
  ? '—'
  : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

const shortDate = (value?: string | null) => value
  ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  : '—';

function ageInDays(value: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
}

function readableReasoning(value?: string | null) {
  if (!value) return 'Ranked by the canonical cross-engine model; detailed rationale is unavailable.';
  if (!value.trim().startsWith('[')) return value;
  try {
    const rows = JSON.parse(value) as Array<{ name?: string; sentiment?: string }>;
    const insights = rows
      .filter((row) => row?.name)
      .slice(0, 3)
      .map((row) => `${row.name}${row.sentiment ? ` (${row.sentiment})` : ''}`);
    return insights.length > 0 ? insights.join(' · ') : 'Structured rationale is available in the stock detail view.';
  } catch {
    return 'Structured rationale could not be summarised; open the stock detail view for source-level evidence.';
  }
}

function EvidenceCard({ evidence }: { evidence: Evidence | null }) {
  if (!evidence) {
    return (
      <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.05] p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <div>
            <p className="text-sm font-semibold text-amber-100">Evidence record unavailable</p>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              This page will not label a live match validated until its persisted cost-aware backtest is available.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const staleDays = ageInDays(evidence.as_of);
  const { best } = evidence;
  const metrics = [
    ['Net spread', `+${best.spread_pct.toFixed(2)}%`, `net after ${evidence.cost_pct_used}% cost`],
    ['Strength', best.t_stat.toFixed(2), `t-stat · p=${best.p_value.toFixed(4)}`],
    ['Signal-days', best.n_signals.toLocaleString('en-IN'), 'observations'],
    ['Test days', best.n_days.toLocaleString('en-IN'), `${evidence.n_days_history} days of history`],
    ['Capacity', 'Small', 'usually ≈1 match/day'],
  ];

  return (
    <article className="relative overflow-hidden rounded-2xl border border-emerald-400/20 bg-[linear-gradient(135deg,rgba(6,78,59,0.30),rgba(2,6,23,0.92)_58%)] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.24)]">
      <div className="absolute -right-16 -top-20 h-52 w-52 rounded-full border border-emerald-300/10 bg-emerald-300/[0.04]" />
      <div className="relative">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-xl border border-emerald-300/20 bg-emerald-300/10 p-2.5">
              <ShieldCheck className="h-5 w-5 text-emerald-300" />
            </div>
            <div>
              <div className="text-[10px] font-black uppercase tracking-[0.24em] text-emerald-300">Validated trade setup</div>
              <h2 className="mt-1 text-lg font-semibold text-white">Capitulation rebound</h2>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-300">
                Gap down + open at the day’s low + top loser. Enter at the next session’s open and exit at that session’s close.
              </p>
            </div>
          </div>
          <div className="text-right text-[10px] text-slate-400">
            <div>Evidence as of {shortDate(evidence.as_of)}</div>
            {staleDays > 30 && <div className="mt-1 text-amber-300">Historical evidence is {staleDays} days old</div>}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 lg:grid-cols-5">
          {metrics.map(([label, value, detail]) => (
            <div key={label} className="bg-slate-950/65 px-3 py-3.5">
              <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">{label}</div>
              <div className="mt-1 text-base font-black tabular-nums text-white">{value}</div>
              <div className="mt-0.5 text-[10px] text-slate-500">{detail}</div>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function ValidatedMatchCard({ match, onSelectStock }: { match: Match; onSelectStock?: (symbol: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelectStock?.(match.symbol)}
      className="group w-full rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.06] p-4 text-left transition hover:-translate-y-0.5 hover:border-emerald-300/50 hover:bg-emerald-400/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-300" />
            <span className="text-lg font-black tracking-wide text-white">{match.symbol}</span>
          </div>
          <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-rose-400/10 px-2 py-1 text-[10px] font-bold text-rose-300">
            <TrendingDown className="h-3 w-3" /> {signedPct(match.change_per)} panic session
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-black tabular-nums text-white">{money(match.price)}</div>
          <div className="mt-1 text-[10px] text-slate-500">Volume {match.volume?.toLocaleString('en-IN') ?? '—'}</div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-emerald-300/10 pt-3 text-xs">
        <span className="text-slate-300">Plan: next open → same-day close</span>
        <ArrowRight className="h-4 w-4 text-emerald-300 transition-transform group-hover:translate-x-1" />
      </div>
    </button>
  );
}

function CanonicalPickCard({ pick, onSelectStock }: { pick: CanonicalPick; onSelectStock?: (symbol: string) => void }) {
  const active = pick.planStatus === 'ACTIVE';
  const expired = pick.planStatus === 'EXPIRED';
  const score = pick.unified_score == null ? null : Math.round(pick.unified_score);

  return (
    <button
      type="button"
      onClick={() => onSelectStock?.(pick.symbol)}
      className="group flex h-full w-full flex-col rounded-2xl border border-slate-700/70 bg-slate-950/55 p-4 text-left transition hover:-translate-y-0.5 hover:border-cyan-300/35 hover:bg-slate-900/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-black tracking-wide text-white">{pick.symbol}</span>
            <span className={cn(
              'rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-wider',
              pick.classification === 'Strong Buy'
                ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200'
                : 'border-sky-300/25 bg-sky-300/[0.07] text-sky-200',
            )}>{pick.classification ?? 'Ranked'}</span>
          </div>
          <div className="mt-1.5 text-[10px] uppercase tracking-[0.16em] text-slate-500">
            {pick.sector ?? 'Sector unavailable'} · {pick.timeframe ?? 'Horizon unavailable'}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xl font-black tabular-nums text-white">{score ?? '—'}</div>
          <div className="text-[9px] uppercase tracking-wider text-slate-500">rank / 100</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-slate-900/80 p-2.5">
          <div className="text-[9px] uppercase tracking-wider text-slate-500">Live price</div>
          <div className="mt-1 text-sm font-bold tabular-nums text-slate-100">{money(pick.livePrice)}</div>
          <div className={cn('mt-0.5 text-[10px]', (pick.changePercent ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300')}>
            {signedPct(pick.changePercent)} today
          </div>
        </div>
        <div className="rounded-xl bg-slate-900/80 p-2.5">
          <div className="text-[9px] uppercase tracking-wider text-slate-500">Entry zone</div>
          <div className="mt-1 text-sm font-bold tabular-nums text-slate-100">
            {pick.entry_zone_low != null && pick.entry_zone_high != null
              ? `${money(pick.entry_zone_low)}–${money(pick.entry_zone_high)}`
              : '—'}
          </div>
          <div className="mt-0.5 text-[10px] text-slate-500">planned, not a live fill</div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 border-y border-slate-800 py-3 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-slate-600">Stop</div>
          <div className="mt-1 text-xs font-bold tabular-nums text-rose-300">{money(pick.stop_loss)}</div>
        </div>
        <div className="border-x border-slate-800">
          <div className="text-[9px] uppercase tracking-wider text-slate-600">Target 1</div>
          <div className="mt-1 text-xs font-bold tabular-nums text-emerald-300">{money(pick.target_1)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-slate-600">Engines</div>
          <div className="mt-1 text-xs font-bold tabular-nums text-slate-200">{pick.engine_coverage_count ?? '—'}</div>
        </div>
      </div>

      <p className="mt-3 line-clamp-2 min-h-10 text-[11px] leading-5 text-slate-400">
        {readableReasoning(pick.trade_reasoning)}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3 text-[9px] font-bold uppercase tracking-wider">
        <span className={cn(
          'rounded-full border px-2 py-1',
          active && 'border-emerald-300/25 bg-emerald-300/[0.07] text-emerald-300',
          expired && 'border-rose-300/25 bg-rose-300/[0.07] text-rose-300',
          !active && !expired && 'border-slate-600 bg-slate-800 text-slate-400',
        )}>{pick.planStatus ?? 'UNKNOWN'}</span>
        <span className="text-slate-600">valid to {shortDate(pick.valid_until)}</span>
        {pick.days_to_next_results != null && pick.days_to_next_results <= 14 && (
          <span className="rounded-full border border-amber-300/25 bg-amber-300/[0.07] px-2 py-1 text-amber-300">
            Results in {pick.days_to_next_results}d
          </span>
        )}
      </div>
    </button>
  );
}

export function HighConvictionPage({ onSelectStock }: { onSelectStock?: (symbol: string) => void }) {
  const validated = trpc.getCapitulationSignal.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
  const canonical = trpc.getBuyRecommendations.useQuery(
    { conviction: 'TOP', horizon: 'ALL', limit: 12 },
    { refetchInterval: 15 * 60_000, staleTime: 15 * 60_000, refetchOnWindowFocus: false },
  );

  const matches: Match[] = validated.data?.matches ?? [];
  const evidence: Evidence | null = validated.data?.evidence ?? null;
  const picks: CanonicalPick[] = canonical.data?.picks ?? [];
  const refreshing = validated.isRefetching || canonical.isRefetching;
  const refreshAll = () => Promise.all([validated.refetch(), canonical.refetch()]);

  return (
    <main className="relative min-h-full overflow-hidden bg-[radial-gradient(circle_at_8%_0%,rgba(16,185,129,0.08),transparent_30%),radial-gradient(circle_at_92%_8%,rgba(34,211,238,0.07),transparent_28%)] p-4 sm:p-6">
      <div className="pointer-events-none absolute inset-0 opacity-[0.025] [background-image:linear-gradient(rgba(255,255,255,.7)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.7)_1px,transparent_1px)] [background-size:34px_34px]" />
      <div className="relative mx-auto max-w-[1580px] space-y-5">
        <header className="flex flex-col justify-between gap-4 border-b border-slate-800/80 pb-4 lg:flex-row lg:items-end">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.28em] text-emerald-300">
              <FlaskConical className="h-3.5 w-3.5" /> Evidence desk
            </div>
            <h1 className="text-3xl font-black tracking-[-0.04em] text-white">Best Picks, without false certainty.</h1>
            <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-400">
              Validated trades and research candidates live in separate lanes. A stock appears here because it matches a
              defined process—not because a model printed a persuasive percentage.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a href="/signal-report-card" className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-cyan-300/35 hover:text-white">
              <BarChart3 className="h-4 w-4 text-cyan-300" /> Audit the record
            </a>
            <button
              type="button"
              onClick={refreshAll}
              disabled={refreshing}
              aria-label="Refresh validated and canonical recommendations"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/35 hover:text-white disabled:opacity-50"
            >
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /> Refresh
            </button>
          </div>
        </header>

        <section aria-labelledby="validated-heading" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-emerald-300/25 bg-emerald-300/[0.08] px-2 py-1 text-[9px] font-black uppercase tracking-[0.2em] text-emerald-300">Evidence tier A</span>
                <span className="text-[10px] text-slate-500">Cost-aware historical validation</span>
              </div>
              <h2 id="validated-heading" className="mt-2 text-xl font-bold text-white">Validated opportunity</h2>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
              <Clock className="h-3.5 w-3.5" /> Live scan {validated.data?.asOf ? shortDate(validated.data.asOf) : 'not available'}
            </div>
          </div>

          <div className="grid items-stretch gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
            <EvidenceCard evidence={evidence} />
            {validated.isError ? (
              <div role="alert" className="flex items-center rounded-2xl border border-rose-400/20 bg-rose-400/[0.05] p-5 text-sm text-rose-200">
                The validated-signal scan could not be loaded. Missing data is not a recommendation.
              </div>
            ) : validated.isLoading ? (
              <div className="min-h-36 animate-pulse rounded-2xl border border-slate-800 bg-slate-900/50" />
            ) : matches.length > 0 ? (
              <div className="grid gap-3">
                {matches.map((match) => <ValidatedMatchCard key={match.symbol} match={match} onSelectStock={onSelectStock} />)}
              </div>
            ) : (
              <div className="flex flex-col justify-between gap-4 rounded-2xl border border-dashed border-slate-700 bg-slate-950/35 p-5">
                <div className="flex items-start gap-3">
                  <div className="rounded-xl bg-slate-800 p-2"><Target className="h-4 w-4 text-slate-400" /></div>
                  <div>
                    <p className="text-sm font-semibold text-slate-200">No validated setup today</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      This is a valid “no trade” result. Lowering the rules merely to fill this lane would invalidate the evidence.
                    </p>
                  </div>
                </div>
                <span className="w-fit rounded-full border border-slate-700 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Stay in cash / research</span>
              </div>
            )}
          </div>
        </section>

        <section aria-labelledby="shortlist-heading" className="space-y-4 border-t border-slate-800/80 pt-7">
          <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-cyan-300/20 bg-cyan-300/[0.06] px-2 py-1 text-[9px] font-black uppercase tracking-[0.2em] text-cyan-200">Evidence tier B</span>
                <span className="rounded-full border border-amber-300/20 bg-amber-300/[0.06] px-2 py-1 text-[9px] font-black uppercase tracking-[0.18em] text-amber-200">Unproven ranking</span>
              </div>
              <h2 id="shortlist-heading" className="mt-2 text-xl font-bold text-white">Research shortlist</h2>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-400">
                Canonical cross-engine Buy candidates, sorted by unified score. The score is a rank, not a probability.
                No demonstrated net edge on liquid names—use these for deeper research, not automatic execution.
              </p>
            </div>
            <div className="text-[10px] leading-5 text-slate-500 lg:text-right">
              <div>Ranker batch {shortDate(canonical.data?.lastComputedAt)}</div>
              <div>Regime context: {canonical.data?.regime ?? 'unavailable'}</div>
            </div>
          </div>

          {canonical.isError ? (
            <div role="alert" className="rounded-2xl border border-rose-400/20 bg-rose-400/[0.05] p-5 text-sm text-rose-200">
              The canonical ranking could not be loaded. A failed read is not an empty recommendation list.
            </div>
          ) : canonical.isLoading ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((item) => <div key={item} className="h-72 animate-pulse rounded-2xl border border-slate-800 bg-slate-900/50" />)}
            </div>
          ) : picks.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {picks.map((pick) => <CanonicalPickCard key={pick.symbol} pick={pick} onSelectStock={onSelectStock} />)}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/35 p-6 text-center">
              <p className="text-sm font-semibold text-slate-300">No canonical Buy candidates in the latest batch</p>
              <p className="mt-1 text-xs text-slate-500">The page will not substitute Hold or Sell rows just to fill the grid.</p>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-3">
            {[
              ['What the number means', 'Higher relative rank across the current universe—not an 82% chance of profit.'],
              ['What to verify', 'Active plan, entry zone, results risk, liquidity, and whether the thesis still holds.'],
              ['Current evidence', 'Promising ordering in a short bearish sample; profitability after realistic costs is not established.'],
            ].map(([title, copy]) => (
              <div key={title} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <div className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-500">{title}</div>
                <p className="mt-1.5 text-xs leading-5 text-slate-300">{copy}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-col justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/50 p-4 sm:flex-row sm:items-center">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <p className="max-w-4xl text-[11px] leading-5 text-slate-400">
                Recommendation means “candidate for review,” not “expected winner.” Compare like-for-like outcomes on the Signal Report Card before relying on any historical percentage.
              </p>
            </div>
            <a href="/signal-report-card" className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold text-cyan-200 hover:text-cyan-100">
              Open evidence <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}
