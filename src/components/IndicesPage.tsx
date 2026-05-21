import React from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { IndexDetailPage } from './IndexDetailPage';

export function extractIndexId(url: string): string | null {
  const m = url.match(/-(\d+)\.html$/);
  return m ? m[1] : null;
}

export const IndicesPage: React.FC<{ 
  onSelectStock: (symbol: string) => void;
  selectedIndex: { id: string; name: string } | null;
  setSelectedIndex: (idx: { id: string; name: string } | null) => void;
}> = ({ onSelectStock, selectedIndex, setSelectedIndex }) => {
  const { data: indicesData, isLoading } = trpc.getAllIndices.useQuery(undefined, { refetchInterval: 30000 });

  if (selectedIndex) {
    return (
      <IndexDetailPage
        indexId={selectedIndex.id}
        indexName={selectedIndex.name}
        onBack={() => setSelectedIndex(null)}
        onSelectStock={onSelectStock}
      />
    );
  }

  const raw = (indicesData as any)?.data;
  const indicesList: { name: string; list: any[] }[] = raw?.indiceList ?? [];

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-black text-white uppercase tracking-tight">Market Indices</h1>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-24 bg-slate-900 border border-slate-800 rounded-2xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-black text-white uppercase tracking-tight mb-1">Market Indices</h1>
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Live Indian Market Intelligence — Click any index for details</p>
      </div>

      {indicesList.map(group => (
        <div key={group.name}>
          <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-4 pl-1">{group.name}</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {group.list
              .filter((idx: any) => idx.name)
              .map((idx: any) => {
                const idxId = extractIndexId(idx.url);
                const changePct = parseFloat(idx.changePer ?? '0');
                const up = Number(idx.direction) === 1 || changePct >= 0;
                return (
                  <motion.button
                    key={idx.name + idx.url}
                    onClick={() => idxId && setSelectedIndex({ id: idxId, name: idx.name })}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className={cn(
                      "bg-slate-900 border rounded-2xl p-4 text-left transition-all hover:shadow-lg group",
                      up ? "border-slate-800 hover:border-emerald-500/30" : "border-slate-800 hover:border-rose-500/30"
                    )}
                  >
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-2 group-hover:text-slate-400 transition-colors line-clamp-2 leading-relaxed">
                      {idx.name}
                    </p>
                    <p className="text-base font-black text-white tabular-nums mb-1">{idx.value}</p>
                    <div className={cn("flex items-center gap-1 text-[10px] font-black", up ? "text-emerald-400" : "text-rose-400")}>
                      {up ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                      {up ? '+' : ''}{idx.change} ({up ? '+' : ''}{changePct.toFixed(2)}%)
                    </div>
                  </motion.button>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
};
