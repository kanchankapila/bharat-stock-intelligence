
import React from 'react';
import { Card } from '../../../components/Card';
import { cn } from '../../../lib/utils';

export const ConfluenceSignalCard = ({ signal }: { signal: any }) => {
  const isHigh = signal.conviction_level === 'High';

  return (
    <Card className="bg-slate-800/40 border-slate-700/50">
      <div className="flex flex-row items-center justify-between pb-2">
        <span className="text-sm font-medium text-slate-300">Confluence Signal</span>
        <span className={cn(
          "text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-tighter whitespace-nowrap",
          isHigh ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"
        )}>
          {signal.conviction_level}
        </span>
      </div>
      <div className="text-lg font-bold text-white">{signal.ai_conclusion}</div>
      <p className="text-xs text-slate-400 mt-1">{signal.trade_reasoning}</p>
      <div className="mt-4">
        <div className="text-xs text-slate-400">Confluence Score</div>
        <div className="font-bold text-white">{signal.confluence_score?.toFixed(2) ?? 'N/A'}</div>
      </div>
    </Card>
  );
};
