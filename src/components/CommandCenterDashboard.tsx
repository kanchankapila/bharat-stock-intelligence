import { useState } from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import {
  Activity, AlertTriangle, RefreshCw,
  Shield, Zap, ChevronDown, ChevronUp, BarChart2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { formatISTWithLocal, relativeFromNow, marketHoursRefetchInterval } from '../lib/timeFormat';
import { EdgeCallBanner, WhatChangedCard, MarketPulseStrip } from './AlphaHonesty';
import { StockTagRow, type TaggableStock } from './StockTagRow';
import { CanonicalBadge } from './CanonicalSourceNote';
import { V4QuickNav } from './v4/components/V4QuickNav';

type ConvictionFilter = 'ALL' | 'S_ELITE' | 'A_HIGH' | 'B_MEDIUM' | 'C_LOW' | 'D_MARGINAL';
type HorizonFilter    = 'ALL' | 'intraday' | 'swing' | 'long_term';

// ponytail: card = the matching v1-card-{up,down,neutral,accent} variant, so pick cards share
// the rest of v1's glass+colored-top-edge shape. bg/border stay for the small tier badge chip,
// which still wants its own solid tint (v1-card's background is fixed, can't be re-tinted).
const CONVICTION_STYLE: Record<string, { bg: string; border: string; text: string; dot: string; label: string; card: string; badge: string }> = {
  S_ELITE:    { bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', text: 'text-emerald-400', dot: 'bg-emerald-400', label: 'S — Elite',    card: 'v1-card-up',     badge: 'v1-badge v1-badge-s' },
  A_HIGH:     { bg: 'bg-sky-500/15',     border: 'border-sky-500/40',     text: 'text-sky-400',     dot: 'bg-sky-400',     label: 'A — High',     card: 'v1-card',        badge: 'v1-badge v1-badge-a' },
  B_MEDIUM:   { bg: 'bg-amber-500/15',   border: 'border-amber-500/40',   text: 'text-amber-400',   dot: 'bg-amber-400',   label: 'B — Medium',   card: 'v1-card-neutral', badge: 'v1-badge v1-badge-b' },
  C_LOW:      { bg: 'bg-slate-700/40',   border: 'border-slate-600/40',   text: 'text-slate-400',   dot: 'bg-slate-400',   label: 'C — Low',      card: 'v1-card-accent', badge: 'v1-badge v1-badge-c' },
  D_MARGINAL: { bg: 'bg-zinc-800/60',    border: 'border-zinc-700/40',    text: 'text-zinc-500',    dot: 'bg-zinc-500',    label: 'D — Marginal', card: 'v1-card-accent', badge: 'v1-badge bg-zinc-800/60 border-zinc-700/40 text-zinc-500' },
};

const NEUTRAL_REGIME_STYLE = { color: 'text-slate-400', icon: '·', bg: 'bg-slate-500/10 border-slate-500/30' };
const REGIME_STYLE: Record<string, { color: string; icon: string; bg: string }> = {
  BULL:     { color: 'text-emerald-400', icon: '▲', bg: 'bg-emerald-500/10 border-emerald-500/30' },
  BEAR:     { color: 'text-rose-400',    icon: '▼', bg: 'bg-rose-500/10 border-rose-500/30'       },
  SIDEWAYS: { color: 'text-amber-400',   icon: '↔', bg: 'bg-amber-500/10 border-amber-500/30'    },
  HIGH_VOL: { color: 'text-amber-400',   icon: '⚡', bg: 'bg-amber-500/10 border-amber-500/30'    },
  CRASH:    { color: 'text-rose-400',     icon: '☠', bg: 'bg-rose-500/10 border-rose-500/30'         },
};

const fmt2 = (n: number | null | undefined) =>
  n == null ? '—' : n.toFixed(2);
const pct = (n: number | null | undefined) =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const pctColor = (n: number | null | undefined) =>
  n == null ? 'text-slate-400' : n >= 0 ? 'text-emerald-400' : 'text-rose-400';

function pickExplanation(pick: any): { label: string; text: string } | null {
  if (pick.trade_reasoning) return { label: 'Trade reasoning', text: pick.trade_reasoning };
  if (!pick.screener_names_json) return null;
  try {
    const parsed = JSON.parse(pick.screener_names_json);
    const names = Array.isArray(parsed?.bull_screeners)
      ? parsed.bull_screeners
      : Array.isArray(parsed) ? parsed : [];
    const clean = names.filter((name: unknown): name is string => typeof name === 'string' && name.trim().length > 0);
    return clean.length > 0
      ? { label: 'Scanner matches (direction unverified)', text: clean.slice(0, 6).join(' · ') }
      : null;
  } catch {
    return null;
  }
}

function ScoreBar({ label, value, color = 'bg-sky-500' }: {
  label: string; value: number | null | undefined; color?: string;
}) {
  // null/undefined means the engine had no data for this stock -- not the same as a real 0,
  // and must not render as an identical zero-width bar (see AF-20260818-31).
  if (value == null) {
    return (
      <div className="flex items-center gap-2 text-[10px]">
        <span className="w-16 text-slate-500 truncate">{label}</span>
        <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden" />
        <span className="w-7 text-right text-slate-600">n/a</span>
      </div>
    );
  }
  const w = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-16 text-slate-500 truncate">{label}</span>
      <div className="flex-1 h-1 bg-slate-700 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${w}%` }} />
      </div>
      <span className="w-7 text-right text-slate-400">{value.toFixed(0)}</span>
    </div>
  );
}

function EodPickCard({ pick, onSelect, flags }: { pick: any; onSelect: (sym: string) => void; flags?: TaggableStock }) {
  const [expanded, setExpanded] = useState(false);
  const style = CONVICTION_STYLE[pick.conviction_level] ?? CONVICTION_STYLE.C_LOW;
  const explanation = pickExplanation(pick);
  const isBuy = pick.classification === 'Buy' || pick.classification === 'Strong Buy';
  const isSell = pick.classification === 'Sell' || pick.classification === 'Strong Sell';
  const card = isBuy ? 'v1-card-up' : isSell ? 'v1-card-down' : 'v1-card-neutral';

  return (
    <motion.div
      layout
      className={cn(card, 'p-4 cursor-pointer hover:brightness-110')}
      onClick={() => onSelect(pick.symbol)}
      role="button"
      tabIndex={0}
      aria-label={`Open ${pick.symbol} in the trade cockpit`}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(pick.symbol); } }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-white font-bold text-sm">{pick.symbol}</span>
            <span
              className={cn('text-[10px] font-black', style.badge)}
              title="Conviction is direction-agnostic: read the Buy/Sell classification. Not graded accuracy."
            >
              {style.label}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[10px]">
            {pick.classification && (
              <span className={cn('px-1.5 py-0.5 rounded border',
                isBuy ? 'text-emerald-400 border-emerald-500/30' : isSell ? 'text-rose-400 border-rose-500/30' : 'text-slate-400 border-slate-600/40')}>
                {pick.classification}
              </span>
            )}
            {pick.timeframe && (
              <span className="px-1.5 py-0.5 rounded border border-slate-600/40 text-slate-300"
                title="Heuristic horizon label, not a model output">
                {pick.timeframe}
              </span>
            )}
            {pick.planStatus === 'EXPIRED' && (
              <span className="px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-400"
                title="Validity window has ended; stop/target no longer apply">
                plan expired
              </span>
            )}
            {pick.planStatus === 'ACTIVE' && pick.valid_until && (
              <span className="text-slate-500" title="Plan validity (IST)">
                valid till {formatISTWithLocal(pick.valid_until)}
              </span>
            )}
          </div>
          {pick.sector && <div className="text-[10px] text-slate-500 mt-0.5">{pick.sector}</div>}
          {flags && <StockTagRow p={{ days_to_next_results: flags.days_to_next_results, eps_surprise_q1: flags.eps_surprise_q1, eps_beat_streak: flags.eps_beat_streak }} className="mt-1" />}
        </div>
        <div className="text-right">
          <div className="text-white font-bold text-sm">
            {pick.livePrice != null ? `₹${pick.livePrice.toLocaleString('en-IN')}` : '—'}
          </div>
          <div className={cn('text-[11px] font-medium', pctColor(pick.changePercent))}>
            {pct(pick.changePercent)}
          </div>
        </div>
      </div>

      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="flex items-center gap-1.5 text-[10px] text-slate-400">
            Unified Score
            {pick.engine_coverage_count != null && (
              <span
                className="text-slate-500"
                title="How many currently active weighted engines had data for this stock. Inactive configured engine slots are excluded."
              >
                · {pick.engine_coverage_count} active engines
              </span>
            )}
          </span>
          <span className={cn('text-sm font-bold', pick.unified_score == null ? 'text-slate-600' : style.text)}>
            {pick.unified_score == null ? 'n/a' : pick.unified_score}
          </span>
        </div>
        <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
          {pick.unified_score != null && (
            <div className={cn('h-full rounded-full', style.dot)} style={{ width: `${pick.unified_score}%` }} />
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 text-[11px] mb-3">
        <span className="text-emerald-400 font-medium" title="Vendor label counts, not independently validated directional evidence">↑{pick.bullish_screener_count ?? 0} vendor-bullish</span>
        <span className="text-rose-400 font-medium" title="Vendor label counts, not independently validated directional evidence">↓{pick.bearish_screener_count ?? 0} vendor-bearish</span>
        {pick.realizedReturnPct != null && (
          <span className={cn('ml-auto font-bold', pctColor(pick.realizedReturnPct))}>
            {pct(pick.realizedReturnPct)} vs entry-zone low, gross
          </span>
        )}
      </div>

      {(pick.entry_zone_low || pick.stop_loss || pick.target_1) && (
        <div className="grid grid-cols-4 gap-1 text-[10px] mb-2">
          <div className="text-center">
            <div className="text-slate-500 mb-0.5">Entry</div>
            <div className="text-slate-300">
              {pick.entry_zone_low && pick.entry_zone_high
                ? `${fmt2(pick.entry_zone_low)}–${fmt2(pick.entry_zone_high)}` : '—'}
            </div>
          </div>
          <div className="text-center">
            <div className="text-slate-500 mb-0.5">SL</div>
            <div className="text-rose-400">{fmt2(pick.stop_loss)}</div>
          </div>
          <div className="text-center">
            <div className="text-slate-500 mb-0.5">T1/T2</div>
            <div className="text-emerald-400">{fmt2(pick.target_1)} / {fmt2(pick.target_2)}</div>
          </div>
          <div className="text-center">
            <div className="text-slate-500 mb-0.5">R:R</div>
            <div className="text-sky-400">{pick.risk_reward ? `1:${fmt2(pick.risk_reward)}` : '—'}</div>
          </div>
        </div>
      )}

      <div className="space-y-1 mb-2">
        <ScoreBar label="Screener"   value={pick.screener_stock_score} color="bg-violet-500" />
        <ScoreBar label="ML"         value={pick.ml_score}             color="bg-sky-500"    />
        <ScoreBar label="Confluence" value={pick.confluence_score}     color="bg-emerald-500" />
        <ScoreBar label="Technical"  value={pick.technical_score}      color="bg-amber-500"  />
        <ScoreBar label="DL"         value={pick.dl_score}             color="bg-pink-500"   />
      </div>

      {explanation && (
        <button
          className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 w-full"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {explanation.label}
        </button>
      )}
      <AnimatePresence>
        {expanded && explanation && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">{explanation.text}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}


export function CommandCenterDashboard({ onSelectStock }: { onSelectStock: (sym: string) => void }) {
  const [conviction, setConviction] = useState<ConvictionFilter>('ALL');
  const [horizon, setHorizon] = useState<HorizonFilter>('ALL');

  const { data, isLoading, isError, refetch, isRefetching, dataUpdatedAt } =
    trpc.getCommandCenter.useQuery(
      { conviction, horizon, limit: 30 },
      // The ranking is nightly; only the live-price overlay moves, and only in session.
      { refetchInterval: marketHoursRefetchInterval(5 * 60_000), staleTime: 5 * 60_000, refetchOnWindowFocus: false },
    );
  const symbols = (data?.eodPicks ?? []).map((p: any) => p.symbol as string);
  const { data: earnings } = trpc.getEarningsFlags.useQuery(
    { symbols }, { enabled: symbols.length > 0, staleTime: 30 * 60_000, refetchOnWindowFocus: false });
  const flagsBySymbol = new Map<string, TaggableStock>((earnings?.rows ?? []).map((r: any) => [r.symbol, r]));

  const { mutate: triggerRanker, isPending: isRunning } =
    trpc.runUnifiedRanker.useMutation({ onSuccess: () => refetch() });

  const regime = data?.regime;
  const regStyle = REGIME_STYLE[regime?.name ?? ''] ?? NEUTRAL_REGIME_STYLE;

  const CONVICTIONS: ConvictionFilter[] = ['ALL', 'S_ELITE', 'A_HIGH', 'B_MEDIUM', 'C_LOW', 'D_MARGINAL'];
  const HORIZONS: { val: HorizonFilter; label: string }[] = [
    { val: 'ALL', label: 'All' },
    { val: 'intraday', label: 'Intraday' },
    { val: 'swing', label: 'Swing' },
    { val: 'long_term', label: 'Long Term' },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-none px-4 pt-4 pb-3 border-b border-slate-700/50">
        <div className="mb-3"><V4QuickNav /></div>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className={cn('flex items-center gap-2 px-3 py-1.5 rounded-lg border', regStyle.bg)}>
            <span className={cn('text-lg', regStyle.color)}>{regStyle.icon}</span>
            <div>
              <div className={cn('text-sm font-black', regStyle.color)}>{regime?.name ?? '—'} REGIME</div>
              {regime?.confidence != null && (
                <div className="text-[10px] text-slate-400" title="Hidden-Markov-model posterior for today's label. It is not a measure of how often the label is right.">{(regime.confidence * 100).toFixed(0)}% HMM posterior</div>
              )}
            </div>
          </div>

          <CanonicalBadge />

          {data?.avgEngineTrackRecord != null && (
            <div className="flex items-center gap-1.5 text-[11px]">
              <BarChart2 className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-slate-400" title="Average realised return of past recommendations across all engines, gross of costs, long and short mixed.">90d avg past-signal return (gross):</span>
              <span className={cn('font-bold', pctColor(data.avgEngineTrackRecord))}>
                {pct(data.avgEngineTrackRecord)}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 ml-auto">
            {data?.lastComputedAt && (
              <span className="text-[10px] text-slate-500">
                Ranker date {String(data.lastComputedAt).slice(0, 10)}
                {dataUpdatedAt > 0 && <span className="ml-1.5 text-slate-600">· fetched {relativeFromNow(dataUpdatedAt)}</span>}
              </span>
            )}
            <button
              onClick={() => triggerRanker()}
              disabled={isRunning || isRefetching}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', (isRunning || isRefetching) && 'animate-spin')} />
              {isRunning ? 'Running…' : 'Re-run'}
            </button>
          </div>
        </div>

        <MarketPulseStrip />
        <EdgeCallBanner />

        <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200/90" role="note">
          <span className="font-semibold text-amber-300">Read as a ranking, not a forecast.</span>{' '}
          Scores are ranks, not probabilities. No forward-return edge has been demonstrated on liquid names yet, and closed
          Buy plans have lost money net of costs. Tiers mirror the rating. Plans expire at their validity time; check the
          tag before acting. The measured record is on the Signal Report Card.
        </div>

        <div className="flex items-center gap-3 mt-3 flex-wrap">
          <div className="flex items-center gap-1 bg-slate-800 rounded-lg p-0.5">
            {CONVICTIONS.map((c) => (
              <button
                key={c}
                onClick={() => setConviction(c)}
                className={cn(
                  'px-2.5 py-1 rounded text-[11px] font-medium transition-colors',
                  conviction === c ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200',
                )}
              >
                {c === 'ALL' ? 'All' : CONVICTION_STYLE[c]?.label ?? c}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 bg-slate-800 rounded-lg p-0.5">
            {HORIZONS.map(({ val, label }) => (
              <button
                key={val}
                onClick={() => setHorizon(val)}
                className={cn(
                  'px-2.5 py-1 rounded text-[11px] font-medium transition-colors',
                  horizon === val ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-48 text-slate-400 text-sm">
            <Activity className="w-4 h-4 mr-2 animate-pulse" /> Loading…
          </div>
        ) : (
          <>
            <WhatChangedCard />

            <section>
              <div className="flex items-center gap-2 mb-3">
                <Shield className="w-4 h-4 text-violet-400" />
                <h2 className="v1-title-section">Ranked plans (EOD)</h2>
                <span className="text-[10px] text-slate-500 ml-auto">
                  {data?.eodPicks?.length ?? 0} stocks · source unified_recommendations · score 0-100 is a rank
                  {earnings?.asOf ? ` · results dates from technical_signals ${earnings.asOf}` : ''}
                </span>
              </div>
              {isError ? (
                <div className="text-center py-12 text-rose-400 text-sm" role="alert">
                  Could not load the ranking. This is a fetch error, not an empty ranking.
                  <button onClick={() => refetch()} className="ml-2 underline">Retry</button>
                </div>
              ) : (data?.eodPicks?.length ?? 0) === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  No picks yet — run unified_ranker after market close
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {data!.eodPicks.map((pick: any) => (
                    <EodPickCard key={pick.symbol} pick={pick} onSelect={onSelectStock} flags={flagsBySymbol.get(pick.symbol)} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <div className="flex items-center gap-2 mb-1">
                <Zap className="w-4 h-4 text-amber-400" />
                <h2 className="v1-title-section">Intraday</h2>
              </div>
              <p className="text-[11px] text-slate-500">
                Intraday picks and their emission gate (open or closed, with the trailing record) are on the Intraday page.
                This panel no longer lists signals: the old filter never matched any row.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
