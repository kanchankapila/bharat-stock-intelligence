import React, { useMemo } from 'react';
import { Zap, Activity } from 'lucide-react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import { Card } from './Card';

// Extracted from App.tsx (2026-08-02 perf pass) so it's lazy-loaded instead of always
// bundled into the main entry chunk -- this tab only mounts when a user opens a stock's
// F&O tab.
export const V1FnOSignals: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: fno, isLoading } = trpc.getFnOSignals.useQuery({ symbol });

  const unusualSignals = useMemo(
    () => (fno?.signals ?? []).filter(s => s.type === 'UNUSUAL_VOLUME' || s.type === 'PCR_SIGNAL'),
    [fno?.signals],
  );
  const oiShiftSignals = useMemo(
    () => (fno?.signals ?? []).filter(s => s.type === 'OI_SPIKE' || s.type === 'BUILDUP'),
    [fno?.signals],
  );

  if (isLoading) return <div className="p-10 text-center animate-pulse text-slate-400">Scanning F&O Activity...</div>;
  if (!fno || !fno.success) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 glass-strong border border-slate-800/50 rounded-2xl">
          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Put-Call Ratio (PCR)</p>
          <p className={cn(
            "text-xl font-black italic",
            (fno.marketSentiment?.pcr ?? 0) > 1 ? "text-emerald-400" : "text-rose-400"
          )}>{fno.marketSentiment?.pcr?.toFixed(2) ?? '—'}</p>
          <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">{(fno.marketSentiment?.pcr ?? 0) > 1.2 ? 'Bullish Sentiment' : (fno.marketSentiment?.pcr ?? 0) < 0.8 ? 'Bearish Sentiment' : 'Neutral Zone'}</p>
        </div>
        <div className="p-4 glass-strong border border-slate-800/50 rounded-2xl">
          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Max Pain Strike</p>
          <p className="text-xl font-black text-white italic">₹{fno.marketSentiment?.maxPain ?? '—'}</p>
          <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Expected Expiry Zone</p>
        </div>
        <div className="p-4 glass-strong border border-slate-800/50 rounded-2xl">
          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Overall OI Trend</p>
          <p className="text-xl font-black text-blue-400 italic uppercase">{fno.marketSentiment?.oiTrend ?? '—'}</p>
          <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Positioning Analysis</p>
        </div>
        <div className="p-4 glass-strong border border-slate-800/50 rounded-2xl">
          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Active Signals</p>
          <p className="text-xl font-black text-white italic">{fno.signals?.length ?? 0}</p>
          <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Institutional Alerts</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card title="Unusual Options Activity" icon={Zap}>
          <div className="space-y-3 pt-2">
            {unusualSignals.map((sig, idx) => (
              <div key={idx} className="p-4 glass/50 border border-slate-800/80 rounded-2xl group hover:border-blue-500/30 transition-all">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      "w-2 h-2 rounded-full",
                      sig.sentiment === 'bullish' ? "bg-emerald-500" : "bg-rose-500"
                    )} />
                    <h5 className="text-[10px] font-black text-white uppercase tracking-widest">{sig.value}</h5>
                  </div>
                  <span className={cn(
                    "text-[8px] font-black px-2 py-0.5 rounded uppercase tracking-widest",
                    sig.confidence === 'high' ? "bg-blue-500/20 text-blue-400" : "bg-slate-800 text-slate-400"
                  )}>{sig.confidence} Confidence</span>
                </div>
                <p className="text-[11px] text-slate-400 font-medium leading-relaxed italic">{sig.description}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Significant OI Shifts" icon={Activity}>
           <div className="space-y-3 pt-2">
            {oiShiftSignals.map((sig, idx) => (
              <div key={idx} className="p-4 glass/50 border border-slate-800/80 rounded-2xl group hover:border-purple-500/30 transition-all">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      "w-2 h-2 rounded-full",
                      sig.sentiment === 'bullish' ? "bg-emerald-500" : "bg-rose-500"
                    )} />
                    <h5 className="text-[10px] font-black text-white uppercase tracking-widest">{sig.value}</h5>
                  </div>
                  <span className="text-[8px] font-black px-2 py-0.5 rounded bg-slate-800 text-slate-400 uppercase tracking-widest">{sig.type}</span>
                </div>
                <p className="text-[11px] text-slate-400 font-medium leading-relaxed italic">{sig.description}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
};

export default V1FnOSignals;
