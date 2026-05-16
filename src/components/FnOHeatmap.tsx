import React from 'react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import { motion } from 'motion/react';
import { Activity, LayoutGrid } from 'lucide-react';

const FnOHeatmap: React.FC<{ onSelectStock: (s: string) => void }> = ({ onSelectStock }) => {
  const { data: heatmapData, isLoading } = trpc.getTrendlyneFnoHeatmap.useQuery(undefined, {
    staleTime: 300000 // 5 mins
  });

  if (isLoading) return <div className="h-96 bg-slate-900/50 animate-pulse rounded-3xl" />;

  const stocks = heatmapData?.data || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2">
          <LayoutGrid className="w-3 h-3" /> F&O Market Sentiment Map
        </h3>
        <div className="flex gap-2">
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-emerald-500 rounded-sm" />
            <span className="text-[8px] font-bold text-slate-600 uppercase">Longs</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-rose-500 rounded-sm" />
            <span className="text-[8px] font-bold text-slate-600 uppercase">Shorts</span>
          </div>
        </div>
      </div>

      {stocks.length > 0 ? (
        <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-10 lg:grid-cols-12 gap-1">
          {stocks.map((s: any, idx: number) => (
            <motion.div
              key={idx}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: idx * 0.005 }}
              onClick={() => onSelectStock(s.code)}
              className="aspect-square rounded-sm cursor-pointer relative group"
              style={{ backgroundColor: s.color }}
            >
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 z-10 rounded-sm">
                <span className="text-[8px] font-black text-white">{s.code}</span>
              </div>
              
              {/* Tooltip on hover */}
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-32 p-2 bg-slate-900 border border-slate-800 rounded-lg opacity-0 group-hover:opacity-100 transition-all pointer-events-none z-50 shadow-2xl">
                <p className="text-[10px] font-black text-white truncate">{s.name}</p>
                <div className="flex justify-between mt-1">
                  <span className="text-[8px] font-bold text-slate-500">Price:</span>
                  <span className={cn("text-[8px] font-black", s.current_change >= 0 ? "text-emerald-400" : "text-rose-400")}>
                    {s.current_change >= 0 ? '+' : ''}{s.current_change.toFixed(2)}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[8px] font-bold text-slate-500">OI Chg:</span>
                  <span className={cn("text-[8px] font-black", s.oi_change >= 0 ? "text-emerald-400" : "text-rose-400")}>
                    {s.oi_change >= 0 ? '+' : ''}{s.oi_change.toFixed(2)}%
                  </span>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="h-48 flex flex-col items-center justify-center bg-slate-900/30 border border-slate-800/50 rounded-3xl">
           <Activity className="w-8 h-8 text-slate-800 mb-3" />
           <p className="text-[10px] font-black text-slate-600 uppercase tracking-widest">Sectoral heatmap currently unavailable</p>
        </div>
      )}
    </div>
  );
};

export default FnOHeatmap;
