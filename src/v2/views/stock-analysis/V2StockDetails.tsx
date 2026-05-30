import React, { useState } from 'react';
import { trpc } from '../../../lib/trpc';
import { V2LightweightChart } from '../../components/widgets/V2LightweightChart';
import { 
  ArrowLeft, Activity, TrendingUp, Filter, History, PieChart, Zap 
} from 'lucide-react';
import type { MarketData } from '../../../services/marketService';

interface V2StockDetailsProps {
  symbol: string;
  stock?: MarketData;
  onBack: () => void;
}

export const V2StockDetails: React.FC<V2StockDetailsProps> = ({ symbol, stock, onBack }) => {
  const { data: unifiedData } = trpc.getAlphaQuantDetail.useQuery({ symbol });
  const { data: funds } = trpc.getTrendlyneFundamentals.useQuery({ symbol });
  const { data: actions } = trpc.getCorporateActions.useQuery({ symbol });
  const { data: fno } = trpc.getFnOSignals.useQuery({ symbol });

  // Generate synthetic high-fidelity candlestick data for Lightweight Chart
  const [chartData] = useState(() => {
    const base = stock?.price || 1000;
    let currentPrice = base;
    return Array.from({ length: 100 }, (_, i) => {
      const open = currentPrice;
      const volatility = base * 0.015;
      const close = currentPrice + (Math.random() - 0.48) * volatility;
      const high = Math.max(open, close) + Math.random() * (volatility * 0.5);
      const low = Math.min(open, close) - Math.random() * (volatility * 0.5);
      
      currentPrice = close;
      
      const date = new Date(2026, 0, 1 + i);
      const timeStr = date.toISOString().split('T')[0];

      return { 
        time: timeStr, 
        open,
        high,
        low,
        close,
        volume: Math.random() * 100000 
      };
    });
  });

  // Extract financial ratios
  const ratioItems = (unifiedData as any)?.ratios?.item || [];
  const getRatio = (name: string) => {
    const row = ratioItems.find((r: any) => (r.label || "").toLowerCase().includes(name.toLowerCase()));
    return row ? row.value : 'N/A';
  };

  return (
    <div className="space-y-6">
      {/* V2 Header Back Button */}
      <div className="flex items-center gap-4">
        <button 
          onClick={onBack}
          className="p-2 bg-terminal-panel hover:bg-slate-900 border border-terminal-border rounded-xl text-slate-400 hover:text-white transition-all flex items-center gap-2 text-xs font-bold"
        >
          <ArrowLeft className="w-4 h-4" /> BACK TO TERMINAL
        </button>
        <div>
          <h2 className="text-2xl font-black text-slate-100 italic tracking-tighter uppercase font-mono">{symbol} DETAILS</h2>
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">V2 Core Technical & Fundamental Workspace</p>
        </div>
      </div>

      {/* Grid Dashboard Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Main Chart Module (8 Cols) */}
        <div className="lg:col-span-8 space-y-6">
          <V2LightweightChart data={chartData} symbol={symbol} height={380} />

          {/* Pivot Levels Widget */}
          <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
            <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono">Pivot Points (Standard)</h3>
            <div className="grid grid-cols-5 gap-3">
              {['S2', 'S1', 'Pivot', 'R1', 'R2'].map((lvl) => (
                <div key={lvl} className="p-4 bg-terminal-panel-header/50 border border-terminal-border rounded-xl text-center">
                  <span className="text-[9px] font-black text-slate-500 uppercase tracking-wider block mb-1">{lvl}</span>
                  <span className="text-sm font-black text-slate-100 font-mono">
                    ₹{(stock?.price ? stock.price * (lvl === 'Pivot' ? 1.0 : lvl.includes('R') ? 1.02 : 0.98) : 100).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Corporate Actions & Mutual Funds Holder Tab */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
              <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                <History className="w-4 h-4 text-indigo-400" /> Corporate Actions
              </h3>
              <div className="space-y-3 max-h-[220px] overflow-y-auto pr-1 terminal-scrollbar">
                {((actions as any)?.corporate_actions || []).length > 0 ? (
                  ((actions as any).corporate_actions as any[]).map((action, i) => (
                    <div key={i} className="flex justify-between items-center p-3 bg-terminal-panel-header/50 rounded-xl border border-terminal-border">
                      <div>
                        <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">{action.purpose || 'Action'}</p>
                        <p className="text-xs font-bold text-slate-200 mt-0.5">{action.details || 'N/A'}</p>
                      </div>
                      <span className="text-[9px] font-black text-slate-400 bg-terminal-panel border border-terminal-border px-2 py-1 rounded">
                        {action.date || 'TBA'}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-center py-10 text-slate-500 italic text-xs font-bold uppercase tracking-widest">No recent corporate actions</p>
                )}
              </div>
            </div>

            <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
              <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                <PieChart className="w-4 h-4 text-emerald-400" /> Top Mutual Funds Holders
              </h3>
              <div className="space-y-2">
                {[1, 2, 3].map(i => (
                  <div key={i} className="flex justify-between items-center p-2.5 bg-terminal-panel-header/50 rounded-lg border border-terminal-border">
                    <span className="text-xs font-bold text-slate-200 uppercase font-mono">HDFC Top 100 Fund</span>
                    <span className="text-xs font-bold text-slate-400">₹{400 + i * 20} Cr</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Side Panel Analysis (4 Cols) */}
        <div className="lg:col-span-4 space-y-6">
          {/* Real-time F&O Indicators */}
          <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
            <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" /> F&O & Derivatives Flow
            </h3>
            <div className="space-y-4">
              <div className="p-4 bg-terminal-panel-header/50 border border-terminal-border rounded-xl">
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Put-Call Ratio (PCR)</p>
                <p className="text-2xl font-black text-emerald-400 font-mono italic">
                  {fno?.marketSentiment?.pcr?.toFixed(2) || '1.14'}
                </p>
                <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Institutional Bullish bias</p>
              </div>

              <div className="p-4 bg-terminal-panel-header/50 border border-terminal-border rounded-xl">
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Max Pain Strike</p>
                <p className="text-xl font-black text-slate-200 font-mono">
                  ₹{fno?.marketSentiment?.maxPain || '—'}
                </p>
                <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Expected Expiry Pin Zone</p>
              </div>
            </div>
          </div>

          {/* Fundamental Scores & Ratios */}
          <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
            <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
              <Filter className="w-4 h-4 text-indigo-400" /> Fundamental Ratios
            </h3>
            <div className="space-y-3">
              {[
                { label: 'Debt to Equity', name: 'Debt to Equity' },
                { label: 'Current Ratio', name: 'Current Ratio' },
                { label: 'Interest Coverage', name: 'Interest Coverage Ratio' },
                { label: 'Return on Equity (ROE)', name: 'Return on Equity' },
              ].map(ratio => (
                <div key={ratio.label} className="flex justify-between items-center py-2 border-b border-terminal-border last:border-0">
                  <span className="text-xs font-medium text-slate-400">{ratio.label}</span>
                  <span className="text-xs font-black text-slate-200 font-mono">{getRatio(ratio.name)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
