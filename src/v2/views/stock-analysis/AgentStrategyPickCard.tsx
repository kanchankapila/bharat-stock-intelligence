
import React from 'react';
import { Card } from '../../../components/Card';
import { cn } from '../../../lib/utils';
import { ArrowUp, ArrowDown } from 'lucide-react';

export const AgentStrategyPickCard = ({ pick }: { pick: any }) => {
  const isBullish = pick.conviction === 'High Conviction Buy' || pick.conviction === 'Buy';

  return (
    <Card className="bg-slate-800/40 border-slate-700/50">
      <div className="flex flex-row items-center justify-between pb-2">
        <span className="text-sm font-medium text-slate-300">{pick.timeframe}</span>
        <span className={cn(
          "flex items-center text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-tighter whitespace-nowrap",
          isBullish ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
        )}>
          {isBullish ? <ArrowUp className="mr-1 h-3 w-3" /> : <ArrowDown className="mr-1 h-3 w-3" />}
          {pick.conviction}
        </span>
      </div>
      <div className="text-2xl font-bold text-white">{pick.symbol}</div>
      <p className="text-xs text-slate-400 mt-1">{pick.narrative}</p>
      <div className="mt-4 grid grid-cols-3 gap-4 text-center">
        <div>
          <div className="text-xs text-slate-400">Entry Zone</div>
          <div className="font-bold text-white">{pick.entry_zone_low} - {pick.entry_zone_high}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400">Stop Loss</div>
          <div className="font-bold text-red-500">{pick.stop_loss}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400">Target 1</div>
          <div className="font-bold text-green-500">{pick.target_1}</div>
        </div>
      </div>
    </Card>
  );
};
