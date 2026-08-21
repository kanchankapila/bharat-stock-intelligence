import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { trpc } from '../lib/trpc';
import { Activity, Zap, TrendingUp, TrendingDown, Minus, Filter, X, Brain, BarChart2, Award, Play, Target, Clock, AlertTriangle } from 'lucide-react';
import { cn } from '../lib/utils';

// --- Filter Definitions ---
const FILTER_GROUPS = [
  {
    name: 'Candlestick & Range',
    keys: [
      'todayNR7', 'yesterdayNR7', 'todayGapUP', 'todayGapDown', 'yesterdayGapUP', 'yesterdayGapDown',
      'todayStockOpenHigh', 'todayStockOpenLow', 'weeklyStockOpenHigh', 'weeklyStockOpenLow',
      'orb5minHigh', 'orb5minLow', 'range52WeekHigh', 'range52WeekLow', 'higherHighHigherLow', 'lowerHighLowerLow',
      'insideDay', 'outsideDay'
    ]
  },
  {
    name: 'Moving Averages',
    keys: [
      'todayAbove20SMA', 'todayBelow20SMA', 'todayAbove50SMA', 'todayBelow50SMA', 'todayAbove200SMA', 'todayBelow200SMA'
    ]
  },
  {
    name: 'Valuation & Fundamentals',
    keys: [
      'stockPEBelow5', 'stockPE10To20', 'stockPE50To100', 'stockPE5To10', 'stockPE20To50', 'stockPEAbove100',
      'dividendYield0To1', 'dividendYield2To5', 'dividendYield1To2', 'dividendYieldAbove5',
      'roceBelow5', 'roce10To20', 'roce50To70', 'roce5To10', 'roce20To50', 'roce70To100',
      'roeBelow0', 'roe10To20', 'roeAbove50', 'roe0To10', 'roe20To50'
    ]
  },
  {
    name: 'Market Cap',
    keys: [
      'marketCapBelow1000', 'marketCap1000To5000', 'marketCap5000To20000', 'marketCap20000To50000', 'marketCapAbove50000'
    ]
  }
];

interface Props {
  onSelectStock?: (symbol: string) => void;
}

export const LiveMarketScreener: React.FC<Props> = ({ onSelectStock }) => {
  const [filters, setFilters] = useState<Record<string, boolean>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [activeTab, setActiveTab] = useState<'screener' | 'ai' | 'intraday'>('screener');
  const [isVisible, setIsVisible] = useState(document.visibilityState === 'visible');

  useEffect(() => {
    const handler = () => setIsVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  const { data, isLoading } = trpc.getLiveMarketScreener.useQuery(filters, {
    refetchInterval: isVisible ? 10000 : false,
  });

  const { data: optimalCombos, isLoading: loadingCombos } = trpc.getLiveScreenerOptimalCombinations.useQuery();
  const { data: backtestRuns } = trpc.getLiveScreenerBacktestRuns.useQuery();

  const { data: intradayCombos, isLoading: loadingIntradayCombos } = trpc.getLiveScreenerOptimalIntradayCombinations.useQuery();
  const { data: intradaySignals, isLoading: loadingIntradaySignals } = trpc.getLiveScreenerIntradaySignals.useQuery(undefined, {
    refetchInterval: isVisible ? 30000 : false,
  });
  const { data: mlModelStatus } = trpc.getLiveScreenerMlModelStatus.useQuery(undefined, {
    refetchInterval: isVisible ? 60000 : false,
  });

  const toggleFilter = (key: string) => {
    setFilters(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  const applyCombo = (comboFilters: string[]) => {
    const newFilters: Record<string, boolean> = {};
    comboFilters.forEach(f => {
      newFilters[f] = true;
    });
    setFilters(newFilters);
    setActiveTab('screener');
    setShowFilters(true);
  };

  const clearFilters = () => setFilters({});

  const activeCount = Object.values(filters).filter(Boolean).length;
  const stocks = (data as any)?.resultData || [];
  // Was recomputed on every render, including the unrelated 30s/60s combo-status poll ticks
  // this component also holds queries for.
  const sortedStocks = useMemo(
    () => [...stocks].sort((a, b) => (b.change_per ?? 0) - (a.change_per ?? 0)),
    [stocks],
  );

  // Find a completed backtest run matching the combination
  const findBacktestForCombo = (comboFilters: string[]) => {
    if (!backtestRuns) return null;
    return backtestRuns.find((run: any) => {
      try {
        const config = JSON.parse(run.strategy_config_json);
        const configFilters = config.filters || [];
        return config.horizon !== 'intraday' &&
               configFilters.length === comboFilters.length &&
               configFilters.every((f: string) => comboFilters.includes(f));
      } catch {
        return false;
      }
    });
  };

  // Same match, restricted to the same-day (intraday) horizon backtests -- run_name/horizon
  // disambiguates these from the swing (1d/3d/5d) runs above so the two never mix.
  const findIntradayBacktestForCombo = (comboFilters: string[]) => {
    if (!backtestRuns) return null;
    return backtestRuns.find((run: any) => {
      try {
        const config = JSON.parse(run.strategy_config_json);
        const configFilters = config.filters || [];
        return config.horizon === 'intraday' &&
               configFilters.length === comboFilters.length &&
               configFilters.every((f: string) => comboFilters.includes(f));
      } catch {
        return false;
      }
    });
  };

  return (
    <div className="flex flex-col min-h-screen text-slate-200">
      {/* Header & Tabs */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 flex-shrink-0">
        <div>
          <h1 className="v1-title-page flex items-center gap-3">
            <Activity className="w-6 h-6 text-indigo-400 animate-pulse" />
            Live Market Screener
          </h1>
          <p className="text-xs font-data text-slate-500 mt-1 font-display uppercase tracking-widest">
            Realtime NiftyTrader Filters & AI Strategies
          </p>
        </div>
        
        {/* Tab Controls */}
        <div className="flex items-center gap-2 bg-slate-900/60 p-1 rounded-lg border border-slate-800">
          <button
            onClick={() => setActiveTab('screener')}
            className={cn(
              "px-3 py-1.5 rounded-md font-data text-xs font-bold transition-all flex items-center gap-1.5",
              activeTab === 'screener' ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/10" : "text-slate-400 hover:text-slate-200"
            )}
          >
            <Zap className="w-3.5 h-3.5" />
            Live Matches ({stocks.length})
          </button>
          
          <button
            onClick={() => setActiveTab('ai')}
            className={cn(
              "px-3 py-1.5 rounded-md font-data text-xs font-bold transition-all flex items-center gap-1.5",
              activeTab === 'ai' ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/10" : "text-slate-400 hover:text-slate-200"
            )}
          >
            <Brain className="w-3.5 h-3.5" />
            AI Strategy Cockpit
          </button>

          <button
            onClick={() => setActiveTab('intraday')}
            className={cn(
              "px-3 py-1.5 rounded-md font-data text-xs font-bold transition-all flex items-center gap-1.5",
              activeTab === 'intraday' ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/10" : "text-slate-400 hover:text-slate-200"
            )}
          >
            <Target className="w-3.5 h-3.5" />
            Intraday Edge
          </button>
        </div>

        {activeTab === 'screener' && (
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg font-data text-xs font-bold transition-all",
              activeCount > 0 ? "bg-indigo-600/20 text-indigo-400 border border-indigo-500/30" : "bg-slate-800 text-slate-400 border border-slate-700"
            )}
          >
            <Filter className="w-4 h-4" />
            {showFilters ? 'Hide Filters' : 'Show Filters'}
            {activeCount > 0 && <span className="bg-indigo-500 text-white rounded-full px-2 py-0.5 ml-1">{activeCount}</span>}
          </button>
        )}
      </div>

      {/* Suggestion banner if there are optimal strategies and we are on screen tab */}
      {activeTab === 'screener' && optimalCombos?.optimal_combinations?.length > 0 && activeCount === 0 && (
        <div className="bg-indigo-950/20 border border-indigo-900/40 rounded-lg p-3 mb-4 flex items-center justify-between text-xs flex-shrink-0 animate-fade-in">
          <div className="flex items-center gap-2 text-indigo-300">
            <Brain className="w-4 h-4 text-indigo-400 animate-pulse" />
            <span>
              <strong>AI Recommendation:</strong> Strategy <code>{optimalCombos.optimal_combinations[0].filters.join(' + ')}</code> has a <strong>{(optimalCombos.optimal_combinations[0].win_rate * 100).toFixed(1)}%</strong> win-rate.
            </span>
          </div>
          <button 
            onClick={() => applyCombo(optimalCombos.optimal_combinations[0].filters)}
            className="bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1 rounded font-semibold transition-all flex items-center gap-1 font-data text-[10px]"
          >
            <Play className="w-2.5 h-2.5 fill-current" /> Apply Combo
          </button>
        </div>
      )}

      {/* Filter Panel */}
      {activeTab === 'screener' && (
        <AnimatePresence>
          {showFilters && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden mb-6 flex-shrink-0"
            >
              <div className="v1-card p-5">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="v1-title-card">Active Filters</h3>
                  {activeCount > 0 && (
                    <button onClick={clearFilters} className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1">
                      <X className="w-3 h-3" /> Clear All
                    </button>
                  )}
                </div>
                
                <div className="space-y-6">
                  {FILTER_GROUPS.map(group => (
                    <div key={group.name}>
                      <h4 className="text-xs font-data text-slate-500 mb-3">{group.name}</h4>
                      <div className="flex flex-wrap gap-2">
                        {group.keys.map(key => {
                          const active = !!filters[key];
                          return (
                            <button
                              key={key}
                              onClick={() => toggleFilter(key)}
                              className={cn(
                                "text-[10px] font-data px-3 py-1.5 rounded-md transition-all border",
                                active 
                                  ? "bg-indigo-600/20 text-indigo-300 border-indigo-500/50 shadow-[0_0_10px_rgba(99,102,241,0.1)]" 
                                  : "bg-slate-800/50 text-slate-400 border-slate-700/50 hover:bg-slate-800 hover:text-slate-300"
                              )}
                            >
                              {key}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {/* Results / Screen Grid */}
      <div className="flex-1 overflow-y-auto hide-scrollbar">
        {activeTab === 'screener' ? (
          isLoading ? (
            <div className="flex flex-col items-center justify-center h-64 text-indigo-400">
              <Zap className="w-8 h-8 animate-pulse mb-4 opacity-50" />
              <p className="font-data text-xs tracking-widest animate-pulse">SCANNING MARKET...</p>
            </div>
          ) : stocks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-500">
              <Activity className="w-8 h-8 mb-4 opacity-30" />
              <p className="font-data text-xs tracking-widest">NO STOCKS MATCH FILTERS</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {sortedStocks.map((stock: any) => {
                const chg = stock.change_per ?? 0;
                let cardClass = 'v1-card-neutral';
                let textColor = 'text-amber-400';
                let Icon = Minus;

                if (chg > 0) {
                  cardClass = 'v1-card-up';
                  textColor = 'text-emerald-400';
                  Icon = TrendingUp;
                } else if (chg < 0) {
                  cardClass = 'v1-card-down';
                  textColor = 'text-rose-400';
                  Icon = TrendingDown;
                }

                return (
                  <div
                    key={stock.symbol_name}
                    onClick={() => onSelectStock?.(stock.symbol_name)}
                    className={cn(
                      cardClass,
                      "p-4 transition-all hover:shadow-[0_8px_30px_rgba(0,0,0,0.12)] cursor-pointer hover:scale-[1.01]"
                    )}
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h3 className="font-display text-lg font-bold text-white tracking-wide">{stock.symbol_name}</h3>
                        <div className={cn("flex items-center gap-1 font-data text-[11px] mt-1 font-bold", textColor)}>
                          <Icon className="w-3 h-3" />
                          {chg > 0 ? '+' : ''}{chg.toFixed(2)}% ({stock.change_value > 0 ? '+' : ''}{stock.change_value})
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-data text-lg font-bold text-slate-100">₹{stock.last_trade_price?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                        <div className="font-data text-[9px] text-slate-500 mt-1 uppercase">Vol: {stock.volume?.toLocaleString('en-IN')}</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 border-t border-slate-800/50 pt-3">
                      {Object.entries(stock).map(([key, value]) => {
                        if (['symbol_name', 'last_trade_price', 'change_value', 'change_per', 'volume'].includes(key)) return null;
                        if (value === null || value === undefined) return null;
                        const formattedValue = typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(2) : String(value);
                        const displayKey = key.replace(/_/g, ' ').toUpperCase();
                        return (
                          <div key={key} className="overflow-hidden">
                            <p className="font-data text-[9px] text-slate-500 truncate">{displayKey}</p>
                            <p className="font-data text-xs font-semibold text-slate-300 mt-0.5 truncate">{formattedValue}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : activeTab === 'ai' ? (
          /* AI Strategy Dashboard */
          <div className="space-y-6">
            <div className="v1-card p-5 mb-4">
              <h2 className="v1-title-section mb-2 flex items-center gap-2">
                <Brain className="w-4 h-4 text-indigo-400" />
                Decision Tree Strategy Optimizer
              </h2>
              <p className="text-xs text-slate-500 leading-relaxed font-data">
                The AI model continuously parses historical EOD outcomes for all live screener combinations. It ranks filters and groups them to discover optimal multi-factor triggers.
              </p>
            </div>

            {loadingCombos ? (
              <div className="flex justify-center py-12">
                <Zap className="w-6 h-6 text-indigo-500 animate-spin" />
              </div>
            ) : !optimalCombos || !optimalCombos.optimal_combinations?.length ? (
              <div className="text-center py-12 text-slate-500 font-data text-xs">
                No optimal combinations computed yet. Please execute <code>live_screener_optimizer.py</code>.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {optimalCombos.optimal_combinations.map((combo: any, idx: number) => {
                  const wr = combo.win_rate * 100;
                  const ret = combo.avg_return;
                  const backtest = findBacktestForCombo(combo.filters);

                  // Classification
                  let actionText = "HOLD";
                  let actionColor = "text-slate-400 border-slate-800 bg-slate-950/40";
                  if (wr >= 70 && ret >= 1.5) {
                    actionText = "STRONG BUY (AI)";
                    actionColor = "text-emerald-400 border-emerald-500/30 bg-emerald-500/5";
                  } else if (wr >= 60 && ret > 0.5) {
                    actionText = "BULLISH";
                    actionColor = "text-indigo-400 border-indigo-500/30 bg-indigo-500/5";
                  }

                  return (
                    <div key={idx} className="v1-card p-5 flex flex-col justify-between hover:border-slate-700/60 transition-all">
                      <div>
                        {/* Title & recommendation tag */}
                        <div className="flex justify-between items-start gap-4 mb-4">
                          <span className="font-data text-xs text-indigo-400 font-bold">Strategy #{idx + 1}</span>
                          <span className={cn("text-[9px] font-data font-bold px-2 py-0.5 rounded border font-display uppercase tracking-wider", actionColor)}>
                            {actionText}
                          </span>
                        </div>

                        {/* Combined Filters */}
                        <div className="flex flex-wrap gap-1.5 mb-5">
                          {combo.filters.map((f: string) => (
                            <code key={f} className="text-[10px] font-data bg-slate-850 px-2 py-1 rounded text-slate-300 border border-slate-800/80">{f}</code>
                          ))}
                        </div>

                        {/* Stats block */}
                        <div className="grid grid-cols-3 gap-2 bg-slate-950/40 border border-slate-900 rounded-lg p-3 mb-4">
                          <div>
                            <p className="font-data text-[9px] text-slate-500 uppercase">Win Rate</p>
                            <p className="font-data text-sm font-bold text-emerald-400 mt-0.5">{wr.toFixed(1)}%</p>
                          </div>
                          <div>
                            <p className="font-data text-[9px] text-slate-500 uppercase">Avg Return (3d)</p>
                            <p className="font-data text-sm font-bold text-slate-200 mt-0.5">+{ret.toFixed(2)}%</p>
                          </div>
                          <div>
                            <p className="font-data text-[9px] text-slate-500 uppercase">Sample Count</p>
                            <p className="font-data text-sm font-bold text-slate-400 mt-0.5">{combo.sample_count}</p>
                          </div>
                        </div>

                        {/* Backtest matching block */}
                        <div className="border-t border-slate-800/50 pt-4 mt-2">
                          <h4 className="text-[10px] font-data font-bold text-slate-400 font-display uppercase tracking-widest flex items-center gap-1.5 mb-2.5">
                            <BarChart2 className="w-3.5 h-3.5 text-indigo-400" />
                            Historical Backtest Performance
                          </h4>
                          {backtest ? (
                            <div className="grid grid-cols-2 gap-3 font-data text-xs text-slate-300">
                              <div className="flex justify-between items-center bg-slate-900/20 p-2 rounded">
                                <span className="text-slate-500 text-[10px]">TOTAL RETURN:</span>
                                <span className="font-bold text-emerald-400">+{backtest.total_return_pct.toFixed(2)}%</span>
                              </div>
                              <div className="flex justify-between items-center bg-slate-900/20 p-2 rounded">
                                <span className="text-slate-500 text-[10px]">ALPHA VS NIFTY:</span>
                                <span className="font-bold text-indigo-400">+{backtest.alpha_pct.toFixed(2)}%</span>
                              </div>
                              <div className="flex justify-between items-center bg-slate-900/20 p-2 rounded">
                                <span className="text-slate-500 text-[10px]">WIN RATE:</span>
                                <span className="font-bold text-slate-200">{(backtest.win_rate * 100).toFixed(0)}%</span>
                              </div>
                              <div className="flex justify-between items-center bg-slate-900/20 p-2 rounded">
                                <span className="text-slate-500 text-[10px]">SHARPE RATIO:</span>
                                <span className="font-bold text-indigo-300">{backtest.sharpe_ratio.toFixed(2)}</span>
                              </div>
                            </div>
                          ) : (
                            <div className="bg-slate-950/20 border border-slate-800/40 rounded p-3 text-[10px] font-data text-slate-500 text-center">
                              No backtest run resolved. Execute <code>backtest_live_screener.py</code> for this combo.
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Action triggers */}
                      <div className="mt-5 pt-3 border-t border-slate-800/50 flex items-center justify-between">
                        <span className="text-[10px] font-data text-slate-500 flex items-center gap-1">
                          <Award className="w-3.5 h-3.5 text-amber-500" />
                          Rank #{idx + 1}
                        </span>
                        <button
                          onClick={() => applyCombo(combo.filters)}
                          className="bg-indigo-600 hover:bg-indigo-500 text-white font-data text-xs font-bold px-4 py-2 rounded-lg transition-all flex items-center gap-1.5"
                        >
                          <Play className="w-3 h-3 fill-current" /> Apply Filter Combo
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          /* Intraday Edge — NiftyTrader live screener ranked by same-day (return_intraday) outcomes.
             Fully separate from the AI tab above: that one optimizes for the 1d/3d/5d swing
             horizon, this one for the same-day exit an intraday trade would actually take. */
          <div className="space-y-6">
            <div className="v1-card p-5 mb-4">
              <h2 className="v1-title-section mb-2 flex items-center gap-2">
                <Target className="w-4 h-4 text-indigo-400" />
                Intraday Edge Ranking
              </h2>
              <p className="text-xs text-slate-500 leading-relaxed font-data">
                Stocks matching NiftyTrader filters as of the latest 15-min collection cycle. Ranked by a
                gradient-boosted classifier's learned <strong>same-day</strong> win-probability once trained
                (backtested against actual EOD screener stock movement, retrained daily, gated so a worse
                retrain never replaces a better one); falls back to the single-best-filter win-rate / avg-return
                rule (min 3 resolved samples) until then. Distinct from the AI Strategy tab, which optimizes
                for a 1-5 day swing horizon.
              </p>
              {intradaySignals?.asOf && (
                <p className="text-[10px] font-data text-slate-600 mt-2 flex items-center gap-1.5">
                  <Clock className="w-3 h-3" /> Live matches as of {new Date(intradaySignals.asOf).toLocaleString('en-IN')}
                </p>
              )}
              {mlModelStatus ? (
                <div className="mt-3 pt-3 border-t border-slate-800/50 flex flex-wrap items-center gap-x-5 gap-y-1 text-[10px] font-data text-slate-400">
                  <span className="text-indigo-300 font-bold font-display uppercase tracking-wider">ML Ranker Active</span>
                  <span>Held-out AUC: <strong className="text-slate-200">{mlModelStatus.test_auc?.toFixed(3)}</strong></span>
                  {mlModelStatus.cv_auc != null && <span>CV AUC: <strong className="text-slate-200">{mlModelStatus.cv_auc.toFixed(3)}</strong></span>}
                  <span>Base rate: <strong className="text-slate-200">{(mlModelStatus.base_rate * 100).toFixed(1)}%</strong></span>
                  <span>Trained on: <strong className="text-slate-200">{mlModelStatus.n_samples}</strong> samples</span>
                  <span>{new Date(mlModelStatus.trained_at).toLocaleString('en-IN')}</span>
                  {mlModelStatus.live_auc != null && (
                    <span>
                      Live AUC ({mlModelStatus.live_auc_rows} resolved):{' '}
                      <strong className={mlModelStatus.live_edge_proven ? 'text-emerald-300' : 'text-rose-300'}>
                        {mlModelStatus.live_auc.toFixed(3)}
                      </strong>
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-[10px] font-data text-slate-600 mt-3 pt-3 border-t border-slate-800/50">
                  No trained ML model yet — execute <code>live_screener_ml_ranker.py --train</code> once enough
                  same-day outcomes have resolved. Ranking below falls back to the single-best-filter rule until then.
                </p>
              )}
              {/* 2026-08-07: live_edge_proven === false means the deployed model has been
                  live-graded against real resolved outcomes and shown NO real discrimination
                  (measured: 0.4615 AUC over 671k rows) despite a respectable held-out test_auc
                  -- the classic CV/test-doesn't-survive-deployment gap this platform has hit
                  before. The backend already drops ml_win_probability entirely once this is
                  true (falls back to the rule-based ranking below); this banner explains why
                  the "ML XX%" badges disappeared rather than leaving it unexplained. */}
              {intradaySignals?.mlEdgeProven === false && (
                <div className="mt-3 pt-3 border-t border-rose-900/40 flex items-start gap-2 text-[10px] font-data text-rose-300">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>
                    Trained model shows <strong>no demonstrated live edge</strong> against actual
                    resolved outcomes — ML scores are hidden and ranking below uses the
                    rule-based single-best-filter fallback instead.
                  </span>
                </div>
              )}
            </div>

            {loadingIntradaySignals ? (
              <div className="flex justify-center py-12">
                <Zap className="w-6 h-6 text-indigo-500 animate-spin" />
              </div>
            ) : !intradaySignals?.stocks?.length ? (
              <div className="text-center py-12 text-slate-500 font-data text-xs">
                No live screener matches yet this cycle — the collector runs every 15 min during market hours.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {intradaySignals.stocks.map((s: any) => {
                  const chg = s.change_per ?? 0;
                  const hasEdge = s.best_sample_count > 0;
                  const hasMl = s.ml_win_probability !== null && s.ml_win_probability !== undefined;
                  const positive = hasMl ? s.ml_win_probability >= 0.5 : s.edge_score > 0;
                  const cardClass = !hasEdge && !hasMl ? 'v1-card-neutral' : positive ? 'v1-card-up' : 'v1-card-down';
                  return (
                    <div
                      key={s.symbol}
                      onClick={() => onSelectStock?.(s.symbol)}
                      className={cn(
                        cardClass,
                        "p-4 transition-all hover:shadow-[0_8px_30px_rgba(0,0,0,0.12)] cursor-pointer hover:scale-[1.01]"
                      )}
                    >
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <h3 className="font-display text-lg font-bold text-white tracking-wide">{s.symbol}</h3>
                          <div className={cn("flex items-center gap-1 font-data text-[11px] mt-1 font-bold", chg >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                            {chg >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            {chg > 0 ? '+' : ''}{chg.toFixed(2)}%
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-data text-lg font-bold text-slate-100">₹{s.price?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                          {hasMl && (
                            <div className={cn("font-data text-[10px] font-bold mt-1 px-1.5 py-0.5 rounded inline-block", s.ml_win_probability >= 0.5 ? 'text-emerald-400 bg-emerald-500/10' : 'text-amber-400 bg-amber-500/10')}>
                              ML {(s.ml_win_probability * 100).toFixed(0)}%
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="border-t border-slate-800/50 pt-3">
                        {hasEdge ? (
                          <>
                            <p className="font-data text-[9px] text-slate-500 uppercase mb-1">Best Setup</p>
                            <code className="text-[10px] font-data bg-slate-850 px-2 py-1 rounded text-indigo-300 border border-slate-800/80">{s.best_filter}</code>
                            <div className="grid grid-cols-3 gap-2 mt-3">
                              <div>
                                <p className="font-data text-[9px] text-slate-500 uppercase">Win Rate</p>
                                <p className={cn("font-data text-sm font-bold mt-0.5", s.best_win_rate >= 0.5 ? 'text-emerald-400' : 'text-amber-400')}>
                                  {(s.best_win_rate * 100).toFixed(0)}%
                                </p>
                              </div>
                              <div>
                                <p className="font-data text-[9px] text-slate-500 uppercase">Avg Return</p>
                                <p className={cn("font-data text-sm font-bold mt-0.5", s.best_avg_return >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                                  {s.best_avg_return >= 0 ? '+' : ''}{s.best_avg_return.toFixed(2)}%
                                </p>
                              </div>
                              <div>
                                <p className="font-data text-[9px] text-slate-500 uppercase">Samples</p>
                                <p className="font-data text-sm font-bold text-slate-400 mt-0.5">{s.best_sample_count}</p>
                              </div>
                            </div>
                          </>
                        ) : (
                          <p className="font-data text-[10px] text-slate-600">
                            Matched {s.filters.map((f: any) => f.filter_key).join(', ')} — no resolved same-day track record yet.
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Optimal intraday filter combinations (decision-tree, isolated from the swing model) */}
            <div className="pt-2">
              <h2 className="v1-title-section mb-4 flex items-center gap-2">
                <Brain className="w-4 h-4 text-indigo-400" />
                Optimal Intraday Filter Combinations
              </h2>
              {loadingIntradayCombos ? (
                <div className="flex justify-center py-8">
                  <Zap className="w-6 h-6 text-indigo-500 animate-spin" />
                </div>
              ) : !intradayCombos || !intradayCombos.optimal_combinations?.length ? (
                <div className="text-center py-8 text-slate-500 font-data text-xs">
                  No optimal intraday combinations computed yet. Please execute <code>live_screener_optimizer.py</code>.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {intradayCombos.optimal_combinations.map((combo: any, idx: number) => {
                    const wr = combo.win_rate * 100;
                    const backtest = findIntradayBacktestForCombo(combo.filters);
                    return (
                      <div key={idx} className="v1-card p-5 flex flex-col justify-between hover:border-slate-700/60 transition-all">
                        <div>
                          <div className="flex justify-between items-start gap-4 mb-4">
                            <span className="font-data text-xs text-indigo-400 font-bold">Intraday Strategy #{idx + 1}</span>
                            <span className={cn("text-[9px] font-data font-bold px-2 py-0.5 rounded border font-display uppercase tracking-wider",
                              wr >= 60 ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/5" : "text-slate-400 border-slate-800 bg-slate-950/40")}>
                              {wr >= 60 ? 'STRONG (AI)' : 'WATCH'}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1.5 mb-5">
                            {combo.filters.map((f: string) => (
                              <code key={f} className="text-[10px] font-data bg-slate-850 px-2 py-1 rounded text-slate-300 border border-slate-800/80">{f}</code>
                            ))}
                          </div>
                          <div className="grid grid-cols-3 gap-2 bg-slate-950/40 border border-slate-900 rounded-lg p-3 mb-4">
                            <div>
                              <p className="font-data text-[9px] text-slate-500 uppercase">Win Rate</p>
                              <p className="font-data text-sm font-bold text-emerald-400 mt-0.5">{wr.toFixed(1)}%</p>
                            </div>
                            <div>
                              <p className="font-data text-[9px] text-slate-500 uppercase">Avg Return (same-day)</p>
                              <p className="font-data text-sm font-bold text-slate-200 mt-0.5">{combo.avg_return >= 0 ? '+' : ''}{combo.avg_return.toFixed(2)}%</p>
                            </div>
                            <div>
                              <p className="font-data text-[9px] text-slate-500 uppercase">Samples</p>
                              <p className="font-data text-sm font-bold text-slate-400 mt-0.5">{combo.sample_count}</p>
                            </div>
                          </div>
                          <div className="border-t border-slate-800/50 pt-4 mt-2">
                            <h4 className="text-[10px] font-data font-bold text-slate-400 font-display uppercase tracking-widest flex items-center gap-1.5 mb-2.5">
                              <BarChart2 className="w-3.5 h-3.5 text-indigo-400" />
                              Historical Backtest Performance
                            </h4>
                            {backtest ? (
                              <div className="grid grid-cols-2 gap-3 font-data text-xs text-slate-300">
                                <div className="flex justify-between items-center bg-slate-900/20 p-2 rounded">
                                  <span className="text-slate-500 text-[10px]">TOTAL RETURN:</span>
                                  <span className="font-bold text-emerald-400">{backtest.total_return_pct >= 0 ? '+' : ''}{backtest.total_return_pct.toFixed(2)}%</span>
                                </div>
                                <div className="flex justify-between items-center bg-slate-900/20 p-2 rounded">
                                  <span className="text-slate-500 text-[10px]">ALPHA VS NIFTY:</span>
                                  <span className="font-bold text-indigo-400">{backtest.alpha_pct >= 0 ? '+' : ''}{backtest.alpha_pct.toFixed(2)}%</span>
                                </div>
                                <div className="flex justify-between items-center bg-slate-900/20 p-2 rounded">
                                  <span className="text-slate-500 text-[10px]">WIN RATE:</span>
                                  <span className="font-bold text-slate-200">{(backtest.win_rate * 100).toFixed(0)}%</span>
                                </div>
                                <div className="flex justify-between items-center bg-slate-900/20 p-2 rounded">
                                  <span className="text-slate-500 text-[10px]">SHARPE RATIO:</span>
                                  <span className="font-bold text-indigo-300">{backtest.sharpe_ratio.toFixed(2)}</span>
                                </div>
                              </div>
                            ) : (
                              <div className="bg-slate-950/20 border border-slate-800/40 rounded p-3 text-[10px] font-data text-slate-500 text-center">
                                No backtest run resolved. Execute <code>backtest_live_screener.py --intraday</code> for this combo.
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="mt-5 pt-3 border-t border-slate-800/50 flex items-center justify-between">
                          <span className="text-[10px] font-data text-slate-500 flex items-center gap-1">
                            <Award className="w-3.5 h-3.5 text-amber-500" />
                            Rank #{idx + 1}
                          </span>
                          <button
                            onClick={() => applyCombo(combo.filters)}
                            className="bg-indigo-600 hover:bg-indigo-500 text-white font-data text-xs font-bold px-4 py-2 rounded-lg transition-all flex items-center gap-1.5"
                          >
                            <Play className="w-3 h-3 fill-current" /> Apply Filter Combo
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
