import React from 'react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import stockData from '../data/stocklist';
import {
  TrendingUp, TrendingDown, Activity, Zap, Info, AlertCircle,
  BarChart3, PieChart, Users, Filter,
  CheckCircle2, BrainCircuit
} from 'lucide-react';
import { motion } from 'motion/react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';

import { Card, SentimentBadge, ValueDisplay, IndicatorRow } from './MCCommon';
import ScreenerDetailsModal from './ScreenerDetailsModal';

interface MCStockInfoPanelProps {
  symbol: string;
  scId: string;
  section?: 'all' | 'technical' | 'fundamental' | 'insights' | 'overview' | 'shareholding' | 'peers';
  onSelectStock?: (symbol: string) => void;
}

type Timeframe = 'D' | 'W' | 'M';
type Tab = 'overview' | 'financials' | 'technical' | 'analysis' | 'analyst';

export const MCStockInfoPanel: React.FC<MCStockInfoPanelProps> = ({ symbol, section, onSelectStock }) => {
  const [timeframe, setTimeframe] = React.useState<Timeframe>('D');
  const [activeTab, setActiveTab] = React.useState<Tab>(
    section === 'technical' ? 'technical' :
    section === 'fundamental' ? 'financials' :
    section === 'insights' ? 'analysis' : 
    section === 'overview' ? 'overview' : 
    section === 'shareholding' ? 'analysis' :
    section === 'peers' ? 'analysis' : 'overview'
  );

  const [isModalOpen, setIsModalOpen] = React.useState(false);
  const [selectedScreener, setSelectedScreener] = React.useState<any>(null);

  // Sync activeTab if section changes
  React.useEffect(() => {
    if (section === 'technical') setActiveTab('technical');
    else if (section === 'fundamental') setActiveTab('financials');
    else if (section === 'insights') setActiveTab('analysis');
    else if (section === 'overview') setActiveTab('overview');
    else if (section === 'shareholding') setActiveTab('analysis');
    else if (section === 'peers') setActiveTab('analysis');
  }, [section]);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = React.useState(false);

  React.useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => { setIsVisible(entry.isIntersecting); },
      { threshold: 0.05, rootMargin: '50px' }
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const stockMapping = stockData.find(s => s.symbol.toUpperCase() === symbol.toUpperCase());

  const { data: unifiedData, isLoading, error } = trpc.getAlphaQuantDetail.useQuery(
    { symbol, timeframe },
    { enabled: isVisible, refetchInterval: isVisible ? 60000 : false, staleTime: 30000 }
  );

  const { data: techW } = trpc.getMcTechnical.useQuery(
    { symbol, duration: 'W' },
    { enabled: isVisible, staleTime: 300000 }
  );
  const { data: techM } = trpc.getMcTechnical.useQuery(
    { symbol, duration: 'M' },
    { enabled: isVisible, staleTime: 3600000 }
  );

  if (!isVisible && !unifiedData) {
    return (
      <div ref={containerRef} className="h-40 flex items-center justify-center bg-slate-900/10 border border-dashed border-slate-800 rounded-2xl">
        <p className="text-[10px] font-black text-slate-700 uppercase tracking-widest italic">
          Waiting for visibility... {symbol}
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div ref={containerRef} className="space-y-4 animate-pulse">
        <div className="flex gap-2 mb-4">
          {[1,2,3].map(i => <div key={i} className="h-8 w-20 bg-slate-800 rounded-lg" />)}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1,2,3,4,5,6,7,8].map(i => <div key={i} className="h-20 bg-slate-800/50 rounded-2xl" />)}
        </div>
        <div className="h-64 bg-slate-800/30 rounded-2xl" />
      </div>
    );
  }

  if (error || !unifiedData) {
    const stockName = stockMapping?.name || symbol;
    return (
      <div ref={containerRef} className="p-8 text-center bg-slate-900/30 border border-slate-800 rounded-2xl">
        <AlertCircle className="w-8 h-8 text-rose-500 mx-auto mb-3" />
        <p className="text-sm text-slate-500 font-bold">Failed to load data for {stockName}</p>
        <p className="text-[10px] text-slate-600 mt-1 uppercase tracking-widest">{symbol}</p>
      </div>
    );
  }

  const mc = unifiedData;
  const alphaData = unifiedData.score ? { score: unifiedData.score, factors: unifiedData.factors } : null;
  const mcScreeners = unifiedData.screeners?.moneycontrol || [];
  const tlScreeners = unifiedData.screeners?.trendlyne || [];
  const allScreeners = [...mcScreeners, ...tlScreeners];

  const hasAnyData = mc.technical || mc.equityCash || mc.stockPrice || mc.swot || mc.essentials || mc.mcInsights;
  if (!hasAnyData) {
    const stockName = stockMapping?.name || symbol;
    return (
      <div ref={containerRef} className="p-8 text-center bg-slate-900/30 border border-slate-800 rounded-2xl">
        <AlertCircle className="w-8 h-8 text-amber-500 mx-auto mb-3" />
        <p className="text-sm text-slate-400 font-bold">No MoneyControl data available for {stockName}</p>
        <p className="text-[10px] text-slate-600 mt-1 uppercase tracking-widest">{symbol} — not mapped to a MoneyControl ID</p>
      </div>
    );
  }

  const tech = mc.technical;
  const techD = tech;
  const eq = mc.equityCash;
  const sp = mc.stockPrice;
  const swot = mc.swot;
  const essentials = mc.essentials;
  const classification = mc.mcInsights?.classification;
  const detailedInsights = mc.detailedInsights;
  const pv = mc.priceVolume;
  const ar = mc.analystRating;
  const ef = mc.earningsForecast;
  const pf = mc.priceForecast;
  const consensus = mc.consensus;
  const hm = mc.hitsMisses;
  const fov = mc.financialOverview;
  const valuation = mc.valuation;
  const historicalRating = mc.historicalRating;
  const technicalV2 = mc.technicalV2;
  const technicalAnalysisV2 = mc.technicalAnalysisV2;
  const technicalRating = mc.technicalRating;
  const chartPatterns = mc.chartPatterns;
  const tb = (unifiedData as any).tradebrains;

  const currentPrice = eq?.pricecurrent || sp?.lastPrice || tech?.close?.toString() || '—';
  const changePct = eq?.pricepercentchange || sp?.perChange || '—';

  const TABS: { key: Tab; label: string }[] = [
    { key: 'overview',   label: 'Overview'   },
    { key: 'financials', label: 'Financials'  },
    { key: 'technical',  label: 'Technical'   },
    { key: 'analysis',   label: 'Analysis'    },
    { key: 'analyst',    label: 'Analyst'     },
  ];

  return (
    <div ref={containerRef} className="space-y-4">

      {/* ── HEADER: Scores (Only show in 'all' or 'overview') ── */}
      {(!section || section === 'all' || section === 'overview') && (
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 pr-4 border-r border-slate-800">
              <Zap className="w-4 h-4 text-blue-500" />
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">AlphaQuant V2</span>
              {alphaData && (
                <div className="flex items-center gap-2">
                  <span className={cn(
                    "text-[9px] font-black px-2 py-0.5 rounded uppercase",
                    alphaData.score.score >= 70 ? "bg-blue-500/20 text-blue-400" :
                    alphaData.score.score >= 50 ? "bg-slate-800 text-slate-400" :
                    "bg-rose-500/10 text-rose-500"
                  )}>
                    Rank: #{alphaData.score.score.toFixed(1)}
                  </span>
                  <span className="text-[8px] font-black text-blue-500/60 uppercase">{alphaData.score.classification}</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <BrainCircuit className="w-4 h-4 text-emerald-500" />
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">MoneyControl</span>
              {classification && (
                <span className={cn(
                  "text-[9px] font-black px-2 py-0.5 rounded uppercase",
                  classification.stockScore >= 70 ? "bg-emerald-500/10 text-emerald-500" :
                  classification.stockScore >= 50 ? "bg-amber-500/10 text-amber-500" :
                  "bg-rose-500/10 text-rose-500"
                )}>
                  Score: {classification.stockScore}
                </span>
              )}
            </div>
            {(() => {
              const tbScore = tb?.portalScore?.score;
              if (tbScore == null || typeof tbScore !== 'number') return null;
              const pct = Math.round((tbScore / 5) * 100);
              return (
                <div className="flex items-center gap-2 pl-4 border-l border-slate-800">
                  <BarChart3 className="w-4 h-4 text-violet-500" />
                  <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">TradeBrains</span>
                  <span className={cn(
                    "text-[9px] font-black px-2 py-0.5 rounded uppercase",
                    pct >= 60 ? "bg-violet-500/10 text-violet-400" :
                    pct >= 40 ? "bg-amber-500/10 text-amber-400" :
                    "bg-rose-500/10 text-rose-500"
                  )}>
                    {tbScore.toFixed(2)}/5
                  </span>
                </div>
              );
            })()}
          </div>
          <div className="flex gap-1 bg-slate-900 rounded-lg p-0.5 border border-slate-800">
            {(['D', 'W', 'M'] as Timeframe[]).map(tf => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={cn(
                  "px-3 py-1.5 rounded-md text-[9px] font-black uppercase tracking-widest transition-all",
                  timeframe === tf ? "bg-blue-600 text-white shadow-lg" : "text-slate-500 hover:text-white"
                )}
              >
                {tf === 'D' ? 'Daily' : tf === 'W' ? 'Weekly' : 'Monthly'}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── KEY STATS (Only show if section is 'all') ── */}
      {(!section || section === 'all') && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <ValueDisplay label="Price" value={`₹${currentPrice}`} sub={changePct ? `${parseFloat(String(changePct)) >= 0 ? '+' : ''}${changePct}%` : undefined}
            color={parseFloat(String(changePct || 0)) >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
          <ValueDisplay label="P/E" value={eq?.PE || sp?.scTtm || essentials?.pe || '—'} sub={`Sector: ${essentials?.sectorPe || eq?.IND_PE || '—'}`} />
          <ValueDisplay label="P/B" value={eq?.PB || essentials?.pb || sp?.priceBook || '—'} />
          <ValueDisplay label="Market Cap" value={essentials?.marketCap || eq?.MKTCAP ? `₹${String(eq?.MKTCAP || essentials?.marketCap || '0').replace(/[^\d.]/g, '')}Cr` : '—'} />
          <ValueDisplay label="Div Yield" value={essentials?.dividendYield ? `${essentials.dividendYield}%` : eq?.DY ? `${eq.DY}%` : '—'} />
          <ValueDisplay label="Face Value" value={essentials?.faceValue || eq?.FV || '—'} />
        </div>
      )}

      {/* ── COMPANY PROFILE (Only show if section is 'all') ── */}
      {(!section || section === 'all') && (tb?.profile || tb?.overviewData?.stock_mentions) && (
        <div className="flex flex-wrap gap-3">
          {tb?.profile && (
            <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl">
              {tb.profile.founded_year && (
                <span className="text-[9px] font-bold text-slate-500">Founded <span className="text-slate-300 font-black">{tb.profile.founded_year}</span></span>
              )}
              {tb.profile.chairman && (
                <span className="text-[9px] font-bold text-slate-500">Chairman <span className="text-slate-300 font-black">{tb.profile.chairman}</span></span>
              )}
              {tb.profile.website && (
                <a href={tb.profile.website} target="_blank" rel="noopener noreferrer"
                  className="text-[9px] font-black text-violet-400 hover:text-violet-300 uppercase tracking-widest">
                  Website ↗
                </a>
              )}
              {tb.profile.address && (
                <span className="text-[9px] font-bold text-slate-600 truncate">{tb.profile.address}</span>
              )}
            </div>
          )}
          {Array.isArray(tb?.overviewData?.stock_mentions?.ace_investors) && tb.overviewData.stock_mentions.ace_investors.length > 0 && (
            <div className="flex items-center gap-2 px-4 py-2.5 bg-violet-500/5 border border-violet-500/20 rounded-xl">
              <Users className="w-3 h-3 text-violet-500 shrink-0" />
              <span className="text-[9px] font-black text-violet-400 uppercase tracking-widest">Ace Investors:</span>
              <span className="text-[9px] font-bold text-slate-300">
                {tb.overviewData.stock_mentions.ace_investors.map((a: any) => a.name || a).join(', ')}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── TAB BAR (Only show if section is 'all' or undefined) ── */}
      {(!section || section === 'all') && (
        <div className="flex border-b border-slate-800 overflow-x-auto">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "px-5 py-2.5 text-[10px] font-black uppercase tracking-widest transition-all whitespace-nowrap border-b-2 -mb-px",
                activeTab === tab.key
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* OVERVIEW TAB                                                   */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'overview' && (
        <div className="space-y-6">

          {/* AlphaQuant Factor Breakdown */}
          {alphaData && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: 'Technical',    value: alphaData.factors.technical,    color: 'text-blue-400',    icon: Activity   },
                { label: 'Fundamental',  value: alphaData.factors.fundamental,  color: 'text-emerald-400', icon: PieChart   },
                { label: 'Momentum',     value: alphaData.factors.momentum,     color: 'text-purple-400',  icon: Zap        },
                { label: 'Valuation',    value: alphaData.factors.valuation,    color: 'text-amber-400',   icon: BarChart3  },
                { label: 'Delivery',     value: alphaData.factors.delivery,     color: 'text-rose-400',    icon: Users      },
              ].map((factor) => (
                <div key={factor.label} className="bg-slate-950 p-3 rounded-2xl border border-slate-800/50 flex flex-col items-center justify-center text-center group hover:border-slate-700 transition-all">
                  <factor.icon className={cn("w-4 h-4 mb-2 opacity-40 group-hover:opacity-100 transition-opacity", factor.color)} />
                  <p className="text-[8px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1">{factor.label}</p>
                  <span className={cn("text-lg font-black italic", factor.color)}>{factor.value.toFixed(1)}</span>
                  <div className="w-full h-1 bg-slate-900 rounded-full mt-2 overflow-hidden">
                    <div className={cn("h-full rounded-full transition-all duration-1000", factor.color.replace('text-', 'bg-'))}
                      style={{ width: `${Math.min(100, factor.value * 10)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* TradeBrains Portal Score Breakdown */}
          {tb?.portalScore && (() => {
            const ps = tb.portalScore;
            const dims = [
              { label: 'Performance',   val: ps.performance,   color: 'bg-blue-500',    text: 'text-blue-400'    },
              { label: 'Growth',        val: ps.growth,        color: 'bg-emerald-500', text: 'text-emerald-400' },
              { label: 'Profitability', val: ps.profitability, color: 'bg-teal-500',    text: 'text-teal-400'    },
              { label: 'Valuation',     val: ps.valuation,     color: 'bg-amber-500',   text: 'text-amber-400'   },
              { label: 'Ownership',     val: ps.ownership,     color: 'bg-purple-500',  text: 'text-purple-400'  },
              { label: 'Quality',       val: ps.quality,       color: 'bg-violet-500',  text: 'text-violet-400'  },
            ].filter(d => d.val != null);
            if (dims.length === 0) return null;
            return (
              <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[10px] font-black text-violet-500 uppercase tracking-widest flex items-center gap-2">
                    <BarChart3 className="w-3 h-3" /> TradeBrains Score Breakdown
                  </p>
                  {ps.score != null && (
                    <span className={cn("text-sm font-black italic px-2 py-0.5 rounded",
                      ps.score >= 3.5 ? "text-emerald-400" : ps.score >= 2.5 ? "text-amber-400" : "text-rose-400"
                    )}>{Number(ps.score).toFixed(2)}<span className="text-[9px] text-slate-500 font-bold">/5</span></span>
                  )}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {dims.map((d) => {
                    const pct = Math.round((Number(d.val) / 5) * 100);
                    return (
                      <div key={d.label} className="space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">{d.label}</span>
                          <span className={cn("text-[10px] font-black", d.text)}>{Number(d.val).toFixed(2)}</span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden">
                          <motion.div initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8, delay: 0.1 }}
                            className={cn("h-full rounded-full", d.color)} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Multi-Timeframe Divergence */}
          {(techD || techW || techM) && (
            <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4">
              <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                <Activity className="w-3 h-3" /> Multi-Timeframe Signal
              </p>
              <div className="grid grid-cols-3 gap-3">
                {([
                  { label: 'Daily',   tech: techD },
                  { label: 'Weekly',  tech: techW },
                  { label: 'Monthly', tech: techM },
                ] as const).map(({ label, tech: t }) => {
                  const indication = (t as any)?.sentiments?.indication || '';
                  const bullish = (t as any)?.sentiments?.totalBullish ?? 0;
                  const bearish = (t as any)?.sentiments?.totalBearish ?? 0;
                  const isBull = indication.toLowerCase().includes('bullish');
                  const isBear = indication.toLowerCase().includes('bearish');
                  return (
                    <div key={label} className={cn("p-3 rounded-xl border text-center",
                      isBull ? "bg-emerald-500/5 border-emerald-500/20" :
                      isBear ? "bg-rose-500/5 border-rose-500/20" : "bg-slate-900 border-slate-800"
                    )}>
                      <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</p>
                      {indication ? (
                        <>
                          <p className={cn("text-[10px] font-black uppercase leading-tight",
                            isBull ? "text-emerald-400" : isBear ? "text-rose-400" : "text-slate-400"
                          )}>{indication}</p>
                          <div className="flex justify-center gap-2 mt-1.5 text-[8px] font-black">
                            <span className="text-emerald-500">{bullish}B</span>
                            <span className="text-slate-700">/</span>
                            <span className="text-rose-500">{bearish}Be</span>
                          </div>
                        </>
                      ) : (
                        <p className="text-[9px] text-slate-700 italic">Loading…</p>
                      )}
                    </div>
                  );
                })}
              </div>
              {techD && techW && techM && (() => {
                const sD = ((techD as any)?.sentiments?.indication || '').toLowerCase();
                const sW = ((techW as any)?.sentiments?.indication || '').toLowerCase();
                const sM = ((techM as any)?.sentiments?.indication || '').toLowerCase();
                if (sD === sW && sW === sM || !sD || !sW || !sM) return null;
                const mBull = sM.includes('bullish'), dBear = sD.includes('bearish');
                return (
                  <div className={cn("mt-3 px-3 py-2 rounded-lg text-[9px] font-bold italic",
                    mBull && dBear ? "bg-blue-500/10 text-blue-400 border border-blue-500/20" : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                  )}>
                    {mBull && dBear
                      ? "⚡ Divergence: Long-term bullish trend with short-term pullback — potential entry zone"
                      : "⚠ Timeframe divergence detected — signals not aligned across D/W/M"}
                  </div>
                );
              })()}
            </div>
          )}

          {/* AlphaQuant Signals */}
          {allScreeners.length > 0 && (
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Zap className="w-4 h-4 text-amber-400" />
                <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest">AlphaQuant Signals ({allScreeners.length})</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {allScreeners.map((screener) => {
                  const isBullish = screener.sentiment === 'bullish';
                  const isBearish = screener.sentiment === 'bearish';
                  return (
                    <div key={`${screener.id}-${screener.name}`}
                      onClick={() => {
                        setSelectedScreener(screener);
                        setIsModalOpen(true);
                      }}
                      className={cn("px-3 py-1.5 rounded-lg text-[9px] font-bold uppercase tracking-tight border flex items-center gap-1.5 transition-all cursor-pointer hover:scale-105 active:scale-95",
                        isBullish ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25" :
                        isBearish ? "bg-rose-500/15 border-rose-500/30 text-rose-400 hover:bg-rose-500/25" :
                        "bg-slate-700/50 border-slate-600/30 text-slate-300 hover:bg-slate-700"
                      )} title={screener.name}>
                      {isBullish ? <TrendingUp className="w-3 h-3" /> : isBearish ? <TrendingDown className="w-3 h-3" /> : <Filter className="w-3 h-3" />}
                      <span className="truncate max-w-xs">{screener.name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Screener Details Modal */}
          <ScreenerDetailsModal 
            isOpen={isModalOpen}
            onClose={() => setIsModalOpen(false)}
            screener={selectedScreener}
            onSelectStock={(sym) => {
              if (onSelectStock) onSelectStock(sym);
            }}
          />

          {/* MC Classification */}
          {classification?.longDesc && (
            <div className={cn("p-4 rounded-2xl border relative overflow-hidden",
              classification.stockScore >= 70 ? "bg-emerald-500/5 border-emerald-500/20" :
              classification.stockScore >= 50 ? "bg-amber-500/5 border-amber-500/20" :
              "bg-rose-500/5 border-rose-500/20"
            )}>
              <div className="absolute top-0 right-0 p-6 opacity-5"><BrainCircuit className="w-20 h-20" /></div>
              <div className="relative z-10">
                <p className="text-[10px] font-black text-emerald-500 uppercase tracking-widest mb-1 flex items-center gap-2">
                  <CheckCircle2 className="w-3 h-3" /> MC Classification
                </p>
                <p className="text-sm text-slate-300 font-medium italic leading-relaxed">{classification.longDesc}</p>
                <div className="flex items-center gap-3 mt-3">
                  <span className="text-[9px] font-black text-slate-500 uppercase">Overall Score</span>
                  <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden max-w-xs">
                    <motion.div initial={{ width: 0 }} animate={{ width: `${classification.stockScore}%` }}
                      className={cn("h-full rounded-full", classification.stockScore >= 70 ? "bg-emerald-500" : classification.stockScore >= 50 ? "bg-amber-500" : "bg-rose-500")} />
                  </div>
                  <span className={cn("text-[10px] font-black",
                    classification.stockScore >= 70 ? "text-emerald-400" : classification.stockScore >= 50 ? "text-amber-400" : "text-rose-400"
                  )}>{classification.stockScore}/100</span>
                </div>
              </div>
            </div>
          )}

          {/* MC Investment Checklist */}
          {essentials?.checklist && (
            <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">MC Investment Checklist</span>
                </div>
                {essentials.passText && (
                  <div className="flex items-center gap-3">
                    <span className="text-[9px] font-black text-emerald-400">{essentials.passYes} Yes</span>
                    <span className="text-[9px] font-black text-rose-400">{essentials.passNo} No</span>
                    <span className={cn("text-[9px] font-black px-2 py-0.5 rounded uppercase",
                      (essentials.passPercent ?? 0) >= 70 ? "bg-emerald-500/10 text-emerald-400" :
                      (essentials.passPercent ?? 0) >= 50 ? "bg-amber-500/10 text-amber-400" : "bg-rose-500/10 text-rose-400"
                    )}>{essentials.passText}</span>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {(['financials', 'industry', 'ownership', 'others'] as const).map((key) => {
                  const labelMap = { financials: 'Financials', industry: 'Industry', ownership: 'Ownership', others: 'Others' };
                  const colorMap = { financials: 'text-blue-400', industry: 'text-purple-400', ownership: 'text-amber-400', others: 'text-slate-400' };
                  const items = essentials.checklist![key];
                  if (!items?.length) return null;
                  return (
                    <div key={key}>
                      <p className={cn("text-[9px] font-black uppercase tracking-widest mb-2", colorMap[key])}>{labelMap[key]}</p>
                      <div className="space-y-1.5">
                        {items.map((item, i) => (
                          <div key={i} className="flex items-start gap-2 p-2 bg-slate-900/60 rounded-lg">
                            <span className={cn("text-[9px] font-black mt-0.5 shrink-0 w-3", item.answer ? "text-emerald-400" : "text-rose-400")}>
                              {item.answer ? "✓" : "✗"}
                            </span>
                            <span className="text-[10px] text-slate-400 font-medium leading-tight">{item.question}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* FINANCIALS TAB                                                 */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'financials' && (
        <div className="space-y-6">

          {/* Financial Overview (TTM) */}
          {fov && section !== 'fundamental' && (
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 bg-blue-500/5 border border-blue-500/20 rounded-xl text-center">
                <p className="text-[8px] font-black text-blue-500 uppercase tracking-widest">TTM EPS</p>
                <p className="text-xs font-black text-white italic">{fov.ttmEpsText}</p>
              </div>
              <div className="p-3 bg-amber-500/5 border border-amber-500/20 rounded-xl text-center">
                <p className="text-[8px] font-black text-amber-500 uppercase tracking-widest">TTM PE</p>
                <p className="text-xs font-black text-white italic">{fov.ttmPeText}</p>
              </div>
              <div className="p-3 bg-purple-500/5 border border-purple-500/20 rounded-xl text-center">
                <p className="text-[8px] font-black text-purple-500 uppercase tracking-widest">P/B</p>
                <p className="text-xs font-black text-white italic">{fov.pbText}</p>
              </div>
            </div>
          )}

          {/* TradeBrains Key Metrics */}
          {tb?.keyMetrics && typeof tb.keyMetrics === 'object' && !Array.isArray(tb.keyMetrics) && (
            <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4">
              <p className="text-[10px] font-black text-violet-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                <BarChart3 className="w-3 h-3" /> TradeBrains Key Metrics
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {([
                  { label: 'P/E',           val: tb.keyMetrics.pe,            color: 'text-blue-400' },
                  { label: 'Industry P/E',  val: tb.keyMetrics.industry_pe,   color: 'text-slate-400' },
                  { label: 'PEG Ratio',     val: tb.keyMetrics.peg_ratio,     color: 'text-violet-400' },
                  { label: 'ROE %',         val: tb.keyMetrics.roe != null ? `${Number(tb.keyMetrics.roe).toFixed(2)}%` : null, color: 'text-emerald-400' },
                  { label: 'ROCE %',        val: tb.keyMetrics.roce != null ? `${Number(tb.keyMetrics.roce).toFixed(2)}%` : null, color: 'text-emerald-400' },
                  { label: 'ROA %',         val: tb.keyMetrics.roa != null ? `${Number(tb.keyMetrics.roa).toFixed(2)}%` : null, color: 'text-teal-400' },
                  { label: 'EPS',           val: tb.keyMetrics.eps,           color: 'text-amber-400' },
                  { label: 'Debt/Equity',   val: tb.keyMetrics.debt_equity,   color: tb.keyMetrics.debt_equity > 1 ? 'text-rose-400' : 'text-emerald-400' },
                  { label: 'Current Ratio', val: tb.keyMetrics.current_ratio, color: tb.keyMetrics.current_ratio >= 1.5 ? 'text-emerald-400' : 'text-amber-400' },
                  { label: 'Total Debt ₹Cr',val: tb.keyMetrics.total_debt,   color: 'text-rose-400' },
                  { label: 'Div Yield %',   val: tb.keyMetrics.divyield != null ? `${tb.keyMetrics.divyield}%` : null, color: 'text-amber-400' },
                  { label: 'EV/Sales',      val: tb.keyMetrics.ev_sales,      color: 'text-slate-400' },
                ] as { label: string; val: any; color: string }[])
                  .filter(m => {
                    if (m.val == null || m.val === '') return false;
                    // Filter out items already in FundamentalInsights big cards
                    const skip = ['P/E', 'P/B', 'ROE %', 'Debt/Equity', 'Current Ratio', 'Quick Ratio', 'Interest Coverage'];
                    return !skip.includes(m.label);
                  })
                  .map((m, i) => (
                    <div key={i} className="p-2.5 bg-slate-900/60 rounded-xl border border-slate-800/50 text-center">
                      <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest truncate mb-0.5">{m.label}</p>
                      <p className={cn("text-[11px] font-black italic", m.color)}>{String(m.val)}</p>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Price Insights + Shareholding */}
          {detailedInsights && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card title="Price Insights" icon={TrendingUp}>
                <div className="space-y-3 pt-2">
                  {detailedInsights.price?.map((p, i) => (
                    <div key={i} className="flex items-start gap-2 p-2.5 bg-slate-950 rounded-xl border border-slate-800/50">
                      <div className={cn("w-1.5 h-1.5 rounded-full mt-1.5 shrink-0",
                        p.color === 'positive' ? 'bg-emerald-500' : p.color === 'negative' ? 'bg-rose-500' : 'bg-slate-500'
                      )} />
                      <div className="flex-1">
                        <p className="text-[11px] text-slate-300 font-medium leading-relaxed">{p.shortDesc}</p>
                        {p.linktext && (
                          <a href={p.linkurl} target="_blank" rel="noopener noreferrer"
                            className="text-[9px] font-black text-blue-500 hover:text-blue-400 uppercase tracking-widest mt-1 inline-block">
                            {p.linktext} →
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                  {detailedInsights.financials?.cagr && (
                    <div className="mt-3 p-3 bg-slate-950 rounded-xl border border-slate-800/50">
                      <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2">CAGR Growth (3Y)</p>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div>
                          <p className="text-[8px] font-black text-emerald-500 uppercase">Revenue</p>
                          <p className="text-xs font-black text-white">{detailedInsights.financials.cagr.Revenue}%</p>
                        </div>
                        <div>
                          <p className="text-[8px] font-black text-blue-500 uppercase">Net Profit</p>
                          <p className="text-xs font-black text-white">{detailedInsights.financials.cagr.NetProfit}%</p>
                        </div>
                        <div>
                          <p className="text-[8px] font-black text-amber-500 uppercase">Op Profit</p>
                          <p className="text-xs font-black text-white">{detailedInsights.financials.cagr.OperatingProfit}%</p>
                        </div>
                      </div>
                    </div>
                  )}
                  {tb?.cagrData && (() => {
                    const cd = tb.cagrData;
                    const rows: { label: string; color: string; y1?: number|null; y3?: number|null; y5?: number|null }[] = [
                      { label: 'Sales',       color: 'text-emerald-500', y1: cd.sales_growth?.value?.one_year,           y3: cd.sales_growth?.value?.three_year,           y5: cd.sales_growth?.value?.five_year },
                      { label: 'Net Profit',  color: 'text-blue-500',    y1: cd.net_profit_growth?.value?.one_year,      y3: cd.net_profit_growth?.value?.three_year,      y5: cd.net_profit_growth?.value?.five_year },
                      { label: 'Op Profit',   color: 'text-amber-500',   y1: cd.operating_profit_growth?.value?.one_year, y3: cd.operating_profit_growth?.value?.three_year, y5: cd.operating_profit_growth?.value?.five_year },
                      { label: 'Stock',       color: 'text-violet-500',  y1: cd.stock_growth?.value?.one_year,           y3: cd.stock_growth?.value?.three_year,           y5: cd.stock_growth?.value?.five_year },
                    ];
                    const hasData = rows.some(r => r.y1 != null || r.y3 != null || r.y5 != null);
                    if (!hasData) return null;
                    return (
                      <div className="mt-3 p-3 bg-violet-500/5 rounded-xl border border-violet-500/20">
                        <p className="text-[9px] font-black text-violet-500 uppercase tracking-widest mb-2">TradeBrains CAGR</p>
                        <div className="overflow-x-auto">
                          <table className="w-full text-center">
                            <thead>
                              <tr className="text-[8px] font-black uppercase tracking-widest text-slate-500">
                                <th className="pb-1.5 text-left">Metric</th>
                                <th className="pb-1.5">1Y</th><th className="pb-1.5">3Y</th><th className="pb-1.5">5Y</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/40">
                              {rows.filter(r => r.y1 != null || r.y3 != null || r.y5 != null).map((r, i) => (
                                <tr key={i}>
                                  <td className={cn("py-1 text-left text-[9px] font-black uppercase", r.color)}>{r.label}</td>
                                  {[r.y1, r.y3, r.y5].map((v, j) => (
                                    <td key={j} className="py-1 text-[10px] font-black text-white tabular-nums">
                                      {v != null ? `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}%` : '—'}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </Card>

              {/* Shareholding & Sector Compare - Section Sensitive */}
              {(!section || section === 'all' || section === 'shareholding' || section === 'peers') && (
                <Card 
                  title={section === 'peers' ? "Industry Comparison" : section === 'shareholding' ? "Shareholding Analysis" : "Shareholding & Sector Compare"} 
                  icon={section === 'peers' ? Users : PieChart}
                >
                  <div className="space-y-3 pt-2">
                    {/* Shareholding Part */}
                    {(section === 'all' || section === 'shareholding' || !section) && (
                      <>
                        {detailedInsights.shareholding?.map((sh, i) => (
                          <div key={i} className="flex justify-between items-center p-2 bg-slate-950 rounded-lg border border-slate-800/50">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{sh.shorttext}</span>
                            <span className={cn("text-[9px] font-black text-right max-w-[60%]",
                              sh.color === 'positive' ? "text-emerald-400" : sh.color === 'negative' ? "text-rose-400" : "text-slate-300"
                            )}>{sh.longtext}</span>
                          </div>
                        ))}
                        {tb?.shareHoldingGraph?.insights && (() => {
                          const shi = tb.shareHoldingGraph.insights;
                          const allInsights: string[] = [
                            ...(Array.isArray(shi.Blue) ? shi.Blue : []),
                            ...(Array.isArray(shi.Green) ? shi.Green : []),
                            ...(Array.isArray(shi.Red) ? shi.Red : []),
                          ];
                          if (allInsights.length === 0) return null;
                          return (
                            <div className="mt-3 space-y-1">
                              <p className="text-[9px] font-black text-violet-500 uppercase tracking-widest mb-2">Shareholding Trends</p>
                              {allInsights.slice(0, 4).map((ins: string, i: number) => {
                                const isPositive = shi.Blue?.includes(ins) || shi.Green?.includes(ins);
                                return (
                                  <div key={i} className={cn("flex items-start gap-2 p-2 rounded-lg border text-[10px] font-medium text-slate-300 leading-relaxed",
                                    isPositive ? "bg-emerald-500/5 border-emerald-500/10" : "bg-rose-500/5 border-rose-500/10"
                                  )}>
                                    <span className={cn("shrink-0 mt-0.5 text-[9px] font-black", isPositive ? "text-emerald-400" : "text-rose-400")}>
                                      {isPositive ? '↑' : '↓'}
                                    </span>
                                    {ins}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </>
                    )}

                    {/* Industry Comparison Part */}
                    {(section === 'all' || section === 'peers' || !section) && detailedInsights.industryComparison && (
                      <>
                        {(section === 'all' || !section) && <div className="h-px bg-slate-800 my-2" />}
                        {section === 'all' || !section || section === 'peers' ? (
                          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2">Industry Comparison</p>
                        ) : null}
                        {detailedInsights.industryComparison.slice(0, 5).map((ic, i) => (
                          <div key={i} className="flex justify-between items-center p-2 bg-slate-950 rounded-lg border border-slate-800/50">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest truncate mr-2">{ic.title}</span>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[10px] font-bold text-white tabular-nums">{ic.value?.toLocaleString()}</span>
                              <span className={cn("text-[8px] font-black px-1.5 py-0.5 rounded",
                                ic.color === 'positive' ? "bg-emerald-500/10 text-emerald-500" :
                                ic.color === 'negative' ? "bg-rose-500/10 text-rose-400" : "bg-slate-800 text-slate-400"
                              )}>{ic.shortDesc}</span>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </Card>
              )}
            </div>
          )}

          {/* Price & Volume Performance */}
          {pv && (
            <Card title="Price & Volume Performance" icon={BarChart3}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                <div className="space-y-4">
                  <div>
                    <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3">Price Returns</p>
                    <div className="grid grid-cols-3 gap-2">
                      {Object.entries(pv.price || {}).map(([period, val]) => (
                        <div key={period} className="p-2.5 bg-slate-950 rounded-xl border border-slate-800/50 text-center">
                          <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">{period}</p>
                          <p className={cn("text-xs font-black italic", val >= 0 ? "text-emerald-400" : "text-rose-400")}>
                            {val >= 0 ? '+' : ''}{val}%
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                  {tb?.stockReturns && (() => {
                    const sr = tb.stockReturns;
                    const periods = [
                      { label: '1W', val: sr.one_week },  { label: '1M', val: sr.one_month },
                      { label: '6M', val: sr.six_months },{ label: '1Y', val: sr.one_year },
                      { label: '3Y', val: sr.three_year },{ label: '5Y', val: sr.five_year },
                    ].filter(p => p.val != null);
                    if (periods.length === 0) return null;
                    return (
                      <div>
                        <p className="text-[9px] font-black text-violet-500 uppercase tracking-widest mb-2">TradeBrains Returns</p>
                        <div className="grid grid-cols-4 gap-1.5">
                          {periods.map(({ label, val }) => {
                            const n = typeof val === 'string' ? parseFloat(val) : Number(val);
                            return (
                              <div key={label} className="p-2 bg-violet-500/5 rounded-lg border border-violet-500/10 text-center">
                                <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">{label}</p>
                                <p className={cn("text-[10px] font-black italic", n >= 0 ? "text-emerald-400" : "text-rose-400")}>
                                  {n >= 0 ? '+' : ''}{n.toFixed(1)}%
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </div>
                <div>
                  <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3">Volume Profile & Delivery</p>
                  <div className="space-y-3">
                    {Object.entries(pv.volume || {}).map(([period, v]) => {
                      const deliveryPctMatch = v.delivery_display_text?.match(/\(([\d.]+)%\)/);
                      const deliveryPct = deliveryPctMatch ? parseFloat(deliveryPctMatch[1]) : 0;
                      return (
                        <div key={period} className="p-3 bg-slate-950 rounded-xl border border-slate-800/50 group hover:border-slate-700 transition-all">
                          <div className="flex justify-between items-center mb-2">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{period}</span>
                            <div className="flex flex-col items-end">
                              <span className="text-[11px] font-black text-white italic">{v.cvol_display_text}</span>
                              <span className="text-[8px] font-bold text-slate-500 uppercase tracking-tighter">Total Traded</span>
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <div className="flex justify-between items-center text-[9px]">
                              <span className="text-slate-500 font-bold uppercase">Delivery Volume</span>
                              <span className={cn("font-black italic",
                                deliveryPct >= 50 ? "text-emerald-400" : deliveryPct >= 30 ? "text-blue-400" : "text-amber-400"
                              )}>{v.delivery_display_text.split('(')[0].trim()} ({deliveryPct}%)</span>
                            </div>
                            <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden flex">
                              <motion.div initial={{ width: 0 }} animate={{ width: `${deliveryPct}%` }}
                                className={cn("h-full rounded-full transition-all duration-1000",
                                  deliveryPct >= 50 ? "bg-emerald-500" : deliveryPct >= 30 ? "bg-blue-500" : "bg-amber-500"
                                )} />
                            </div>
                          </div>
                          {(v.cvol_tooltip_text || v.delivery_tooltip_text) && (
                            <div className="mt-2 pt-2 border-t border-slate-900/50 flex gap-2 overflow-hidden">
                              <Info className="w-3 h-3 text-slate-700 shrink-0" />
                              <p className="text-[8px] text-slate-600 font-medium truncate italic">
                                {v.cvol_tooltip_text || v.delivery_tooltip_text}
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* Earnings EPS Forecast */}
          {ef?.eps && ef.eps.length > 0 && (
            <Card title="Earnings Forecast (EPS)" icon={Activity}>
              <div className="overflow-x-auto pt-2">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[9px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-800">
                      <th className="pb-2 pr-3">Period</th>
                      <th className="pb-2 pr-3 text-right">High</th>
                      <th className="pb-2 pr-3 text-right">Avg</th>
                      <th className="pb-2 pr-3 text-right">Low</th>
                      <th className="pb-2 text-right">Actual</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {ef.eps.map((row, i) => (
                      <tr key={i} className="text-[11px] font-bold">
                        <td className="py-2 pr-3 text-slate-300">{row.date}</td>
                        <td className="py-2 pr-3 text-right text-slate-300">{row.high || '—'}</td>
                        <td className="py-2 pr-3 text-right text-white">{row.avg || '—'}</td>
                        <td className="py-2 pr-3 text-right text-slate-300">{row.low || '—'}</td>
                        <td className={cn("py-2 text-right", row.actual ? "text-emerald-400" : "text-slate-600")}>{row.actual || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Net Profit Forecast */}
          {ef?.netProfit && ef.netProfit.length > 0 && (
            <Card title="Net Profit Forecast (Cr)" icon={BarChart3}>
              <div className="overflow-x-auto pt-2">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[9px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-800">
                      <th className="pb-2 pr-3">Period</th>
                      <th className="pb-2 pr-3 text-right">High</th>
                      <th className="pb-2 pr-3 text-right">Avg</th>
                      <th className="pb-2 pr-3 text-right">Low</th>
                      <th className="pb-2 text-right">Actual</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {ef.netProfit.map((row, i) => (
                      <tr key={i} className="text-[11px] font-bold">
                        <td className="py-2 pr-3 text-slate-300">{row.date}</td>
                        <td className="py-2 pr-3 text-right text-slate-300">{row.high ? `₹${row.high}` : '—'}</td>
                        <td className="py-2 pr-3 text-right text-white">{row.avg ? `₹${row.avg}` : '—'}</td>
                        <td className="py-2 pr-3 text-right text-slate-300">{row.low ? `₹${row.low}` : '—'}</td>
                        <td className={cn("py-2 text-right", row.actual ? "text-emerald-400" : "text-slate-600")}>{row.actual || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Hits & Misses */}
          {hm?.list && hm.list.length > 0 && (
            <Card title="Earnings Hits & Misses" icon={Activity}>
              <div className="overflow-x-auto pt-2">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[9px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-800">
                      <th className="pb-2 pr-3">Quarter</th>
                      <th className="pb-2 pr-3 text-right">Actual</th>
                      <th className="pb-2 pr-3 text-right">Estimate</th>
                      <th className="pb-2 text-right">Type</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {hm.list.map((row, i) => (
                      <tr key={i} className="text-[11px] font-bold">
                        <td className="py-2 pr-3 text-slate-300">{row.quarter}</td>
                        <td className="py-2 pr-3 text-right text-white">{row.actual || '—'}</td>
                        <td className="py-2 pr-3 text-right text-slate-300">{row.estimates || '—'}</td>
                        <td className="py-2 text-right">
                          <span className={cn("text-[9px] font-black px-2 py-0.5 rounded uppercase tracking-tighter",
                            row.type === 'positive' ? "bg-emerald-500/10 text-emerald-400" :
                            row.type === 'negative' ? "bg-rose-500/10 text-rose-400" : "bg-slate-800 text-slate-400"
                          )}>{row.type}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Piotroski Score */}
          {detailedInsights?.financials?.piotroskiData && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 bg-slate-950 border border-slate-800 rounded-2xl text-center">
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Piotroski Score</p>
                <p className={cn("text-2xl font-black italic",
                  parseInt(detailedInsights.financials.piotroskiData.score) >= 7 ? "text-emerald-400" :
                  parseInt(detailedInsights.financials.piotroskiData.score) >= 5 ? "text-amber-400" : "text-rose-400"
                )}>{detailedInsights.financials.piotroskiData.score}/9</p>
                <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mt-1">{detailedInsights.financials.piotroskiData.shortDesc}</p>
              </div>
              <div className="md:col-span-2 p-4 bg-slate-950 border border-slate-800 rounded-2xl flex items-center">
                <p className="text-[10px] text-slate-400 italic font-medium">{detailedInsights.financials.piotroskiData.tooltip}</p>
              </div>
            </div>
          )}

          {/* Credit Ratings */}
          {Array.isArray(tb?.creditRating) && tb.creditRating.length > 0 && (
            <Card title="Credit Ratings" icon={Filter}>
              <div className="space-y-2 pt-2">
                {tb.creditRating.slice(0, 6).map((cr: any, i: number) => {
                  const rating  = cr.rating   || '—';
                  const agency  = cr.ratingby || '';
                  const sectype = cr.sectype  || '';
                  const status  = cr.stattype || '';
                  const date    = cr.ratdate  || '';
                  const isSafe   = /AAA|AA\+?|A\+?(?![-B])|BBB/.test(rating.toUpperCase());
                  const isDanger = /B[-+]?|CCC|D/.test(rating.toUpperCase()) && !/BBB|AAA|AA/.test(rating.toUpperCase());
                  return (
                    <div key={i} className="flex items-center justify-between p-3 bg-slate-950 rounded-xl border border-slate-800/50">
                      <div className="flex items-center gap-3">
                        <span className={cn("text-sm font-black italic px-2 py-0.5 rounded min-w-[3rem] text-center",
                          isSafe ? "bg-emerald-500/10 text-emerald-400" :
                          isDanger ? "bg-rose-500/10 text-rose-400" : "bg-amber-500/10 text-amber-400"
                        )}>{rating}</span>
                        <div>
                          {agency && <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest">{agency}</p>}
                          <p className="text-[9px] text-slate-500 font-bold">{[sectype, status].filter(Boolean).join(' · ')}</p>
                        </div>
                      </div>
                      {date && <p className="text-[9px] text-slate-600 font-bold shrink-0">{String(date).slice(0, 10)}</p>}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* TECHNICAL TAB                                                  */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'technical' && (
        <div className="space-y-6">

          {/* Technical Analysis */}
          {tech && (
            <Card title={`Technical Analysis (${timeframe === 'D' ? 'Daily' : timeframe === 'W' ? 'Weekly' : 'Monthly'})`} icon={Activity}>
              <div className="space-y-6">
                {tech.sentiments && (
                  <div className="p-4 bg-slate-950 rounded-2xl border border-slate-800">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Overall Sentiment</span>
                      <SentimentBadge sentiment={tech.sentiments.indication} />
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <p className="text-emerald-400 text-xl font-black">{tech.sentiments.totalBullish}</p>
                        <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mt-1">Bullish</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-xl font-black">{tech.sentiments.totalNeutral}</p>
                        <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mt-1">Neutral</p>
                      </div>
                      <div>
                        <p className="text-rose-400 text-xl font-black">{tech.sentiments.totalBearish}</p>
                        <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mt-1">Bearish</p>
                      </div>
                    </div>
                    <div className="flex gap-2 mt-3">
                      {[
                        { label: 'MA',         bullish: tech.sentiments.movingAverageSentiment?.bullishCount ?? 0,          bearish: tech.sentiments.movingAverageSentiment?.bearishCount ?? 0 },
                        { label: 'Cross',      bullish: tech.sentiments.movingAverageCrossOverSentiment?.bullishCount ?? 0, bearish: tech.sentiments.movingAverageCrossOverSentiment?.bearishCount ?? 0 },
                        { label: 'Indicators', bullish: tech.sentiments.indicatorsSentiment?.bullishCount ?? 0,             bearish: tech.sentiments.indicatorsSentiment?.bearishCount ?? 0 },
                      ].map(s => (
                        <div key={s.label} className="flex-1 p-2 bg-slate-900 rounded-lg text-center">
                          <p className="text-[8px] font-black text-slate-600 uppercase tracking-widest mb-1">{s.label}</p>
                          <div className="flex justify-center gap-2 text-[10px] font-black">
                            <span className="text-emerald-400">{s.bullish}B</span>
                            <span className="text-slate-600">/</span>
                            <span className="text-rose-400">{s.bearish}B</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Momentum Indicators</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {tech.indicators?.map((ind: any) => (
                      <IndicatorRow key={ind.id} name={ind.displayName} value={ind.value} sentiment={ind.indication} />
                    ))}
                  </div>
                </div>
                {tech.crossover && tech.crossover.length > 0 && (
                  <div>
                    <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Moving Average Crossovers</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      {tech.crossover.map((cross: any) => (
                        <div key={cross.key} className="p-3 bg-slate-950 rounded-xl border border-slate-800/50">
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{cross.period}</span>
                            <SentimentBadge sentiment={cross.indication} />
                          </div>
                          <p className="text-[11px] text-slate-300 font-bold">{cross.displayValue}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* MC Pivot Levels */}
          {tech?.pivotLevels && tech.pivotLevels.length > 0 && (
            <Card title="Pivot Levels" icon={Filter}>
              <div className="space-y-4 pt-2">
                {tech.pivotLevels.map((pg: any) => (
                  <div key={pg.key} className="p-4 bg-slate-950 rounded-2xl border border-slate-800/50">
                    <p className="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-3">{pg.key}</p>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                      <div className="p-2 bg-slate-900 rounded-lg text-center border border-emerald-500/20">
                        <p className="text-[8px] font-black text-emerald-500 uppercase tracking-widest">R2</p>
                        <p className="text-xs font-black text-white">₹{pg.pivotLevel.r2}</p>
                      </div>
                      <div className="p-2 bg-slate-900 rounded-lg text-center border border-emerald-500/10">
                        <p className="text-[8px] font-black text-emerald-400 uppercase tracking-widest">R1</p>
                        <p className="text-xs font-black text-white">₹{pg.pivotLevel.r1}</p>
                      </div>
                      <div className="p-2 bg-slate-900 rounded-lg text-center border border-blue-500/30 ring-1 ring-blue-500/20">
                        <p className="text-[8px] font-black text-blue-500 uppercase tracking-widest">Pivot</p>
                        <p className="text-xs font-black text-white">₹{pg.pivotLevel.pivotPoint}</p>
                      </div>
                      <div className="p-2 bg-slate-900 rounded-lg text-center border border-rose-500/10">
                        <p className="text-[8px] font-black text-rose-400 uppercase tracking-widest">S1</p>
                        <p className="text-xs font-black text-white">₹{pg.pivotLevel.s1}</p>
                      </div>
                      <div className="p-2 bg-slate-900 rounded-lg text-center border border-rose-500/20">
                        <p className="text-[8px] font-black text-rose-500 uppercase tracking-widest">S2</p>
                        <p className="text-xs font-black text-white">₹{pg.pivotLevel.s2}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* TradeBrains Pivot Levels */}
          {tb?.pivotData && (() => {
            const pd = tb.pivotData;
            const levels = [
              { label: 'Fibonacci', data: pd.fibonacci },
              { label: 'Standard',  data: pd.standard  },
            ].filter(l => l.data);
            if (levels.length === 0) return null;
            return (
              <Card title="TradeBrains Pivot Levels" icon={Filter}>
                <div className="space-y-4 pt-2">
                  {levels.map(({ label, data }) => (
                    <div key={label} className="p-4 bg-slate-950 rounded-2xl border border-slate-800/50">
                      <p className="text-[10px] font-black text-violet-500 uppercase tracking-widest mb-3">{label}</p>
                      <div className="grid grid-cols-3 md:grid-cols-7 gap-2 text-center">
                        {[
                          { k: 'res_three',    label: 'R3', cls: 'border-emerald-500/40 text-emerald-300' },
                          { k: 'res_two',      label: 'R2', cls: 'border-emerald-500/30 text-emerald-400' },
                          { k: 'res_one',      label: 'R1', cls: 'border-emerald-500/20 text-emerald-400' },
                          { k: 'pivot',        label: 'PP', cls: 'border-blue-500/40 text-blue-400 ring-1 ring-blue-500/20' },
                          { k: 'support_one',  label: 'S1', cls: 'border-rose-500/20 text-rose-400' },
                          { k: 'support_two',  label: 'S2', cls: 'border-rose-500/30 text-rose-400' },
                          { k: 'support_three',label: 'S3', cls: 'border-rose-500/40 text-rose-300' },
                        ].map(({ k, label: lbl, cls }) => data[k] != null ? (
                          <div key={k} className={cn("p-2 bg-slate-900 rounded-lg border", cls)}>
                            <p className="text-[8px] font-black uppercase tracking-widest mb-0.5">{lbl}</p>
                            <p className="text-[10px] font-black text-white tabular-nums">₹{Number(data[k]).toFixed(2)}</p>
                          </div>
                        ) : null)}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })()}

          {/* SMA / EMA */}
          {tech && (tech.sma?.length > 0 || tech.ema?.length > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card title="SMA Levels" icon={TrendingUp}>
                <div className="grid grid-cols-2 gap-2 pt-2">
                  {tech.sma?.map((ma: any) => (
                    <div key={ma.key} className="flex justify-between items-center p-2.5 bg-slate-950 rounded-xl border border-slate-800/50">
                      <span className="text-[10px] font-black text-slate-500 uppercase">SMA {ma.key}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white tabular-nums">₹{ma.value}</span>
                        <SentimentBadge sentiment={ma.indication} />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
              <Card title="EMA Levels" icon={Activity}>
                <div className="grid grid-cols-2 gap-2 pt-2">
                  {tech.ema?.map((ma: any) => (
                    <div key={ma.key} className="flex justify-between items-center p-2.5 bg-slate-950 rounded-xl border border-slate-800/50">
                      <span className="text-[10px] font-black text-slate-500 uppercase">EMA {ma.key}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white tabular-nums">₹{ma.value}</span>
                        <SentimentBadge sentiment={ma.indication} />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}

          {/* Technical Rating */}
          {(technicalRating || technicalV2) && (() => {
            const rating = technicalRating?.data || technicalRating;
            const v2 = technicalV2?.data || technicalV2;
            const ratingText = rating?.rating || v2?.sentiments?.indication || '';
            const buyCount  = rating?.buyCount  ?? rating?.buy  ?? v2?.sentiments?.totalBullish ?? null;
            const sellCount = rating?.sellCount ?? rating?.sell ?? v2?.sentiments?.totalBearish ?? null;
            const holdCount = rating?.holdCount ?? rating?.hold ?? v2?.sentiments?.totalNeutral ?? null;
            if (!ratingText && buyCount === null) return null;
            const isBull = ratingText.toLowerCase().includes('bullish') || ratingText.toLowerCase().includes('buy');
            const isBear = ratingText.toLowerCase().includes('bearish') || ratingText.toLowerCase().includes('sell');
            return (
              <div className={cn("p-4 rounded-2xl border flex items-center justify-between gap-4",
                isBull ? "bg-emerald-500/5 border-emerald-500/20" :
                isBear ? "bg-rose-500/5 border-rose-500/20" : "bg-slate-950 border-slate-800"
              )}>
                <div className="flex items-center gap-3">
                  <Zap className={cn("w-5 h-5", isBull ? "text-emerald-400" : isBear ? "text-rose-400" : "text-slate-500")} />
                  <div>
                    <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">
                      MC Technical Rating ({timeframe === 'D' ? 'Daily' : timeframe === 'W' ? 'Weekly' : 'Monthly'})
                    </p>
                    <p className={cn("text-sm font-black uppercase italic", isBull ? "text-emerald-400" : isBear ? "text-rose-400" : "text-slate-300")}>
                      {ratingText || 'Neutral'}
                    </p>
                  </div>
                </div>
                {(buyCount !== null || sellCount !== null) && (
                  <div className="flex gap-4 text-center">
                    {buyCount  !== null && <div><p className="text-[8px] font-black text-emerald-500 uppercase tracking-widest">Buy</p><p className="text-lg font-black text-emerald-400">{buyCount}</p></div>}
                    {holdCount !== null && <div><p className="text-[8px] font-black text-amber-500 uppercase tracking-widest">Hold</p><p className="text-lg font-black text-amber-400">{holdCount}</p></div>}
                    {sellCount !== null && <div><p className="text-[8px] font-black text-rose-500 uppercase tracking-widest">Sell</p><p className="text-lg font-black text-rose-400">{sellCount}</p></div>}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Technical Analysis V2 Notes */}
          {technicalAnalysisV2?.data && (technicalAnalysisV2.data.smaNote || technicalAnalysisV2.data.crossNote || technicalAnalysisV2.data.indicatorNote) && (
            <Card title="Trend Analysis" icon={Activity}>
              <div className="flex flex-col gap-3">
                {[
                  { label: 'Moving Averages', note: technicalAnalysisV2.data.smaNote },
                  { label: 'MA Crossovers', note: technicalAnalysisV2.data.crossNote },
                  { label: 'Indicators', note: technicalAnalysisV2.data.indicatorNote }
                ].filter(x => x.note).map((item, idx) => {
                  const isBull = item.note.toLowerCase().includes('bullish');
                  const isBear = item.note.toLowerCase().includes('bearish');
                  return (
                    <div key={idx} className="p-3 bg-slate-900 rounded-xl border border-slate-800 flex items-center justify-between gap-4">
                      <div>
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{item.label}</p>
                        <p className="text-xs font-medium text-slate-300 mt-1">{item.note}</p>
                      </div>
                      <span className={cn(
                        "px-2 py-1 rounded text-[9px] font-black uppercase tracking-widest shrink-0 border",
                        isBull ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                        isBear ? "bg-rose-500/10 text-rose-400 border-rose-500/20" :
                        "bg-slate-800 text-slate-400 border-slate-700"
                      )}>
                        {isBull ? 'BULLISH' : isBear ? 'BEARISH' : 'NEUTRAL'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Chart Patterns (Technical Picks) */}
          {chartPatterns?.data && chartPatterns.data.length > 0 && (
            <Card title="Chart Patterns & Technical Picks" icon={Activity}>
              <div className="grid grid-cols-1 gap-4 pt-2">
                {chartPatterns.data.map((pattern: any, idx: number) => {
                  let meta: any = {};
                  try {
                    meta = JSON.parse(pattern.meta_data);
                  } catch (e) {
                    // ignore
                  }
                  
                  const isBuy = meta.pattern_type === 'buy';
                  const isSell = meta.pattern_type === 'sell';
                  const imgUrl = meta.timeline?.[0]?.pattern_img?.['1200x600'] || meta.timeline?.[0]?.pattern_img?.['800x400'];
                  const rationale = meta.timeline?.[0]?.rationale;
                  
                  return (
                    <div key={idx} className="p-4 bg-slate-950 border border-slate-800 rounded-2xl flex flex-col md:flex-row gap-4">
                      {imgUrl && (
                        <div className="w-full md:w-1/3 shrink-0">
                          <img src={imgUrl} alt={pattern.pattern_name} className="w-full h-auto rounded-lg border border-slate-800 object-cover" />
                        </div>
                      )}
                      <div className="flex-1 space-y-3">
                        <div className="flex justify-between items-start gap-2">
                          <div>
                            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{pattern.time_frame} • {pattern.updated_at?.split(' ')[0]}</p>
                            <h4 className="text-sm font-black text-white">{pattern.pattern_name}</h4>
                            <p className="text-[11px] text-slate-400 italic">{pattern.comment}</p>
                          </div>
                          <span className={cn("text-[9px] font-black px-2 py-0.5 rounded uppercase tracking-widest shrink-0",
                            isBuy ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : 
                            isSell ? "bg-rose-500/10 text-rose-400 border border-rose-500/20" : 
                            "bg-slate-800 text-slate-400 border border-slate-700"
                          )}>
                            {meta.pattern_type || pattern.p_status}
                          </span>
                        </div>
                        
                        {(meta.entry_price || meta.target_price || meta.stoploss_price) && (
                          <div className="grid grid-cols-3 gap-2 p-2 bg-slate-900 rounded-lg">
                            {meta.entry_price && (
                              <div className="text-center border-r border-slate-800 last:border-0">
                                <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Entry</p>
                                <p className="text-[11px] font-black text-white">₹{meta.entry_price}</p>
                              </div>
                            )}
                            {meta.target_price && (
                              <div className="text-center border-r border-slate-800 last:border-0">
                                <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Target</p>
                                <p className="text-[11px] font-black text-emerald-400">₹{meta.target_price}</p>
                                {meta.target_return_prcnt && (
                                  <p className="text-[8px] font-bold text-emerald-500">{meta.target_return_prcnt}%</p>
                                )}
                              </div>
                            )}
                            {meta.stoploss_price && (
                              <div className="text-center border-r border-slate-800 last:border-0">
                                <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Stop Loss</p>
                                <p className="text-[11px] font-black text-rose-400">₹{meta.stoploss_price}</p>
                                {meta.stoploss_prcnt && (
                                  <p className="text-[8px] font-bold text-rose-500">{meta.stoploss_prcnt}%</p>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        
                        {rationale && (
                          <div className="p-2.5 bg-slate-900/50 rounded-lg border border-slate-800/50">
                            <p className="text-[11px] text-slate-300 leading-relaxed font-medium">{rationale}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Historical Rating Chart */}
          {historicalRating && (() => {
            const raw: any[] =
              Array.isArray(historicalRating) ? historicalRating :
              Array.isArray(historicalRating?.data) ? historicalRating.data :
              Array.isArray(historicalRating?.data?.ratingData) ? historicalRating.data.ratingData :
              Array.isArray(historicalRating?.ratingData) ? historicalRating.ratingData : [];
            if (raw.length === 0) return null;
            const chartData = raw.map((d: any) => ({
              date:    d.date || d.dt || '',
              bullish: d.bullish ?? d.bullishCount ?? d.buy ?? 0,
              bearish: d.bearish ?? d.bearishCount ?? d.sell ?? 0,
              neutral: d.neutral ?? d.neutralCount ?? d.hold ?? 0,
            })).filter((d: any) => d.date || d.bullish || d.bearish);
            if (chartData.length < 2) return null;
            return (
              <Card title="Historical Technical Rating — 6 Month Trend" icon={Activity}>
                <div className="h-44 mt-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#475569' }} tickFormatter={(v: string) => v?.slice(0, 6) || ''} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 8, fill: '#475569' }} />
                      <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', fontSize: '9px' }}
                        formatter={(v: any, n: string) => [v, n.charAt(0).toUpperCase() + n.slice(1)]}
                        labelFormatter={(l: string) => l} />
                      <Legend wrapperStyle={{ fontSize: '9px', paddingTop: '8px' }} />
                      <Line type="monotone" dataKey="bullish" stroke="#10b981" strokeWidth={2} dot={false} name="bullish" />
                      <Line type="monotone" dataKey="neutral" stroke="#f59e0b" strokeWidth={1.5} dot={false} name="neutral" />
                      <Line type="monotone" dataKey="bearish" stroke="#f43f5e" strokeWidth={2} dot={false} name="bearish" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="text-[8px] text-center text-slate-700 font-bold uppercase tracking-widest mt-2">
                  {chartData.length} data points • {timeframe === 'D' ? 'Daily' : timeframe === 'W' ? 'Weekly' : 'Monthly'} period
                </p>
              </Card>
            );
          })()}

        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* ANALYSIS TAB                                                   */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'analysis' && (
        <div className="space-y-6">

          {/* Shareholding Analysis (Textual) */}
          {(!section || section === 'all' || section === 'shareholding' || section === 'insights') && detailedInsights.shareholding && (
            <Card title="Shareholding Analysis" icon={PieChart}>
              <div className="space-y-3 pt-2">
                {detailedInsights.shareholding.map((sh, i) => (
                  <div key={i} className="flex justify-between items-center p-2 bg-slate-950 rounded-lg border border-slate-800/50">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{sh.shorttext}</span>
                    <span className={cn("text-[9px] font-black text-right max-w-[60%]",
                      sh.color === 'positive' ? "text-emerald-400" : sh.color === 'negative' ? "text-rose-400" : "text-slate-300"
                    )}>{sh.longtext}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* TradeBrains Pros & Cons */}
          {tb?.insights && (() => {
            const ins = tb.insights;
            const pros: string[] = Array.isArray(ins?.pros) ? ins.pros : Array.isArray(ins?.positives) ? ins.positives : Array.isArray(ins?.strengths) ? ins.strengths : [];
            const cons: string[] = Array.isArray(ins?.cons) ? ins.cons : Array.isArray(ins?.negatives) ? ins.negatives : Array.isArray(ins?.weaknesses) ? ins.weaknesses : [];
            if (pros.length === 0 && cons.length === 0) return null;
            return (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {pros.length > 0 && (
                  <Card title="TradeBrains Pros" icon={TrendingUp}>
                    <div className="space-y-1.5 pt-2">
                      {pros.slice(0, 6).map((p: string, i: number) => (
                        <div key={i} className="flex items-start gap-2 p-2 bg-violet-500/5 rounded-xl border border-violet-500/10">
                          <span className="text-[9px] text-violet-400 font-black mt-0.5 shrink-0">✓</span>
                          <span className="text-[11px] text-slate-300 font-medium leading-relaxed">{p}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
                {cons.length > 0 && (
                  <Card title="TradeBrains Cons" icon={TrendingDown}>
                    <div className="space-y-1.5 pt-2">
                      {cons.slice(0, 6).map((c: string, i: number) => (
                        <div key={i} className="flex items-start gap-2 p-2 bg-rose-500/5 rounded-xl border border-rose-500/10">
                          <AlertCircle className="w-3 h-3 text-rose-500 mt-0.5 shrink-0" />
                          <span className="text-[11px] text-slate-300 font-medium leading-relaxed">{c}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            );
          })()}

          {/* SWOT Analysis */}
          {swot && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card title="Strengths & Opportunities" icon={TrendingUp}>
                <div className="space-y-4 pt-2">
                  {swot.strengths.length > 0 && (
                    <div>
                      <p className="text-[10px] font-black text-emerald-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> Strengths ({swot.strengths.length})
                      </p>
                      <div className="space-y-1.5">
                        {swot.strengths.map((s, i) => (
                          <div key={i} className="flex items-start gap-2 p-2 bg-emerald-500/5 rounded-xl border border-emerald-500/10">
                            <span className="text-[9px] text-emerald-400 font-black mt-0.5 shrink-0">✓</span>
                            <span className="text-[11px] text-slate-300 font-medium leading-relaxed">{s}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {swot.opportunities.length > 0 && (
                    <div>
                      <p className="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                        <Zap className="w-3 h-3" /> Opportunities ({swot.opportunities.length})
                      </p>
                      <div className="space-y-1.5">
                        {swot.opportunities.map((o, i) => (
                          <div key={i} className="flex items-start gap-2 p-2 bg-blue-500/5 rounded-xl border border-blue-500/10">
                            <Zap className="w-3 h-3 text-blue-500 mt-0.5 shrink-0" />
                            <span className="text-[11px] text-slate-300 font-medium leading-relaxed">{o}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </Card>
              <Card title="Weaknesses & Threats" icon={TrendingDown}>
                <div className="space-y-4 pt-2">
                  {swot.weaknesses.length > 0 && (
                    <div>
                      <p className="text-[10px] font-black text-rose-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" /> Weaknesses ({swot.weaknesses.length})
                      </p>
                      <div className="space-y-1.5">
                        {swot.weaknesses.map((w, i) => (
                          <div key={i} className="flex items-start gap-2 p-2 bg-rose-500/5 rounded-xl border border-rose-500/10">
                            <AlertCircle className="w-3 h-3 text-rose-500 mt-0.5 shrink-0" />
                            <span className="text-[11px] text-slate-300 font-medium leading-relaxed">{w}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {swot.threats.length > 0 && (
                    <div>
                      <p className="text-[10px] font-black text-amber-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                        <Info className="w-3 h-3" /> Threats ({swot.threats.length})
                      </p>
                      <div className="space-y-1.5">
                        {swot.threats.map((t, i) => (
                          <div key={i} className="flex items-start gap-2 p-2 bg-amber-500/5 rounded-xl border border-amber-500/10">
                            <Info className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" />
                            <span className="text-[11px] text-slate-300 font-medium leading-relaxed">{t}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          )}

        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* ANALYST TAB                                                    */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'analyst' && (
        <div className="space-y-6">

          {/* Analyst Consensus */}
          {ar && (
            <Card title="Analyst Consensus" icon={Users}>
              <div className="space-y-4 pt-2">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Consensus</span>
                  <SentimentBadge sentiment={ar.finalRating} />
                </div>
                <div className="flex items-center gap-2">
                  {ar.ratings?.map((r, i) => {
                    const val = parseInt(r.value);
                    const isBuy  = r.name === 'Buy'  || r.name === 'Outperform';
                    const isSell = r.name === 'Sell' || r.name === 'Underperform';
                    return (
                      <div key={i} className="flex-1 text-center p-2 bg-slate-950 rounded-xl border border-slate-800/50">
                        <p className={cn("text-[8px] font-black uppercase tracking-widest", isBuy ? "text-emerald-500" : isSell ? "text-rose-500" : "text-amber-500")}>{r.name}</p>
                        <p className="text-xs font-black text-white mt-0.5">{val}%</p>
                      </div>
                    );
                  })}
                </div>
                {ar.analystCount && (
                  <p className="text-[9px] text-slate-600 italic text-center font-bold uppercase tracking-widest">
                    Based on {ar.analystCount} analysts
                  </p>
                )}
              </div>
            </Card>
          )}

          {/* Price Forecast */}
          {pf && (
            <Card title="Price Forecast (Analyst Targets)" icon={TrendingUp}>
              <div className="grid grid-cols-3 gap-4 pt-2">
                <div className="p-4 bg-emerald-500/5 border border-emerald-500/20 rounded-2xl text-center">
                  <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest">High</p>
                  <p className="text-xl font-black text-white italic">₹{pf.high}</p>
                </div>
                <div className="p-4 bg-blue-500/5 border border-blue-500/20 rounded-2xl text-center">
                  <p className="text-[9px] font-black text-blue-500 uppercase tracking-widest">Mean</p>
                  <p className="text-xl font-black text-white italic">₹{pf.mean}</p>
                </div>
                <div className="p-4 bg-rose-500/5 border border-rose-500/20 rounded-2xl text-center">
                  <p className="text-[9px] font-black text-rose-500 uppercase tracking-widest">Low</p>
                  <p className="text-xl font-black text-white italic">₹{pf.low}</p>
                </div>
              </div>
              {pf.graphData && pf.graphData.length > 0 && (
                <p className="text-[9px] text-slate-600 italic text-center mt-3 font-bold uppercase tracking-widest">
                  Forecast data points: {pf.graphData.length}
                </p>
              )}
            </Card>
          )}

          {/* Analyst Consensus Trend */}
          {consensus && (
            <Card title="Analyst Consensus Trend" icon={Users}>
              <div className="space-y-3 pt-2">
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2">Rating Distribution Over Time</p>
                <div className="flex flex-wrap gap-2">
                  {consensus.categories?.map((cat, i) => (
                    <span key={i} className="text-[9px] font-bold text-slate-400 bg-slate-950 px-2 py-1 rounded border border-slate-800">{cat}</span>
                  ))}
                </div>
                <div className="space-y-2">
                  {consensus.graphData?.map((g, i) => {
                    const latest = g.data[g.data.length - 1];
                    const isPositive = g.name === 'Buy' || g.name === 'Outperform';
                    const isNegative = g.name === 'Sell' || g.name === 'Underperform';
                    return (
                      <div key={i} className="flex items-center gap-3">
                        <span className={cn("text-[9px] font-black uppercase tracking-widest w-24 shrink-0",
                          isPositive ? "text-emerald-500" : isNegative ? "text-rose-500" : "text-amber-500"
                        )}>{g.name}</span>
                        <div className="flex-1 h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                          <motion.div initial={{ width: 0 }} animate={{ width: `${(latest / Math.max(...g.data)) * 100}%` }}
                            className={cn("h-full rounded-full", isPositive ? "bg-emerald-500" : isNegative ? "bg-rose-500" : "bg-amber-500")} />
                        </div>
                        <span className="text-[10px] font-black text-white tabular-nums w-8 text-right">{latest}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </Card>
          )}

          {/* Valuation Estimates */}
          {valuation?.list && valuation.list.length > 0 && (
            <Card title="Analyst Valuation Estimates" icon={BarChart3}>
              <div className="overflow-x-auto pt-2">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[9px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-800">
                      <th className="pb-2 pr-3">Period</th>
                      <th className="pb-2 pr-3 text-right">EPS</th>
                      <th className="pb-2 pr-3 text-right">PE</th>
                      <th className="pb-2 pr-3 text-right">BVPS</th>
                      <th className="pb-2 pr-3 text-right">PB</th>
                      <th className="pb-2 text-right">Target</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {valuation.list.map((row, i) => (
                      <tr key={i} className="text-[11px] font-bold hover:bg-slate-900/30 transition-colors">
                        <td className="py-2.5 pr-3 text-blue-400 font-black uppercase tracking-widest">{row.heading}</td>
                        <td className="py-2.5 pr-3 text-right text-white tabular-nums">{row.data?.eps || '—'}</td>
                        <td className="py-2.5 pr-3 text-right text-slate-300 tabular-nums">{row.data?.pe || '—'}</td>
                        <td className="py-2.5 pr-3 text-right text-slate-300 tabular-nums">{row.data?.bvps || '—'}</td>
                        <td className="py-2.5 pr-3 text-right text-slate-300 tabular-nums">{row.data?.pb || '—'}</td>
                        <td className="py-2.5 text-right">
                          {row.data?.analyst ? <span className="text-emerald-400 font-black">₹{row.data.analyst}</span> : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {valuation.displayLock === '1' && (
                  <p className="text-[9px] text-amber-500/70 font-bold uppercase tracking-widest mt-3 text-center italic">
                    Some data requires a MoneyControl Pro subscription
                  </p>
                )}
              </div>
            </Card>
          )}

        </div>
      )}

      {/* ── Footer ── */}
      <div className="text-center pt-4 border-t border-slate-800">
        <p className="text-[8px] text-slate-700 font-bold uppercase tracking-widest">
          Data sourced from MoneyControl{tb ? ' · TradeBrains' : ''} · Refreshes every 60s
        </p>
      </div>

    </div>
  );
};

export default MCStockInfoPanel;
