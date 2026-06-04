import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { trpc } from '../lib/trpc';
import { Activity, Zap, TrendingUp, TrendingDown, Minus, Filter, X } from 'lucide-react';
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

  const { data, isLoading } = trpc.getLiveMarketScreener.useQuery(filters, {
    refetchInterval: 10000,
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
  const sortedStocks = [...stocks].sort((a, b) => (b.change_per ?? 0) - (a.change_per ?? 0));

  return (
    <div className="flex flex-col h-[600px] glass border border-slate-800/50 rounded-xl p-6 text-slate-200">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold font-['Rajdhani'] flex items-center gap-3">
            <Activity className="w-6 h-6 text-indigo-400" />
            Live Market Screener
          </h1>
          <p className="text-xs font-mono text-slate-500 mt-1 uppercase tracking-widest">
            {stocks.length} Matches Found
          </p>
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-lg font-mono text-xs font-bold transition-all",
            activeCount > 0 ? "bg-indigo-600/20 text-indigo-400 border border-indigo-500/30" : "bg-slate-800 text-slate-400 border border-slate-700"
          )}
        >
          <Filter className="w-4 h-4" />
          {showFilters ? 'Hide Filters' : 'Show Filters'}
          {activeCount > 0 && <span className="bg-indigo-500 text-white rounded-full px-2 py-0.5 ml-1">{activeCount}</span>}
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
                <h3 className="text-sm font-bold font-['Rajdhani'] uppercase tracking-wider text-slate-400">Active Filters</h3>
                {activeCount > 0 && (
                  <button onClick={clearFilters} className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1">
                    <X className="w-3 h-3" /> Clear All
                  </button>
                )}
              </div>
              
              <div className="space-y-6">
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

      {/* Results Grid */}
      <div className="flex-1 overflow-y-auto hide-scrollbar">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-64 text-indigo-400">
            <Zap className="w-8 h-8 animate-pulse mb-4 opacity-50" />
            <p className="font-mono text-xs tracking-widest animate-pulse">SCANNING MARKET...</p>
          </div>
        ) : stocks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-slate-500">
            <Activity className="w-8 h-8 mb-4 opacity-30" />
            <p className="font-mono text-xs tracking-widest">NO STOCKS MATCH FILTERS</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {sortedStocks.map((stock: any) => {
              const chg = stock.change_per ?? 0;
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
                  key={stock.symbol_name} 
                  onClick={() => onSelectStock?.(stock.symbol_name)}
                  className={cn(
                    "rounded-xl border p-4 transition-all hover:shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-sm cursor-pointer hover:scale-[1.01]",
                    borderColor, bgColor
                  )}
                >
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="font-['Rajdhani'] text-lg font-bold text-white tracking-wide">{stock.symbol_name}</h3>
                      <div className={cn("flex items-center gap-1 font-mono text-[11px] mt-1 font-bold", textColor)}>
                        <Icon className="w-3 h-3" />
                        {chg > 0 ? '+' : ''}{chg.toFixed(2)}% ({stock.change_value > 0 ? '+' : ''}{stock.change_value})
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-lg font-bold text-slate-100">₹{stock.last_trade_price?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                      <div className="font-mono text-[9px] text-slate-500 mt-1 uppercase">Vol: {stock.volume?.toLocaleString('en-IN')}</div>
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
                          <p className="font-mono text-[9px] text-slate-500 truncate">{displayKey}</p>
                          <p className="font-mono text-xs font-semibold text-slate-300 mt-0.5 truncate">{formattedValue}</p>
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
