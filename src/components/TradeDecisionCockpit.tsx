import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import {
  ShieldCheck, AlertTriangle, Play, Sparkles, BrainCircuit,
  CircleDollarSign, TrendingUp, HelpCircle, Activity,
  ChevronRight, BarChart2, CheckSquare, Coins, ArrowRight
} from 'lucide-react';
import { cn } from '../lib/utils';

export const TradeDecisionCockpit: React.FC<{ onSelectStock: (symbol: string) => void }> = ({ onSelectStock }) => {
  const { data: cockpitRes, isLoading, refetch } = trpc.getTradeDecisionCockpitData.useQuery(undefined, {
    refetchInterval: 30000
  });

  const [selectedCandidate, setSelectedCandidate] = useState<any>(null);
  const [activeDetailTab, setActiveDetailTab] = useState<'audit' | 'tech' | 'thesis'>('audit');

  if (isLoading) {
    return (
      <div className="py-48 flex flex-col items-center justify-center space-y-6">
        <div className="relative w-12 h-12">
          <div className="absolute inset-0 border-2 border-indigo-500/20 rounded-full" />
          <div className="absolute inset-0 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] animate-pulse">Running Unified Multi-Factor Quant Scans...</p>
      </div>
    );
  }

  const cockpitData = cockpitRes?.success ? cockpitRes.data : null;
  const overview = cockpitData?.marketOverview || { verdict: 'NO TRADE', verdictReason: 'No signal data yet — run technical scans to populate.', advDecRatio: 1.0, avgWinProbability: 50.0, activeSignalsCount: 0 };
  const candidates = cockpitData?.candidates || [];

  if (!selectedCandidate && candidates.length > 0) {
    setSelectedCandidate(candidates[0]);
  }

  const isTradeActive = overview.verdict === 'TRADE';

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Page Header */}
      <div>
        <h2 className="text-3xl font-black text-white italic tracking-tighter uppercase flex items-center gap-3">
          <Sparkles className="w-8 h-8 text-indigo-400 animate-pulse" />
          Bharat Quant Trade Cockpit
        </h2>
        <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mt-1 italic">
          The ultimate multi-factor trade recommendation and execution cockpit
        </p>
      </div>

      {/* Global Trade Verdict Status Panel */}
      <div className={cn(
        "p-6 rounded-3xl border transition-all flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6",
        isTradeActive
          ? "bg-gradient-to-r from-emerald-950/40 to-teal-950/20 border-emerald-500/30 shadow-[0_0_30px_rgba(16,185,129,0.1)]"
          : "bg-gradient-to-r from-amber-950/30 to-slate-900/40 border-amber-500/20 shadow-[0_0_30px_rgba(245,158,11,0.05)]"
      )}>
        <div className="space-y-3 flex-1">
          <div className="flex items-center gap-3">
            <span className={cn(
              "px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border flex items-center gap-1.5",
              isTradeActive
                ? "bg-emerald-500/10 border-emerald-400/20 text-emerald-400"
                : "bg-amber-500/10 border-amber-400/20 text-amber-400"
            )}>
              {isTradeActive ? <ShieldCheck className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
              {isTradeActive ? 'TRADE SIGNAL ACTIVE' : 'RISK-OFF NO-TRADE SYSTEM'}
            </span>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Live Market Scanner Status</span>
          </div>
          <h3 className="text-2xl font-black text-white italic tracking-tight uppercase">
            {isTradeActive ? '🔥 High Confluence Trade Regime Detected' : '🛡️ Capital Preservation Mode Enabled'}
          </h3>
          <p className="text-xs text-slate-400 leading-relaxed font-medium max-w-3xl">
            {overview.verdictReason}
          </p>
        </div>
        <div className="shrink-0">
          <button
            onClick={() => refetch()}
            className="px-6 py-4 glass border border-slate-800/50 hover:border-slate-800/30 hover:text-indigo-600 rounded-2xl text-[10px] font-black uppercase tracking-widest text-slate-300 transition-all flex items-center gap-2"
          >
            <Activity className="w-4 h-4 text-indigo-400 animate-pulse" />
            Recalculate Factors
          </button>
        </div>
      </div>

      {/* Overview Stat Widgets */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="p-4 bg-slate-900/60 border border-slate-800/50 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Global Decision</p>
            <p className={cn("text-xl font-black italic uppercase", isTradeActive ? "text-emerald-400" : "text-amber-400")}>
              {isTradeActive ? 'Active Trade' : 'Risk Off'}
            </p>
            <p className="text-[9.5px] text-slate-400 font-bold uppercase mt-1">Regime Verdict</p>
          </div>
          <div className="p-3 bg-indigo-500/10 rounded-xl">
            <Play className="w-4 h-4 text-indigo-400" />
          </div>
        </div>

        <div className="p-4 bg-slate-900/60 border border-slate-800/50 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Adv / Dec Ratio</p>
            <p className="text-xl font-black text-white italic">{overview.advDecRatio}x</p>
            <p className={cn("text-[9.5px] font-black uppercase mt-1", overview.advDecRatio >= 1.0 ? "text-emerald-500" : "text-rose-500")}>
              {overview.advDecRatio >= 1.0 ? 'Bulls in Control' : 'Bears Dominating'}
            </p>
          </div>
          <div className="p-3 bg-blue-500/10 rounded-xl">
            <BarChart2 className="w-4 h-4 text-blue-400" />
          </div>
        </div>

        <div className="p-4 bg-slate-900/60 border border-slate-800/50 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Avg ML Win Prob</p>
            <p className="text-xl font-black text-indigo-400 italic">{overview.avgWinProbability}%</p>
            <p className="text-[9.5px] text-slate-400 font-bold uppercase mt-1">Ensemble Accuracy Edge</p>
          </div>
          <div className="p-3 bg-indigo-500/10 rounded-xl">
            <BrainCircuit className="w-4 h-4 text-indigo-400" />
          </div>
        </div>

        <div className="p-4 bg-slate-900/60 border border-slate-800/50 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Active Quant Signals</p>
            <p className="text-xl font-black text-white italic">{overview.activeSignalsCount}</p>
            <p className="text-[9.5px] text-slate-400 font-bold uppercase mt-1">Confluence Scans Run</p>
          </div>
          <div className="p-3 bg-pink-500/10 rounded-xl">
            <CircleDollarSign className="w-4 h-4 text-pink-400" />
          </div>
        </div>
      </div>

      {candidates.length === 0 ? (
        <div className="py-24 text-center bg-slate-950/20 border border-slate-800/80 rounded-3xl border-dashed flex flex-col justify-center items-center gap-4">
          <HelpCircle className="w-10 h-10 text-slate-300" />
          <div>
            <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest">No trade candidates yet</p>
            <p className="text-[10px] text-slate-400 mt-1">Run technical signal scans from the Signals tab to populate candidates</p>
          </div>
        </div>
      ) : (
        /* Main candidates and Multi-Factor Detail Drawer */
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Candidates panel */}
          <div className="xl:col-span-8 glass-strong border border-slate-800/50 rounded-3xl overflow-hidden flex flex-col">
            <div className="p-5 border-b border-slate-800/50 bg-slate-900/40 flex justify-between items-center">
              <div>
                <h3 className="text-xs font-black text-white uppercase tracking-wider">Bharat Confluence Trade Candidates</h3>
                <p className="text-[9.5px] text-slate-400 font-bold uppercase mt-0.5">Scored by ML, Fundamentals, Technicals, & Smart Money Flows</p>
              </div>
              <span className="text-[9.5px] bg-slate-800 text-slate-300 font-bold px-2.5 py-1 rounded-md uppercase">Top {candidates.length}</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="glass/25 border-b border-slate-800/50/60">
                    <th className="px-5 py-4 text-[9.5px] font-black text-slate-400 uppercase tracking-widest">Asset</th>
                    <th className="px-5 py-4 text-[9.5px] font-black text-slate-400 uppercase tracking-widest text-center">Advice</th>
                    <th className="px-5 py-4 text-[9.5px] font-black text-slate-400 uppercase tracking-widest text-center">Quant Score</th>
                    <th className="px-5 py-4 text-[9.5px] font-black text-slate-400 uppercase tracking-widest text-center">ML Win Prob</th>
                    <th className="px-5 py-4 text-[9.5px] font-black text-slate-400 uppercase tracking-widest text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/20">
                  {candidates.map((cand: any) => {
                    const isSelected = selectedCandidate?.symbol === cand.symbol;
                    return (
                      <tr
                        key={cand.symbol}
                        onClick={() => setSelectedCandidate(cand)}
                        className={cn(
                          "hover:bg-slate-950/30 transition-colors cursor-pointer group",
                          isSelected && "bg-indigo-500/5 hover:bg-indigo-500/10"
                        )}
                      >
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "w-1.5 h-1.5 rounded-full",
                              cand.changePct >= 0 ? "bg-emerald-500 animate-pulse" : "bg-rose-500"
                            )} />
                            <div>
                              <span className="text-xs font-black text-white group-hover:text-indigo-400 transition-colors uppercase">{cand.symbol}</span>
                              <span className="block text-[9.5px] text-slate-400 font-semibold mt-0.5 max-w-[150px] truncate">{cand.name}</span>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-4 text-center">
                          <span className={cn(
                            "text-[9.5px] font-black px-2.5 py-1 rounded-md border",
                            cand.actionAdvice === 'STRONG BUY'
                              ? 'text-violet-400 bg-violet-400/5 border-violet-400/10'
                              : cand.actionAdvice === 'BUY'
                              ? 'text-emerald-400 bg-emerald-400/5 border-emerald-400/10'
                              : 'text-slate-400 bg-slate-800/20 border-slate-800/30'
                          )}>
                            {cand.actionAdvice}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <span className="text-xs font-black text-white tabular-nums">{cand.compositeScore}</span>
                            <div className="w-16 h-1.5 glass border border-slate-800/50 rounded-full overflow-hidden hidden md:block">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  cand.compositeScore >= 75 ? "bg-violet-500" : cand.compositeScore >= 70 ? "bg-emerald-500" : "bg-slate-9000"
                                )}
                                style={{ width: `${cand.compositeScore}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-4 text-center text-xs font-black text-indigo-400 tabular-nums">
                          {cand.mlProbability}%
                        </td>
                        <td className="px-5 py-4 text-right">
                          <button
                            onClick={(e) => { e.stopPropagation(); onSelectStock(cand.symbol); }}
                            className="p-2 glass border border-slate-800/50 hover:border-slate-800/30 hover:text-indigo-600 rounded-xl text-slate-400 transition-all"
                          >
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Selected Candidate Detail */}
          <div className="xl:col-span-4 space-y-6">
            {selectedCandidate ? (
              <div className="p-5 bg-slate-900/40 border border-slate-800/50 rounded-3xl space-y-6">
                <div className="flex justify-between items-start border-b border-slate-800/50 pb-4">
                  <div>
                    <h3 className="text-lg font-black text-white italic uppercase">{selectedCandidate.symbol}</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">{selectedCandidate.name}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Bharat Score</p>
                    <span className="text-2xl font-black text-indigo-400 italic tabular-nums">{selectedCandidate.compositeScore}</span>
                  </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 bg-slate-950/40 rounded-xl p-1">
                  {[
                    { id: 'audit',  label: 'Factor Audit', icon: ShieldCheck },
                    { id: 'tech',   label: 'Technicals',   icon: Activity    },
                    { id: 'thesis', label: 'Levels & AI',  icon: BrainCircuit},
                  ].map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveDetailTab(tab.id as any)}
                      className={cn(
                        'flex-1 flex flex-col sm:flex-row items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all',
                        activeDetailTab === tab.id
                          ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                          : 'text-slate-400 hover:text-slate-300'
                      )}
                    >
                      <tab.icon className="w-3.5 h-3.5" />
                      <span>{tab.label}</span>
                    </button>
                  ))}
                </div>

                {activeDetailTab === 'audit' && (
                  <>
                    <div className="space-y-4">
                      <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                        <Coins className="w-4 h-4 text-indigo-400" /> Quantitative Factor Analysis
                      </h4>
                      <div className="space-y-3.5">
                        {[
                          { label: '🤖 ML Model Win Probability', value: `${selectedCandidate.mlProbability}%`, pct: selectedCandidate.mlProbability, color: 'bg-indigo-500', textColor: 'text-indigo-400' },
                          { label: '💎 Fundamental Composite Rank', value: `#${selectedCandidate.quantRank}`, pct: Math.max(0, 100 - selectedCandidate.quantRank), color: 'bg-amber-500', textColor: 'text-amber-500' },
                          { label: '📈 Technical Bullish Setups', value: `${selectedCandidate.techSignalCount} signals`, pct: Math.min(100, selectedCandidate.techSignalCount * 25), color: 'bg-emerald-500', textColor: 'text-emerald-400' },
                          { label: '💸 FII Smart Money Net', value: `₹${selectedCandidate.smartMoneyCr} Cr`, pct: Math.min(100, Math.max(0, 50 + selectedCandidate.smartMoneyCr * 5)), color: 'bg-pink-500', textColor: 'text-pink-500' },
                          { label: '📰 News Sentiment Score', value: `${selectedCandidate.newsSentiment}`, pct: 50 + selectedCandidate.newsSentiment * 50, color: 'bg-blue-500', textColor: 'text-blue-400' },
                        ].map((item, i) => (
                          <div key={i}>
                            <div className="flex justify-between text-[10px] font-black uppercase tracking-wider mb-1">
                              <span className={item.textColor}>{item.label}</span>
                              <span className="text-slate-100 font-bold">{item.value}</span>
                            </div>
                            <div className="w-full h-2 glass-strong border border-slate-800/50 rounded-full overflow-hidden">
                              <div className={`h-full ${item.color} rounded-full`} style={{ width: `${item.pct}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="p-4 glass-strong border border-slate-800/80 rounded-2xl space-y-3">
                      <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                        <CheckSquare className="w-4 h-4 text-emerald-400" /> Decision Execution Checklist
                      </h4>
                      <div className="space-y-2">
                        {[
                          { label: 'ML Win Probability exceeds 54.0% edge', val: selectedCandidate.mlProbability >= 54.0 },
                          { label: 'Active bullish technical setups present', val: selectedCandidate.techSignalCount > 0 },
                          { label: 'Top-quartile composite fundamental rank', val: selectedCandidate.quantRank <= 30 },
                          { label: 'Positive average 7-day news sentiment', val: selectedCandidate.newsSentiment >= 0.0 },
                          { label: 'Institutional FII/DII block deal support', val: selectedCandidate.smartMoneyCr >= 0 },
                        ].map((chk, i) => (
                          <div key={i} className="flex items-center gap-2 text-[10px] font-bold">
                            <span className={cn(
                              "w-4 h-4 rounded border flex items-center justify-center shrink-0",
                              chk.val
                                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                                : "border-slate-800/50 glass text-slate-400"
                            )}>
                              {chk.val ? '✓' : '—'}
                            </span>
                            <span className={chk.val ? "text-slate-200" : "text-slate-400"}>{chk.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {activeDetailTab === 'tech' && (
                  <div className="space-y-4">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                      <Activity className="w-4 h-4 text-indigo-400 animate-pulse" /> Technical Indicator Grid
                    </h4>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        {
                          label: 'RSI (14)',
                          val: selectedCandidate.rsi ? selectedCandidate.rsi.toFixed(1) : '—',
                          desc: selectedCandidate.rsi >= 70 ? 'Overbought' : selectedCandidate.rsi <= 30 ? 'Oversold' : 'Neutral',
                          color: selectedCandidate.rsi >= 70 ? 'text-rose-400' : selectedCandidate.rsi <= 30 ? 'text-emerald-400' : 'text-slate-300'
                        },
                        {
                          label: 'MACD Difference',
                          val: selectedCandidate.macd ? selectedCandidate.macd.toFixed(2) : '—',
                          desc: selectedCandidate.macd > selectedCandidate.macdSignal ? 'Bullish Cross' : 'Bearish Cross',
                          color: selectedCandidate.macd > selectedCandidate.macdSignal ? 'text-emerald-400' : 'text-rose-400'
                        },
                        {
                          label: 'SMA Alignment',
                          val: selectedCandidate.sma50 && selectedCandidate.sma200 ? `₹${selectedCandidate.sma50.toFixed(0)} / ₹${selectedCandidate.sma200.toFixed(0)}` : '—',
                          desc: selectedCandidate.sma50 > selectedCandidate.sma200 ? 'SMA50 > SMA200 (Golden)' : 'SMA50 < SMA200 (Death)',
                          color: selectedCandidate.sma50 > selectedCandidate.sma200 ? 'text-emerald-400' : 'text-rose-400'
                        },
                        {
                          label: 'Volume Multiplier',
                          val: selectedCandidate.volumeRatio ? `${selectedCandidate.volumeRatio.toFixed(1)}x` : '—',
                          desc: selectedCandidate.volumeRatio >= 1.5 ? 'High Volume Breakout' : 'Average Activity',
                          color: selectedCandidate.volumeRatio >= 1.5 ? 'text-emerald-400' : 'text-slate-400'
                        },
                        {
                          label: 'Bollinger Band Width',
                          val: selectedCandidate.bbWidth ? `${(selectedCandidate.bbWidth * 100).toFixed(1)}%` : '—',
                          desc: selectedCandidate.bbWidth <= 0.08 ? 'Squeeze (Volatility)' : 'Normal Volatility',
                          color: selectedCandidate.bbWidth <= 0.08 ? 'text-indigo-400' : 'text-slate-400'
                        },
                        {
                          label: 'Delivery Percentage',
                          val: selectedCandidate.deliveryPct ? `${selectedCandidate.deliveryPct.toFixed(1)}%` : '—',
                          desc: selectedCandidate.deliveryPct >= 45.0 ? 'Strong Accumulation' : 'Speculative Trade',
                          color: selectedCandidate.deliveryPct >= 45.0 ? 'text-emerald-400' : 'text-slate-400'
                        }
                      ].map((ind, i) => (
                        <div key={i} className="p-3 bg-slate-950/30 border border-slate-800/40 rounded-xl space-y-1">
                          <span className="block text-[9px] font-bold text-slate-500 uppercase tracking-wider">{ind.label}</span>
                          <span className="block text-sm font-black text-slate-100 tabular-nums">{ind.val}</span>
                          <span className={cn('block text-[8.5px] font-black uppercase tracking-wide', ind.color)}>{ind.desc}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {activeDetailTab === 'thesis' && (
                  <div className="space-y-4">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-indigo-400" /> Target Levels & AI Thesis
                    </h4>

                    {/* Visual execution ranges */}
                    <div className="p-3 bg-slate-950/30 border border-slate-800/40 rounded-xl space-y-2">
                      <div className="flex justify-between text-[10px] font-black uppercase">
                        <span className="text-rose-400">Stop Loss</span>
                        <span className="text-indigo-400">Entry Zone</span>
                        <span className="text-emerald-400">Target</span>
                      </div>
                      <div className="flex justify-between text-xs font-black text-slate-200 tabular-nums">
                        <span>₹{selectedCandidate.stopLoss || '—'}</span>
                        <span>{selectedCandidate.entryZone || `₹${selectedCandidate.entryPrice || '—'}`}</span>
                        <span>{selectedCandidate.targets || `₹${selectedCandidate.targetPrice || '—'}`}</span>
                      </div>

                      {/* Risk Reward Ratio calculator */}
                      {(() => {
                        const entry = parseFloat(selectedCandidate.entryPrice) || selectedCandidate.cmp || 0;
                        const target = parseFloat(selectedCandidate.targetPrice) || 0;
                        const stop = parseFloat(selectedCandidate.stopLoss) || 0;

                        if (entry > 0 && target > 0 && stop > 0 && entry > stop && target > entry) {
                          const reward = target - entry;
                          const risk = entry - stop;
                          const rr = (reward / risk).toFixed(2);
                          return (
                            <div className="border-t border-slate-800/30 pt-2 flex justify-between items-center text-[10px] font-black">
                              <span className="text-slate-400 uppercase">Risk-to-Reward Ratio</span>
                              <span className={cn('text-xs font-black px-2 py-0.5 rounded border uppercase',
                                parseFloat(rr) >= 2.0 ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-slate-800 border-slate-700 text-slate-300'
                              )}>
                                {rr}x {parseFloat(rr) >= 2.0 ? 'Excellent' : 'Moderate'}
                              </span>
                            </div>
                          );
                        }
                        return null;
                      })()}
                    </div>

                    {/* AI Insight and Confluence List */}
                    {selectedCandidate.aiInsight && (
                      <div className="p-3 bg-slate-950/40 border border-slate-800/50 rounded-xl space-y-1.5">
                        <span className="block text-[9px] font-bold text-slate-500 uppercase tracking-wider">AI Confluence Analysis</span>
                        <p className="text-[10.5px] text-slate-300 leading-normal font-medium">{selectedCandidate.aiInsight}</p>
                      </div>
                    )}

                    {/* Confluence signals parsed list */}
                    {(() => {
                      try {
                        const sigs = JSON.parse(selectedCandidate.signalsJson || '[]');
                        if (sigs.length > 0) {
                          return (
                            <div className="space-y-1.5">
                              <span className="block text-[9px] font-bold text-slate-500 uppercase tracking-wider">Breakout Confluence</span>
                              <div className="space-y-1">
                                {sigs.map((s: any, idx: number) => (
                                  <div key={idx} className="p-2 bg-slate-900/60 border border-slate-800/30 rounded-lg text-[9.5px]">
                                    <span className="block font-black text-indigo-400 uppercase">{s.type.replace(/_/g, ' ')}</span>
                                    <p className="text-slate-400 font-semibold mt-0.5">{s.detail}</p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        }
                      } catch { /* skip */ }
                      return null;
                    })()}
                  </div>
                )}

                <button
                  onClick={() => onSelectStock(selectedCandidate.symbol)}
                  className="w-full py-4 bg-gradient-to-r from-indigo-500 to-violet-600 text-white font-black text-[10px] uppercase tracking-widest rounded-2xl hover:shadow-[0_0_20px_rgba(99,102,241,0.35)] transition-all flex items-center justify-center gap-2"
                >
                  Execute Analysis
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="py-24 text-center bg-slate-950/20 border border-slate-800/80 rounded-3xl border-dashed flex flex-col justify-center items-center">
                <Sparkles className="w-8 h-8 text-slate-300 mb-2" />
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Select a candidate for full matrix audit</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default TradeDecisionCockpit;
