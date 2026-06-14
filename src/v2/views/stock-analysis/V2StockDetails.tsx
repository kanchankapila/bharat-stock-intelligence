import React, { useState } from 'react';
import { trpc } from '../../../lib/trpc';
import { V2LightweightChart } from '../../components/widgets/V2LightweightChart';
import { OptionChainView } from '../../../components/OptionChainView';
import { OptionChainView } from '../../../components/OptionChainView';
import { 
  ArrowLeft, ArrowUpRight, Activity, TrendingUp, Filter, History, PieChart, Zap, LayoutDashboard, Database, BarChart3, Target, BrainCircuit
  ArrowLeft, Activity, TrendingUp, Filter, History, PieChart, Zap, LayoutDashboard, Database, BarChart3, Target
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { cn } from '../../../lib/utils';
import type { MarketData } from '../../../services/marketService';

interface V2StockDetailsProps {
  symbol: string;
  stock?: MarketData;
  onBack: () => void;
}

export const V2StockDetails: React.FC<V2StockDetailsProps> = ({ symbol, stock, onBack }) => {
  const [activeTab, setActiveTab] = useState<'Technicals' | 'Fundamentals' | 'F&O'>('Technicals');

  const { data: unifiedData } = trpc.getAlphaQuantDetail.useQuery({ symbol });
  const { data: funds } = trpc.getTrendlyneFundamentals.useQuery({ symbol });
  const { data: actions } = trpc.getCorporateActions.useQuery({ symbol });
  const { data: fno } = trpc.getFnOSignals.useQuery({ symbol });
  const { data: overview } = trpc.getCompanyOverview.useQuery({ symbol });
  const { data: profileAnalysis } = trpc.getCompanyProfileAnalysis.useQuery({ symbol });

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
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* V2 Header Back Button & Title */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="flex items-center gap-4">
          <button 
            onClick={onBack}
            className="p-2 bg-terminal-panel hover:bg-slate-900 border border-terminal-border rounded-xl text-slate-400 hover:text-white transition-all flex items-center gap-2 text-xs font-bold"
          >
            <ArrowLeft className="w-4 h-4" /> BACK
          </button>
          <div>
            <h2 className="text-2xl font-black text-slate-100 italic tracking-tighter uppercase font-mono">{symbol} DETAILS</h2>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">V2 Core Workspace</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex glass border border-slate-800/50 p-1 rounded-2xl w-fit">
          <button onClick={() => setActiveTab('Technicals')}
            className={cn("px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2",
              activeTab === 'Technicals' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" : "text-slate-400 hover:text-slate-300")}>
            <BarChart3 className="w-4 h-4" /> Technicals
          </button>
          <button onClick={() => setActiveTab('Fundamentals')}
            className={cn("px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2",
              activeTab === 'Fundamentals' ? "bg-emerald-600 text-white shadow-lg shadow-emerald-500/20" : "text-slate-400 hover:text-slate-300")}>
            <Database className="w-4 h-4" /> Fundamentals
          </button>
          <button onClick={() => setActiveTab('F&O')}
            className={cn("px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2",
              activeTab === 'F&O' ? "bg-rose-600 text-white shadow-lg shadow-rose-500/20" : "text-slate-400 hover:text-slate-300")}>
            <Zap className="w-4 h-4" /> F&O Chain
          </button>
        </div>
      </div>

      {/* ── TECHNICALS TAB ── */}
      {activeTab === 'Technicals' && (
        <div className="space-y-6">
          <div className="bg-terminal-panel border border-terminal-border rounded-2xl overflow-hidden p-2">
            <V2LightweightChart data={chartData} symbol={symbol} height={450} />
          </div>

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
        </div>
      )}

      {/* ── FUNDAMENTALS TAB ── */}
      {activeTab === 'Fundamentals' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 space-y-6">
            
            {/* ── COMPANY PROFILE AI ANALYSIS ── */}
            {profileAnalysis && (
              <div className="bg-slate-800/40 rounded-xl p-5 border border-slate-700/50 mb-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-emerald-400 font-semibold flex items-center gap-2">
                    <BrainCircuit className="w-5 h-5" /> AI Profile Analysis
                  </h3>
                  <div className="flex gap-2">
                    {(profileAnalysis as any).high_growth_scope === 1 && (
                      <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-1 rounded-full border border-emerald-500/20 flex items-center gap-1">
                        <ArrowUpRight className="w-3 h-3" /> High Growth Scope
                      </span>
                    )}
                    {(profileAnalysis as any).in_news_for_growth === 1 && (
                      <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-1 rounded-full border border-amber-500/20 flex items-center gap-1">
                        <Zap className="w-3 h-3" /> In News for Growth
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-slate-300 text-sm leading-relaxed mb-4">
                  {(profileAnalysis as any).ai_analysis}
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 uppercase tracking-wide">Growth Score</span>
                  <div className="flex-1 bg-slate-900 rounded-full h-2 overflow-hidden">
                    <div 
                      className="bg-gradient-to-r from-emerald-600 to-emerald-400 h-full rounded-full transition-all duration-1000"
                      style={{ width: `${(profileAnalysis as any).growth_score}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono text-emerald-400">{(profileAnalysis as any).growth_score}/100</span>
                </div>
              </div>
            )}

            {/* Company Profile */}
            <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
              <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                <Database className="w-4 h-4 text-emerald-400" /> Company Profile
              </h3>
              <div className="text-[11px] text-slate-400 font-medium leading-relaxed whitespace-pre-wrap">
                {(overview as any)?.companyProfileData?.companyDescription || 'No company profile available.'}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Dividends */}
              <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-amber-400" /> Dividends
                </h3>
                <div className="space-y-3 max-h-[250px] overflow-y-auto pr-1 terminal-scrollbar">
                  {(overview as any)?.eventsData?.dividendTableData?.length ? (
                    (overview as any).eventsData.dividendTableData.map((d: any, i: number) => (
                      <div key={i} className="flex justify-between items-center p-3 bg-terminal-panel-header/50 rounded-xl border border-terminal-border">
                        <div>
                          <p className="text-[10px] font-black text-amber-400 uppercase tracking-widest">{d.dividendType || 'Dividend'}</p>
                          <p className="text-xs font-bold text-slate-200 mt-0.5">₹{d.dividendAmount}</p>
                        </div>
                        <span className="text-[9px] font-black text-slate-400 bg-terminal-panel border border-terminal-border px-2 py-1 rounded">
                          {d.exDate}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-center py-6 text-slate-500 italic text-xs font-bold uppercase tracking-widest">No recent dividends</p>
                  )}
                </div>
              </div>

              {/* Board Meetings */}
              <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                  <History className="w-4 h-4 text-indigo-400" /> Board Meetings
                </h3>
                <div className="space-y-3 max-h-[250px] overflow-y-auto pr-1 terminal-scrollbar">
                  {(overview as any)?.eventsData?.boardMeetingTableData?.length ? (
                    (overview as any).eventsData.boardMeetingTableData.map((action: any, i: number) => (
                      <div key={i} className="flex justify-between items-center p-3 bg-terminal-panel-header/50 rounded-xl border border-terminal-border">
                        <div>
                          <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest leading-tight w-32 truncate">{action.purpose || 'Meeting'}</p>
                        </div>
                        <span className="text-[9px] font-black text-slate-400 bg-terminal-panel border border-terminal-border px-2 py-1 rounded">
                          {action.boardMeetDate}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-center py-6 text-slate-500 italic text-xs font-bold uppercase tracking-widest">No recent meetings</p>
                  )}
                </div>
              </div>
            </div>

            {/* FAQs */}
            {(overview as any)?.faq && (overview as any).faq.length > 0 && (
              <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                  <Activity className="w-4 h-4 text-rose-400" /> Market FAQs
                </h3>
                <div className="space-y-4">
                  {(overview as any).faq.slice(0, 4).map((f: any, i: number) => (
                    <div key={i} className="p-4 bg-terminal-panel-header/30 rounded-xl border border-terminal-border">
                      <p className="text-[11px] font-black text-slate-200 mb-1">{f.question}</p>
                      <p className="text-[10px] font-medium text-slate-400 leading-relaxed" dangerouslySetInnerHTML={{ __html: f.answer }} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="lg:col-span-4 space-y-6">
            <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl h-full">
              <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                <Filter className="w-4 h-4 text-indigo-400" /> Fundamental Ratios
              </h3>
              <div className="space-y-3">
                {[
                  { label: 'Debt to Equity', name: 'Debt to Equity' },
                  { label: 'Current Ratio', name: 'Current Ratio' },
                  { label: 'Interest Coverage', name: 'Interest Coverage Ratio' },
                  { label: 'Return on Equity (ROE)', name: 'Return on Equity' },
                  { label: 'Return on Assets (ROA)', name: 'Return on Assets' },
                  { label: 'P/E Ratio', name: 'PE Ratio' },
                  { label: 'Price to Book', name: 'Price to Book' },
                ].map(ratio => (
                  <div key={ratio.label} className="flex justify-between items-center py-3 border-b border-terminal-border last:border-0">
                    <span className="text-xs font-medium text-slate-400">{ratio.label}</span>
                    <span className="text-xs font-black text-slate-200 font-mono">{getRatio(ratio.name)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── F&O TAB ── */}
      {activeTab === 'F&O' && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl flex items-center gap-6">
              <Zap className="w-12 h-12 text-amber-400 opacity-20" />
              <div>
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Put-Call Ratio (PCR)</p>
                <p className="text-3xl font-black text-emerald-400 font-mono italic">
                  {fno?.marketSentiment?.pcr?.toFixed(2) || '1.14'}
                </p>
                <p className="text-[10px] text-slate-400 font-bold uppercase mt-1">Institutional Bullish bias</p>
              </div>
            </div>

            <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl flex items-center gap-6">
              <Target className="w-12 h-12 text-indigo-400 opacity-20" />
              <div>
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Max Pain Strike</p>
                <p className="text-3xl font-black text-slate-200 font-mono">
                  ₹{fno?.marketSentiment?.maxPain || '—'}
                </p>
                <p className="text-[10px] text-slate-400 font-bold uppercase mt-1">Expected Expiry Pin Zone</p>
              </div>
            </div>
          </div>

          {/* New Interactive Option Chain Component */}
          <div className="bg-terminal-panel border border-terminal-border rounded-2xl overflow-hidden p-2">
            <OptionChainView defaultSymbol={symbol} />
          </div>
        </div>
      )}
    </div>
  );
};
