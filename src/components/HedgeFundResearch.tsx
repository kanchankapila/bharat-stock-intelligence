// src/components/HedgeFundResearch.tsx
import React, { useState, useEffect, useMemo } from 'react';
import { trpc } from '../lib/trpc';
import { motion, AnimatePresence } from 'motion/react';
import {
  FlaskConical, Trophy, AlertTriangle,
  ChevronDown, ChevronUp, RefreshCw, Clock, CheckCircle2,
  XCircle, Eye, BarChart2, Activity
} from 'lucide-react';
import { cn } from '../lib/utils';

// --- Types ---
interface StockPick {
  symbol: string;
  conviction_score: number;
  quant_rank: number;
  signal_score: number;
  xgboost_score: number;
  screener_net: number;
  rsi: number | null;
  adx: number | null;
  trailing_pe: number | null;
  roe: number | null;
  debt_to_equity: number | null;
  piotroski: number | null;
  bullish_screeners: number;
  return_1m: number | null;
  return_3m: number | null;
  above_sma200: number;
  entry_note: string;
  stop_loss_pct: number;
  target_1_pct: number;
  target_2_pct: number;
  risk_reward: number;
  layers_confirmed: number;
  flags: string[];
}

interface ResearchReport {
  report_date: string;
  report_type: 'PRE_MARKET' | 'POST_CLOSE';
  market_regime: string;
  sentiment_score: number;
  fii_net_5d: number;
  global_cue: string;
  hot_themes: string[];
  top_picks: StockPick[];
  watchlist: { symbol: string; conviction_score: number; layers_confirmed: number }[];
  avoid_list: { symbol: string; reason: string }[];
  sector_rankings: { sector: string; score: number; momentum: string }[];
  executive_summary: string;
}

// --- RegimeBadge ---
function RegimeBadge({ regime }: { regime: string }) {
  const map: Record<string, string> = {
    BULL: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    SIDEWAYS: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    BEAR: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
    TRANSITIONAL_BULL: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
  };
  const cls = map[regime] ?? 'bg-slate-800/50 text-slate-400 border-slate-700/30';
  return (
    <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-black font-display uppercase tracking-widest border', cls)}>
      {regime.replace(/_/g, ' ')}
    </span>
  );
}

// --- StatusBadge ---
function StatusBadge({ status }: { status: string }) {
  if (status === 'READY') {
    return (
      <span className="flex items-center gap-1 text-emerald-400 text-xs font-bold">
        <CheckCircle2 className="w-3.5 h-3.5" /> READY
      </span>
    );
  }
  if (status === 'GENERATING') {
    return (
      <span className="flex items-center gap-1 text-indigo-400 text-xs font-bold">
        <RefreshCw className="w-3.5 h-3.5 animate-spin" /> GENERATING
      </span>
    );
  }
  if (status === 'FAILED') {
    return (
      <span className="flex items-center gap-1 text-rose-400 text-xs font-bold">
        <XCircle className="w-3.5 h-3.5" /> FAILED
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-slate-400 text-xs font-bold">
      <Clock className="w-3.5 h-3.5" /> PENDING
    </span>
  );
}

// --- ConvictionDots ---
function ConvictionDots({ score }: { score: number }) {
  const filled = Math.round((score / 100) * 5);
  const colorCls = filled >= 4 ? 'bg-emerald-400' : filled >= 3 ? 'bg-indigo-400' : 'bg-yellow-400';
  return (
    <span className="flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={cn('w-2 h-2 rounded-full', i < filled ? colorCls : 'bg-slate-700')}
        />
      ))}
    </span>
  );
}

// --- LayerBadge ---
function LayerBadge({ layers }: { layers: number }) {
  const cls =
    layers >= 4
      ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
      : layers >= 3
      ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
      : 'bg-slate-800/50 text-slate-400 border-slate-700/30';
  return (
    <span className={cn('px-1.5 py-0.5 rounded text-[9px] font-black border', cls)}>
      {layers}L
    </span>
  );
}

// --- ScoreBar ---
function ScoreBar({ label, value, max = 100 }: { label: string; value: number | null; max?: number }) {
  const pct = value == null ? 0 : Math.min(100, Math.round((value / max) * 100));
  const color =
    pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-indigo-500' : 'bg-yellow-500';
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[10px] text-slate-400 font-bold">
        <span>{label}</span>
        <span className="text-white">{value == null ? '—' : value.toFixed(1)}</span>
      </div>
      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// --- StockDeepDive ---
function StockDeepDive({
  pick,
  blurbs,
  onAddWatchlist,
  dlBySymbol,
}: {
  pick: StockPick;
  blurbs?: Record<string, string>;
  onAddWatchlist?: (symbol: string, meta?: any) => void;
  dlBySymbol?: Map<string, any>;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25 }}
      className="overflow-hidden"
    >
      <div className="glass-strong border border-slate-800/30 rounded-2xl p-5 mt-1 mb-2 overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Column 1: Score Breakdown */}
          <div className="space-y-3">
            <p className="text-[10px] font-black font-display uppercase tracking-widest text-slate-400 flex items-center gap-1">
              <BarChart2 className="w-3 h-3" /> Score Breakdown
            </p>
            <ScoreBar label="Conviction" value={pick.conviction_score} />
            <ScoreBar label="Signal Score" value={pick.signal_score} />
            <ScoreBar label="XGBoost" value={pick.xgboost_score} />
            <ScoreBar label="Screener Net" value={pick.screener_net} max={20} />
            <ScoreBar label="RSI" value={pick.rsi} />
            <ScoreBar label="ADX" value={pick.adx} max={50} />
          </div>

          {/* Column 2: Fundamental Snapshot */}
          <div className="space-y-3">
            <p className="text-[10px] font-black font-display uppercase tracking-widest text-slate-400 flex items-center gap-1">
              <Activity className="w-3 h-3" /> Fundamentals
            </p>
            <table className="w-full text-xs text-slate-300">
              <tbody className="divide-y divide-slate-800/30">
                {[
                  ['Trailing PE', pick.trailing_pe?.toFixed(1) ?? '—'],
                  ['ROE (%)', pick.roe?.toFixed(1) ?? '—'],
                  ['D/E Ratio', pick.debt_to_equity?.toFixed(2) ?? '—'],
                  ['Piotroski', pick.piotroski?.toString() ?? '—'],
                  ['1M Return', pick.return_1m != null ? `${pick.return_1m > 0 ? '+' : ''}${pick.return_1m.toFixed(1)}%` : '—'],
                  ['3M Return', pick.return_3m != null ? `${pick.return_3m > 0 ? '+' : ''}${pick.return_3m.toFixed(1)}%` : '—'],
                  ['Above SMA200', pick.above_sma200 ? 'Yes' : 'No'],
                  ['Bullish Screeners', pick.bullish_screeners.toString()],
                ].map(([k, v]) => (
                  <tr key={k}>
                    <td className="py-1 text-slate-500 font-bold pr-3">{k}</td>
                    <td className="py-1 font-black text-right text-white">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Column 3: AI Blurb + Trade Setup */}
          <div className="space-y-3">
            <p className="text-[10px] font-black font-display uppercase tracking-widest text-slate-400 flex items-center gap-1">
              <Eye className="w-3 h-3" /> AI Insight
            </p>
            {blurbs?.[pick.symbol] ? (
              <p className="text-xs text-slate-300 leading-relaxed">{blurbs[pick.symbol]}</p>
            ) : (
              <p className="text-xs text-slate-500 italic">{pick.entry_note || 'No AI insight available.'}</p>
            )}

            <div className="mt-3 pt-3 border-t border-slate-800/30 space-y-1">
              <p className="text-[10px] font-black font-display uppercase tracking-widest text-slate-400">Trade Setup</p>
              <div className="flex gap-2 flex-wrap">
                <span className="px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px] font-black">
                  SL {pick.stop_loss_pct.toFixed(1)}%
                </span>
                <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-black">
                  T1 +{pick.target_1_pct.toFixed(1)}%
                </span>
                <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-[10px] font-black">
                  T2 +{pick.target_2_pct.toFixed(1)}%
                </span>
                <span className="px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[10px] font-black">
                  R:R {pick.risk_reward.toFixed(1)}
                </span>
              </div>
            </div>

            {pick.flags?.length > 0 && (
              <div className="flex gap-1 flex-wrap mt-2">
                {pick.flags.map((f) => (
                  <span
                    key={f}
                    className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[9px] font-black uppercase"
                  >
                    {f}
                  </span>
                ))}
              </div>
            )}

            {onAddWatchlist && (
              <button
                onClick={() => onAddWatchlist(pick.symbol, { source: 'HedgeFund Research', conviction: pick.conviction_score })}
                className="mt-3 w-full py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-black hover:bg-indigo-500/20 transition-all"
              >
                + Add to Watchlist
              </button>
            )}
          </div>
        </div>

        {/* AI Model Signals */}
        {(() => {
          const dl = dlBySymbol?.get(pick.symbol);
          if (!dl) return null;
          return (
            <div className="mt-4 border-t border-slate-700/50 pt-4">
              <p className="text-[10px] font-black font-display uppercase tracking-widest text-slate-400 mb-3">AI Model Signals</p>
              <div className="flex gap-2 mb-3">
                {([1, 5, 15] as const).map(h => {
                  const prob = (dl[`prob_up_${h}d`] as number) ?? 0;
                  const ret  = dl[`exp_ret_${h}d`] as number | null;
                  const color = prob >= 0.65 ? 'text-emerald-400' : prob >= 0.50 ? 'text-amber-400' : 'text-rose-400';
                  return (
                    <div key={h} className="flex-1 glass rounded-lg p-2 text-center">
                      <div className="text-[9px] text-slate-500 mb-1">{h}D</div>
                      <div className={`text-sm font-bold ${color}`}>{(prob * 100).toFixed(0)}%↑</div>
                      {ret != null && (
                        <div className={`text-[9px] ${ret >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                          {ret >= 0 ? '+' : ''}{(ret * 100).toFixed(1)}%
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="text-[10px] text-slate-500 mb-2">
                Confidence: <span className="text-slate-300">{((dl.confidence ?? 0) * 100).toFixed(0)}%</span>
                &nbsp;·&nbsp;
                Uncertainty: <span className="text-slate-300">±{((dl.uncertainty ?? 0) * 100).toFixed(0)}%</span>
              </div>
            </div>
          );
        })()}
      </div>
    </motion.div>
  );
}

// --- TopPicksTable ---
function TopPicksTable({
  picks,
  blurbs,
  onAddWatchlist,
  dlBySymbol,
  currentRegime,
}: {
  picks: StockPick[];
  blurbs?: Record<string, string>;
  onAddWatchlist?: (symbol: string, meta?: any) => void;
  dlBySymbol?: Map<string, any>;
  currentRegime?: any;
}) {
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

  const sorted = [...picks].sort((a, b) => b.conviction_score - a.conviction_score).slice(0, 10);

  return (
    <div className="glass-strong border border-slate-800/30 rounded-2xl overflow-hidden">
      {/* Table Header */}
      <div className="px-4 py-3 border-b border-slate-800/30 grid grid-cols-[24px_1fr_60px_40px_60px_50px_50px_50px_50px_60px] gap-2 text-[9px] font-black font-display uppercase tracking-widest text-slate-500">
        <span>#</span>
        <span>Symbol</span>
        <span className="text-right">Score</span>
        <span className="text-center">L</span>
        <span className="text-right">Entry</span>
        <span className="text-right">SL%</span>
        <span className="text-right">T1%</span>
        <span className="text-right">R:R</span>
        <span className="text-right">DL↑</span>
        <span className="text-center">Regime</span>
      </div>

      {sorted.map((pick, idx) => {
        const isExpanded = expandedSymbol === pick.symbol;
        return (
          <React.Fragment key={pick.symbol}>
            <div
              onClick={() => setExpandedSymbol(isExpanded ? null : pick.symbol)}
              className={cn(
                'px-4 py-3 grid grid-cols-[24px_1fr_60px_40px_60px_50px_50px_50px_50px_60px] gap-2 items-center cursor-pointer transition-all',
                'border-b border-slate-800/20 hover:bg-slate-800/20',
                isExpanded && 'bg-slate-800/30'
              )}
            >
              <span className="text-[10px] font-black text-slate-500">#{idx + 1}</span>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-black text-white uppercase truncate">{pick.symbol}</span>
                <ConvictionDots score={pick.conviction_score} />
              </div>
              <span className="text-right text-xs font-black text-indigo-400">{pick.conviction_score.toFixed(0)}</span>
              <span className="flex justify-center"><LayerBadge layers={pick.layers_confirmed} /></span>
              <span className="text-right text-[10px] text-slate-300 font-bold truncate">{pick.entry_note?.slice(0, 8) || '—'}</span>
              <span className="text-right text-[10px] font-black text-rose-400">{pick.stop_loss_pct.toFixed(1)}%</span>
              <span className="text-right text-[10px] font-black text-emerald-400">+{pick.target_1_pct.toFixed(1)}%</span>
              <span className="text-right text-[10px] font-black text-slate-300">{pick.risk_reward.toFixed(1)}</span>
              <span className="text-right text-[10px] font-black">
                {(() => {
                  const dl = dlBySymbol?.get(pick.symbol);
                  if (!dl) return <span className="text-slate-600">—</span>;
                  const prob = (dl.prob_up_5d as number) ?? 0;
                  const color = prob >= 0.65 ? 'text-emerald-400' : prob >= 0.50 ? 'text-amber-400' : 'text-rose-400';
                  return <span className={color}>{(prob * 100).toFixed(0)}%</span>;
                })()}
              </span>
              <span className="text-center">
                {currentRegime ? (
                  <span className={`text-[9px] font-semibold px-1 py-0.5 rounded ${
                    currentRegime.regime === 'BULL'     ? 'bg-emerald-900/60 text-emerald-300' :
                    currentRegime.regime === 'BEAR'     ? 'bg-rose-900/60 text-rose-300' :
                    currentRegime.regime === 'CRASH'    ? 'bg-rose-950/80 text-rose-200' :
                    currentRegime.regime === 'HIGH_VOL' ? 'bg-amber-900/60 text-amber-300' :
                                                          'bg-slate-800 text-slate-400'
                  }`}>
                    {currentRegime.regime}
                  </span>
                ) : <span className="text-slate-600 text-[9px]">—</span>}
              </span>
            </div>

            <AnimatePresence>
              {isExpanded && (
                <div className="px-3">
                  <StockDeepDive pick={pick} blurbs={blurbs} onAddWatchlist={onAddWatchlist} dlBySymbol={dlBySymbol} />
                </div>
              )}
            </AnimatePresence>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// --- MarketContextBar ---
function MarketContextBar({ report }: { report: ResearchReport }) {
  const sentimentColor =
    report.sentiment_score >= 20
      ? 'text-emerald-400'
      : report.sentiment_score <= -20
      ? 'text-rose-400'
      : 'text-slate-300';
  const fiiColor = report.fii_net_5d >= 0 ? 'text-emerald-400' : 'text-rose-400';

  return (
    <div className="glass border border-slate-800/30 rounded-2xl px-4 py-3 flex flex-wrap items-center gap-4">
      <RegimeBadge regime={report.market_regime} />

      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-slate-500 font-bold">Sentiment</span>
        <span className={cn('font-black', sentimentColor)}>
          {report.sentiment_score > 0 ? '+' : ''}{report.sentiment_score.toFixed(0)}
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-slate-500 font-bold">FII 5D</span>
        <span className={cn('font-black', fiiColor)}>
          {report.fii_net_5d >= 0 ? '+' : ''}₹{(report.fii_net_5d / 100).toFixed(0)}Cr
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-slate-500 font-bold">Global</span>
        <span className="text-slate-300 font-bold">{report.global_cue}</span>
      </div>

      {report.hot_themes?.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {report.hot_themes.slice(0, 4).map((t) => (
            <span
              key={t}
              className="px-2 py-0.5 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-300 text-[9px] font-black font-display uppercase tracking-wide"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// --- ResearchSidebar ---
function ResearchSidebar({
  report,
  onAddWatchlist,
}: {
  report: ResearchReport;
  onAddWatchlist?: (symbol: string, meta?: any) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Avoid List */}
      <div className="glass-strong border border-slate-800/30 rounded-2xl p-4 space-y-3">
        <p className="text-[10px] font-black font-display uppercase tracking-widest text-slate-400 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3 text-rose-400" /> Avoid List
        </p>
        {report.avoid_list?.length > 0 ? (
          report.avoid_list.slice(0, 6).map((item) => (
            <div key={item.symbol} className="flex items-start gap-2">
              <span className="text-xs font-black text-rose-400 uppercase w-20 shrink-0">{item.symbol}</span>
              <span className="text-[10px] text-slate-400 leading-tight">{item.reason}</span>
            </div>
          ))
        ) : (
          <p className="text-xs text-slate-500 italic">No stocks to avoid today.</p>
        )}
      </div>

      {/* Watchlist Candidates */}
      <div className="glass-strong border border-slate-800/30 rounded-2xl p-4 space-y-3">
        <p className="text-[10px] font-black font-display uppercase tracking-widest text-slate-400 flex items-center gap-1">
          <Eye className="w-3 h-3 text-indigo-400" /> Watchlist Candidates
        </p>
        {report.watchlist?.length > 0 ? (
          report.watchlist.slice(0, 8).map((item) => (
            <div key={item.symbol} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <LayerBadge layers={item.layers_confirmed} />
                <span className="text-xs font-black text-white uppercase">{item.symbol}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-indigo-400 font-bold">{item.conviction_score.toFixed(0)}</span>
                {onAddWatchlist && (
                  <button
                    onClick={() => onAddWatchlist(item.symbol, { source: 'HedgeFund Watchlist' })}
                    className="px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[9px] font-black hover:bg-indigo-500/20 transition-all"
                  >
                    +
                  </button>
                )}
              </div>
            </div>
          ))
        ) : (
          <p className="text-xs text-slate-500 italic">No watchlist candidates.</p>
        )}
      </div>

      {/* Sector Rankings */}
      <div className="glass-strong border border-slate-800/30 rounded-2xl p-4 space-y-3">
        <p className="text-[10px] font-black font-display uppercase tracking-widest text-slate-400 flex items-center gap-1">
          <Trophy className="w-3 h-3 text-amber-400" /> Sector Rankings
        </p>
        {report.sector_rankings?.length > 0 ? (
          report.sector_rankings.slice(0, 8).map((s, i) => {
            const momentumColor =
              s.momentum === 'STRONG_UP'
                ? 'text-emerald-400'
                : s.momentum === 'UP'
                ? 'text-lime-400'
                : s.momentum === 'DOWN'
                ? 'text-rose-400'
                : 'text-slate-400';
            const barPct = Math.min(100, Math.max(0, s.score));
            return (
              <div key={s.sector} className="space-y-0.5">
                <div className="flex justify-between items-center text-[10px]">
                  <span className="text-slate-300 font-bold truncate max-w-[120px]">
                    #{i + 1} {s.sector}
                  </span>
                  <span className={cn('font-black text-[9px]', momentumColor)}>{s.momentum}</span>
                </div>
                <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500/60 rounded-full"
                    style={{ width: `${barPct}%` }}
                  />
                </div>
              </div>
            );
          })
        ) : (
          <p className="text-xs text-slate-500 italic">No sector data.</p>
        )}
      </div>
    </div>
  );
}

// --- Main Component ---
interface HedgeFundResearchProps {
  onAddWatchlist?: (symbol: string, meta?: any) => void;
}

export default function HedgeFundResearch({ onAddWatchlist }: HedgeFundResearchProps) {
  const [selectedDate, setSelectedDate] = useState<string | undefined>(undefined);
  const [selectedType, setSelectedType] = useState<'PRE_MARKET' | 'POST_CLOSE'>('PRE_MARKET');
  const [pollStatus, setPollStatus] = useState(false);

  // Queries
  const { data: reportRow, isLoading: reportLoading } = trpc.getDailyResearch.useQuery(
    { date: selectedDate, type: selectedType },
    { refetchInterval: pollStatus ? 15000 : false }
  );

  const { data: history } = trpc.getDailyResearchHistory.useQuery({ limit: 7 });
  const triggerGeneration = trpc.triggerResearchGeneration.useMutation();

  const { data: dlPredictions } = trpc.getDLPredictions.useQuery(
    { date: selectedDate },
    { staleTime: 5 * 60 * 1000 }
  );
  const { data: currentRegime } = trpc.getMarketRegime.useQuery(
    { date: selectedDate },
    { staleTime: 5 * 60 * 1000 }
  );

  const dlBySymbol = useMemo(
    () => new Map((dlPredictions ?? []).map((d: any) => [d.symbol, d])),
    [dlPredictions]
  );

  // Poll when GENERATING
  useEffect(() => {
    setPollStatus(reportRow?.status === 'GENERATING');
  }, [reportRow?.status]);

  // Derive unique date pills
  const historyDates = [...new Set((history ?? []).map((r: any) => r.report_date))].slice(0, 7) as string[];

  // Parse JSON fields
  let report: ResearchReport | null = null;
  let blurbs: Record<string, string> = {};

  if (reportRow?.status === 'READY' && reportRow?.report_json) {
    try {
      report = JSON.parse(reportRow.report_json);
    } catch {}
    try {
      blurbs = JSON.parse(reportRow.ai_blurbs_json || '{}');
    } catch {}
  }

  const currentStatus = reportRow?.status ?? 'PENDING';
  const showGenerateButton = !reportRow || currentStatus === 'FAILED';

  const handleGenerate = () => {
    triggerGeneration.mutate({ type: selectedType, date: selectedDate });
    setPollStatus(true);
  };

  return (
    <div className="space-y-5 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl glass border border-slate-800/50 flex items-center justify-center">
            <FlaskConical className="w-4 h-4 text-violet-400" />
          </div>
          <div>
            <h1 className="v1-title-page">Hedge Fund Research</h1>
            <p className="text-[10px] text-slate-400 font-bold uppercase italic">AI-Driven Daily Intelligence</p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Status */}
          <StatusBadge status={currentStatus} />

          {/* Timestamp */}
          {reportRow?.generated_at && (
            <span className="text-[10px] text-slate-500 font-bold">
              {new Date(reportRow.generated_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}

          {/* Type Toggle */}
          <div className="flex rounded-lg overflow-hidden border border-slate-800/50">
            {(['PRE_MARKET', 'POST_CLOSE'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setSelectedType(t)}
                className={cn(
                  'px-3 py-1.5 text-[10px] font-black font-display uppercase tracking-wider transition-all',
                  selectedType === t
                    ? 'bg-indigo-500/20 text-indigo-400'
                    : 'text-slate-500 hover:text-slate-300'
                )}
              >
                {t === 'PRE_MARKET' ? 'Pre-Market' : 'Post-Close'}
              </button>
            ))}
          </div>

          {/* Generate Button */}
          {showGenerateButton && (
            <button
              onClick={handleGenerate}
              disabled={triggerGeneration.isPending || pollStatus}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-400 text-[10px] font-black hover:bg-violet-500/20 transition-all disabled:opacity-50"
            >
              <RefreshCw className={cn('w-3 h-3', (triggerGeneration.isPending || pollStatus) && 'animate-spin')} />
              Generate
            </button>
          )}
        </div>
      </div>

      {/* Date Pills */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setSelectedDate(undefined)}
          className={cn(
            'px-3 py-1 rounded-full text-[10px] font-black font-display uppercase tracking-widest border transition-all',
            !selectedDate
              ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
              : 'text-slate-400 border-slate-800/50 hover:border-slate-600/50'
          )}
        >
          Latest
        </button>
        {historyDates.map((d) => (
          <button
            key={d}
            onClick={() => setSelectedDate(d)}
            className={cn(
              'px-3 py-1 rounded-full text-[10px] font-black font-display uppercase tracking-widest border transition-all',
              selectedDate === d
                ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
                : 'text-slate-400 border-slate-800/50 hover:border-slate-600/50'
            )}
          >
            {new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
          </button>
        ))}
      </div>

      {/* States */}
      {reportLoading && (
        <div className="flex items-center justify-center py-16 gap-3 text-slate-400">
          <RefreshCw className="w-5 h-5 animate-spin" />
          <span className="text-sm font-bold">Loading research...</span>
        </div>
      )}

      {!reportLoading && currentStatus === 'GENERATING' && (
        <div className="glass-strong border border-indigo-500/20 rounded-2xl p-8 flex flex-col items-center gap-4 text-center">
          <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin" />
          <div>
            <p className="text-sm font-black text-white">Generating Research Report</p>
            <p className="text-xs text-slate-400 mt-1">This takes 2–3 minutes. Auto-refreshing every 15s.</p>
          </div>
          <div className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"
                style={{ animationDelay: `${i * 0.2}s` }}
              />
            ))}
          </div>
        </div>
      )}

      {!reportLoading && currentStatus === 'FAILED' && (
        <div className="glass-strong border border-rose-500/20 rounded-2xl p-8 flex flex-col items-center gap-3 text-center">
          <XCircle className="w-8 h-8 text-rose-400" />
          <div>
            <p className="text-sm font-black text-white">Generation Failed</p>
            <p className="text-xs text-slate-400 mt-1">Click Generate to retry.</p>
          </div>
        </div>
      )}

      {!reportLoading && !reportRow && (
        <div className="glass-strong border border-slate-800/30 rounded-2xl p-8 flex flex-col items-center gap-3 text-center">
          <FlaskConical className="w-8 h-8 text-slate-500" />
          <div>
            <p className="text-sm font-black text-white">No Report Yet</p>
            <p className="text-xs text-slate-400 mt-1">Generate a research report for today.</p>
          </div>
        </div>
      )}

      {/* Ready: Full Report */}
      <AnimatePresence>
        {!reportLoading && currentStatus === 'READY' && report && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-5"
          >
            {/* Market Context Bar */}
            <MarketContextBar report={report} />

            {/* Executive Summary */}
            {report.executive_summary && (
              <div className="glass-strong border border-slate-800/30 rounded-2xl p-4">
                <p className="text-[10px] font-black font-display uppercase tracking-widest text-slate-400 mb-2 flex items-center gap-1">
                  <Activity className="w-3 h-3" /> Executive Summary
                </p>
                <p className="text-xs text-slate-300 leading-relaxed">{report.executive_summary}</p>
              </div>
            )}

            {/* Main Grid: 3:1 picks | sidebar */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5">
              {/* Top Picks Table */}
              <div className="space-y-3">
                <p className="text-[10px] font-black font-display uppercase tracking-widest text-slate-400 px-1 flex items-center gap-1">
                  <Trophy className="w-3 h-3 text-amber-400" /> Top Picks ({report.top_picks?.length ?? 0})
                </p>
                {report.top_picks?.length > 0 ? (
                  <TopPicksTable picks={report.top_picks} blurbs={blurbs} onAddWatchlist={onAddWatchlist} dlBySymbol={dlBySymbol} currentRegime={currentRegime} />
                ) : (
                  <div className="glass-strong border border-slate-800/30 rounded-2xl p-6 text-center text-slate-500 text-xs">
                    No picks available for this report.
                  </div>
                )}
              </div>

              {/* Sidebar */}
              <ResearchSidebar report={report} onAddWatchlist={onAddWatchlist} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
