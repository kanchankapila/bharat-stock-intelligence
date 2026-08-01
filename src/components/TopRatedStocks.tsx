import React from 'react';
import { trpc } from '../lib/trpc';
import {
  Trophy, TrendingUp, TrendingDown, RefreshCw,
  Search, ExternalLink, Activity, Zap, CheckCircle2,
  AlertCircle, Star, Plus, Minus
} from 'lucide-react';
import { cn } from '../lib/utils';
import { motion } from 'motion/react';
import stockData from '../data/stocklist';
import { LegacyScoreBanner } from './CanonicalSourceNote';

interface ScoredStock {
  symbol?: string;
  timeframe?: string;
  stock_id?: string;
  score?: number;
  confidence?: number;
  classification?: string;
  top_domain?: string;
  position_size_pct?: number;
  positive_count?: number;
  negative_count?: number;
  reasons?: Array<{ name?: string; sentiment?: string; source?: string }>;
  last_updated?: string;
}

const RankingList: React.FC<{ 
  title: string; 
  stocks: ScoredStock[]; 
  isLoading: boolean;
  icon: React.ReactNode;
  subtitle: string;
  onSelectStock: (symbol: string) => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
}> = ({ title, stocks, isLoading, icon, subtitle, onSelectStock, watchlist = [], onToggleWatchlist }) => (
  <div className="space-y-6">
    <div className="flex items-center gap-3 px-2">
      <div className="w-8 h-8 rounded-lg glass border border-slate-800/50 flex items-center justify-center">
        {icon}
      </div>
      <div>
        <h2 className="text-sm font-black text-white uppercase tracking-widest">{title}</h2>
        <p className="text-[10px] text-slate-400 font-bold uppercase italic">{subtitle}</p>
      </div>
    </div>

    <div className="space-y-3">
      {stocks.map((stock, index) => (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.03 }}
          key={`${stock.symbol}-${stock.timeframe}`}
          onClick={() => onSelectStock(stock.symbol)}
          className="glass-strong border border-slate-800/30 rounded-2xl p-4 hover:border-blue-500/30 transition-all group relative overflow-hidden cursor-pointer animate-fade-in"
        >
          <div className="flex justify-between items-center relative z-10">
            <div className="flex items-center gap-4">
              <div className="w-8 h-8 glass rounded-lg flex items-center justify-center border border-slate-800/50 text-xs font-black text-slate-400 group-hover:text-blue-400 transition-all">
                #{index + 1}
              </div>
              
              <div className="flex items-center gap-3">
                {/* Watchlist toggle buttons */}
                <div onClick={(e) => e.stopPropagation()}>
                  {watchlist.includes(stock.symbol) ? (
                    <button
                      onClick={() => onToggleWatchlist(stock.symbol)}
                      className="p-1.5 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-500 hover:bg-rose-500 hover:text-indigo-600 transition-all shadow-md flex items-center justify-center w-7 h-7"
                      title="Remove from Watchlist"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={() => onToggleWatchlist(stock.symbol, { price: undefined, name: stockData.find(s => s.symbol.toUpperCase() === stock.symbol.toUpperCase())?.name, source: `Consensus: ${title}` })}
                      className="p-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-500 hover:bg-emerald-500 hover:text-indigo-600 transition-all shadow-md flex items-center justify-center w-7 h-7"
                      title="Add to Watchlist"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-black text-white italic uppercase tracking-tight leading-none truncate max-w-[180px]" title={stockData.find(s => s.symbol.toUpperCase() === stock.symbol.toUpperCase())?.name}>
                      {stockData.find(s => s.symbol.toUpperCase() === stock.symbol.toUpperCase())?.name || stock.symbol}
                    </h3>
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">
                      {stock.symbol}
                    </span>
                    <span className={cn(
                      "px-1.5 py-0.5 rounded text-[7px] font-black uppercase tracking-widest leading-none",
                      stock.classification.includes('Strong Buy') ? "bg-emerald-500/20 text-emerald-400" :
                      stock.classification.includes('Buy') ? "bg-emerald-500/10 text-emerald-500/80" :
                      "bg-slate-800 text-slate-400"
                    )}>
                      {stock.classification}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1.5">
                    <span className="text-[10px] font-black text-slate-400 uppercase">Score <span className="text-white">{stock.score.toFixed(1)}</span></span>
                    <span className="text-[10px] font-black text-slate-400 uppercase">Conf <span className="text-blue-400">{stock.confidence.toFixed(0)}%</span></span>
                    <span className="text-[10px] font-black text-blue-500/80 uppercase tracking-tighter bg-blue-500/5 px-1.5 py-0.5 rounded italic">Driver: {stock.top_domain}</span>
                    {(stock.position_size_pct ?? 0) > 0 && (
                      <span className="text-[10px] font-black text-emerald-400 uppercase tracking-tighter bg-emerald-500/10 px-1.5 py-0.5 rounded italic">Weight: {stock.position_size_pct!.toFixed(1)}%</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
            
            <div className="flex gap-2">
              <div className="text-center px-2 py-1 bg-emerald-500/5 border border-emerald-500/10 rounded-lg">
                <p className="text-emerald-500 text-xs font-black">{stock.positive_count}</p>
              </div>
              <div className="text-center px-2 py-1 bg-rose-500/5 border border-rose-500/10 rounded-lg">
                <p className="text-rose-500 text-xs font-black">{stock.negative_count}</p>
              </div>
            </div>
          </div>
        </motion.div>
      ))}
      
      {stocks.length === 0 && !isLoading && (
        <div className="text-center py-12 border border-dashed border-slate-800/50 rounded-3xl">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">No Signals Detected</p>
        </div>
      )}
    </div>
  </div>
);

const TopRatedStocks: React.FC<{ 
  onSelectStock: (symbol: string) => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
}> = ({ onSelectStock, watchlist = [], onToggleWatchlist }) => {
  const { data: longTermStocks, isLoading: isLoadingLT, refetch: refetchLT } = trpc.getTopRatedStocks.useQuery({ limit: 20, timeframe: 'long_term' }, { refetchInterval: 15 * 60_000 });
  const { data: intradayStocks, isLoading: isLoadingID, refetch: refetchID } = trpc.getTopRatedStocks.useQuery({ limit: 20, timeframe: 'intraday' }, { refetchInterval: 5 * 60_000 });
  const triggerStockScoring = trpc.triggerStockScoring.useMutation();

  const handleRecalculate = async () => {
    try {
      await triggerStockScoring.mutateAsync();
      refetchLT();
      refetchID();
    } catch (err) {
      console.error("Scoring trigger failed:", err);
    }
  };

  const isLoading = isLoadingLT || isLoadingID;

  if (isLoading && !longTermStocks && !intradayStocks) {
    return (
      <div className="flex flex-col items-center justify-center py-32 space-y-4">
        <RefreshCw className="w-12 h-12 text-blue-500 animate-spin" />
        <p className="text-slate-400 font-black uppercase tracking-[0.2em]">AlphaQuant Multi-Horizon Engine Syncing...</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-8 max-w-[1600px] mx-auto">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center border border-blue-500/20">
              <Trophy className="w-6 h-6 text-blue-500" />
            </div>
            <h1 className="text-4xl font-black text-white italic tracking-tighter uppercase">
              AlphaQuant <span className="text-blue-500">Intelligence</span>
            </h1>
          </div>
          <p className="text-slate-400 text-[10px] font-black uppercase tracking-[0.2em] flex items-center gap-2">
            <Zap className="w-3 h-3 text-amber-500" />
            FinBERT-Powered Multi-Factor Multi-Horizon Ranking
          </p>
        </div>

        <button
          onClick={handleRecalculate}
          disabled={triggerStockScoring.isPending}
          className="flex items-center gap-2 glass border border-slate-800/50 hover:border-blue-500/50 text-white px-6 py-3 rounded-2xl text-xs font-black uppercase tracking-widest transition-all group disabled:opacity-50"
        >
          <RefreshCw className={cn("w-4 h-4 transition-transform group-hover:rotate-180", triggerStockScoring.isPending && "animate-spin")} />
          {triggerStockScoring.isPending ? 'Syncing intelligence...' : 'Refresh All Scopes'}
        </button>
      </div>

      <LegacyScoreBanner note="Ranked from the per-timeframe scoring engine (stock_scores), computed separately from the unified cross-engine model -- check Alpha / Buy Recs for the canonical, regime-aware view of the same stocks." />

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-8">
        <div className="xl:col-span-3 grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Column 1: Long Term */}
          <RankingList 
            title="Institutional Long Term" 
            subtitle="Fundamental + Multi-Factor Consensus"
            stocks={longTermStocks || []} 
            isLoading={isLoadingLT}
            icon={<Trophy className="w-4 h-4 text-amber-500" />}
            onSelectStock={onSelectStock}
            watchlist={watchlist}
            onToggleWatchlist={onToggleWatchlist}
          />

          {/* Column 2: Intraday */}
          <RankingList 
            title="High-Velocity Intraday" 
            subtitle="Momentum + Volume + Technical Scans"
            stocks={intradayStocks || []} 
            isLoading={isLoadingID}
            icon={<Zap className="w-4 h-4 text-blue-500" />}
            onSelectStock={onSelectStock}
            watchlist={watchlist}
            onToggleWatchlist={onToggleWatchlist}
          />
        </div>

        <div className="space-y-6">
          <div className="glass/50 border border-slate-800/50 rounded-3xl p-6">
            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
              <Star className="w-3 h-3 text-blue-500" />
              Methodology
            </h3>
            <div className="space-y-4">
              <div className="p-3 glass-strong rounded-2xl border border-slate-800/50">
                <p className="text-[10px] font-black text-white uppercase mb-1 italic">FinBERT Sentiment Engine</p>
                <p className="text-[10px] text-slate-400 leading-relaxed font-medium italic">
                  Utilizes ProsusAI FinBERT deep learning models to perform high-fidelity semantic analysis of screeners, neutralizing bias and identifying institutional intent.
                </p>
              </div>
              <div className="p-3 glass-strong rounded-2xl border border-slate-800/50">
                <p className="text-[10px] font-black text-white uppercase mb-1 italic">Weight Distribution</p>
                <p className="text-[10px] text-slate-400 leading-relaxed font-medium italic">
                  Intraday rankings prioritize Volume Shockers and Breakouts. Long Term rankings prioritize ROE, Valuation, and Delivery.
                </p>
              </div>
            </div>
            
            <div className="mt-6 p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl">
              <p className="text-[10px] font-black text-amber-500 uppercase tracking-widest mb-1">Risk Warning</p>
              <p className="text-[10px] text-slate-300 italic leading-loose">
                Intraday signals are volatile and should be verified with live price action before execution.
              </p>
            </div>
          </div>

          <div className="glass/50 border border-slate-800/50 rounded-3xl p-6">
            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-4">Discovery Metrics</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="glass-strong p-3 rounded-2xl border border-slate-800/50 text-center">
                <p className="text-[9.5px] font-black text-slate-400 uppercase mb-1">LT Coverage</p>
                <p className="text-lg font-black text-white">{longTermStocks?.length || 0}</p>
              </div>
              <div className="glass-strong p-3 rounded-2xl border border-slate-800/50 text-center">
                <p className="text-[9.5px] font-black text-slate-400 uppercase mb-1">ID Signals</p>
                <p className="text-lg font-black text-white">{intradayStocks?.length || 0}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TopRatedStocks;
