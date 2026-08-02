import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
} from 'recharts';
import {
  Filter, Save, Bookmark, Activity, TrendingUp, Zap, ArrowDownRight,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import type { MarketData } from '../services/marketService';
import { Card } from './Card';

// Extracted from App.tsx (2026-08-02 perf pass) so it's lazy-loaded instead of always
// bundled into the main entry chunk -- this only mounts when a user opens the Backtest tab.
export const V1Backtest: React.FC<{ stocks?: MarketData[] }> = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<any>(null);
  const [symbol, setSymbol] = useState('RELIANCE');
  const [timeframe, setTimeframe] = useState('Daily Candlesticks');

  // Strategy Parameters
  const [rsiUpper, setRsiUpper] = useState(70);
  const [rsiLower, setRsiLower] = useState(30);
  const [emaShort, setEmaShort] = useState(20);
  const [emaLong, setEmaLong] = useState(50);
  const [strategyName, setStrategyName] = useState('');
  const [showSaveModal, setShowSaveModal] = useState(false);

  const utils = trpc.useContext();
  const { data: savedStrategies } = trpc.getBacktestStrategies.useQuery();

  const backtestMutation = trpc.runBacktest.useMutation({
    onSuccess: (data) => {
      setResults(data);
      setIsRunning(false);
    },
    onError: () => {
      setIsRunning(false);
    }
  });

  const saveStrategyMutation = trpc.saveBacktestStrategy.useMutation({
    onSuccess: () => {
      utils.getBacktestStrategies.invalidate();
      setShowSaveModal(false);
      setStrategyName('');
    }
  });

  const startBacktest = () => {
    setIsRunning(true);
    setResults(null);
    backtestMutation.mutate({
      symbol,
      strategy: 'Custom RSI+EMA',
      period: timeframe === 'Daily Candlesticks' ? '1D' : timeframe === '1H Momentum' ? '1H' : '15M',
      params: { rsiUpper, rsiLower, emaShort, emaLong }
    });
  };

  // ── Walk-Forward Optimization (real engine: backtester.py run_walk_forward,
  //    signal-based across the whole universe — separate from the RSI/EMA demo above) ──
  const [wfStart, setWfStart] = useState('2020-01-01');
  const [wfEnd, setWfEnd] = useState(new Date().toISOString().split('T')[0]);
  const [wfMode, setWfMode] = useState<'rolling' | 'anchored'>('rolling');
  const [wfObjective, setWfObjective] = useState<'sharpe' | 'sortino'>('sharpe');
  const [wfJobId, setWfJobId] = useState<string | null>(null);
  const [wfDone, setWfDone] = useState(false);

  const wfMutation = trpc.runWalkForwardOptimization.useMutation({
    onSuccess: (data) => setWfJobId(data.jobId),
  });

  const { data: wfStatus } = trpc.getWalkForwardStatus.useQuery(
    { jobId: wfJobId ?? '' },
    { enabled: !!wfJobId && !wfDone, refetchInterval: 4000 }
  );

  useEffect(() => {
    if (wfStatus?.state === 'completed' || wfStatus?.state === 'failed') setWfDone(true);
  }, [wfStatus?.state]);

  const startWalkForward = () => {
    setWfJobId(null);
    setWfDone(false);
    wfMutation.mutate({ start: wfStart, end: wfEnd, mode: wfMode, objective: wfObjective });
  };

  const wfRunning = !!wfJobId && !wfDone;
  const wfCombined = wfStatus?.state === 'completed' ? wfStatus.result?.combined : null;
  const wfFolds = wfStatus?.state === 'completed' ? wfStatus.result?.folds ?? [] : [];

  const handleSaveStrategy = () => {
    if (!strategyName) return;
    saveStrategyMutation.mutate({
      name: strategyName,
      symbol,
      timeframe,
      params: { rsiUpper, rsiLower, emaShort, emaLong }
    });
  };

  const loadStrategy = (s: any) => {
    setSymbol(s.symbol);
    setTimeframe(s.timeframe);
    setRsiUpper(s.params.rsiUpper);
    setRsiLower(s.params.rsiLower);
    setEmaShort(s.params.emaShort);
    setEmaLong(s.params.emaLong);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-4 space-y-6">
          <Card title="Strategy Parameters" icon={Filter}>
            <div className="space-y-5">
               <div className="space-y-2">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">Target Symbol</label>
                 <input
                    type="text"
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                    className="w-full glass-strong border border-slate-800/50 rounded-xl p-3 text-xs font-bold text-white focus:outline-none focus:ring-1 focus:ring-blue-500 uppercase"
                    placeholder="e.g. RELIANCE"
                 />
               </div>

               <div className="space-y-2">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">Timeframe</label>
                 <select
                    value={timeframe}
                    onChange={(e) => setTimeframe(e.target.value)}
                    className="w-full glass-strong border border-slate-800/50 rounded-xl p-3 text-xs font-bold text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                 >
                   <option>Daily Candlesticks</option>
                   <option>1H Momentum</option>
                   <option>15M Scalping</option>
                 </select>
               </div>

               <div className="pt-4 border-t border-slate-800/30 space-y-4">
                  <h4 className="text-[10px] font-black text-blue-500 uppercase tracking-[0.2em] mb-2">Technical Indicators</h4>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">RSI Upper (Sell)</label>
                      <input
                        type="number" value={rsiUpper} onChange={(e) => setRsiUpper(parseInt(e.target.value))}
                        className="w-full glass-strong border border-slate-800/50 rounded-lg p-2 text-xs font-bold text-white"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">RSI Lower (Buy)</label>
                      <input
                        type="number" value={rsiLower} onChange={(e) => setRsiLower(parseInt(e.target.value))}
                        className="w-full glass-strong border border-slate-800/50 rounded-lg p-2 text-xs font-bold text-white"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">EMA Short Period</label>
                      <input
                        type="number" value={emaShort} onChange={(e) => setEmaShort(parseInt(e.target.value))}
                        className="w-full glass-strong border border-slate-800/50 rounded-lg p-2 text-xs font-bold text-white"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">EMA Long Period</label>
                      <input
                        type="number" value={emaLong} onChange={(e) => setEmaLong(parseInt(e.target.value))}
                        className="w-full glass-strong border border-slate-800/50 rounded-lg p-2 text-xs font-bold text-white"
                      />
                    </div>
                  </div>
               </div>

               <div className="pt-6 flex gap-2">
                 <button
                   onClick={startBacktest}
                   disabled={isRunning}
                   className={cn(
                     "flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-xl text-[10px] tracking-widest uppercase transition-all shadow-lg shadow-blue-500/20",
                     isRunning && "opacity-50 cursor-not-allowed"
                   )}
                 >
                   {isRunning ? "Running..." : "Run Backtest"}
                 </button>
                 <button
                   onClick={() => setShowSaveModal(true)}
                   className="p-3 glass-strong border border-slate-800/50 rounded-xl text-slate-400 hover:text-white hover:border-slate-800/30 transition-all"
                   title="Save Strategy"
                 >
                   <Save className="w-4 h-4" />
                 </button>
               </div>
            </div>
          </Card>

          {savedStrategies && savedStrategies.length > 0 && (
            <Card title="Saved Strategies" icon={Bookmark}>
              <div className="space-y-3 pt-2">
                {savedStrategies.map((s: any) => (
                  <button
                    key={s.id}
                    onClick={() => loadStrategy(s)}
                    className="w-full text-left p-3 glass-strong border border-slate-800/50 rounded-xl hover:border-blue-500 transition-all group"
                  >
                    <p className="text-xs font-black text-white italic group-hover:text-blue-400 uppercase tracking-tight">{s.name}</p>
                    <div className="flex gap-2 mt-1">
                      <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">{s.symbol}</span>
                      <span className="text-[8px] font-bold text-slate-300 uppercase tracking-widest">•</span>
                      <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">{s.timeframe}</span>
                    </div>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="lg:col-span-8">
          <Card title="Simulation Analysis" icon={Activity} className="h-full">
            {!results && (
              <div className="h-full min-h-[400px] flex flex-col items-center justify-center p-12 text-center relative overflow-hidden">
                <div className="w-24 h-24 bg-blue-600/10 rounded-full flex items-center justify-center mb-6">
                  <Activity className={cn("text-blue-500 w-12 h-12", isRunning && "animate-pulse")} />
                </div>
                <h4 className="text-white font-black text-2xl italic uppercase tracking-tighter">AI Scenario Simulation</h4>
                <p className="text-slate-400 text-sm mt-3 max-w-sm mx-auto leading-relaxed">
                  {isRunning ? "Simulating thousands of trade paths across 10 years of market data history..." : "Adjust your strategy parameters on the left and initiate the simulation to validate your edge."}
                </p>
                {isRunning && (
                  <div className="mt-8 w-48 h-1 glass rounded-full overflow-hidden border border-slate-800/50">
                    <motion.div
                      initial={{ left: '-100%' }}
                      animate={{ left: '100%' }}
                      transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                      className="absolute top-0 h-1 w-1/3 bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.8)]"
                    />
                  </div>
                )}
              </div>
            )}

            {results && (
              <div className="space-y-8 animate-in fade-in duration-500">
                 <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                   {[
                     { label: 'Returns', value: `${results.totalReturn >= 0 ? '+' : ''}${results.totalReturn}%`, icon: TrendingUp, color: results.totalReturn >= 0 ? 'text-emerald-400' : 'text-rose-400' },
                     { label: 'Profit Factor', value: results.profitFactor, icon: Activity, color: 'text-blue-400' },
                     { label: 'Win Rate', value: `${results.winRate}%`, icon: Zap, color: 'text-amber-400' },
                     { label: 'Max DD', value: `${results.maxDrawdown}%`, icon: ArrowDownRight, color: 'text-rose-400' },
                   ].map(stat => (
                     <div key={stat.label} className="p-5 glass-strong border border-slate-800/50 rounded-2xl relative overflow-hidden group">
                       <stat.icon className="w-4 h-4 text-slate-200 absolute -right-1 -top-1 scale-[300%] rotate-12 opacity-50 group-hover:scale-[400%] transition-transform" />
                       <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest relative z-10">{stat.label}</p>
                       <p className={cn("text-2xl font-black mt-2 relative z-10 tracking-tighter", stat.color)}>{stat.value}</p>
                     </div>
                   ))}
                 </div>

                 <div className="p-6 glass-strong rounded-3xl border border-slate-800/50">
                   <div className="flex justify-between items-center mb-8">
                     <div>
                       <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Equity Growth</h5>
                       <p className="text-sm font-black text-white italic">Backtest Period: 2014 - {new Date().getFullYear()}</p>
                     </div>
                     <div className="flex gap-6">
                        <div className="flex items-center gap-2">
                           <div className="w-2.5 h-2.5 bg-blue-500 rounded-full" />
                           <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Portfolio</span>
                        </div>
                        <div className="flex items-center gap-2">
                           <div className="w-2.5 h-2.5 bg-rose-500/20 border border-rose-500 rounded-full" />
                           <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Drawdown</span>
                        </div>
                     </div>
                   </div>
                   <div className="h-80">
                     <ResponsiveContainer width="100%" height="100%">
                       <AreaChart data={results.equityCurve}>
                         <defs>
                           <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                             <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                             <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                           </linearGradient>
                           <linearGradient id="drawdownGradient" x1="0" y1="0" x2="0" y2="1">
                             <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.1}/>
                             <stop offset="95%" stopColor="#f43f5e" stopOpacity={0}/>
                           </linearGradient>
                         </defs>
                         <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                         <XAxis dataKey="date" hide />
                         <YAxis yAxisId="left" hide domain={['auto', 'auto']} />
                         <YAxis yAxisId="right" hide orientation="right" domain={['auto', 0]} />
                         <Tooltip
                           contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px' }}
                           labelStyle={{ color: '#64748b', fontSize: '10px', fontWeight: 'bold' }}
                           itemStyle={{ fontSize: '12px', fontWeight: 'bold', color: '#fff' }}
                         />
                         <Area yAxisId="left" type="monotone" dataKey="equity" stroke="#3b82f6" fillOpacity={1} fill="url(#equityGradient)" strokeWidth={3} />
                         <Area yAxisId="right" type="monotone" dataKey="drawdown" stroke="#f43f5e" fillOpacity={1} fill="url(#drawdownGradient)" strokeWidth={1} strokeDasharray="3 3" />
                       </AreaChart>
                     </ResponsiveContainer>
                   </div>
                 </div>

                 <div className="p-6 bg-blue-500/10 border border-blue-500/20 rounded-3xl flex flex-col md:flex-row items-center justify-between gap-6 overflow-hidden relative">
                    <div className="absolute top-0 right-0 p-4 opacity-5">
                       <Zap className="w-32 h-32 text-blue-500" />
                    </div>
                    <div className="flex items-center gap-4 relative z-10">
                        <div className="w-12 h-12 bg-blue-500 text-blue-950 rounded-2xl flex items-center justify-center font-black italic">
                           AI
                        </div>
                        <div>
                            <h5 className="text-white font-black text-lg tracking-tight uppercase italic mb-1">Adaptive Strategy Intelligence</h5>
                            <p className="text-slate-400 font-medium text-xs max-w-md">
                              {Math.abs(parseFloat(results.maxDrawdown)) > 15
                                ? `This run drew down ${results.maxDrawdown}% at its worst point — consider tightening the stop-loss to reduce that exposure.`
                                : `Max drawdown for this run was a contained ${results.maxDrawdown}%. Re-run Walk-Forward Optimization below to re-tune thresholds on the real engine.`}
                            </p>
                        </div>
                    </div>
                    <button
                      onClick={startBacktest}
                      className="px-6 py-3 bg-white text-blue-900 font-black rounded-xl text-[10px] tracking-widest uppercase hover:bg-blue-50 transition-all relative z-10"
                    >
                      Optimize Strategy
                    </button>
                 </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card title="Walk-Forward Optimization" icon={Zap}>
        <p className="text-slate-400 text-xs mb-6 max-w-2xl">
          Re-optimizes signal thresholds (min score / stop-loss / horizon) on rolling in-sample
          windows and scores only the following out-of-sample window — the real universe-wide
          engine (<span className="font-bold text-slate-300">backtester.py</span>), not the demo
          simulation above.
        </p>
        <div className="flex flex-wrap items-end gap-4 mb-6">
          <div className="space-y-1.5">
            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Start</label>
            <input type="date" value={wfStart} onChange={(e) => setWfStart(e.target.value)}
              className="glass-strong border border-slate-800/50 rounded-lg p-2 text-xs font-bold text-white" />
          </div>
          <div className="space-y-1.5">
            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">End</label>
            <input type="date" value={wfEnd} onChange={(e) => setWfEnd(e.target.value)}
              className="glass-strong border border-slate-800/50 rounded-lg p-2 text-xs font-bold text-white" />
          </div>
          <div className="space-y-1.5">
            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Mode</label>
            <select value={wfMode} onChange={(e) => setWfMode(e.target.value as any)}
              className="glass-strong border border-slate-800/50 rounded-lg p-2 text-xs font-bold text-white">
              <option value="rolling">Rolling (365d IS / 90d OOS)</option>
              <option value="anchored">Anchored (4 folds)</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Objective</label>
            <select value={wfObjective} onChange={(e) => setWfObjective(e.target.value as any)}
              className="glass-strong border border-slate-800/50 rounded-lg p-2 text-xs font-bold text-white">
              <option value="sharpe">Sharpe</option>
              <option value="sortino">Sortino</option>
            </select>
          </div>
          <button
            onClick={startWalkForward}
            disabled={wfRunning}
            className={cn(
              "py-2.5 px-6 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-xl text-[10px] tracking-widest uppercase transition-all",
              wfRunning && "opacity-50 cursor-not-allowed"
            )}
          >
            {wfRunning ? `Running... (${wfStatus?.state ?? 'queued'})` : "Run Walk-Forward"}
          </button>
        </div>

        {wfStatus?.state === 'failed' && (
          <p className="text-rose-400 text-xs font-bold">Failed: {wfStatus.failedReason}</p>
        )}

        {wfCombined && (
          <div className="space-y-6 animate-in fade-in duration-500">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              {[
                { label: 'Total Return', value: `${wfCombined.total_return_pct ?? 0}%` },
                { label: 'Sharpe', value: wfCombined.sharpe_ratio ?? 0 },
                { label: 'Sortino', value: wfCombined.sortino_ratio ?? 0 },
                { label: 'Win Rate', value: `${((wfCombined.win_rate ?? 0) * 100).toFixed(1)}%` },
                { label: 'Max DD', value: `${wfCombined.max_drawdown_pct ?? 0}%` },
              ].map(stat => (
                <div key={stat.label} className="p-4 glass-strong border border-slate-800/50 rounded-2xl">
                  <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest">{stat.label}</p>
                  <p className="text-xl font-black mt-1 text-white tracking-tighter">{stat.value}</p>
                </div>
              ))}
            </div>

            {wfFolds.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[9px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-800/50">
                      <th className="text-left p-2">Fold</th>
                      <th className="text-left p-2">OOS Window</th>
                      <th className="text-left p-2">Best Params</th>
                      <th className="text-left p-2">Trades</th>
                      <th className="text-left p-2">OOS Sharpe</th>
                      <th className="text-left p-2">OOS Win%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wfFolds.map((f: any) => (
                      <tr key={f.fold} className="border-b border-slate-800/30">
                        <td className="p-2 font-bold text-white">{f.fold}</td>
                        <td className="p-2 text-slate-400">{f.oos_start} → {f.oos_end}</td>
                        <td className="p-2 text-slate-400">
                          score≥{f.best_params?.min_score}, SL {f.best_params?.stop_loss_pct?.toFixed?.(1)}%, {f.best_params?.horizon_days}d
                        </td>
                        <td className="p-2 text-slate-400">{f.n_trades}</td>
                        <td className="p-2 text-slate-400">{f.oos_stats?.sharpe_ratio ?? '—'}</td>
                        <td className="p-2 text-slate-400">{f.oos_stats?.win_rate != null ? `${(f.oos_stats.win_rate * 100).toFixed(1)}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>

      <AnimatePresence>
        {showSaveModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSaveModal(false)}
              className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md glass border border-slate-800/50 rounded-3xl p-8 shadow-2xl"
            >
              <h3 className="text-xl font-black text-white italic tracking-tighter uppercase mb-6">Name Your Strategy</h3>
              <div className="space-y-4">
                <input
                  type="text"
                  value={strategyName}
                  onChange={(e) => setStrategyName(e.target.value)}
                  className="w-full glass-strong border border-slate-800/50 rounded-2xl p-4 text-xs font-bold text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="e.g. Aggressive RSI Scalper"
                  autoFocus
                />
                <div className="flex gap-3 mt-4">
                  <button
                    onClick={() => setShowSaveModal(false)}
                    className="flex-1 py-3 glass-strong border border-slate-800/50 text-slate-400 font-black rounded-xl text-[10px] tracking-widest uppercase transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveStrategy}
                    disabled={!strategyName}
                    className="flex-1 py-3 bg-blue-600 text-white font-black rounded-xl text-[10px] tracking-widest uppercase transition-all disabled:opacity-50"
                  >
                    Confirm Save
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default V1Backtest;
