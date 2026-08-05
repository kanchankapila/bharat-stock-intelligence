import React, { useState } from 'react';
import { trpc } from '../../../lib/trpc';
import { AiInsightsTab } from './AiInsightsTab';
import { QuantFactorsTab } from './QuantFactorsTab';
import { WhyThisPick } from '../../../components/WhyThisPick';
import { V2LightweightChart } from '../../components/widgets/V2LightweightChart';
import { OptionChainView } from '../../../components/OptionChainView';
import {
  ArrowLeft, ArrowUpRight, Activity, TrendingUp, Filter, History, PieChart, Zap, LayoutDashboard, Database, BarChart3, Target, BrainCircuit, Lightbulb
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { MarketData } from '../../../services/marketService';
import type { QuantScores } from '../../../server/quantService';

interface V2StockDetailsProps {
  symbol: string;
  stock?: MarketData;
  onBack: () => void;
}

export const V2StockDetails: React.FC<V2StockDetailsProps> = ({ symbol, stock, onBack }) => {
  const [activeTab, setActiveTab] = useState<'Technicals' | 'Fundamentals' | 'F&O' | 'AI Insights' | 'Quant Factors'>('Technicals');

  const { data: unifiedData } = trpc.getAlphaQuantDetail.useQuery({ symbol });
  const { data: trendlyneOverview } = trpc.getTrendlyneOverview.useQuery({ symbol });
  const { data: actions } = trpc.getCorporateActions.useQuery({ symbol });
  const { data: fno } = trpc.getFnOSignals.useQuery({ symbol });
  const { data: overview } = trpc.getCompanyOverview.useQuery({ symbol });
  const { data: profileAnalysis } = trpc.getCompanyProfileAnalysis.useQuery({ symbol });
  const { data: niftyTraderData } = trpc.getNiftyTraderData.useQuery({ symbol });
  const { data: quantScores } = trpc.getQuantScores.useQuery({ symbol });
  const { data: aiInsights } = trpc.getAiInsights.useQuery({ symbol });

  // Real OHLCV chart data (Finding #75, 2026-07-28 audit): this used to generate 100
  // Math.random() candles. Now sourced from getOHLCData, the same procedure v4's
  // StockIntelligencePage already uses correctly.
  const { data: ohlcResp } = trpc.getOHLCData.useQuery({ symbol, dur: '6m' });
  const chartData = React.useMemo(() => {
    const rows: any[] = (ohlcResp as any)?.data ?? [];
    return rows.map((r: any) => ({
      time: r.time, open: Number(r.open), high: Number(r.high), low: Number(r.low),
      close: Number(r.close), volume: Number(r.volume) || 0,
    }));
  }, [ohlcResp]);

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
            <h2 className="text-2xl font-black text-slate-100 italic tracking-tighter uppercase font-mono">
              {symbol} <span className="text-slate-500 font-sans not-italic text-xl tracking-normal ml-2">
                {(() => {
                  if (stock?.name && stock.name !== symbol) return stock.name;
                  const peers = niftyTraderData?.industryData?.lstFinancires || [];
                  const currentPeer = peers.find((p: any) => p.symbol?.toUpperCase() === symbol.toUpperCase());
                  if (currentPeer?.company_Name) return currentPeer.company_Name;
                  return '';
                })()}
              </span>
            </h2>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5 flex flex-wrap items-center gap-2">
              <span>V2 Core Workspace</span>
              {niftyTraderData?.analysisData?.symbolData?.created_at && (
                <>
                  <span className="text-slate-600">•</span>
                  <span className="text-indigo-400">NT Updated: {new Date(niftyTraderData.analysisData.symbolData.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                </>
              )}
            </p>
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
          <button onClick={() => setActiveTab('AI Insights')}
            className={cn("px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2",
              activeTab === 'AI Insights' ? "bg-yellow-600 text-white shadow-lg shadow-yellow-500/20" : "text-slate-400 hover:text-slate-300")}>
            <Lightbulb className="w-4 h-4" /> AI Insights
          </button>
          <button onClick={() => setActiveTab('Quant Factors')}
            className={cn("px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2",
              activeTab === 'Quant Factors' ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20" : "text-slate-400 hover:text-slate-300")}>
            <Zap className="w-4 h-4" /> Quant Factors
          </button>
        </div>
      </div>

      <WhyThisPick symbol={symbol} />

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

          {/* NiftyTrader Technical Signals */}
          {niftyTraderData && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Column A: Gaps Analysis */}
              <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-indigo-400" /> NiftyTrader Gap Analysis
                </h3>
                <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1 terminal-scrollbar">
                  {niftyTraderData.analysisData?.msg_data?.length ? (
                    niftyTraderData.analysisData.msg_data.map((msg: string, idx: number) => {
                      const isSupport = msg.toLowerCase().includes('support');
                      return (
                        <div key={idx} className={cn("p-3 rounded-xl border text-[11px] leading-relaxed font-mono flex items-start gap-2",
                          isSupport ? "bg-emerald-950/20 border-emerald-900/50 text-emerald-400" : "bg-rose-950/20 border-rose-900/50 text-rose-400"
                        )}>
                          <span className="font-black shrink-0">{isSupport ? "▲" : "▼"}</span>
                          <span>{msg}</span>
                        </div>
                      );
                    })
                  ) : (
                    <p className="text-center py-6 text-slate-500 text-[10px] font-mono">NO UNFILLED GAPS FOUND</p>
                  )}
                </div>
              </div>

              {/* Column B: Moving Averages & Delivery */}
              <div className="space-y-6">
                {/* Delivery and NR7 Card */}
                <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                  <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono">Delivery & Patterns</h3>
                  <div className="grid grid-cols-2 gap-4">
                    {niftyTraderData.analysisData?.priceTable?.[0] && (() => {
                      const latest = niftyTraderData.analysisData.priceTable[0];
                      return (
                        <div className="p-4 bg-terminal-panel-header/50 border border-terminal-border rounded-xl">
                          <span className="text-[9px] font-black text-slate-500 uppercase tracking-wider block mb-1">Delivery %</span>
                          <span className="text-lg font-black text-slate-100 font-mono">
                            {latest.delivery_percentage ? `${latest.delivery_percentage}%` : "N/A"}
                          </span>
                          <span className="text-[8px] font-bold text-slate-500 block mt-1">
                            Vol: {latest.volume?.toLocaleString('en-IN')}
                          </span>
                        </div>
                      );
                    })()}
                    {niftyTraderData.analysisData?.stocktrend && (() => {
                      const trend = niftyTraderData.analysisData.stocktrend;
                      const hasNr7 = trend.nr7_today?.toLowerCase() === 'yes';
                      return (
                        <div className={cn("p-4 border rounded-xl",
                          hasNr7 ? "bg-blue-950/20 border-blue-900/50" : "bg-terminal-panel-header/50 border-terminal-border"
                        )}>
                          <span className="text-[9px] font-black text-slate-500 uppercase tracking-wider block mb-1">NR7 Pattern</span>
                          <span className={cn("text-lg font-black font-mono", hasNr7 ? "text-blue-400 animate-pulse" : "text-slate-400")}>
                            {trend.nr7_today || "NO"}
                          </span>
                          <span className="text-[8px] font-bold text-slate-500 block mt-1">
                            Narrow Range 7
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* SMAs Comparison Table */}
                {niftyTraderData.analysisData?.stocktrend && (() => {
                  const trend = niftyTraderData.analysisData.stocktrend;
                  const currentPrice = niftyTraderData.analysisData.symbolData?.last_trade_price || 0;
                  const smas = [
                    { label: '10 SMA', val: trend.sma_10_days },
                    { label: '20 SMA', val: trend.sma_20_days },
                    { label: '50 SMA', val: trend.sma_50_days },
                    { label: '100 SMA', val: trend.sma_100_days },
                    { label: '200 SMA', val: trend.sma_200_days },
                  ];
                  return (
                    <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                      <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono">Simple Moving Averages</h3>
                      <div className="space-y-2">
                        {smas.map((sma) => {
                          const isAbove = currentPrice >= (sma.val || 0);
                          return (
                            <div key={sma.label} className="flex justify-between items-center py-2 border-b border-terminal-border/40 last:border-0">
                              <span className="text-[10px] font-bold text-slate-400">{sma.label}</span>
                              <div className="flex items-center gap-3">
                                <span className="text-xs font-black text-slate-200 font-mono">₹{sma.val?.toFixed(2) || '—'}</span>
                                {sma.val && (
                                  <span className={cn("text-[9px] font-black font-mono px-2 py-0.5 rounded uppercase",
                                    isAbove ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                                  )}>
                                    {isAbove ? "ABOVE" : "BELOW"}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
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

            {/* Trendlyne SWOT Analysis */}
            {trendlyneOverview?.swot && (() => {
              const swot = trendlyneOverview.swot;
              const categories = [
                { key: 'strengths', label: 'Strengths', badgeColor: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/20', iconColor: 'text-emerald-400' },
                { key: 'weaknesses', label: 'Weaknesses', badgeColor: 'bg-rose-500/20 text-rose-400 border-rose-500/20', iconColor: 'text-rose-400' },
                { key: 'opportunities', label: 'Opportunities', badgeColor: 'bg-blue-500/20 text-blue-400 border-blue-500/20', iconColor: 'text-blue-400' },
                { key: 'threats', label: 'Threats', badgeColor: 'bg-amber-500/20 text-amber-400 border-amber-500/20', iconColor: 'text-amber-400' },
              ];

              const hasAnySwot = categories.some(cat => Array.isArray(swot[cat.key]) && swot[cat.key].length > 0);
              if (!hasAnySwot) return null;

              return (
                <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                  <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                    <BrainCircuit className="w-4 h-4 text-indigo-400" /> Trendlyne SWOT Analysis
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {categories.map(cat => {
                      const items = swot[cat.key];
                      if (!Array.isArray(items) || items.length === 0) return null;
                      return (
                        <div key={cat.key} className="space-y-3">
                          <div className="flex items-center">
                            <span className={cn("text-[9px] font-black px-2.5 py-1 rounded-lg border uppercase tracking-widest font-mono", cat.badgeColor)}>
                              {cat.label} ({items.length})
                            </span>
                          </div>
                          <div className="space-y-2">
                            {items.map((item: string, idx: number) => (
                              <div key={idx} className="flex items-start gap-2 text-[10px] text-slate-400 leading-relaxed bg-terminal-panel-header/30 p-2.5 rounded-xl border border-terminal-border hover:border-slate-700 transition-colors">
                                <span className={cn("font-black shrink-0", cat.iconColor)}>•</span>
                                <span>{item}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Trendlyne Checklist Widget */}
            {trendlyneOverview?.checklist && (() => {
              const checklist = trendlyneOverview.checklist;
              const cdata: Record<string, any> = checklist.checklistData || {};
              const sections = Object.keys(cdata);
              const score = checklist.score || 0;
              const yesCount = checklist.yesCount || 0;
              const total = checklist.total || 0;
              
              return (
                <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4 border-b border-terminal-border pb-4">
                    <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest font-mono flex items-center gap-2">
                      <Database className="w-4 h-4 text-emerald-400" /> Trendlyne Checklist
                    </h3>
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Pass Rate:</span>
                      <span className={cn("text-xs font-black px-2.5 py-1 rounded-lg border uppercase tracking-wider font-mono",
                        score >= 60 ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/20" :
                        score >= 35 ? "bg-amber-500/20 text-amber-400 border-amber-500/20" :
                        "bg-rose-500/20 text-rose-400 border-rose-500/20"
                      )}>
                        {score.toFixed(1)}% ({yesCount}/{total} Passed)
                      </span>
                    </div>
                  </div>
                  
                  {checklist.insight && (
                    <p className="text-[10px] text-slate-400 italic mb-4 leading-relaxed font-medium bg-terminal-panel-header/35 p-3 rounded-xl border border-terminal-border">
                      {checklist.insight}
                    </p>
                  )}

                  {sections.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {sections.map(sectionName => {
                        const items = cdata[sectionName];
                        if (!Array.isArray(items) || items.length === 0) return null;
                        return (
                          <div key={sectionName} className="p-4 bg-terminal-panel-header/20 border border-terminal-border rounded-xl">
                            <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-2.5 border-b border-terminal-border pb-1 font-mono">
                              {sectionName.toUpperCase()}
                            </p>
                            <div className="space-y-2">
                              {items.map((item: any, idx: number) => (
                                <div key={idx} className="flex items-center justify-between p-2 bg-slate-950/40 rounded-lg border border-terminal-border">
                                  <span className="text-[10px] text-slate-400 font-bold leading-tight truncate mr-2" title={item.question}>
                                    {item.question}
                                  </span>
                                  <span className={cn("text-[9px] font-black shrink-0 font-mono", 
                                    item.answer ? "text-emerald-400" : "text-rose-400"
                                  )}>
                                    {item.answer ? "PASS" : "FAIL"}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-center py-6 text-slate-500 text-[10px] font-bold">No checklist data found.</p>
                  )}
                </div>
              );
            })()}

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
            {/* Peer Comparison (NiftyTrader) */}
            {niftyTraderData?.industryData?.lstFinancires && (() => {
              const peers = niftyTraderData.industryData.lstFinancires;
              return (
                <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                  <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                    <PieChart className="w-4 h-4 text-blue-400" /> Industry Peer Comparison (NiftyTrader)
                  </h3>
                  <div className="overflow-x-auto terminal-scrollbar">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-terminal-border/60">
                          <th className="py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-wider">Symbol</th>
                          <th className="py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-wider">Company Name</th>
                          <th className="py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-wider text-right">Mkt Cap (Cr)</th>
                          <th className="py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-wider text-right">CMP</th>
                          <th className="py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-wider text-right">P/E</th>
                          <th className="py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-wider text-right">Sales Gr %</th>
                          <th className="py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-wider text-right">Book Value</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-terminal-border/30">
                        {peers.map((peer: any, idx: number) => {
                          const isCurrent = peer.symbol?.toUpperCase() === symbol.toUpperCase();
                          return (
                            <tr key={idx} className={cn("hover:bg-slate-900/30 font-mono text-[10px]", isCurrent && "bg-blue-950/20 text-blue-300")}>
                              <td className="py-3 font-bold">{peer.symbol}</td>
                              <td className="py-3 text-[9px] font-sans text-slate-400 max-w-[150px] truncate" title={peer.company_Name}>{peer.company_Name}</td>
                              <td className="py-3 text-right">{peer.market_Cap ? parseFloat(peer.market_Cap).toLocaleString('en-IN') : '—'}</td>
                              <td className="py-3 text-right">₹{peer.current_price || peer.cmp || '—'}</td>
                              <td className="py-3 text-right">{peer.stock_PE || '—'}</td>
                              <td className={cn("py-3 text-right font-bold", 
                                parseFloat(peer.sales_Growth) >= 0 ? "text-emerald-400" : parseFloat(peer.sales_Growth) < 0 ? "text-rose-400" : "text-slate-400"
                              )}>
                                {peer.sales_Growth ? `${peer.sales_Growth}%` : '—'}
                              </td>
                              <td className="py-3 text-right">₹{peer.book_Value || '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}

            {/* Historical Annual Financials (NiftyTrader) */}
            {niftyTraderData?.industryData?.lstfutureprojectval && (() => {
              const annuals = [...niftyTraderData.industryData.lstfutureprojectval].sort((a: any, b: any) => {
                const parseYear = (str: string) => parseInt(str.replace(/[^\d]/g, ''), 10) || 0;
                return parseYear(a.year) - parseYear(b.year);
              });

              if (annuals.length === 0) return null;

              return (
                <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                  <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                    <History className="w-4 h-4 text-emerald-400" /> Historical Annual Performance (NiftyTrader)
                  </h3>
                  <div className="overflow-x-auto terminal-scrollbar">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-terminal-border/60">
                          <th className="py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-wider">Year</th>
                          <th className="py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-wider text-right">Sales Revenue (Cr)</th>
                          <th className="py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-wider text-right">Net Profit (Cr)</th>
                          <th className="py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-wider text-right">Net Profit Margin %</th>
                          <th className="py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-wider text-right">Actual EPS</th>
                          <th className="py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-wider text-right">Reserves (Cr)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-terminal-border/30">
                        {annuals.map((row: any, idx: number) => {
                          const marginPct = (row.npm * 100).toFixed(1);
                          return (
                            <tr key={idx} className="hover:bg-slate-900/30 font-mono text-[10px] text-slate-300">
                              <td className="py-3 font-bold text-slate-100">{row.year}</td>
                              <td className="py-3 text-right">₹{row.sales_Revenue ? parseFloat(row.sales_Revenue).toLocaleString('en-IN') : '—'}</td>
                              <td className={cn("py-3 text-right font-bold", 
                                parseFloat(row.netProfit) >= 0 ? "text-emerald-400" : parseFloat(row.netProfit) < 0 ? "text-rose-400" : "text-slate-400"
                              )}>
                                ₹{row.netProfit ? parseFloat(row.netProfit).toLocaleString('en-IN') : '—'}
                              </td>
                              <td className="py-3 text-right">{row.npm != null ? `${marginPct}%` : '—'}</td>
                              <td className="py-3 text-right">₹{row.actualEPS || row.epSinRs || '—'}</td>
                              <td className="py-3 text-right">{row.reserves ? `₹${parseFloat(row.reserves).toLocaleString('en-IN')}` : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}

            {/* Recent Quarterly Performance (NiftyTrader) */}
            {niftyTraderData?.industryData?.lastThreeQTRModel && (() => {
              const quarters = niftyTraderData.industryData.lastThreeQTRModel;
              if (quarters.length === 0) return null;
              return (
                <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                  <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-violet-400" /> Recent Quarterly Performance (NiftyTrader)
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                    {quarters.map((q: any, idx: number) => (
                      <div key={idx} className="p-4 bg-terminal-panel-header/50 border border-terminal-border rounded-xl">
                        <span className="text-[9px] font-black text-slate-500 uppercase tracking-wider block mb-1">{q.year}</span>
                        <div className="space-y-1">
                          <div className="flex justify-between items-center text-[10px]">
                            <span className="text-slate-400">Sales:</span>
                            <span className="font-mono font-black text-slate-200">₹{parseFloat(q.sales_Revenue || '0').toLocaleString('en-IN')}Cr</span>
                          </div>
                          <div className="flex justify-between items-center text-[10px]">
                            <span className="text-slate-400">Profit:</span>
                            <span className={cn("font-mono font-black", 
                              parseFloat(q.netProfit || '0') >= 0 ? "text-emerald-400" : "text-rose-400"
                            )}>₹{parseFloat(q.netProfit || '0').toLocaleString('en-IN')}Cr</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>

          <div className="lg:col-span-4 space-y-6">
            {trendlyneOverview?.dvm && (() => {
              const dvm = trendlyneOverview.dvm;
              const qVal = dvm.quality?.score ?? dvm.durability?.score ?? null;
              const qInsight = dvm.quality?.insight ?? dvm.durability?.insight ?? '';
              const vVal = dvm.valuation?.score ?? null;
              const vInsight = dvm.valuation?.insight ?? '';
              const tVal = dvm.technicals?.score ?? dvm.momentum?.score ?? null;
              const tInsight = dvm.technicals?.insight ?? dvm.momentum?.insight ?? '';
              
              const params = [
                { label: 'Quality / Durability', val: qVal, insight: qInsight, textClass: 'text-emerald-400', progressClass: 'from-emerald-600 to-emerald-400' },
                { label: 'Valuation', val: vVal, insight: vInsight, textClass: 'text-amber-400', progressClass: 'from-amber-600 to-amber-400' },
                { label: 'Technicals / Momentum', val: tVal, insight: tInsight, textClass: 'text-blue-400', progressClass: 'from-blue-600 to-blue-400' },
              ].filter(p => p.val !== null);

              if (params.length === 0) return null;

              return (
                <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                  <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                    <Zap className="w-4 h-4 text-indigo-400" /> Trendlyne DVM
                  </h3>
                  <div className="space-y-4">
                    {params.map(p => (
                      <div key={p.label} className="space-y-1.5">
                        <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-widest">
                          <span className="text-slate-400">{p.label}</span>
                          <span className={cn("font-mono", p.textClass)}>{p.val}/100</span>
                        </div>
                        <div className="h-1.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800/50">
                          <div className={cn("h-full bg-gradient-to-r transition-all duration-1000", p.progressClass)} style={{ width: `${p.val}%` }} />
                        </div>
                        <p className="text-[9px] text-slate-400 font-bold uppercase tracking-tight">{p.insight}</p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

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

            {/* NiftyTrader Financial Ratios */}
            {niftyTraderData?.financialData?.[0] && (() => {
              const fin = niftyTraderData.financialData[0];
              return (
                <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                  <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-4 font-mono flex items-center gap-2">
                    <Database className="w-4 h-4 text-emerald-400" /> NiftyTrader Key Metrics
                  </h3>
                  <div className="space-y-3">
                    {[
                      { label: 'Market Cap', val: `₹${fin.market_cap?.toLocaleString('en-IN')} Cr` },
                      { label: 'Current Price', val: `₹${fin.current_price || '—'}` },
                      { label: 'Stock P/E', val: fin.stock_pe },
                      { label: 'Book Value', val: `₹${fin.book_value || '—'}` },
                      { label: 'Dividend Yield', val: fin.dividend_yield ? `${fin.dividend_yield}%` : '—' },
                      { label: 'ROCE %', val: fin.roce ? `${fin.roce}%` : '—' },
                      { label: 'ROE %', val: fin.roe ? `${fin.roe}%` : '—' },
                      { label: 'Sales Growth %', val: fin.sales_growth ? `${fin.sales_growth}%` : '—' },
                      { label: 'Face Value', val: fin.face_value },
                    ].map((metric) => (
                      <div key={metric.label} className="flex justify-between items-center py-3 border-b border-terminal-border/40 last:border-0">
                        <span className="text-xs font-medium text-slate-400">{metric.label}</span>
                        <span className="text-xs font-black text-slate-200 font-mono">{metric.val ?? '—'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
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

        {/* ── AI INSIGHTS TAB ── */}
        {activeTab === 'AI Insights' && (
            <AiInsightsTab insights={aiInsights} />
        )}

        {/* ── QUANT FACTORS TAB ── */}
        {activeTab === 'Quant Factors' && (
            quantScores && 'overall_score' in quantScores ? (
                <QuantFactorsTab scores={quantScores && !('error' in quantScores) ? (quantScores as QuantScores) : undefined} />
            ) : (
                <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
                    <p className="text-slate-400">No quant scores available for this stock.</p>
                </div>
            )
        )}
    </div>
  );
};
