import { useState, useMemo } from 'react';
import {
  Zap, BarChart3, RefreshCw, Filter, Clock, Star,
  AlertCircle, Award,
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { LegacyScoreBanner } from './CanonicalSourceNote';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ConfluenceSignal {
  symbol: string;
  computed_at: string;
  confluence_score: number;
  conviction_level: 'ELITE' | 'STRONG' | 'MODERATE' | 'WEAK';
  active_screener_count: number;
  bullish_screener_count: number;
  bearish_screener_count: number;
  screener_names_json: string;
  screener_ids_json: string;
  trend_alignment_score: number;
  volume_score: number;
  sector_strength_score: number;
  fundamental_score: number;
  ml_breakout_probability?: number;
  suggested_timeframe: string;
  entry_zone_low?: number;
  entry_zone_high?: number;
  stop_loss?: number;
  target_1?: number;
  target_2?: number;
  target_3?: number;
  risk_reward?: number;
  trade_reasoning?: string;
  sector?: string;
  current_price?: number;
  rsi?: number;
}

// ─── Conviction Badge ────────────────────────────────────────────────────────

const CONVICTION_CONFIG = {
  ELITE:    { color: 'from-amber-500 to-orange-500',  text: 'text-amber-400',  border: 'border-amber-500/40',  bg: 'bg-amber-500/10'  },
  STRONG:   { color: 'from-emerald-500 to-emerald-500', text: 'text-emerald-400', border: 'border-emerald-500/40', bg: 'bg-emerald-500/10' },
  MODERATE: { color: 'from-indigo-500 to-indigo-500',   text: 'text-indigo-400',   border: 'border-indigo-500/40',   bg: 'bg-indigo-500/10'   },
  WEAK:     { color: 'from-slate-500 to-slate-600',   text: 'text-slate-400',  border: 'border-slate-600',     bg: 'bg-slate-800'     },
};

function ConvictionBadge({ level }: { level: string }) {
  const cfg = CONVICTION_CONFIG[level as keyof typeof CONVICTION_CONFIG] ?? CONVICTION_CONFIG.WEAK;
  return (
    <span className={cn('px-2 py-0.5 rounded text-[10px] font-bold tracking-widest border', cfg.bg, cfg.text, cfg.border)}>
      {level}
    </span>
  );
}

// ─── Score Ring ──────────────────────────────────────────────────────────────

function ScoreRing({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score));
  const color = pct >= 80 ? '#f59e0b' : pct >= 60 ? '#10b981' : pct >= 40 ? '#6366f1' : '#64748b';
  return (
    <div className="relative w-10 h-10">
      <svg viewBox="0 0 36 36" className="w-10 h-10 -rotate-90">
        <circle cx="18" cy="18" r="15" fill="none" stroke="#1e293b" strokeWidth="3" />
        <circle
          cx="18" cy="18" r="15" fill="none"
          stroke={color} strokeWidth="3"
          strokeDasharray={`${pct * 0.942} 94.2`}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white">{score}</span>
    </div>
  );
}

// ─── Factor Bar ──────────────────────────────────────────────────────────────

function FactorBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.round((value / max) * 100);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px]">
        <span className="text-slate-400">{label}</span>
        <span className="text-slate-300 font-data">{value.toFixed(1)}</span>
      </div>
      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── Stat Card ───────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="glass rounded-lg p-3 flex flex-col gap-0.5">
      <span className="text-[10px] text-slate-500 font-display uppercase tracking-widest">{label}</span>
      <span className={cn('text-2xl font-bold', color ?? 'text-white')}>{value}</span>
      {sub && <span className="text-[10px] text-slate-500">{sub}</span>}
    </div>
  );
}

// ─── AI Insight Panel ────────────────────────────────────────────────────────

function AIInsightPanel({ signal }: { signal: ConfluenceSignal }) {
  const { data: detail } = trpc.getConfluenceDetail.useQuery({ symbol: signal.symbol }, { enabled: !!signal.symbol });

  const screenerNames: string[] = useMemo(() => {
    try { return JSON.parse(signal.screener_names_json || '[]'); } catch { return []; }
  }, [signal.screener_names_json]);

  const hasTrade = signal.entry_zone_low && signal.stop_loss && signal.target_1;

  return (
    <div className="glass rounded-xl p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-white font-bold text-lg">{signal.symbol}</div>
          <div className="text-slate-400 text-xs">{signal.sector ?? 'Unknown sector'}</div>
        </div>
        <div className="flex items-center gap-2">
          <ConvictionBadge level={signal.conviction_level} />
          <ScoreRing score={signal.confluence_score} />
        </div>
      </div>

      {/* AI Conclusion */}
      {signal.trade_reasoning && (
        <div className="bg-indigo-900/20 border border-indigo-500/20 rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Zap className="w-3 h-3 text-indigo-400" />
            <span className="text-[10px] text-indigo-400 font-display uppercase tracking-widest font-bold">AI Reasoning</span>
          </div>
          <p className="text-slate-300 text-xs leading-relaxed">{signal.trade_reasoning}</p>
        </div>
      )}

      {/* 5-Factor Breakdown */}
      <div className="space-y-2">
        <div className="text-[10px] text-slate-500 font-display uppercase tracking-widest">Score Breakdown</div>
        <FactorBar label="Screener Confluence" value={signal.bullish_screener_count} max={10} color="bg-amber-500" />
        <FactorBar label="Trend Alignment"     value={signal.trend_alignment_score}   max={15} color="bg-emerald-500" />
        <FactorBar label="Volume Strength"     value={signal.volume_score}            max={10} color="bg-indigo-500" />
        <FactorBar label="Sector Momentum"     value={signal.sector_strength_score}   max={8}  color="bg-purple-500" />
        <FactorBar label="Fundamentals"        value={signal.fundamental_score}       max={12} color="bg-rose-500" />
      </div>

      {/* Trade Setup */}
      {hasTrade && (
        <div className="space-y-2">
          <div className="text-[10px] text-slate-500 font-display uppercase tracking-widest">Trade Setup</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-slate-800/50 rounded-lg p-2">
              <div className="text-[10px] text-slate-500">Entry Zone</div>
              <div className="text-xs font-data text-white">
                {signal.entry_zone_low?.toFixed(2)} – {signal.entry_zone_high?.toFixed(2)}
              </div>
            </div>
            <div className="bg-rose-900/20 border border-rose-500/20 rounded-lg p-2">
              <div className="text-[10px] text-slate-500">Stop Loss</div>
              <div className="text-xs font-data text-rose-400">{signal.stop_loss?.toFixed(2)}</div>
            </div>
            <div className="bg-emerald-900/20 border border-emerald-500/20 rounded-lg p-2">
              <div className="text-[10px] text-slate-500">Target 1</div>
              <div className="text-xs font-data text-emerald-400">{signal.target_1?.toFixed(2)}</div>
            </div>
            <div className="bg-emerald-900/20 border border-emerald-500/20 rounded-lg p-2">
              <div className="text-[10px] text-slate-500">Target 2</div>
              <div className="text-xs font-data text-emerald-400">{signal.target_2?.toFixed(2)}</div>
            </div>
          </div>
          {signal.risk_reward && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500">R:R</span>
              <span className="text-white font-bold">1 : {signal.risk_reward}</span>
              <span className="text-slate-500">|</span>
              <span className="text-slate-500">Timeframe</span>
              <span className={cn('text-xs font-bold',
                signal.suggested_timeframe === 'INTRADAY' ? 'text-amber-400' :
                signal.suggested_timeframe === 'SWING'    ? 'text-indigo-400' : 'text-purple-400'
              )}>{signal.suggested_timeframe}</span>
            </div>
          )}
        </div>
      )}

      {/* ML Probability */}
      {signal.ml_breakout_probability != null && (
        <div className="flex items-center gap-3">
          <div className="text-[10px] text-slate-500 font-display uppercase tracking-widest">ML Breakout Prob</div>
          <div className={cn('text-sm font-bold',
            signal.ml_breakout_probability > 0.7 ? 'text-emerald-400' :
            signal.ml_breakout_probability > 0.5 ? 'text-amber-400' : 'text-slate-400'
          )}>
            {(signal.ml_breakout_probability * 100).toFixed(0)}%
          </div>
        </div>
      )}

      {/* Active Screeners */}
      {screenerNames.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-slate-500 font-display uppercase tracking-widest">Active Scanners ({screenerNames.length})</div>
          <div className="flex flex-wrap gap-1.5">
            {screenerNames.slice(0, 8).map((name, i) => (
              <span key={`${signal.symbol}-${i}-${name}`} className="px-2 py-0.5 bg-indigo-900/30 border border-indigo-500/20 rounded text-[10px] text-indigo-300">
                {name}
              </span>
            ))}
            {screenerNames.length > 8 && (
              <span className="text-[10px] text-slate-500">+{screenerNames.length - 8} more</span>
            )}
          </div>
        </div>
      )}

      {/* Screener Reliability from detail */}
      {detail?.screenerReliability && detail.screenerReliability.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-slate-500 font-display uppercase tracking-widest">Scanner Reliability</div>
          {detail.screenerReliability.slice(0, 4).map((r: any) => (
            <div key={r.scan_id} className="flex items-center justify-between text-[10px]">
              <span className="text-slate-400 truncate max-w-[140px]">{r.screener_name}</span>
              <div className="flex items-center gap-2">
                <span className="text-slate-500">7d Win</span>
                <span className={cn('font-data', r.win_rate_7d > 0.6 ? 'text-emerald-400' : r.win_rate_7d > 0.4 ? 'text-amber-400' : 'text-slate-400')}>
                  {((r.win_rate_7d ?? 0) * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function SignalIntelligence() {
  const [selectedSignal, setSelectedSignal] = useState<ConfluenceSignal | null>(null);
  const [convictionFilter, setConvictionFilter] = useState<string>('ALL');
  const [timeframeFilter, setTimeframeFilter] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<'confluence_score' | 'ml_breakout_probability' | 'bullish_screener_count'>('confluence_score');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [minScore, setMinScore] = useState(30);

  const { data: stats, refetch: refetchStats } = trpc.getConfluenceStats.useQuery(undefined, { refetchInterval: 5 * 60 * 1000 });
  const { data: rawSignals, isLoading, refetch: refetchSignals } = trpc.getConfluenceSignals.useQuery({
    minScore,
    convictionLevel: convictionFilter !== 'ALL' ? convictionFilter as any : undefined,
    timeframe: timeframeFilter !== 'ALL' ? timeframeFilter as any : undefined,
    limit: 100,
  }, { refetchInterval: 5 * 60 * 1000 });
  const { data: reliability } = trpc.getScreenerReliability.useQuery(
    { limit: 10, orderBy: 'reliability_score' },
    { refetchInterval: 60 * 60_000, staleTime: 50 * 60_000, refetchOnWindowFocus: false }
  );
  const { data: sectorMatrix } = trpc.getSectorMomentumMatrix.useQuery(undefined, { refetchInterval: 5 * 60 * 1000 });
  const refreshMutation = trpc.refreshConfluenceSignals.useMutation({
    onSuccess: () => { refetchSignals(); refetchStats(); },
  });

  const signals: ConfluenceSignal[] = useMemo(() => {
    if (!rawSignals) return [];
    return [...rawSignals].sort((a, b) => {
      const av = (a as any)[sortBy] ?? 0;
      const bv = (b as any)[sortBy] ?? 0;
      return sortDir === 'desc' ? bv - av : av - bv;
    });
  }, [rawSignals, sortBy, sortDir]);

  const toggleSort = (col: typeof sortBy) => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const lastComputed = stats?.lastComputed
    ? new Date(stats.lastComputed).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    : 'Never';

  return (
    <div className="p-4 space-y-4 min-h-screen">
      <LegacyScoreBanner note="Multi-screener consensus and scanner reliability, computed separately from the unified cross-engine model -- measured bullish screener consensus has been significantly negative (IC -0.027) and this platform's own screener_reliability win rates have not survived from-scratch re-measurement, so treat conviction here as directional context, not a standalone signal. Check Alpha / Buy Recs for the canonical, regime-aware view." />
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" />
            Signal Intelligence Engine
          </h1>
          <p className="text-slate-400 text-xs mt-0.5">Multi-screener confluence • AI conviction scoring • Breakout probability</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500 flex items-center gap-1">
            <Clock className="w-3 h-3" /> Last: {lastComputed}
          </span>
          <button
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white text-xs font-medium transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn('w-3 h-3', refreshMutation.isPending && 'animate-spin')} />
            {refreshMutation.isPending ? 'Computing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Stats Row ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total Signals"    value={stats?.total ?? 0}    sub="active screener stocks" />
        <StatCard label="Elite Conviction" value={stats?.elite ?? 0}    sub="score ≥ 80" color="text-amber-400" />
        <StatCard label="Strong Conviction" value={stats?.strong ?? 0}  sub="score 60–79" color="text-emerald-400" />
        <StatCard label="Avg Score"        value={`${stats?.avgScore ?? 0}`} sub="across all signals" color="text-indigo-400" />
      </div>

      {/* ── Filters ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-slate-500 flex items-center gap-1"><Filter className="w-3 h-3" /> Filters:</span>
        {(['ALL', 'ELITE', 'STRONG', 'MODERATE'] as const).map(lvl => (
          <button
            key={lvl}
            onClick={() => setConvictionFilter(lvl)}
            className={cn(
              'px-3 py-1 rounded-full text-[10px] font-bold border transition-colors',
              convictionFilter === lvl
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'border-slate-700 text-slate-400 hover:border-slate-500'
            )}
          >{lvl}</button>
        ))}
        <div className="w-px h-4 bg-slate-700 mx-1" />
        {(['ALL', 'INTRADAY', 'SWING', 'POSITIONAL'] as const).map(tf => (
          <button
            key={tf}
            onClick={() => setTimeframeFilter(tf)}
            className={cn(
              'px-3 py-1 rounded-full text-[10px] font-bold border transition-colors',
              timeframeFilter === tf
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'border-slate-700 text-slate-400 hover:border-slate-500'
            )}
          >{tf}</button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-[10px] text-slate-400">
          Min score:
          <input
            type="range" min="0" max="80" step="10" value={minScore}
            onChange={e => setMinScore(Number(e.target.value))}
            className="w-20 accent-indigo-500"
          />
          <span className="text-white font-data w-6">{minScore}</span>
        </div>
      </div>

      {/* ── Main Content ─────────────────────────────────────────────────────── */}
      <div className="flex gap-4 items-start">
        {/* Left: Opportunities Table */}
        <div className="flex-1 min-w-0 glass rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700/50 flex items-center gap-2">
            <Award className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-bold text-white">High Conviction Opportunities</span>
            <span className="ml-auto text-[10px] text-slate-500">{signals.length} stocks</span>
          </div>

          {isLoading ? (
            <div className="p-8 text-center text-slate-500 text-sm">Computing confluence scores...</div>
          ) : signals.length === 0 ? (
            <div className="p-8 text-center">
              <AlertCircle className="w-8 h-8 text-slate-600 mx-auto mb-2" />
              <p className="text-slate-500 text-sm">No signals found. Click Refresh to compute.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-700/50 text-[10px] text-slate-500 font-display uppercase tracking-widest">
                    <th className="px-3 py-2 text-left">Symbol</th>
                    <th className="px-3 py-2 text-left">Conviction</th>
                    <th className="px-3 py-2 text-right cursor-pointer hover:text-white" onClick={() => toggleSort('confluence_score')}>
                      Score {sortBy === 'confluence_score' && (sortDir === 'desc' ? '↓' : '↑')}
                    </th>
                    <th className="px-3 py-2 text-right cursor-pointer hover:text-white" onClick={() => toggleSort('ml_breakout_probability')}>
                      ML Prob {sortBy === 'ml_breakout_probability' && (sortDir === 'desc' ? '↓' : '↑')}
                    </th>
                    <th className="px-3 py-2 text-right cursor-pointer hover:text-white" onClick={() => toggleSort('bullish_screener_count')}>
                      Scanners {sortBy === 'bullish_screener_count' && (sortDir === 'desc' ? '↓' : '↑')}
                    </th>
                    <th className="px-3 py-2 text-right">Entry</th>
                    <th className="px-3 py-2 text-right">SL</th>
                    <th className="px-3 py-2 text-right">T1</th>
                    <th className="px-3 py-2 text-right">R:R</th>
                    <th className="px-3 py-2 text-center">TF</th>
                    <th className="px-3 py-2 text-left">Sector</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((sig, i) => {
                    const isSelected = selectedSignal?.symbol === sig.symbol;
                    return (
                      <tr
                        key={sig.symbol}
                        onClick={() => setSelectedSignal(isSelected ? null : sig)}
                        className={cn(
                          'border-b border-slate-800/50 cursor-pointer transition-colors',
                          isSelected ? 'bg-indigo-900/20 border-indigo-500/20' : 'hover:bg-slate-800/30',
                          i % 2 === 0 ? '' : 'bg-slate-900/20',
                        )}
                      >
                        <td className="px-3 py-2 font-bold text-white">{sig.symbol}</td>
                        <td className="px-3 py-2"><ConvictionBadge level={sig.conviction_level} /></td>
                        <td className="px-3 py-2 text-right">
                          <span className={cn('font-bold',
                            sig.confluence_score >= 80 ? 'text-amber-400' :
                            sig.confluence_score >= 60 ? 'text-emerald-400' :
                            sig.confluence_score >= 40 ? 'text-indigo-400' : 'text-slate-400'
                          )}>{sig.confluence_score}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-data text-slate-300">
                          {sig.ml_breakout_probability != null
                            ? `${(sig.ml_breakout_probability * 100).toFixed(0)}%`
                            : <span className="text-slate-600">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className="text-emerald-400 font-bold">{sig.bullish_screener_count}</span>
                          {sig.bearish_screener_count > 0 && (
                            <span className="text-rose-400 ml-1">-{sig.bearish_screener_count}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-data text-slate-300">
                          {sig.entry_zone_high ? sig.entry_zone_high.toFixed(1) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-data text-rose-400">
                          {sig.stop_loss ? sig.stop_loss.toFixed(1) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-data text-emerald-400">
                          {sig.target_1 ? sig.target_1.toFixed(1) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-300">
                          {sig.risk_reward ? `1:${sig.risk_reward}` : '—'}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded',
                            sig.suggested_timeframe === 'INTRADAY' ? 'bg-amber-900/30 text-amber-400' :
                            sig.suggested_timeframe === 'SWING'    ? 'bg-indigo-900/30 text-indigo-400' :
                                                                     'bg-purple-900/30 text-purple-400'
                          )}>
                            {sig.suggested_timeframe === 'INTRADAY' ? 'ID' :
                             sig.suggested_timeframe === 'SWING' ? 'SW' : 'PO'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-400 text-[10px]">
                          {sig.sector ? sig.sector.slice(0, 16) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right: AI Insight Panel */}
        <AnimatePresence>
          {selectedSignal && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="w-80 shrink-0"
            >
              <AIInsightPanel signal={selectedSignal} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Bottom Row: Reliability Leaderboard + Sector Matrix ──────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Scanner Reliability Leaderboard */}
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700/50 flex items-center gap-2">
            <Star className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-bold text-white">Scanner Reliability Leaderboard</span>
          </div>
          {reliability && reliability.length > 0 ? (
            <div className="divide-y divide-slate-800/50">
              {reliability.map((r: any, i: number) => (
                <div key={r.scan_id} className="px-4 py-2.5 flex items-center gap-3">
                  <span className="text-[10px] text-slate-600 w-4">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white truncate">{r.screener_name}</div>
                    <div className="text-[10px] text-slate-500">{r.source} • {r.total_signals} signals</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={cn('text-xs font-bold',
                      r.win_rate_7d > 0.65 ? 'text-emerald-400' :
                      r.win_rate_7d > 0.45 ? 'text-amber-400' : 'text-slate-400'
                    )}>
                      {((r.win_rate_7d ?? 0) * 100).toFixed(0)}%
                    </div>
                    <div className="text-[10px] text-slate-500">7d win</div>
                  </div>
                  <div className="w-12 text-right shrink-0">
                    <div className={cn('text-xs font-bold',
                      r.reliability_score > 65 ? 'text-emerald-400' :
                      r.reliability_score > 45 ? 'text-amber-400' : 'text-slate-400'
                    )}>
                      {r.reliability_score?.toFixed(0)}
                    </div>
                    <div className="text-[10px] text-slate-500">score</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-6 text-center text-slate-500 text-xs">
              Reliability data builds up as signal outcomes are tracked.
              <br />Run <code className="text-indigo-400">confluence_outcome_tracker.py</code> after market close.
            </div>
          )}
        </div>

        {/* Sector Momentum Matrix */}
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700/50 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-bold text-white">Sector Momentum Matrix</span>
          </div>
          {sectorMatrix && sectorMatrix.length > 0 ? (
            <>
              <div className="p-3">
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={sectorMatrix.slice(0, 10)} layout="vertical" margin={{ left: 0, right: 10 }}>
                    <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 9, fill: '#64748b' }} />
                    <YAxis
                      type="category" dataKey="sector" width={80}
                      tick={{ fontSize: 9, fill: '#94a3b8' }}
                      tickFormatter={(v: string) => v.slice(0, 10)}
                    />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 10 }}
                      formatter={(v: any) => [v, 'Avg Score']}
                    />
                    <Bar dataKey="avg_score" radius={[0, 3, 3, 0]}>
                      {sectorMatrix.slice(0, 10).map((entry: any, index: number) => (
                        <Cell key={index} fill={entry.avg_score >= 60 ? '#10b981' : entry.avg_score >= 40 ? '#6366f1' : '#475569'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="divide-y divide-slate-800/50 max-h-40 overflow-y-auto">
                {sectorMatrix.slice(0, 8).map((s: any) => (
                  <div key={s.sector} className="px-4 py-1.5 flex items-center gap-2 text-xs">
                    <span className="flex-1 text-slate-300 truncate">{s.sector}</span>
                    <span className="text-slate-500 text-[10px]">{s.stock_count} stocks</span>
                    <span className={cn('font-bold',
                      s.avg_score >= 60 ? 'text-emerald-400' :
                      s.avg_score >= 40 ? 'text-indigo-400' : 'text-slate-400'
                    )}>{s.avg_score}</span>
                    {s.high_conviction_count > 0 && (
                      <span className="text-amber-400 text-[10px]">★{s.high_conviction_count}</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="p-6 text-center text-slate-500 text-xs">
              No sector data available. Run a refresh to compute.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SignalIntelligence;
