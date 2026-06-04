import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { trpc } from '../lib/trpc';
import { Activity, Zap, TrendingUp, TrendingDown, Minus, Filter, X } from 'lucide-react';
import { cn } from '../lib/utils';

// --- Filter Definitions for EOD ---
const FILTER_GROUPS = [
  {
    name: 'Moving Average Crossovers',
    keys: [
      '_5_20_sma_crossover_below', '_5_20_sma_crossover_above', '_20_50_sma_crossover_below', '_20_50_sma_crossover_above',
      '_20_100_sma_crossover_below', '_20_100_sma_crossover_above', '_50_100_sma_crossover_below', '_50_100_sma_crossover_above',
      '_50_200_sma_crossover_below', '_50_200_sma_crossover_above',
      'ema5_sma20_cross_below', 'ema5_sma20_cross_above', 'ema20_sma50_cross_below', 'ema20_sma50_cross_above',
      'ema50_sma100_cross_below', 'ema50_sma100_cross_above'
    ]
  },
  {
    name: 'Moving Average Levels',
    keys: [
      '_20_day_sma_below', '_20_day_sma_above', '_50_day_sma_below', '_50_day_sma_above', '_100_day_sma_below', '_100_day_sma_above',
      '_200_day_sma_below', '_200_day_sma_above', '_5_day_ema_below', '_5_day_ema_above', '_8_day_ema_below', '_8_day_ema_above',
      '_20_day_ema_below', '_20_day_ema_above', '_26_day_ema_below', '_26_day_ema_above', '_50_day_ema_below', '_50_day_ema_above',
      '_200_day_ema_below', '_200_day_ema_above'
    ]
  },
  {
    name: 'Candlestick Patterns',
    keys: [
      'doji_bullish', 'doji_bearish', 'engul_fing_bullish', 'engul_fing_bearish', 'harami_bullish', 'harami_bearish',
      'hammer_bullish', 'hammer_bearish', 'morning_star_bullish', 'evening_star_bearish', 'marubozu_bullish', 'marubozu_bearish',
      'inside_day', 'outside_day', 'nr4', 'nr7'
    ]
  },
  {
    name: 'Highs & Lows (5, 20, 50, 100, 200 Days)',
    keys: [
      'new_5_days_high_above', 'new_5_days_low_below', 'new_20_days_high_above', 'new_20_days_low_below',
      'new_50_days_high_above', 'new_50_days_low_below', 'new_100_days_high_above', 'new_100_days_low_below',
      'new_200_days_high_above', 'new_200_days_low_below'
    ]
  },
  {
    name: 'Oscillators (RSI, MACD, CCI, MFI)',
    keys: [
      'rsi_cross_30_below', 'rsi_cross_70_above', 'rsi_cross_20_below', 'rsi_cross_80_above',
      'macd_cross_below', 'macd_cross_above', 'macd_cross_above_zero', 'macd_cross_below_zero',
      'cci_100_above', 'cci_100_below', 'mfi_above_80', 'mfi_below_20'
    ]
  },
  {
    name: 'Bollinger Bands & ATR',
    keys: [
      'upper_bb_below', 'upper_bb_above', 'lower_bb_below', 'lower_bb_above',
      'atr_inc_3', 'atr_dec_3', 'atr_inc_5', 'atr_dec_5'
    ]
  }
];

interface Props {
  onSelectStock?: (symbol: string) => void;
}

export const EODMarketScreener: React.FC<Props> = ({ onSelectStock }) => {
  const [filters, setFilters] = useState<Record<string, boolean>>({});
  const [showFilters, setShowFilters] = useState(false);

  const { data, isLoading } = trpc.getEODMarketScreener.useQuery(filters, {
    refetchInterval: 60000, // EOD data changes less frequently
  });

  const toggleFilter = (key: string) => {
    setFilters(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  const clearFilters = () => setFilters({});

  const activeCount = Object.values(filters).filter(Boolean).length;
  const stocks = (data as any)?.resultData || [];
  const sortedStocks = [...stocks].sort((a, b) => (b.change_percent ?? 0) - (a.change_percent ?? 0));

  return (
    <div className="flex flex-col h-[600px] backdrop-blur-md bg-slate-900/30 border border-slate-800/50 rounded-xl p-6 text-slate-200">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold font-['Rajdhani'] flex items-center gap-3">
            <Activity className="w-6 h-6 text-violet-400" />
            EOD Market Screener
          </h1>
          <p className="text-xs font-mono text-slate-500 mt-1 uppercase tracking-widest">
            {stocks.length} Matches Found
          </p>
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-lg font-mono text-xs font-bold transition-all",
            activeCount > 0 ? "bg-violet-600/20 text-violet-400 border border-violet-500/30" : "bg-slate-800 text-slate-400 border border-slate-700"
          )}
        >
          <Filter className="w-4 h-4" />
          {showFilters ? 'Hide Filters' : 'Show Filters'}
          {activeCount > 0 && <span className="bg-violet-500 text-white rounded-full px-2 py-0.5 ml-1">{activeCount}</span>}
        </button>
      </div>

      {/* Filter Panel */}
      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden mb-6 flex-shrink-0"
          >
            <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-bold font-['Rajdhani'] uppercase tracking-wider text-slate-400">EOD Active Filters</h3>
                {activeCount > 0 && (
                  <button onClick={clearFilters} className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1">
                    <X className="w-3 h-3" /> Clear All
                  </button>
                )}
              </div>
              
              <div className="space-y-6 max-h-[300px] overflow-y-auto hide-scrollbar pr-2">
                {FILTER_GROUPS.map(group => (
                  <div key={group.name}>
                    <h4 className="text-xs font-mono text-slate-500 mb-3">{group.name}</h4>
                    <div className="flex flex-wrap gap-2">
                      {group.keys.map(key => {
                        const active = !!filters[key];
                        return (
                          <button
                            key={key}
                            onClick={() => toggleFilter(key)}
                            className={cn(
                              "text-[10px] font-mono px-3 py-1.5 rounded-md transition-all border",
                              active 
                                ? "bg-violet-600/20 text-violet-300 border-violet-500/50 shadow-[0_0_10px_rgba(139,92,246,0.1)]" 
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

      {/* Results Grid */}
      <div className="flex-1 overflow-y-auto hide-scrollbar">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-64 text-violet-400">
            <Zap className="w-8 h-8 animate-pulse mb-4 opacity-50" />
            <p className="font-mono text-xs tracking-widest animate-pulse">SCANNING EOD MARKET...</p>
          </div>
        ) : stocks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-slate-500">
            <Activity className="w-8 h-8 mb-4 opacity-30" />
            <p className="font-mono text-xs tracking-widest">NO STOCKS MATCH FILTERS</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {sortedStocks.map((stock: any) => {
              const chg = stock.change_percent ?? 0;
              let borderColor = 'border-amber-500/40';
              let bgColor = 'bg-amber-500/10';
              let textColor = 'text-amber-400';
              let Icon = Minus;

              if (chg > 0) {
                borderColor = 'border-emerald-500/50';
                bgColor = 'bg-emerald-500/10';
                textColor = 'text-emerald-400';
                Icon = TrendingUp;
              } else if (chg < 0) {
                borderColor = 'border-rose-500/50';
                bgColor = 'bg-rose-500/10';
                textColor = 'text-rose-400';
                Icon = TrendingDown;
              }

              return (
                <div 
                  key={stock.symbol} 
                  onClick={() => onSelectStock?.(stock.symbol)}
                  className={cn(
                    "rounded-xl border p-4 transition-all hover:shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-sm cursor-pointer hover:scale-[1.01]",
                    borderColor, bgColor
                  )}
                >
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="font-['Rajdhani'] text-lg font-bold text-white tracking-wide">{stock.symbol}</h3>
                      <div className={cn("flex items-center gap-1 font-mono text-[11px] mt-1 font-bold", textColor)}>
                        <Icon className="w-3 h-3" />
                        {chg > 0 ? '+' : ''}{chg.toFixed(2)}% ({stock.change > 0 ? '+' : ''}{stock.change})
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-lg font-bold text-slate-100">₹{stock.last_trade_price?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                      <div className="font-mono text-[9px] text-slate-500 mt-1 uppercase">Vol: {stock.t0_volume?.toLocaleString('en-IN')}</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 border-t border-slate-800/50 pt-3">
                    {Object.entries(stock).map(([key, value]) => {
                      if (['symbol', 'last_trade_price', 'change', 'change_percent', 'priceChange', 'priceChangePercentage', 't0_volume'].includes(key)) return null;
                      if (value === null || value === undefined) return null;
                      const formattedValue = typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(2) : String(value);
                      const displayKey = key.replace(/t0_/g, '').replace(/_/g, ' ').trim().toUpperCase();
                      return (
                        <div key={key} className="overflow-hidden">
                          <p className="font-mono text-[9px] text-slate-500 truncate">{displayKey}</p>
                          <p className="font-mono text-[10px] font-semibold text-slate-300 mt-0.5 truncate">{formattedValue}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
