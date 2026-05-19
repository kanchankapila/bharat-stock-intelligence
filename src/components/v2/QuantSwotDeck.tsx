import React, { useState } from 'react';
import { 
  Award, 
  AlertCircle, 
  Sparkles, 
  Flame, 
  Plus, 
  HelpCircle 
} from 'lucide-react';
import { trpc } from '../../lib/trpc';

interface QuantSwotDeckProps {
  symbol: string;
}

type SwotTab = 'strengths' | 'weaknesses' | 'opportunities' | 'threats';

export const QuantSwotDeck: React.FC<QuantSwotDeckProps> = ({ symbol }) => {
  const [activeTab, setActiveTab] = useState<SwotTab>('strengths');

  const { data: swot, isLoading } = trpc.getMcSwot.useQuery(
    { symbol },
    { enabled: !!symbol, refetchInterval: 3600000 } // SWOT changes very slowly, check once an hour
  );

  const stats = React.useMemo(() => {
    if (!swot) return { strengths: 0, weaknesses: 0, opportunities: 0, threats: 0 };
    return {
      strengths: swot.strengths?.length || 0,
      weaknesses: swot.weaknesses?.length || 0,
      opportunities: swot.opportunities?.length || 0,
      threats: swot.threats?.length || 0,
    };
  }, [swot]);

  const items = React.useMemo(() => {
    if (!swot) return [];
    return swot[activeTab] || [];
  }, [swot, activeTab]);

  const tabConfig = [
    { 
      id: 'strengths' as SwotTab, 
      label: 'Strengths', 
      count: stats.strengths,
      color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20 shadow-emerald-500/5',
      indicator: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
    },
    { 
      id: 'weaknesses' as SwotTab, 
      label: 'Weaknesses', 
      count: stats.weaknesses,
      color: 'text-amber-400 bg-amber-500/10 border-amber-500/20 shadow-amber-500/5',
      indicator: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]'
    },
    { 
      id: 'opportunities' as SwotTab, 
      label: 'Opportunities', 
      count: stats.opportunities,
      color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20 shadow-cyan-500/5',
      indicator: 'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)]'
    },
    { 
      id: 'threats' as SwotTab, 
      label: 'Threats', 
      count: stats.threats,
      color: 'text-rose-400 bg-rose-500/10 border-rose-500/20 shadow-rose-500/5',
      indicator: 'bg-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.6)]'
    },
  ];

  return (
    <div className="bg-slate-900/50 border border-white/[0.06] rounded-3xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-2xl">
      <div className="absolute top-0 right-0 w-[300px] h-[150px] bg-indigo-500/5 rounded-full blur-[60px] pointer-events-none" />
      
      {/* Header */}
      <div className="flex items-center gap-3 mb-6 border-b border-white/[0.04] pb-4">
        <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 shadow-md">
          <Award className="w-5 h-5 text-indigo-400" />
        </div>
        <div>
          <h3 className="text-sm font-black text-white tracking-widest uppercase italic">SWOT Matrix</h3>
          <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase">MoneyControl SWOT Business Health Indices</p>
        </div>
      </div>

      {/* Tabs list */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {tabConfig.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex flex-col items-center justify-center p-3 rounded-2xl border text-center transition-all cursor-pointer ${
              activeTab === tab.id
                ? tab.color
                : 'bg-slate-950/40 border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${
                activeTab === tab.id ? tab.indicator : 'bg-slate-700'
              }`} />
              <span className="text-[10px] font-black uppercase tracking-widest">{tab.label}</span>
            </div>
            <span className="text-base font-black tabular-nums">{tab.count}</span>
          </button>
        ))}
      </div>

      {/* Tab body content */}
      <div className="bg-slate-950/40 border border-white/[0.04] rounded-2xl p-5 min-h-[160px] flex flex-col justify-between">
        {isLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center py-8">
            <div className="w-6 h-6 border-t-2 border-indigo-500 border-r-2 border-r-indigo-500/20 rounded-full animate-spin mb-3" />
            <p className="text-[9px] font-bold text-slate-500 tracking-widest uppercase animate-pulse">Syncing corporate details...</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-8 text-center">
            <HelpCircle className="w-7 h-7 text-slate-700 mb-2" />
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
              No recorded {activeTab} for {symbol}
            </span>
          </div>
        ) : (
          <ul className="space-y-3 flex-1 overflow-y-auto max-h-[220px] pr-1 hide-scrollbar">
            {items.map((item, idx) => (
              <li 
                key={idx} 
                className="text-xs text-slate-300 font-medium leading-relaxed bg-white/[0.01] border border-white/[0.02] p-2.5 rounded-xl flex items-start gap-2.5 hover:border-white/[0.06] transition-all"
              >
                <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                  activeTab === 'strengths' ? 'bg-emerald-400' :
                  activeTab === 'weaknesses' ? 'bg-amber-400' :
                  activeTab === 'opportunities' ? 'bg-cyan-400' : 'bg-rose-400'
                }`} />
                {item}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 pt-3 border-t border-white/[0.03] text-[9px] font-bold text-slate-600 uppercase tracking-widest text-right">
          Last computed: today
        </div>
      </div>
    </div>
  );
};
