import React, { useState, useMemo } from 'react';
import { trpc } from '../../lib/trpc';
import { cn } from '../../lib/utils';
import {
  Trophy, TrendingUp, TrendingDown, Minus, Brain,
  Activity, AlertTriangle, CheckCircle2, ChevronRight,
  Zap, BarChart2, Shield, RefreshCw,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface TopPicksPageProps {
  onSelectStock: (symbol: string) => void;
}

type ActionFilter = 'ALL' | 'STRONG BUY' | 'BUY' | 'MOMENTUM WATCH';

const ACTION_COLORS: Record<string, string> = {
  'STRONG BUY':    'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  'BUY':           'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  'MOMENTUM WATCH':'bg-amber-500/15 text-amber-400 border-amber-500/30',
  'NO TRADE':      'bg-slate-700/50 text-slate-500 border-slate-700',
};

const ACTION_DOT: Record<string, string> = {
  'STRONG BUY':    'bg-emerald-400',
  'BUY':           'bg-cyan-400',
  'MOMENTUM WATCH':'bg-amber-400',
  'NO TRADE':      'bg-slate-600',
};

const FILTERS: ActionFilter[] = ['ALL', 'STRONG BUY', 'BUY', 'MOMENTUM WATCH'];

function ScoreBar({ value, max = 100, color }: { value: number; max?: number; color: string }) {
  return (
    <div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden">
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(100, (value / max) * 100)}%` }}
        transition={{ duration: 0.8, ease: 'easeOut' }}
        className={cn('h-full rounded-full', color)}
      />
    </div>
  );
}

const TopPicksPage: React.FC<TopPicksPageProps> = ({ onSelectStock }) => {
  const [filter, setFilter] = useState<ActionFilter>('ALL');

  const { data: cockpit, isLoading, refetch, isFetching } = trpc.getTradeDecisionCockpitData.useQuery(undefined, {
    refetchInterval: 5 * 60 * 1000,
  });

  const overview = cockpit?.data?.marketOverview;
  const allCandidates: any[] = cockpit?.data?.candidates ?? [];

  const candidates = useMemo(() => {
    if (filter === 'ALL') return allCandidates;
    return allCandidates.filter(c => c.actionAdvice === filter);
  }, [allCandidates, filter]);

  const isTradeDay = overview?.verdict === 'TRADE';

  return (
    <div className="space-y-8 animate-fade-in">

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-2">
          <h2 className="text-3xl font-bold text-slate-50 tracking-tight flex items-center gap-3">
            <Trophy className="w-7 h-7 text-amber-500" />
            Top Picks
          </h2>
          <p className="text-slate-500 text-base">
            Multi-factor recommendations — ML · Quant · Technicals · Smart Money · Sentiment
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-500/12 hover:bg-indigo-500/18 text-indigo-300 rounded-lg text-sm font-semibold interactive-base border glass-border"
        >
          <RefreshCw className={cn('w-4 h-4', isFetching && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* Market Verdict strip */}
      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-24 rounded-lg surface-primary glass-border animate-pulse" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Verdict */}
          <div className={cn(
            'col-span-2 md:col-span-1 rounded-lg p-5 flex flex-col gap-2',
            isTradeDay
              ? 'surface-primary glass-border glow-success-strong'
              : 'surface-primary glass-border glow-danger-strong'
          )}>
            <div className="flex items-center gap-2">
              {isTradeDay
                ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                : <AlertTriangle className="w-4 h-4 text-rose-400" />}
              <span className="text-label">Market Verdict</span>
            </div>
            <p className={cn(
              'text-2xl font-bold',
              isTradeDay ? 'text-emerald-400' : 'text-rose-400'
            )}>
              {overview?.verdict ?? '—'}
            </p>
            <p className="text-xs text-slate-500 leading-snug">{overview?.verdictReason ?? ''}</p>
          </div>

          {/* Adv/Dec Ratio */}
          <div className="rounded-lg p-5 surface-primary glass-border glow-accent flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-slate-500" />
              <span className="text-label">Adv / Dec</span>
            </div>
            <p className={cn(
              'text-2xl font-bold tabular-nums',
              (overview?.advDecRatio ?? 1) >= 1 ? 'text-emerald-400' : 'text-rose-400'
            )}>
              {overview?.advDecRatio?.toFixed(1) ?? '—'}
            </p>
            <p className="text-xs text-slate-500">advance / decline ratio</p>
          </div>

          {/* Avg Win Probability */}
          <div className="rounded-lg p-5 surface-primary glass-border glow-accent flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Brain className="w-4 h-4 text-indigo-400" />
              <span className="text-label">Avg ML Win %</span>
            </div>
            <p className="text-2xl font-bold text-indigo-400 tabular-nums">
              {overview?.avgWinProbability?.toFixed(1) ?? '—'}%
            </p>
            <p className="text-xs text-slate-500">across all candidates</p>
          </div>

          {/* Active Signals */}
          <div className="rounded-lg p-5 surface-primary glass-border glow-accent flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              <span className="text-label">Active Signals</span>
            </div>
            <p className="text-2xl font-bold text-amber-400 tabular-nums">
              {overview?.activeSignalsCount ?? '—'}
            </p>
            <p className="text-xs text-slate-500">technical patterns scanned</p>
          </div>
        </div>
      )}

      {/* Action filter tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {FILTERS.map(f => {
          const count = f === 'ALL'
            ? allCandidates.length
            : allCandidates.filter(c => c.actionAdvice === f).length;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold interactive-base border',
                filter === f
                  ? f === 'ALL'
                    ? 'bg-indigo-500/15 text-indigo-300 glow-accent-strong'
                    : cn(ACTION_COLORS[f], 'border')
                  : 'surface-primary text-slate-400 glass-border hover:text-slate-200'
              )}
            >
              {f !== 'ALL' && (
                <span className={cn('w-2 h-2 rounded-full', filter === f ? ACTION_DOT[f] : 'bg-slate-600')} />
              )}
              {f}
              <span className={cn(
                'text-xs px-2 py-0.5 rounded-md font-bold',
                filter === f ? 'bg-white/15' : 'bg-slate-700/40'
              )}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Candidates table */}
      <div className="surface-primary glass-border rounded-lg overflow-hidden shadow-md-soft">
        {isLoading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className="h-14 rounded-lg surface-secondary glass-border animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto hide-scrollbar">
            <table className="w-full text-left border-collapse">
              <thead className="border-b glass-border bg-slate-900/40">
                <tr>
                  <th className="py-4 px-4 text-label w-8">#</th>
                  <th className="py-4 px-4 text-label">Stock</th>
                  <th className="py-4 px-4 text-label text-center">Action</th>
                  <th className="py-4 px-4 text-label text-right">Score</th>
                  <th className="py-4 px-4 text-label text-right">
                    <span className="flex items-center justify-end gap-1"><Brain className="w-3 h-3" /> ML Win</span>
                  </th>
                  <th className="py-4 px-4 text-label text-right">
                    <span className="flex items-center justify-end gap-1"><Zap className="w-3 h-3" /> Tech</span>
                  </th>
                  <th className="py-4 px-4 text-label text-right">
                    <span className="flex items-center justify-end gap-1"><BarChart2 className="w-3 h-3" /> Quant</span>
                  </th>
                  <th className="py-4 px-4 text-label text-right">
                    <span className="flex items-center justify-end gap-1"><Shield className="w-3 h-3" /> Smart ₹</span>
                  </th>
                  <th className="py-4 px-4 text-label text-right">RSI</th>
                  <th className="py-4 px-4 text-label text-right">CMP</th>
                  <th className="py-4 px-1 w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/30">
                <AnimatePresence>
                  {candidates.map((c, idx) => {
                    const isUp = c.changePct >= 0;
                    const actionColor = ACTION_COLORS[c.actionAdvice] ?? ACTION_COLORS['NO TRADE'];

                    return (
                      <motion.tr
                        key={c.symbol}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ delay: Math.min(idx * 0.03, 0.4) }}
                        onClick={() => onSelectStock(c.symbol)}
                        className="hover:bg-slate-800/20 interactive-base cursor-pointer group"
                      >
                        {/* Rank */}
                        <td className="py-3.5 px-4 text-xs font-bold text-slate-600 tabular-nums">{idx + 1}</td>

                        {/* Stock */}
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-3">
                            <div className={cn(
                              'w-9 h-9 rounded-lg flex items-center justify-center text-xs font-black shrink-0',
                              c.actionAdvice === 'STRONG BUY' ? 'bg-emerald-500/15 text-emerald-400' :
                              c.actionAdvice === 'BUY' ? 'bg-cyan-500/15 text-cyan-400' :
                              c.actionAdvice === 'MOMENTUM WATCH' ? 'bg-amber-500/15 text-amber-400' :
                              'bg-slate-800 text-slate-500'
                            )}>
                              {c.symbol.substring(0, 2)}
                            </div>
                            <div>
                              <p className="font-bold text-slate-200 text-sm group-hover:text-white transition-colors">{c.symbol}</p>
                              <p className="text-[11px] text-slate-500 truncate max-w-[140px]">{c.name}</p>
                            </div>
                          </div>
                        </td>

                        {/* Action */}
                        <td className="py-3.5 px-4 text-center">
                          <span className={cn(
                            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold border',
                            actionColor
                          )}>
                            <span className={cn('w-1.5 h-1.5 rounded-full', ACTION_DOT[c.actionAdvice] ?? 'bg-slate-600')} />
                            {c.actionAdvice}
                          </span>
                        </td>

                        {/* Composite Score */}
                        <td className="py-3.5 px-4 text-right">
                          <div className="flex flex-col items-end gap-1">
                            <span className={cn(
                              'text-sm font-black tabular-nums',
                              c.compositeScore >= 75 ? 'text-emerald-400' :
                              c.compositeScore >= 60 ? 'text-cyan-400' :
                              'text-slate-400'
                            )}>
                              {c.compositeScore}
                            </span>
                            <ScoreBar
                              value={c.compositeScore}
                              color={
                                c.compositeScore >= 75 ? 'bg-emerald-500' :
                                c.compositeScore >= 60 ? 'bg-cyan-500' :
                                'bg-slate-600'
                              }
                            />
                          </div>
                        </td>

                        {/* ML Win % */}
                        <td className="py-3.5 px-4 text-right">
                          <div className="flex flex-col items-end gap-1">
                            <span className="text-sm font-bold text-indigo-400 tabular-nums">{c.mlProbability}%</span>
                            <ScoreBar value={c.mlProbability} color="bg-indigo-500" />
                          </div>
                        </td>

                        {/* Tech Signal Count */}
                        <td className="py-3.5 px-4 text-right">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/10 text-amber-400 rounded text-xs font-bold">
                            <Zap className="w-3 h-3" />{c.techSignalCount}
                          </span>
                        </td>

                        {/* Quant Rank */}
                        <td className="py-3.5 px-4 text-right">
                          <span className="text-sm tabular-nums text-slate-300 font-medium">{c.quantRank}</span>
                        </td>

                        {/* Smart Money */}
                        <td className="py-3.5 px-4 text-right">
                          <span className={cn(
                            'text-sm tabular-nums font-bold',
                            c.smartMoneyCr > 0 ? 'text-emerald-400' :
                            c.smartMoneyCr < 0 ? 'text-rose-400' :
                            'text-slate-500'
                          )}>
                            {c.smartMoneyCr > 0 ? '+' : ''}{c.smartMoneyCr}Cr
                          </span>
                        </td>

                        {/* RSI */}
                        <td className="py-3.5 px-4 text-right">
                          <span className={cn(
                            'text-sm tabular-nums font-medium',
                            c.rsi >= 70 ? 'text-rose-400' :
                            c.rsi <= 30 ? 'text-emerald-400' :
                            'text-slate-300'
                          )}>
                            {c.rsi?.toFixed(0)}
                          </span>
                        </td>

                        {/* CMP */}
                        <td className="py-3.5 px-4 text-right">
                          <div className="flex flex-col items-end">
                            <span className="text-sm font-bold text-slate-200 tabular-nums">
                              {c.cmp > 0 ? `₹${c.cmp.toLocaleString('en-IN', { maximumFractionDigits: 1 })}` : '—'}
                            </span>
                            <span className={cn(
                              'text-[11px] font-semibold tabular-nums',
                              isUp ? 'text-emerald-400' : 'text-rose-400'
                            )}>
                              {isUp ? '+' : ''}{c.changePct?.toFixed(2)}%
                            </span>
                          </div>
                        </td>

                        {/* Arrow */}
                        <td className="py-3.5 px-1">
                          <ChevronRight className="w-4 h-4 text-slate-700 group-hover:text-indigo-400 transition-colors" />
                        </td>
                      </motion.tr>
                    );
                  })}
                </AnimatePresence>

                {!isLoading && candidates.length === 0 && (
                  <tr>
                    <td colSpan={11} className="py-16 text-center text-slate-500 text-sm">
                      {allCandidates.length === 0
                        ? 'No candidates yet — run a technical signal scan to populate scores.'
                        : `No stocks with "${filter}" action advice right now.`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer: factor weight legend */}
        {!isLoading && candidates.length > 0 && (
          <div className="px-5 py-3 border-t border-slate-800/60 flex items-center gap-6 flex-wrap">
            <span className="text-[11px] text-slate-600 font-medium">Score weights:</span>
            {[
              { label: 'ML/RL', weight: '30%', color: 'text-indigo-400' },
              { label: 'Fundamentals', weight: '25%', color: 'text-cyan-400' },
              { label: 'Technicals', weight: '20%', color: 'text-amber-400' },
              { label: 'Smart Money', weight: '15%', color: 'text-emerald-400' },
              { label: 'Sentiment', weight: '10%', color: 'text-violet-400' },
            ].map(({ label, weight, color }) => (
              <span key={label} className="flex items-center gap-1 text-[11px]">
                <span className={cn('font-bold', color)}>{label}</span>
                <span className="text-slate-600">{weight}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default TopPicksPage;
