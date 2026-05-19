import React from 'react';
import { Card } from './Card';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { PieChart, TrendingUp, TrendingDown } from 'lucide-react';

export const SectorHeatmap: React.FC<{ indexId?: string; className?: string }> = ({ indexId, className }) => {
  const { data: sectors, isLoading } = trpc.getSectorPerformance.useQuery({ indexId }, {
    refetchInterval: 60000,
    refetchOnWindowFocus: false,
  });

  if (isLoading || !sectors) return <div className={cn("h-72 bg-[#141416]/80 animate-pulse rounded-2xl", className)} />;

  return (
    <Card title="Sector Heatmap" icon={PieChart} className={cn("h-full", className)}>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 pt-2">
        {sectors.map((sector) => (
          <div 
            key={sector.name}
            className={cn(
              "p-2 rounded-lg border flex flex-col justify-between transition-all hover:scale-[1.02]",
              sector.change >= 0 
                ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-400" 
                : "bg-rose-500/5 border-rose-500/20 text-rose-400"
            )}
          >
            <span className="text-[9px] font-black uppercase tracking-widest text-zinc-400">{sector.name}</span>
            <div className="flex items-end justify-between mt-1">
              <span className="text-base font-black italic tracking-tighter truncate">
                {sector.change >= 0 ? '+' : ''}{sector.change.toFixed(2)}%
              </span>
              <span className="text-[7px] font-bold text-zinc-500">{sector.stocks}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

export const SectorPerformance: React.FC<{ className?: string }> = ({ className }) => {
  const { data, isLoading } = trpc.getMarketMapData.useQuery({ indId: '38' }); // Energy by default

  if (isLoading || !data) return <div className="h-40 bg-[#141416]/80 animate-pulse rounded-2xl" />;

  const sectors = (data as any)?.item || [];

  return (
    <Card title="Market Map (Sectors)" icon={PieChart} className={cn("h-full", className)}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {sectors.slice(0, 8).map((s: any) => (
          <div key={s.id} className="p-3 bg-[#0c0c0e] border border-white/[0.07] rounded-xl hover:border-white/[0.1] transition-all">
            <p className="text-[8px] font-black text-zinc-500 uppercase tracking-widest mb-1">{s.shortname}</p>
            <div className="flex items-center justify-between">
              <p className={cn(
                "text-base font-black italic tracking-tighter",
                s.direction === "1" ? "text-emerald-400" : "text-rose-400"
              )}>
                {s.percentchange}%
              </p>
              <div className={cn(
                "p-0.5 rounded",
                s.direction === "1" ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
              )}>
                {s.direction === "1" ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
              </div>
            </div>
            <p className="text-[7px] text-zinc-600 font-bold uppercase mt-1">Cap: ₹{s.mktcap} Cr</p>
          </div>
        ))}
      </div>
    </Card>
  );
};
