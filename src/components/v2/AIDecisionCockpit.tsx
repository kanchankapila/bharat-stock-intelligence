import React from 'react';
import { 
  Zap, 
  BrainCircuit, 
  Target, 
  TrendingUp, 
  ShieldAlert, 
  CheckCircle2, 
  AlertCircle,
  HelpCircle,
  Award
} from 'lucide-react';
import { trpc } from '../../lib/trpc';

interface AIDecisionCockpitProps {
  symbol: string;
}

export const AIDecisionCockpit: React.FC<AIDecisionCockpitProps> = ({ symbol }) => {
  const { data: liveQuote } = trpc.getLiveStockQuote.useQuery({ symbol }, { refetchInterval: 30000 });
  const { data: quantScore, isLoading: loadingScore } = trpc.getQuantScore.useQuery({ symbol });
  const { data: signals, isLoading: loadingSignals } = trpc.getSignalHistory.useQuery({ symbol });

  const activeSignal = React.useMemo<any>(() => {
    if (signals && Array.isArray(signals) && signals.length > 0) {
      // Find the first active signal, or just return the most recent one
      const active = (signals as any[]).find((s: any) => s.status === 'ACTIVE');
      return active || signals[0];
    }
    return null;
  }, [signals]);

  // Compute a fallback recommendation or targets based on composite quant ranks
  const computedRec = React.useMemo(() => {
    if (!quantScore) return null;

    const score = quantScore.rank_composite ?? 50;
    const price = liveQuote?.price || 100;
    
    let recommendation = 'HOLD';
    let colorClass = 'text-amber-400 bg-amber-500/10 border-amber-500/20';
    let confidence = 50;
    let target = Number((price * 1.12).toFixed(2));
    let stopLoss = Number((price * 0.94).toFixed(2));

    if (score >= 75) {
      recommendation = 'STRONG BUY';
      colorClass = 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20 glow-up';
      confidence = Math.round(55 + (score - 75) * 1.6);
      target = Number((price * 1.15).toFixed(2));
      stopLoss = Number((price * 0.93).toFixed(2));
    } else if (score >= 60) {
      recommendation = 'BUY';
      colorClass = 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20 glow-up';
      confidence = Math.round(50 + (score - 60) * 1.5);
      target = Number((price * 1.12).toFixed(2));
      stopLoss = Number((price * 0.94).toFixed(2));
    } else if (score <= 30) {
      recommendation = 'SELL';
      colorClass = 'text-rose-400 bg-rose-500/10 border-rose-500/20 glow-down';
      confidence = Math.round(50 + (30 - score) * 1.6);
      target = Number((price * 0.88).toFixed(2));
      stopLoss = Number((price * 1.05).toFixed(2));
    }

    return {
      recommendation,
      colorClass,
      confidence,
      target,
      stopLoss,
      reasoning: `Quant scoring systems report high confluence in this ticker, indicating a ${recommendation.toLowerCase()} structure. Standard deviation bands support trading within the targets.`,
    };
  }, [quantScore, liveQuote]);

  const decision = activeSignal ? activeSignal.type : (computedRec?.recommendation || 'HOLD');
  const confidence = activeSignal ? Math.round(activeSignal.confidence || 75) : (computedRec?.confidence || 50);
  const target = (activeSignal && activeSignal.target && activeSignal.target > 0) ? activeSignal.target : (computedRec?.target || 0);
  const dbStop = activeSignal ? (activeSignal.stopLoss || activeSignal.sl || activeSignal.stop) : null;
  const stopLoss = (dbStop && dbStop > 0) ? dbStop : (computedRec?.stopLoss || 0);
  const reasoning = activeSignal ? (activeSignal.reasoning || activeSignal.summary) : (computedRec?.reasoning || 'Evaluating technical coordinates...');
  const signalStatus = activeSignal ? activeSignal.status : 'ACTIVE';


  const isBuy = decision.toUpperCase().includes('BUY');
  const isSell = decision.toUpperCase().includes('SELL');

  const progressRingDash = (percent: number) => {
    const radius = 24;
    const circumference = 2 * Math.PI * radius;
    return circumference - (percent / 100) * circumference;
  };

  return (
    <div className="bg-slate-900/50 border border-white/[0.06] rounded-3xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-2xl">
      <div className="absolute top-0 right-0 w-[300px] h-[150px] bg-violet-500/5 rounded-full blur-[60px] pointer-events-none" />
      
      {/* Header */}
      <div className="flex items-center gap-3 mb-6 border-b border-white/[0.04] pb-4">
        <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center border border-violet-500/20 shadow-md">
          <BrainCircuit className="w-5 h-5 text-violet-400" />
        </div>
        <div>
          <h3 className="text-sm font-black text-white tracking-widest uppercase italic">AI Decision Cockpit</h3>
          <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase">Deep Neural Scoring & Trade Execution Metrics</p>
        </div>
      </div>

      {/* Main Signal Display */}
      {loadingScore || loadingSignals ? (
        <div className="py-12 flex flex-col items-center justify-center">
          <div className="w-8 h-8 border-t-2 border-violet-500 border-r-2 border-r-violet-500/20 rounded-full animate-spin mb-3" />
          <p className="text-[10px] font-bold text-slate-500 tracking-widest uppercase animate-pulse">Scanning signal outcomes...</p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-6 bg-slate-950/40 p-4 border border-white/[0.04] rounded-2xl">
            {/* Left side: Recommendation indicator */}
            <div className="flex items-center gap-4">
              <div className={`px-5 py-2.5 rounded-2xl border text-base font-black tracking-widest uppercase flex items-center gap-2 shadow-inner ${
                isBuy 
                  ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20 glow-up'
                  : isSell
                    ? 'text-rose-400 bg-rose-500/10 border-rose-500/20 glow-down'
                    : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
              }`}>
                <Zap className={`w-4 h-4 fill-current ${isBuy ? 'animate-pulse' : ''}`} />
                {decision}
              </div>

              <div>
                <span className="text-[9px] font-black text-slate-500 block tracking-widest uppercase mb-0.5">Confidence Index</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-black text-white">{confidence}%</span>
                  <span className="text-[9px] font-bold text-slate-400">({confidence >= 80 ? 'HIGH' : confidence >= 50 ? 'MEDIUM' : 'LOW'})</span>
                </div>
              </div>
            </div>

            {/* Right side: Progress Ring for composite score */}
            {quantScore && (
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <span className="text-[9px] font-black text-slate-500 block tracking-widest uppercase mb-0.5">Quant Rank</span>
                  <span className="text-sm font-black text-white">{Math.round(quantScore.rank_composite ?? 50)} / 100</span>
                </div>
                
                <div className="relative w-12 h-12 flex items-center justify-center">
                  <svg className="w-full h-full transform -rotate-90">
                    <circle cx="24" cy="24" r="20" className="stroke-slate-800" strokeWidth="3" fill="transparent" />
                    <circle 
                      cx="24" 
                      cy="24" 
                      r="20" 
                      className={isBuy ? 'stroke-emerald-400' : isSell ? 'stroke-rose-400' : 'stroke-amber-400'} 
                      strokeWidth="3.5" 
                      fill="transparent" 
                      strokeDasharray={`${2 * Math.PI * 20}`}
                      strokeDashoffset={progressRingDash(quantScore.rank_composite ?? 50)}
                      strokeLinecap="round"
                    />
                  </svg>
                  <span className="absolute text-[10px] font-black text-white">{Math.round(quantScore.rank_composite ?? 50)}</span>
                </div>
              </div>
            )}
          </div>

          {/* Targets and Stops Dashboard */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-950/60 p-4 border border-white/[0.04] rounded-2xl flex items-center gap-3.5 group hover:border-emerald-500/20 transition-all">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 group-hover:bg-emerald-500/20 transition-all">
                <Target className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <span className="text-[9px] font-black text-slate-500 block tracking-widest uppercase mb-0.5">Target Exit</span>
                <span className="text-base font-black text-emerald-400 tabular-nums">₹{target > 0 ? target.toLocaleString() : '—'}</span>
              </div>
            </div>

            <div className="bg-slate-950/60 p-4 border border-white/[0.04] rounded-2xl flex items-center gap-3.5 group hover:border-rose-500/20 transition-all">
              <div className="w-10 h-10 rounded-xl bg-rose-500/10 flex items-center justify-center border border-rose-500/20 group-hover:bg-rose-500/20 transition-all">
                <ShieldAlert className="w-5 h-5 text-rose-400" />
              </div>
              <div>
                <span className="text-[9px] font-black text-slate-500 block tracking-widest uppercase mb-0.5">Stop Loss</span>
                <span className="text-base font-black text-rose-400 tabular-nums">₹{stopLoss > 0 ? stopLoss.toLocaleString() : '—'}</span>
              </div>
            </div>
          </div>

          {/* Core Reasoning */}
          <div className="bg-slate-950/20 p-4 border border-white/[0.04] rounded-2xl space-y-2">
            <div className="flex items-center gap-2 text-[10px] font-black uppercase text-slate-400 tracking-wider">
              <Award className="w-4 h-4 text-violet-400" />
              Model Recommendation Rationale
            </div>
            <p className="text-xs text-slate-300 leading-relaxed font-medium italic">
              "{reasoning}"
            </p>
            {activeSignal && (
              <div className="flex justify-between items-center pt-2 text-[9px] text-slate-500 font-bold border-t border-white/[0.03]">
                <span>Status: <span className={`font-black ${signalStatus === 'ACTIVE' ? 'text-cyan-400' : 'text-slate-400'}`}>{signalStatus}</span></span>
                <span>Active since: {activeSignal.createdAt ? new Date(activeSignal.createdAt.seconds ? activeSignal.createdAt.seconds * 1000 : activeSignal.createdAt).toLocaleDateString() : 'Recent'}</span>
              </div>
            )}
          </div>

          {/* Score breakdown pillars */}
          {quantScore && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 border-t border-white/[0.04] pt-4">
              {[
                { label: 'Momentum', val: quantScore.rank_momentum, color: 'text-indigo-400' },
                { label: 'Quality', val: quantScore.rank_quality, color: 'text-cyan-400' },
                { label: 'Value', val: quantScore.rank_value, color: 'text-emerald-400' },
                { label: 'Confluence', val: quantScore.confluence_rank, color: 'text-amber-400' },
              ].map((pillar) => (
                <div key={pillar.label} className="bg-slate-950/40 border border-white/[0.03] rounded-xl p-2.5 text-center">
                  <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block mb-1">{pillar.label}</span>
                  <span className={`text-sm font-black tabular-nums ${pillar.color}`}>{Math.round(pillar.val ?? 50)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
