import React from 'react';
import { trpc } from '../../../lib/trpc';
import { ArrowUpRight, ArrowDownRight, ShieldCheck, ShieldAlert, Crosshair, Zap } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

interface V3QuantSwotWidgetProps {
  symbol: string;
}

export const V3QuantSwotWidget: React.FC<V3QuantSwotWidgetProps> = ({ symbol }) => {
  const { data: swotData, isLoading } = trpc.getTrendlyneSwot.useQuery({ symbol }, { refetchInterval: 60000 });

  if (isLoading) {
    return (
      <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800 rounded-2xl p-6 h-[400px] flex items-center justify-center">
         <div className="w-8 h-8 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
      </div>
    );
  }

  const strengths = swotData?.strengths || [];
  const weaknesses = swotData?.weaknesses || [];

  return (
    <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800 rounded-2xl p-6 shadow-2xl h-[500px] flex flex-col">
      <div className="flex items-center gap-2 text-indigo-400 mb-6 shrink-0">
         <Crosshair className="w-5 h-5" />
         <h3 className="font-bold text-sm uppercase tracking-widest">Algorithmic SWOT</h3>
      </div>

      <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-6">
        {/* Strengths */}
        <div>
          <div className="flex items-center gap-2 mb-3">
             <div className="w-6 h-6 rounded-full bg-emerald-500/10 flex items-center justify-center">
                <ArrowUpRight className="w-4 h-4 text-emerald-500" />
             </div>
             <h4 className="text-xs font-bold text-emerald-400 uppercase tracking-widest">Bullish Factors</h4>
             <span className="ml-auto text-xs font-black text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full">{strengths.length}</span>
          </div>
          <ul className="space-y-2">
            <AnimatePresence>
              {strengths.slice(0, 5).map((s: string, idx: number) => (
                <motion.li 
                  key={`s-${idx}`}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="flex items-start gap-2 bg-slate-800/30 p-2.5 rounded-lg border border-slate-800/50"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
                  <span className="text-xs text-slate-300 font-medium leading-relaxed">{s}</span>
                </motion.li>
              ))}
            </AnimatePresence>
            {strengths.length === 0 && <p className="text-xs text-slate-500 italic px-2">No significant bullish factors identified.</p>}
          </ul>
        </div>

        {/* Weaknesses */}
        <div>
          <div className="flex items-center gap-2 mb-3">
             <div className="w-6 h-6 rounded-full bg-rose-500/10 flex items-center justify-center">
                <ArrowDownRight className="w-4 h-4 text-rose-500" />
             </div>
             <h4 className="text-xs font-bold text-rose-400 uppercase tracking-widest">Bearish Factors</h4>
             <span className="ml-auto text-xs font-black text-rose-500 bg-rose-500/10 px-2 py-0.5 rounded-full">{weaknesses.length}</span>
          </div>
          <ul className="space-y-2">
            <AnimatePresence>
              {weaknesses.slice(0, 5).map((w: string, idx: number) => (
                <motion.li 
                  key={`w-${idx}`}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="flex items-start gap-2 bg-slate-800/30 p-2.5 rounded-lg border border-slate-800/50"
                >
                  <ShieldAlert className="w-3.5 h-3.5 text-rose-500 mt-0.5 shrink-0" />
                  <span className="text-xs text-slate-300 font-medium leading-relaxed">{w}</span>
                </motion.li>
              ))}
            </AnimatePresence>
             {weaknesses.length === 0 && <p className="text-xs text-slate-500 italic px-2">No significant bearish factors identified.</p>}
          </ul>
        </div>
      </div>
    </div>
  );
};
