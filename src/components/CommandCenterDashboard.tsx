import { useState } from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import {
  Activity, AlertTriangle, RefreshCw,
  Shield, Zap, ChevronDown, ChevronUp, BarChart2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { formatISTWithLocal, relativeFromNow } from '../lib/timeFormat';
import { CanonicalBadge } from './CanonicalSourceNote';
import { V4QuickNav } from '../v4/components/V4QuickNav';

type ConvictionFilter = 'ALL' | 'S_ELITE' | 'A_HIGH' | 'B_MEDIUM' | 'C_LOW' | 'D_MARGINAL';
type HorizonFilter    = 'ALL' | 'intraday' | 'swing' | 'long_term';

const CONVICTION_STYLE: Record<string, { bg: string; border: string; text: string; dot: string; label: string }> = {
  S_ELITE:    { bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', text: 'text-emerald-400', dot: 'bg-emerald-400', label: 'S — Elite'    },
  A_HIGH:     { bg: 'bg-sky-500/15',     border: 'border-sky-500/40',     text: 'text-sky-400',     dot: 'bg-sky-400',     label: 'A — High'     },
  B_MEDIUM:   { bg: 'bg-amber-500/15',   border: 'border-amber-500/40',   text: 'text-amber-400',   dot: 'bg-amber-400',   label: 'B — Medium'   },
  C_LOW:      { bg: 'bg-slate-700/40',   border: 'border-slate-600/40',   text: 'text-slate-400',   dot: 'bg-slate-400',   label: 'C — Low'      },
  D_MARGINAL: { bg: 'bg-zinc-800/60',    border: 'border-zinc-700/40',    text: 'text-zinc-500',    dot: 'bg-zinc-500',    label: 'D — Marginal' },
};

const REGIME_STYLE: Record<string, { color: string; icon: string; bg: string }> = {
  BULL:     { color: 'text-emerald-400', icon: '▲', bg: 'bg-emerald-500/10 border-emerald-500/30' },
  BEAR:     { color: 'text-rose-400',    icon: '▼', bg: 'bg-rose-500/10 border-rose-500/30'       },
  HIGH_VOL: { color: 'text-amber-400',   icon: '⚡', bg: 'bg-amber-500/10 border-amber-500/30'    },
  CRASH:    { color: 'text-red-400',     icon: '☠', bg: 'bg-red-500/10 border-red-500/30'         },
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
      ? { label: 'Bullish screeners', text: clean.slice(0, 6).join(' · ') }
      : null;
  } catch {
    return null;
  }
}

function ScoreBar({ label, value, color = 'bg-sky-500' }: {
  label: string; value: number; color?: string;
}) {
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

function EodPickCard({ pick, onSelect }: { pick: any; onSelect: (sym: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const style = CONVICTION_STYLE[pick.conviction_level] ?? CONVICTION_STYLE.C_LOW;
  const explanation = pickExplanation(pick);

  return (
    <motion.div
      layout
      className={cn('rounded-xl border p-4 cursor-pointer hover:brightness-110 transition-all', style.bg, style.border)}
      onClick={() => onSelect(pick.symbol)}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-white font-bold text-sm">{pick.symbol}</span>
            <span className={cn('text-[10px] font-black px-1.5 py-0.5 rounded border', style.bg, style.border, style.text)}>
              {style.label}
            </span>
          </div>
          {pick.sector && <div className="text-[10px] text-slate-500 mt-0.5">{pick.sector}</div>}
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
                title="How many of the ranker's 8 component engines (screener/ml/confluence/technical/dl/cs/breakout/smart_money) had data for this stock — a better at-a-glance confidence signal than the blended score alone"
              >
                · {pick.engine_coverage_count}/8
              </span>
            )}
          </span>
          <span className={cn('text-sm font-bold', style.text)}>{pick.unified_score}</span>
        </div>
        <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
          <div className={cn('h-full rounded-full', style.dot)} style={{ width: `${pick.unified_score}%` }} />
        </div>
      </div>

      <div className="flex items-center gap-3 text-[11px] mb-3">
        <span className="text-emerald-400 font-medium">↑{pick.bullish_screener_count ?? 0} bullish</span>
        <span className="text-rose-400 font-medium">↓{pick.bearish_screener_count ?? 0} bearish</span>
        {pick.realizedReturnPct != null && (
          <span className={cn('ml-auto font-bold', pctColor(pick.realizedReturnPct))}>
            {pct(pick.realizedReturnPct)} since rec
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
        <ScoreBar label="Screener"   value={pick.screener_stock_score ?? 0} color="bg-violet-500" />
        <ScoreBar label="ML"         value={pick.ml_score ?? 0}             color="bg-sky-500"    />
        <ScoreBar label="Confluence" value={pick.confluence_score ?? 0}     color="bg-emerald-500" />
        <ScoreBar label="Technical"  value={pick.technical_score ?? 0}      color="bg-amber-500"  />
        <ScoreBar label="DL"         value={pick.dl_score ?? 0}             color="bg-pink-500"   />
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

function IntradayCard({ sig, onSelect }: { sig: any; onSelect: (sym: string) => void }) {
  return (
    <div
      className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-3 cursor-pointer hover:border-slate-600 transition-colors"
      onClick={() => onSelect(sig.symbol)}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-white font-bold text-sm">{sig.symbol}</span>
        <span className="text-[10px] bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 px-1.5 py-0.5 rounded font-bold">HIGH</span>
      </div>
      <div className="text-[10px] text-slate-400 mb-2">{sig.signal_type?.replace(/_/g, ' ')}</div>
      <div className="flex items-center justify-between text-[11px]">
        <span className={cn('font-medium', pctColor(sig.change_pct))}>{pct(sig.change_pct)}</span>
        <span className="text-sky-400">
          Win P: {sig.win_probability != null ? `${(sig.win_probability * 100).toFixed(0)}%` : '—'}
        </span>
        {sig.time_horizon && <span className="text-slate-500">{sig.time_horizon}</span>}
      </div>
    </div>
  );
}

export function CommandCenterDashboard({ onSelectStock }: { onSelectStock: (sym: string) => void }) {
  const [conviction, setConviction] = useState<ConvictionFilter>('ALL');
  const [horizon, setHorizon] = useState<HorizonFilter>('ALL');

  const { data, isLoading, refetch, isRefetching, dataUpdatedAt } =
    trpc.getCommandCenter.useQuery(
      { conviction, horizon, limit: 30 },
      { refetchInterval: 5 * 60_000, refetchOnWindowFocus: true },
    );

  const { mutate: triggerRanker, isPending: isRunning } =
    trpc.runUnifiedRanker.useMutation({ onSuccess: () => refetch() });

  const regime = data?.regime;
  const regStyle = REGIME_STYLE[regime?.name ?? 'BULL'] ?? REGIME_STYLE.BULL;

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
                <div className="text-[10px] text-slate-400">{(regime.confidence * 100).toFixed(0)}% confidence</div>
              )}
            </div>
          </div>

          <CanonicalBadge />

          {data?.avgEngineTrackRecord != null && (
            <div className="flex items-center gap-1.5 text-[11px]">
              <BarChart2 className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-slate-400">90d track record:</span>
              <span className={cn('font-bold', pctColor(data.avgEngineTrackRecord))}>
                {pct(data.avgEngineTrackRecord)}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 ml-auto">
            {data?.lastComputedAt && (
              <span className="text-[10px] text-slate-500">
                Model run {formatISTWithLocal(data.lastComputedAt)}
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
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Shield className="w-4 h-4 text-violet-400" />
                <h2 className="text-sm font-bold text-white">EOD Swing Picks</h2>
                <span className="text-[10px] text-slate-500 ml-auto">{data?.eodPicks?.length ?? 0} stocks</span>
              </div>
              {(data?.eodPicks?.length ?? 0) === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  No picks yet — run unified_ranker after market close
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {data!.eodPicks.map((pick: any) => (
                    <EodPickCard key={pick.symbol} pick={pick} onSelect={onSelectStock} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <div className="flex items-center gap-2 mb-3">
                <Zap className="w-4 h-4 text-amber-400" />
                <h2 className="text-sm font-bold text-white">Intraday Live</h2>
                <span className="text-[10px] text-slate-500 ml-auto">
                  {data?.intradaySignals?.length ?? 0} HIGH-strength signals
                </span>
              </div>
              {regime?.name === 'CRASH' ? (
                <div className="flex items-center gap-2 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                  <AlertTriangle className="w-4 h-4 flex-none" />
                  Intraday signals disabled — CRASH regime active. Preserve capital.
                </div>
              ) : (data?.intradaySignals?.length ?? 0) === 0 ? (
                <div className="text-center py-8 text-slate-500 text-sm">No HIGH-strength intraday signals today</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                  {data!.intradaySignals.map((sig: any, i: number) => (
                    <IntradayCard key={`${sig.symbol}-${i}`} sig={sig} onSelect={onSelectStock} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
