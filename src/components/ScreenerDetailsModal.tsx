import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  X, TrendingUp, TrendingDown, Filter, ExternalLink, 
  Search, ArrowUpRight, ArrowDownRight, Zap, Activity 
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

interface ScreenerDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  screener: {
    id: string;
    name: string;
    sentiment: 'bullish' | 'bearish' | 'neutral';
    source: string;
    screenpk: string;
    description?: string;
  } | null;
  onSelectStock: (symbol: string) => void;
}

const ScreenerDetailsModal: React.FC<ScreenerDetailsModalProps> = ({ 
  isOpen, 
  onClose, 
  screener,
  onSelectStock
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  // Fetch stocks for this screener
  const { data: screenerData, isLoading, error } = trpc.getTrendlyneScreener.useQuery(
    { 
      screenpk: screener?.screenpk || '', 
      screenerName: screener?.name || '' 
    },
    { enabled: !!screener && isOpen }
  );

  const stocks = screenerData?.data || [];
  const filteredStocks = stocks.filter(s => 
    s.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    s.stockId.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (s.symbol && s.symbol.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  if (!isOpen || !screener) return null;

  const isBullish = screener.sentiment === 'bullish';
  const isBearish = screener.sentiment === 'bearish';

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
        {/* Backdrop */}
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-slate-950/80 backdrop-blur-md"
        />

        {/* Modal Content */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          className="relative w-full max-w-4xl max-h-[85vh] bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col"
        >
          {/* Header */}
          <div className="p-6 border-b border-slate-800 flex flex-wrap items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-2">
                <div className={cn(
                  "p-2 rounded-xl",
                  isBullish ? "bg-emerald-500/10 text-emerald-500" :
                  isBearish ? "bg-rose-500/10 text-rose-500" :
                  "bg-slate-800 text-slate-400"
                )}>
                  {isBullish ? <TrendingUp className="w-5 h-5" /> : 
                   isBearish ? <TrendingDown className="w-5 h-5" /> : 
                   <Filter className="w-5 h-5" />}
                </div>
                <div>
                  <h2 className="text-xl font-black text-white uppercase italic tracking-tight leading-none truncate">
                    {screener.name}
                  </h2>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest bg-slate-800 px-2 py-0.5 rounded">
                      Source: {screener.source}
                    </span>
                    <span className={cn(
                      "text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded",
                      isBullish ? "text-emerald-400 bg-emerald-500/10" :
                      isBearish ? "text-rose-400 bg-rose-500/10" :
                      "text-slate-400 bg-slate-800"
                    )}>
                      {screener.sentiment}
                    </span>
                  </div>
                </div>
              </div>
              {screener.description && (
                <p className="text-xs text-slate-400 font-medium leading-relaxed italic">
                  {screener.description}
                </p>
              )}
            </div>
            <button 
              onClick={onClose}
              className="p-2 hover:bg-slate-800 rounded-xl transition-colors text-slate-500 hover:text-white"
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* Search bar */}
          <div className="px-6 py-4 bg-slate-900/50 border-b border-slate-800/50 flex items-center gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input 
                type="text" 
                placeholder="Search stocks in this screener..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-blue-500/50"
              />
            </div>
            <div className="flex items-center gap-2 text-[10px] font-black text-slate-500 uppercase tracking-widest whitespace-nowrap">
              <Activity className="w-3 h-3" />
              {filteredStocks.length} Results
            </div>
          </div>

          {/* Stocks Content */}
          <div className="flex-1 overflow-y-auto p-6 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
            {isLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 animate-pulse">
                {[1, 2, 3, 4, 5, 6].map(i => (
                  <div key={i} className="h-24 bg-slate-800/50 rounded-2xl border border-slate-800" />
                ))}
              </div>
            ) : error ? (
              <div className="py-20 text-center">
                <Activity className="w-12 h-12 text-slate-800 mx-auto mb-4" />
                <p className="text-slate-500 text-sm font-bold uppercase tracking-widest">Failed to load screener results</p>
              </div>
            ) : filteredStocks.length === 0 ? (
              <div className="py-20 text-center">
                <Search className="w-12 h-12 text-slate-800 mx-auto mb-4" />
                <p className="text-slate-500 text-sm font-bold uppercase tracking-widest">No stocks found matching your search</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredStocks.map((stock) => (
                  <motion.div
                    key={stock.stockId}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    onClick={() => {
                      onSelectStock(stock.symbol || stock.stockId);
                      onClose();
                    }}
                    className="p-4 bg-slate-950/50 border border-slate-800 rounded-2xl hover:border-blue-500/30 hover:bg-slate-900 transition-all cursor-pointer group"
                  >
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <h4 className="text-sm font-black text-white group-hover:text-blue-400 transition-colors uppercase italic leading-none">
                          {stock.symbol || stock.stockId}
                        </h4>
                        <p className="text-[10px] text-slate-500 font-bold uppercase truncate max-w-[150px] mt-1.5">
                          {stock.name}
                        </p>
                      </div>
                      <div className="p-1.5 bg-slate-900 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity">
                        <ArrowUpRight className="w-3 h-3 text-blue-500" />
                      </div>
                    </div>

                    <div className="flex items-end justify-between">
                      <div>
                        <p className="text-[8px] font-black text-slate-600 uppercase tracking-widest mb-0.5">Price</p>
                        <p className="text-lg font-black text-white tabular-nums italic tracking-tighter leading-none">
                          ₹{stock.ltp.toLocaleString()}
                        </p>
                      </div>
                      <div className={cn(
                        "flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-black tabular-nums italic",
                        stock.changePercent >= 0 ? "text-emerald-400 bg-emerald-500/10" : "text-rose-400 bg-rose-500/10"
                      )}>
                        {stock.changePercent >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                        {Math.abs(stock.changePercent).toFixed(2)}%
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-4 bg-slate-950 border-t border-slate-800 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <Zap className="w-3 h-3 text-blue-500" />
              <span className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em]">AlphaQuant Intelligent Engine</span>
            </div>
            <button 
              onClick={onClose}
              className="text-[10px] font-black text-slate-400 hover:text-white uppercase tracking-widest px-4 py-2 bg-slate-900 rounded-xl transition-colors border border-slate-800"
            >
              Close Window
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default ScreenerDetailsModal;
