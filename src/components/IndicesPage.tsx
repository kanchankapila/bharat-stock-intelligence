import React from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight, ArrowDownRight, Activity } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { IndexDetailPage } from './IndexDetailPage';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

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
  const { data: advDecData } = trpc.getIndexAdvanceDecline.useQuery(undefined, { refetchInterval: 60000 });

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
            <div key={i} className="h-24 glass border border-slate-800/50 rounded-2xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-black text-white uppercase tracking-tight mb-1">Market Indices</h1>
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Live Indian Market Intelligence — Click any index for details</p>
      </div>

      {advDecData?.data && Array.isArray(advDecData.data) && (
        <div className="glass border border-slate-800/50 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-4 h-4 text-purple-400" />
            <h2 className="text-sm font-black text-white uppercase tracking-widest">Market Breadth (Advance/Decline)</h2>
          </div>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={advDecData.data} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorAdv" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorDec" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#f43f5e" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                <XAxis dataKey="time" hide />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '0.5rem', fontSize: '10px' }}
                  labelFormatter={() => ''}
                  formatter={(value, name) => [value, name === 'advances' ? 'Advances' : 'Declines']}
                />
                <Area type="monotone" dataKey="advances" stroke="#10b981" fillOpacity={1} fill="url(#colorAdv)" />
                <Area type="monotone" dataKey="declines" stroke="#f43f5e" fillOpacity={1} fill="url(#colorDec)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {indicesList.map(group => (
        <div key={group.name}>
          <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4 pl-1">{group.name}</h2>
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
                      "glass border rounded-2xl p-4 text-left transition-all hover:shadow-lg group",
                      up ? "border-slate-800/50 hover:border-emerald-500/30" : "border-slate-800/50 hover:border-rose-500/30"
                    )}
                  >
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2 group-hover:text-slate-400 transition-colors line-clamp-2 leading-relaxed">
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
