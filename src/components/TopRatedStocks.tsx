import React from 'react';
import { trpc } from '../lib/trpc';
import { 
  Trophy, TrendingUp, TrendingDown, RefreshCw, 
  Search, ExternalLink, Activity, Zap, CheckCircle2,
  AlertCircle, Star
} from 'lucide-react';
import { cn } from '../lib/utils';
import { motion } from 'motion/react';

interface ScoredStock {
  symbol: string;
  stock_id: string;
  score: number;
  positive_count: number;
  negative_count: number;
  reasons: Array<{ name: string; sentiment: string }>;
  last_updated: string;
}

const TopRatedStocks: React.FC = () => {
  const { data: stocks, isLoading, refetch } = trpc.getTopRatedStocks.useQuery({ limit: 50 });
  const triggerScoring = trpc.triggerStockScoring.useMutation();

  const handleRecalculate = async () => {
    try {
      await triggerScoring.mutateAsync();
      refetch();
    } catch (err) {
      console.error("Scoring trigger failed:", err);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 space-y-4">
        <RefreshCw className="w-12 h-12 text-blue-500 animate-spin" />
        <p className="text-slate-500 font-black uppercase tracking-[0.2em]">Analyzing Market Sentiment...</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-8 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-amber-500/10 rounded-xl flex items-center justify-center border border-amber-500/20">
              <Trophy className="w-6 h-6 text-amber-500" />
            </div>
            <h1 className="text-4xl font-black text-white italic tracking-tighter uppercase">
              Top Rated <span className="text-blue-500">Intelligence</span>
            </h1>
          </div>
          <p className="text-slate-500 text-xs font-bold uppercase tracking-widest">
            Institutional-grade scoring based on Trendlyne screener aggregations
          </p>
        </div>

        <button
          onClick={handleRecalculate}
          disabled={triggerScoring.isPending}
          className="flex items-center gap-2 bg-slate-900 border border-slate-800 hover:border-blue-500/50 text-white px-6 py-3 rounded-2xl text-xs font-black uppercase tracking-widest transition-all group disabled:opacity-50"
        >
          <RefreshCw className={cn("w-4 h-4 transition-transform group-hover:rotate-180", triggerScoring.isPending && "animate-spin")} />
          {triggerScoring.isPending ? 'Syncing...' : 'Recalculate Scores'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-4">
          {stocks?.map((stock, index) => (
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.05 }}
              key={stock.symbol}
              className="bg-slate-950 border border-slate-800 rounded-3xl p-6 hover:border-blue-500/30 transition-all group relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
                <Star className="w-24 h-24 text-blue-500" />
              </div>

              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 relative z-10">
                <div className="flex items-center gap-5">
                  <div className="w-12 h-12 bg-slate-900 rounded-2xl flex items-center justify-center border border-slate-800 text-xl font-black text-blue-500 group-hover:bg-blue-500 group-hover:text-white transition-all">
                    {index + 1}
                  </div>
                  <div>
                    <h3 className="text-xl font-black text-white italic tracking-tight uppercase group-hover:text-blue-400 transition-colors">
                      {stock.symbol}
                    </h3>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Score</span>
                      <span className="text-sm font-black text-white tabular-nums">{stock.score.toFixed(1)}</span>
                      <div className="flex gap-1 h-1 w-24 bg-slate-900 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500" style={{ width: `${Math.min(100, stock.score * 10)}%` }} />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="text-center px-4 py-2 bg-emerald-500/5 border border-emerald-500/10 rounded-2xl">
                    <p className="text-emerald-500 text-lg font-black">{stock.positive_count}</p>
                    <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Bullish</p>
                  </div>
                  <div className="text-center px-4 py-2 bg-rose-500/5 border border-rose-500/10 rounded-2xl">
                    <p className="text-rose-500 text-lg font-black">{stock.negative_count}</p>
                    <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Bearish</p>
                  </div>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-2">
                {stock.reasons.slice(0, 6).map((reason, rid) => (
                  <span
                    key={rid}
                    className={cn(
                      "px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-tighter border italic transition-all",
                      reason.sentiment === 'positive' 
                        ? "bg-emerald-500/5 border-emerald-500/10 text-emerald-400/80 hover:bg-emerald-500/10" 
                        : reason.sentiment === 'negative'
                        ? "bg-rose-500/5 border-rose-500/10 text-rose-400/80 hover:bg-rose-500/10"
                        : "bg-slate-900 border-slate-800 text-slate-500 hover:bg-slate-800"
                    )}
                  >
                    {reason.name}
                  </span>
                ))}
                {stock.reasons.length > 6 && (
                  <span className="px-3 py-1.5 rounded-xl text-[9px] font-black bg-slate-900 border border-slate-800 text-slate-600 italic">
                    +{stock.reasons.length - 6} MORE
                  </span>
                )}
              </div>
            </motion.div>
          ))}

          {(!stocks || stocks.length === 0) && (
            <div className="text-center py-20 bg-slate-900/30 rounded-3xl border border-slate-800 border-dashed">
              <Activity className="w-12 h-12 text-slate-700 mx-auto mb-4" />
              <p className="text-slate-500 font-bold uppercase tracking-widest">No scored data available yet.</p>
              <button onClick={handleRecalculate} className="mt-4 text-blue-500 font-black uppercase text-xs hover:underline">
                Run First Scoring Scan
              </button>
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="bg-slate-900/50 border border-slate-800 rounded-3xl p-6">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
              <BrainCircuit className="w-4 h-4 text-blue-500" />
              Scoring Methodology
            </h3>
            <div className="space-y-5">
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                  <TrendingUp className="w-4 h-4 text-emerald-500" />
                </div>
                <div>
                  <p className="text-[10px] font-black text-white uppercase mb-1">Bullish Screens</p>
                  <p className="text-[10px] text-slate-500 leading-relaxed font-medium">
                    Screeners containing keywords like "Bullish", "Breakout", or "Strong Buy" contribute <span className="text-emerald-400 font-black">+1.0</span> points.
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-lg bg-rose-500/10 flex items-center justify-center shrink-0">
                  <TrendingDown className="w-4 h-4 text-rose-500" />
                </div>
                <div>
                  <p className="text-[10px] font-black text-white uppercase mb-1">Bearish Screens</p>
                  <p className="text-[10px] text-slate-500 leading-relaxed font-medium">
                    Screeners with keywords like "Bearish", "Fall", or "Overbought" subtract <span className="text-rose-400 font-black">-1.0</span> points.
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                  <Activity className="w-4 h-4 text-blue-500" />
                </div>
                <div>
                  <p className="text-[10px] font-black text-white uppercase mb-1">Neutral Screens</p>
                  <p className="text-[10px] text-slate-500 leading-relaxed font-medium">
                    Consolidation or high-volume neutral screens contribute <span className="text-blue-400 font-black">+0.1</span> points as stability indicators.
                  </p>
                </div>
              </div>
            </div>
            
            <div className="mt-8 p-4 bg-blue-600/10 border border-blue-500/20 rounded-2xl">
              <div className="flex items-center gap-2 mb-2">
                <Zap className="w-3 h-3 text-blue-400 fill-blue-400" />
                <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest">Alpha Insight</p>
              </div>
              <p className="text-[10px] text-slate-300 italic leading-loose">
                Stocks appearing in multiple conflicting screeners (High Bullish & High Bearish) indicate extreme volatility and institutional battlegrounds.
              </p>
            </div>
          </div>

          <div className="bg-slate-900/50 border border-slate-800 rounded-3xl p-6">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-4">Market Stats</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-950 p-3 rounded-2xl border border-slate-800">
                <p className="text-[8px] font-black text-slate-600 uppercase mb-1">Scanned</p>
                <p className="text-xl font-black text-white tabular-nums">{stocks?.length || 0}</p>
              </div>
              <div className="bg-slate-950 p-3 rounded-2xl border border-slate-800">
                <p className="text-[8px] font-black text-slate-600 uppercase mb-1">Avg Score</p>
                <p className="text-xl font-black text-white tabular-nums">
                  {(stocks?.reduce((a, b) => a + b.score, 0) || 0 / (stocks?.length || 1)).toFixed(1)}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// Mock Icons needed for the methodology section that were missing in the first import
const BrainCircuit = ({ className }: { className?: string }) => <Activity className={className} />;

export default TopRatedStocks;
