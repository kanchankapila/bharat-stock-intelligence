import React from 'react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import stockData from '../data/stocklist';
import {
  TrendingUp, TrendingDown, Activity, Zap, Info, AlertCircle,
  BarChart3, PieChart, Users, Filter,
  CheckCircle2, BrainCircuit, Search
} from 'lucide-react';
import { motion } from 'motion/react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ComposedChart
} from 'recharts';
import { 
  TechnicalAnalysisWidget, 
  AdvancedChartWidget 
} from './TradingViewWidgets';


const Candlestick = (props: any) => {
  const { x, y, width, height, payload } = props;
  const isGrowing = payload.close > payload.open;
  const color = isGrowing ? '#10b981' : '#f43f5e';
  const range = Math.abs(payload.high - payload.low);
  if (range === 0) return <line x1={x} y1={y} x2={x + width} y2={y} stroke={color} strokeWidth={2} />;
  const ratio = height / range;
  const yTop = y + (payload.high - Math.max(payload.open, payload.close)) * ratio;
  const boxHeight = Math.max(1, Math.abs(payload.open - payload.close) * ratio);

  return (
    <g stroke={color} fill={color} strokeWidth="1">
      <line x1={x + width / 2} y1={y} x2={x + width / 2} y2={y + height} />
      <rect x={x} y={yTop} width={width} height={boxHeight} />
    </g>
  );
};

import { Card, SentimentBadge, ValueDisplay, IndicatorRow, CompactMetricCard } from './MCCommon';
import ScreenerDetailsModal from './ScreenerDetailsModal';

interface MCStockInfoPanelProps {
  symbol: string;
  scId: string;
  section?: 'all' | 'technical' | 'fundamental' | 'insights' | 'overview' | 'shareholding' | 'peers' | 'trendlyne';
  onSelectStock?: (symbol: string) => void;
  watchlist?: string[];
  onToggleWatchlist?: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
}

type Timeframe = 'D' | 'W' | 'M';
type Tab = 'overview' | 'financials' | 'technical' | 'analysis' | 'analyst' | 'trendlyne' | 'fno';

export const MCStockInfoPanel: React.FC<MCStockInfoPanelProps> = ({ 
  symbol, 
  section, 
  onSelectStock,
  watchlist = [],
  onToggleWatchlist = () => {}
}) => {
  const [timeframe, setTimeframe] = React.useState<Timeframe>('D');
  const [activeTab, setActiveTab] = React.useState<Tab>(
    section === 'technical' ? 'technical' :
    section === 'fundamental' ? 'financials' :
    section === 'insights' ? 'analysis' :
    section === 'overview' ? 'overview' :
    section === 'shareholding' ? 'analysis' :
    section === 'trendlyne' ? 'trendlyne' :
    section === 'peers' ? 'analysis' : 'overview'
  );

  const [isModalOpen, setIsModalOpen] = React.useState(false);
  const [selectedScreener, setSelectedScreener] = React.useState<any>(null);

  const [chartDuration, setChartDuration] = React.useState<string>('max');
  const [chartType, setChartType] = React.useState<'line' | 'ohlc'>('line');
  const [useTVChart, setUseTVChart] = React.useState(false);


  // Sync activeTab if section changes
  React.useEffect(() => {
    if (section === 'technical') setActiveTab('technical');
    else if (section === 'fundamental') setActiveTab('financials');
    else if (section === 'insights') setActiveTab('analysis');
    else if (section === 'overview') setActiveTab('overview');
    else if (section === 'shareholding') setActiveTab('analysis');
    else if (section === 'peers') setActiveTab('analysis');
    else if (section === 'trendlyne') setActiveTab('trendlyne');
  }, [section]);  const containerRef = React.useRef<HTMLDivElement>(null);
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

  const { data: maxOhlcData, isLoading: loadingOhlc } = trpc.getOHLCData.useQuery(
    { symbol, dur: chartDuration },
    { enabled: isVisible && activeTab === 'technical', staleTime: 60000 }
  );

  const { data: unifiedData, isLoading, error } = trpc.getAlphaQuantDetail.useQuery(
    { symbol, timeframe },
    { enabled: isVisible, refetchInterval: isVisible ? 60000 : false, staleTime: 30000 }
  );

  const { data: techD_fixed } = trpc.getMcTechnical.useQuery(
    { symbol, duration: 'D' },
    { enabled: isVisible, staleTime: 300000 }
  );
  const { data: techW } = trpc.getMcTechnical.useQuery(
    { symbol, duration: 'W' },
    { enabled: isVisible, staleTime: 300000 }
  );
  const { data: techM } = trpc.getMcTechnical.useQuery(
    { symbol, duration: 'M' },
    { enabled: isVisible, staleTime: 3600000 }
  );

  const { data: trendlyneMetrics, isLoading: loadingTlMetrics } = trpc.getTrendlyneStockMetrics.useQuery(
    { symbol },
    { enabled: isVisible && activeTab === 'trendlyne', staleTime: 60000 }
  );

  const { data: trendlyneTa, isLoading: loadingTlTa } = trpc.getTrendlyneAdvTechnicalAnalysis.useQuery(
    { symbol, timeframe },
    { enabled: isVisible && activeTab === 'trendlyne', staleTime: 60000 }
  );

  const { data: vwapData } = trpc.getMcVwapChart.useQuery(
    { symbol },
    { enabled: isVisible && activeTab === 'overview', staleTime: 300000 }
  );
  const { data: indexFnoData } = trpc.getIndexFno.useQuery(
    { id: 'NIFTY' },
    { enabled: isVisible && activeTab === 'fno', staleTime: 60000 }
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
  const alphaData = (unifiedData as any).score ? { score: (unifiedData as any).score, factors: (unifiedData as any).factors } : null;
  const mcScreeners = (unifiedData as any).screeners?.moneycontrol || [];
  const tlScreeners = (unifiedData as any).screeners?.trendlyne || [];
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
  const techD = techD_fixed || (timeframe === 'D' ? tech : null);
  const techW_final = techW || (timeframe === 'W' ? tech : null);
  const techM_final = techM || (timeframe === 'M' ? tech : null);
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
    { key: 'fno',        label: 'F&O'         },
    { key: 'analysis',   label: 'Analysis'    },
    { key: 'analyst',    label: 'Analyst'     },
    { key: 'trendlyne',  label: 'Trendlyne'   },
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

      {/* ── KEY STATS (Show in 'all' or 'overview') ── */}
      {(!section || section === 'all' || activeTab === 'overview') && (
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
          <CompactMetricCard label="Price" value={`₹${currentPrice}`} sub={changePct ? `${parseFloat(String(changePct)) >= 0 ? '+' : ''}${changePct}%` : undefined}
            color={parseFloat(String(changePct || 0)) >= 0 ? 'text-emerald-400' : 'text-rose-400'} icon={Activity} />
          <CompactMetricCard label="P/E (TTM)" value={eq?.PE || sp?.scTtm || essentials?.pe || tb?.keyMetrics?.pe || '—'} sub={`Sec: ${essentials?.sectorPe || eq?.IND_PE || tb?.keyMetrics?.industry_pe || '—'}`} icon={BarChart3} />
          <CompactMetricCard label="P/B Ratio" value={eq?.PB || essentials?.pb || sp?.priceBook || '—'} icon={PieChart} />
          <CompactMetricCard label="ROE %" value={tb?.keyMetrics?.roe != null ? `${Number(tb.keyMetrics.roe).toFixed(1)}%` : '—'} color="text-emerald-400" icon={TrendingUp} />
          <CompactMetricCard label="Market Cap" value={essentials?.marketCap || eq?.MKTCAP ? `₹${String(eq?.MKTCAP || essentials?.marketCap || '0').replace(/[^\d.]/g, '')}Cr` : '—'} color="text-blue-400" icon={Users} />
          <CompactMetricCard label="Div Yield" value={essentials?.dividendYield ? `${essentials.dividendYield}%` : eq?.DY ? `${eq.DY}%` : tb?.keyMetrics?.divyield ? `${tb.keyMetrics.divyield}%` : '—'} color="text-amber-400" icon={Zap} />
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
      {activeTab === 'overview' && (
        <div className="space-y-4">

          {/* High-Density Intelligence Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {/* AlphaQuant Factor Breakdown */}
            {alphaData && (
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 flex flex-col justify-between min-h-[140px]">
                <p className="text-[9px] font-black text-blue-500 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                  <Zap className="w-3 h-3" /> AlphaQuant Core
                </p>
                <div className="grid grid-cols-5 gap-1">
                  {[
                    { label: 'TECH', value: alphaData.factors.technical,    color: 'text-blue-400'    },
                    { label: 'FUND', value: alphaData.factors.fundamental,  color: 'text-emerald-400' },
                    { label: 'MOM',  value: alphaData.factors.momentum,     color: 'text-purple-400'  },
                    { label: 'VAL',  value: alphaData.factors.valuation,    color: 'text-amber-400'   },
                    { label: 'DELV', value: alphaData.factors.delivery,     color: 'text-rose-400'    },
                  ].map((factor) => (
                    <div key={factor.label} className="text-center">
                      <span className={cn("text-[10px] font-black italic", factor.color)}>{factor.value.toFixed(1)}</span>
                      <p className="text-[6px] font-black text-slate-600 uppercase tracking-tighter">{factor.label}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[8px] font-black uppercase tracking-widest text-slate-600 mb-1">
                    <span>Aggregate</span>
                    <span className="text-blue-400">{(alphaData.factors.momentum * 10).toFixed(0)}%</span>
                  </div>
                  <div className="h-0.5 w-full bg-slate-900 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500 rounded-full" style={{ width: `${alphaData.factors.momentum * 10}%` }} />
                  </div>
                </div>
              </div>
            )}

            {/* TradeBrains Portal Score Breakdown */}
            {tb?.portalScore && (() => {
              const ps = tb.portalScore;
              const dims = [
                { label: 'Perf',   val: ps.performance,   color: 'bg-blue-500',    text: 'text-blue-400'    },
                { label: 'Growth', val: ps.growth,        color: 'bg-emerald-500', text: 'text-emerald-400' },
                { label: 'Profit', val: ps.profitability, color: 'bg-teal-500',    text: 'text-teal-400'    },
                { label: 'Value',  val: ps.valuation,     color: 'bg-amber-500',   text: 'text-amber-400'   },
                { label: 'Owner',  val: ps.ownership,     color: 'bg-purple-500',  text: 'text-purple-400'  },
                { label: 'Qual',   val: ps.quality,       color: 'bg-violet-500',  text: 'text-violet-400'  },
              ].filter(d => d.val != null);
              if (dims.length === 0) return null;
              return (
                <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 min-h-[140px]">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[9px] font-black text-violet-500 uppercase tracking-widest flex items-center gap-1.5">
                      <BarChart3 className="w-3 h-3" /> TB Matrix
                    </p>
                    <span className={cn("text-[10px] font-black italic",
                      ps.score >= 3.5 ? "text-emerald-400" : ps.score >= 2.5 ? "text-amber-400" : "text-rose-400"
                    )}>{Number(ps.score).toFixed(1)}/5</span>
                  </div>
                  <div className="grid grid-cols-3 gap-y-1.5 gap-x-3">
                    {dims.map((d) => (
                      <div key={d.label} className="space-y-0.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[7px] font-black text-slate-500 uppercase tracking-tight">{d.label}</span>
                          <span className={cn("text-[8px] font-black", d.text)}>{Number(d.val).toFixed(1)}</span>
                        </div>
                        <div className="h-0.5 w-full bg-slate-900 rounded-full overflow-hidden">
                          <motion.div initial={{ width: 0 }} animate={{ width: `${(Number(d.val) / 5) * 100}%` }} className={cn("h-full rounded-full", d.color)} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Multi-Timeframe Confluence */}
            {(techD || techW || techM) && (
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 min-h-[140px]">
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-1.5 mb-2">
                  <Activity className="w-3 h-3" /> Multi-TF Confluence
                </p>
                <div className="grid grid-cols-3 gap-1.5 mb-2">
                  {[
                    { label: 'D', tech: techD },
                    { label: 'W', tech: techW_final },
                    { label: 'M', tech: techM_final },
                  ].map(({ label, tech: t }) => {
                    const indication = (t as any)?.sentiments?.indication || '';
                    const isBull = indication.toLowerCase().includes('bullish');
                    const isBear = indication.toLowerCase().includes('bearish');
                    return (
                      <div key={label} className={cn("p-1.5 rounded-lg border text-center",
                        isBull ? "bg-emerald-500/5 border-emerald-500/10" :
                        isBear ? "bg-rose-500/5 border-rose-500/10" : "bg-slate-900 border-slate-800"
                      )}>
                        <p className="text-[7px] font-black text-slate-600 uppercase mb-0.5">{label}</p>
                        <p className={cn("text-[8px] font-black uppercase leading-tight truncate",
                          isBull ? "text-emerald-400" : isBear ? "text-rose-400" : "text-slate-500"
                        )}>{indication.split(' ')[0] || '—'}</p>
                      </div>
                    );
                  })}
                </div>
                {techD && techW && techM && (() => {
                  const sD = ((techD as any)?.sentiments?.indication || '').toLowerCase();
                  const sW = ((techW_final as any)?.sentiments?.indication || '').toLowerCase();
                  const sM = ((techM_final as any)?.sentiments?.indication || '').toLowerCase();
                  if (!sD || !sW || !sM) return null;
                  const mBull = sM.includes('bullish'), dBear = sD.includes('bearish');
                  return (
                    <div className={cn("px-2 py-1 rounded-lg text-[8px] font-bold italic border flex gap-1.5 items-center",
                      mBull && dBear ? "bg-blue-500/5 text-blue-400 border-blue-500/10" : "bg-amber-500/5 text-amber-400 border-amber-500/10"
                    )}>
                      <Info className="w-2.5 h-2.5 shrink-0" />
                      <span className="truncate text-[8px] font-black uppercase tracking-tighter">
                        {mBull && dBear ? "Bullish Trend / Pullback" : "Mixed Divergence"}
                      </span>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Active Signals List */}
            <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 flex flex-col min-h-[140px]">
              <div className="flex items-center gap-1.5 mb-2">
                <Zap className="w-3 h-3 text-amber-400" />
                <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Active Signals ({allScreeners.length})</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 overflow-y-auto max-h-[85px] pr-1 scrollbar-none">
                {allScreeners.slice(0, 10).map((screener, i) => {
                  const isBullish = screener.sentiment === 'bullish';
                  const isBearish = screener.sentiment === 'bearish';
                  return (
                    <div key={`${screener.id}-${i}`}
                      onClick={() => { setSelectedScreener(screener); setIsModalOpen(true); }}
                      className={cn("px-2 py-1 rounded-md text-[7px] font-black uppercase tracking-tighter border flex items-center gap-1.5 transition-all cursor-pointer hover:bg-slate-900 active:scale-95",
                        isBullish ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-400" :
                        isBearish ? "bg-rose-500/5 border-rose-500/20 text-rose-400" :
                        "bg-slate-900 border-slate-800 text-slate-400"
                      )}>
                      {isBullish ? <TrendingUp className="w-2 h-2" /> : isBearish ? <TrendingDown className="w-2 h-2" /> : <Filter className="w-2 h-2" />}
                      <span className="truncate">{screener.name}</span>
                    </div>
                  );
                })}
                {allScreeners.length === 0 && <p className="text-[8px] text-slate-700 italic font-bold text-center mt-4">No active signals</p>}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* MC Classification */}
            {classification?.longDesc && (
              <div className={cn("p-3 rounded-2xl border relative overflow-hidden flex flex-col justify-between",
                classification.stockScore >= 70 ? "bg-emerald-500/5 border-emerald-500/20" :
                classification.stockScore >= 50 ? "bg-amber-500/5 border-amber-500/20" :
                "bg-rose-500/5 border-rose-500/20"
              )}>
                <div className="absolute top-0 right-0 p-4 opacity-[0.03] pointer-events-none"><BrainCircuit className="w-16 h-16" /></div>
                <div className="relative z-10">
                  <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3 h-3" /> MC Expert Analysis
                  </p>
                  <p className="text-[11px] text-slate-300 font-medium italic leading-relaxed">{classification.longDesc}</p>
                </div>
                <div className="flex items-center gap-3 mt-3 relative z-10">
                  <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Score</span>
                  <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                    <motion.div initial={{ width: 0 }} animate={{ width: `${classification.stockScore}%` }}
                      className={cn("h-full rounded-full", classification.stockScore >= 70 ? "bg-emerald-500" : classification.stockScore >= 50 ? "bg-amber-500" : "bg-rose-500")} />
                  </div>
                  <span className={cn("text-[10px] font-black italic",
                    classification.stockScore >= 70 ? "text-emerald-400" : classification.stockScore >= 50 ? "text-amber-400" : "text-rose-400"
                  )}>{classification.stockScore}<span className="text-[7px] text-slate-600 font-bold ml-0.5">/100</span></span>
                </div>
              </div>
            )}

            {/* MC Investment Checklist */}
            {essentials?.checklist && (
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">MC Checklist</span>
                  </div>
                  {essentials.passText && (
                    <div className="flex items-center gap-2">
                      <span className="text-[8px] font-black text-emerald-500/60">{essentials.passYes}Y</span>
                      <span className="text-[8px] font-black text-rose-500/60">{essentials.passNo}N</span>
                      <span className={cn("text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-widest",
                        (essentials.passPercent ?? 0) >= 70 ? "bg-emerald-500/10 text-emerald-400" :
                        (essentials.passPercent ?? 0) >= 50 ? "bg-amber-500/10 text-amber-400" : "bg-rose-500/10 text-rose-400"
                      )}>{essentials.passText}</span>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  {(['financials', 'industry', 'ownership', 'others'] as const).map((key) => {
                    const labelMap = { financials: 'FIN', industry: 'IND', ownership: 'OWN', others: 'OTH' };
                    const colorMap = { financials: 'text-blue-500', industry: 'text-purple-500', ownership: 'text-amber-500', others: 'text-slate-500' };
                    const items = essentials.checklist![key];
                    if (!items?.length) return null;
                    return (
                      <div key={key}>
                        <p className={cn("text-[7px] font-black uppercase tracking-widest mb-1.5 border-b border-slate-800/50 pb-0.5", colorMap[key])}>{labelMap[key]}</p>
                        <div className="grid grid-cols-1 gap-1">
                          {items.slice(0, 3).map((item, i) => (
                            <div key={i} className="flex items-center justify-between px-1.5 py-1 bg-slate-900/30 rounded border border-slate-800/20">
                              <span className="text-[8px] text-slate-500 font-bold leading-tight truncate mr-2">{item.question}</span>
                              <span className={cn("text-[8px] font-black shrink-0", item.answer ? "text-emerald-500" : "text-rose-500")}>
                                {item.answer ? "YES" : "NO"}
                              </span>
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

          {/* VWAP Chart */}
          {(vwapData as any)?.NSE && (vwapData as any).NSE.length > 0 && (
            <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold text-slate-300">VWAP — Intraday</span>
                <span className="text-xs text-slate-500">NSE</span>
              </div>
              <ResponsiveContainer width="100%" height={120}>
                <AreaChart data={(vwapData as any).NSE.slice(-60)} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="vwapGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="time" hide />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9, fill: '#94a3b8' }} />
                  <Tooltip
                    contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6 }}
                    formatter={(v: any) => [`₹${parseFloat(v).toFixed(2)}`, 'VWAP']}
                  />
                  <Area type="monotone" dataKey="vwap" stroke="#3b82f6" strokeWidth={1.5}
                        fill="url(#vwapGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          <ScreenerDetailsModal
            isOpen={isModalOpen}
            onClose={() => setIsModalOpen(false)}
            screener={selectedScreener}
            onSelectStock={(sym) => { if (onSelectStock) onSelectStock(sym); }}
            watchlist={watchlist}
            onToggleWatchlist={onToggleWatchlist}
          />

        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* FINANCIALS TAB                                                 */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'financials' && (
        <div className="space-y-6">

          {/* High-Density Valuation & Key Metrics */}
          {(fov || tb?.keyMetrics) && (
            <Card title="Valuation & Profitability Matrix" icon={BarChart3}>
              <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2 pt-2">
                {[
                  { label: 'TTM EPS',    val: fov?.ttmEpsText || tb?.keyMetrics?.eps, color: 'text-blue-400' },
                  { label: 'TTM PE',     val: fov?.ttmPeText || tb?.keyMetrics?.pe,   color: 'text-amber-400' },
                  { label: 'P/B Ratio',  val: fov?.pbText || tb?.keyMetrics?.pb,      color: 'text-purple-400' },
                  { label: 'Ind. PE',    val: tb?.keyMetrics?.industry_pe,            color: 'text-slate-400' },
                  { label: 'PEG Ratio',  val: tb?.keyMetrics?.peg_ratio,              color: 'text-violet-400' },
                  { label: 'ROE %',      val: tb?.keyMetrics?.roe != null ? `${Number(tb.keyMetrics.roe).toFixed(1)}%` : null, color: 'text-emerald-400' },
                  { label: 'ROCE %',     val: tb?.keyMetrics?.roce != null ? `${Number(tb.keyMetrics.roce).toFixed(1)}%` : null, color: 'text-emerald-400' },
                  { label: 'ROA %',      val: tb?.keyMetrics?.roa != null ? `${Number(tb.keyMetrics.roa).toFixed(1)}%` : null, color: 'text-teal-400' },
                  { label: 'Debt/Eq',    val: tb?.keyMetrics?.debt_equity,            color: (Number(tb?.keyMetrics?.debt_equity) > 1) ? 'text-rose-400' : 'text-emerald-400' },
                  { label: 'Cur. Ratio', val: tb?.keyMetrics?.current_ratio,         color: (Number(tb?.keyMetrics?.current_ratio) >= 1.5) ? 'text-emerald-400' : 'text-amber-400' },
                  { label: 'Div Yield',  val: tb?.keyMetrics?.divyield != null ? `${tb.keyMetrics.divyield}%` : null, color: 'text-amber-400' },
                  { label: 'EV/Sales',   val: tb?.keyMetrics?.ev_sales,               color: 'text-slate-400' },
                ].filter(m => m.val != null && m.val !== '').map((m, i) => (
                  <CompactMetricCard key={i} label={m.label} value={String(m.val)} color={m.color} />
                ))}
              </div>
            </Card>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Price Performance Insights */}
            {detailedInsights?.price && (
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                <p className="text-[9px] font-black text-blue-500 uppercase tracking-widest mb-3 flex items-center gap-1.5 border-l-2 border-blue-500 pl-2">
                  Market Dynamics
                </p>
                <div className="space-y-1.5">
                  {detailedInsights.price.slice(0, 6).map((p: any, i: number) => (
                    <div key={i} className="flex justify-between items-center p-2 bg-slate-900/30 rounded-lg border border-slate-800/30">
                      <span className="text-[9px] font-black text-slate-500 uppercase truncate max-w-[40%]">{p.shortDesc.split(' ')[0]}</span>
                      <span className={cn("text-[9px] font-black text-right flex-1", 
                        p.color === 'positive' ? "text-emerald-400" : p.color === 'negative' ? "text-rose-400" : "text-slate-300"
                      )}>{p.shortDesc}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Ownership Insights */}
            {detailedInsights?.shareholding && (
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                <p className="text-[9px] font-black text-violet-500 uppercase tracking-widest mb-3 flex items-center gap-1.5 border-l-2 border-violet-500 pl-2">
                  Ownership Trends
                </p>
                <div className="space-y-1.5">
                  {detailedInsights.shareholding.slice(0, 6).map((sh: any, i: number) => (
                    <div key={i} className="flex justify-between items-center p-2 bg-slate-900/30 rounded-lg border border-slate-800/30">
                      <span className="text-[9px] font-black text-slate-500 uppercase truncate max-w-[40%]">{sh.shorttext}</span>
                      <span className={cn("text-[9px] font-black text-right flex-1",
                        sh.color === 'positive' ? "text-emerald-400" : sh.color === 'negative' ? "text-rose-400" : "text-slate-300"
                      )}>{sh.longtext}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Shareholding Intelligence (TB Insights) */}
            {tb?.shareHoldingGraph?.insights && (
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest mb-3 flex items-center gap-1.5 border-l-2 border-emerald-500 pl-2">
                  Alpha Insights
                </p>
                <div className="space-y-1.5">
                  {(() => {
                    const shi = tb.shareHoldingGraph.insights;
                    const allInsights: string[] = [
                      ...(Array.isArray(shi.Blue) ? shi.Blue : []),
                      ...(Array.isArray(shi.Green) ? shi.Green : []),
                      ...(Array.isArray(shi.Red) ? shi.Red : []),
                    ];
                    return allInsights.slice(0, 6).map((ins: string, i: number) => {
                      const isPos = shi.Blue?.includes(ins) || shi.Green?.includes(ins);
                      return (
                        <div key={i} className={cn("p-2 rounded-lg border text-[9px] font-medium leading-tight flex items-start gap-1.5",
                          isPos ? "bg-emerald-500/5 border-emerald-500/10 text-emerald-200" : "bg-rose-500/5 border-rose-500/10 text-rose-200"
                        )}>
                          <span className={cn("shrink-0 font-black", isPos ? "text-emerald-400" : "text-rose-400")}>{isPos ? '↑' : '↓'}</span>
                          <span className="truncate">{ins}</span>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            )}
          </div>

          {/* Returns Center */}
          <Card title="Performance & Returns Hub" icon={BarChart3}>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-2">
              <div className="space-y-4">
                <p className="text-[9px] font-black text-blue-500 uppercase tracking-widest border-l-2 border-blue-500 pl-2">MC Price Returns</p>
                <div className="grid grid-cols-3 gap-2">
                  {Object.entries(pv?.price || {}).map(([period, val]) => (
                    <div key={period} className="p-2.5 bg-slate-950 rounded-xl border border-slate-800/50 text-center">
                      <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mb-0.5">{period}</p>
                      <p className={cn("text-[11px] font-black italic", Number(val) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        {Number(val) >= 0 ? '+' : ''}{val}%
                      </p>
                    </div>
                  ))}
                </div>
                {tb?.stockReturns && (
                  <div className="mt-4">
                    <p className="text-[9px] font-black text-violet-500 uppercase tracking-widest border-l-2 border-violet-500 pl-2 mb-3">TradeBrains Long-Term Returns</p>
                    <div className="grid grid-cols-4 gap-1.5">
                      {[
                        { label: '1W', val: tb.stockReturns.one_week },  { label: '1M', val: tb.stockReturns.one_month },
                        { label: '6M', val: tb.stockReturns.six_months },{ label: '1Y', val: tb.stockReturns.one_year },
                        { label: '3Y', val: tb.stockReturns.three_year },{ label: '5Y', val: tb.stockReturns.five_year },
                      ].filter(p => p.val != null).map(({ label, val }) => {
                        const n = typeof val === 'string' ? parseFloat(val) : Number(val);
                        return (
                          <div key={label} className="p-2 bg-slate-950 rounded-lg border border-slate-800/50 text-center">
                            <p className="text-[7px] font-black text-slate-500 uppercase mb-0.5">{label}</p>
                            <p className={cn("text-[10px] font-black italic", n >= 0 ? "text-emerald-400" : "text-rose-400")}>
                              {n >= 0 ? '+' : ''}{n.toFixed(1)}%
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              
              {/* Volume Profile */}
              {pv?.volume && (
                <div className="space-y-3">
                  <p className="text-[9px] font-black text-amber-500 uppercase tracking-widest border-l-2 border-amber-500 pl-2 mb-3">Volume & Delivery Dynamics</p>
                  <div className="grid grid-cols-1 gap-2">
                    {Object.entries(pv.volume).slice(0, 3).map(([period, v]: [string, any]) => {
                      const deliveryPctMatch = v.delivery_display_text?.match(/\(([\d.]+)%\)/);
                      const deliveryPct = deliveryPctMatch ? parseFloat(deliveryPctMatch[1]) : 0;
                      return (
                        <div key={period} className="p-3 bg-slate-950 rounded-xl border border-slate-800/50 group">
                          <div className="flex justify-between items-center mb-1.5">
                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{period}</span>
                            <div className="text-right">
                              <span className="text-[10px] font-black text-white italic">{v.cvol_display_text}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="flex-1 h-1 bg-slate-900 rounded-full overflow-hidden flex">
                              <motion.div initial={{ width: 0 }} animate={{ width: `${deliveryPct}%` }}
                                className={cn("h-full rounded-full transition-all duration-1000",
                                  deliveryPct >= 50 ? "bg-emerald-500" : deliveryPct >= 30 ? "bg-blue-500" : "bg-amber-500"
                                )} />
                            </div>
                            <span className={cn("text-[9px] font-black shrink-0 tabular-nums",
                              deliveryPct >= 50 ? "text-emerald-400" : deliveryPct >= 30 ? "text-blue-400" : "text-amber-400"
                            )}>{deliveryPct}% <span className="text-slate-600 text-[7px] font-bold uppercase">Delv</span></span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* Forecast Center */}
          {(ef?.eps?.length > 0 || ef?.netProfit?.length > 0) && (
            <Card title="Forward Estimates & Forecasts" icon={Activity}>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-2">
                {/* EPS Forecast */}
                {ef.eps && ef.eps.length > 0 && (
                  <div>
                    <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest border-l-2 border-emerald-500 pl-2 mb-3">EPS Forecasts</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-[10px]">
                        <thead>
                          <tr className="text-slate-500 font-black uppercase tracking-tighter border-b border-slate-800">
                            <th className="pb-1.5">Period</th>
                            <th className="pb-1.5 text-right">Avg Est</th>
                            <th className="pb-1.5 text-right">Actual</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/30">
                          {ef.eps.slice(0, 4).map((row: any, i: number) => (
                            <tr key={i}>
                              <td className="py-2 text-slate-400 font-bold">{row.date}</td>
                              <td className="py-2 text-right text-white font-black">{row.avg || '—'}</td>
                              <td className={cn("py-2 text-right font-black", row.actual ? "text-emerald-400" : "text-slate-600")}>{row.actual || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {/* Net Profit Forecast */}
                {ef.netProfit && ef.netProfit.length > 0 && (
                  <div>
                    <p className="text-[9px] font-black text-blue-500 uppercase tracking-widest border-l-2 border-blue-500 pl-2 mb-3">Net Profit (Cr) Est.</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-[10px]">
                        <thead>
                          <tr className="text-slate-500 font-black uppercase tracking-tighter border-b border-slate-800">
                            <th className="pb-1.5">Period</th>
                            <th className="pb-1.5 text-right">Avg Est</th>
                            <th className="pb-1.5 text-right">Actual</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/30">
                          {ef.netProfit.slice(0, 4).map((row: any, i: number) => (
                            <tr key={i}>
                              <td className="py-2 text-slate-400 font-bold">{row.date}</td>
                              <td className="py-2 text-right text-white font-black">{row.avg ? `₹${row.avg}` : '—'}</td>
                              <td className={cn("py-2 text-right font-black", row.actual ? "text-emerald-400" : "text-slate-600")}>{row.actual || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
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
                    {hm.list.map((row: any, i: number) => (
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
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              {/* Historical Max Data Chart */}
              <Card 
                title={useTVChart ? "Advanced TradingView Chart" : "Historical Price Action"} 
                icon={TrendingUp}
                action={
                  <button
                    onClick={() => setUseTVChart(!useTVChart)}
                    className="px-3 py-1 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 text-[9px] font-black uppercase tracking-widest rounded-lg border border-blue-500/30 transition-all"
                  >
                    {useTVChart ? 'Show Basic Chart' : 'Show Advanced Chart'}
                  </button>
                }
              >
                <div className="space-y-4">
                  {!useTVChart && (
                    <div className="flex flex-wrap justify-between items-center gap-4">
                      <div className="flex flex-wrap gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800">
                        {['1d', '5d', '1m', '3m', '6m', '1y', '5y', 'max'].map((d) => (
                          <button
                            key={d}
                            onClick={() => setChartDuration(d)}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all",
                              chartDuration === d ? "bg-blue-600 text-white shadow-lg" : "text-slate-500 hover:text-slate-300"
                            )}
                          >
                            {d}
                          </button>
                        ))}
                      </div>
                      
                      <div className="flex gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800">
                        {['line', 'ohlc'].map((t) => (
                          <button
                            key={t}
                            onClick={() => setChartType(t as any)}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all",
                              chartType === t ? "bg-blue-600 text-white shadow-lg" : "text-slate-500 hover:text-slate-300"
                            )}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className={cn("w-full bg-slate-950/50 rounded-2xl border border-slate-800/30 p-3 overflow-hidden", useTVChart ? "h-[450px]" : "h-[300px]")}>
                    {useTVChart ? (
                      <AdvancedChartWidget symbol={symbol} height={410} />
                    ) : (
                      loadingOhlc ? (
                        <div className="h-full flex items-center justify-center">
                          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
                        </div>
                      ) : maxOhlcData?.data && maxOhlcData.data.length > 0 ? (() => {
                          const mappedData = maxOhlcData.data.map((d: any) => ({
                            ...d,
                            date: new Date(d.time * 1000).toLocaleDateString(),
                            lowHigh: [d.low, d.high]
                          }));
                          return (
                            <ResponsiveContainer width="100%" height="100%">
                              <ComposedChart data={mappedData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                <XAxis 
                                  dataKey="date" 
                                  tick={{ fontSize: 9, fill: '#64748b' }} 
                                  axisLine={false}
                                  tickLine={false}
                                  minTickGap={30}
                                />
                                <YAxis 
                                  domain={['auto', 'auto']} 
                                  tick={{ fontSize: 9, fill: '#64748b' }} 
                                  orientation="right"
                                  axisLine={false}
                                  tickLine={false}
                                  tickFormatter={(v) => `₹${v.toLocaleString()}`}
                                />
                                <Tooltip 
                                  contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px' }}
                                  labelStyle={{ fontSize: 10, fontWeight: 900, color: '#94a3b8', marginBottom: 4 }}
                                  itemStyle={{ fontSize: 12, fontWeight: 700 }}
                                />
                                {chartType === 'line' ? (
                                  <Area type="monotone" dataKey="close" stroke="#3b82f6" strokeWidth={3} fill="url(#colorPrice)" />
                                ) : (
                                  <Bar dataKey="close" shape={<Candlestick />} />
                                )}
                                <defs>
                                  <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                                  </linearGradient>
                                </defs>
                              </ComposedChart>
                            </ResponsiveContainer>
                          );
                      })() : (
                        <div className="h-full flex items-center justify-center text-slate-700 text-[10px] font-black uppercase tracking-widest italic">
                          No price data available
                        </div>
                      )
                    )}
                  </div>
                </div>
              </Card>

              {/* Technical Analysis */}
              {tech && (
                <Card title={`Technical Signals (${timeframe === 'D' ? 'Daily' : timeframe === 'W' ? 'Weekly' : 'Monthly'})`} icon={Activity}>
                  <div className="space-y-6">
                    {tech.sentiments && (
                      <div className="p-3 bg-slate-950/60 rounded-2xl border border-slate-800">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <Activity className="w-3.5 h-3.5 text-blue-500" />
                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Sentiment Hub</span>
                          </div>
                          <SentimentBadge sentiment={tech.sentiments.indication} />
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                          {[
                            { label: 'Bull', val: tech.sentiments.totalBullish, color: 'text-emerald-400' },
                            { label: 'Neu', val: tech.sentiments.totalNeutral, color: 'text-slate-400' },
                            { label: 'Bear', val: tech.sentiments.totalBearish, color: 'text-rose-400' },
                          ].map(s => (
                            <div key={s.label} className="p-1.5 bg-slate-900/40 rounded-xl border border-slate-800/30 text-center">
                              <p className={cn("text-base font-black italic", s.color)}>{s.val}</p>
                              <p className="text-[6px] font-black uppercase tracking-widest text-slate-600">{s.label}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* Indicators Grid */}
                      <div>
                        <h4 className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                          <Zap className="w-3 h-3" /> Momentum Indicators
                        </h4>
                        <div className="grid grid-cols-1 gap-1.5">
                          {tech.indicators?.map((ind: any) => (
                            <IndicatorRow key={ind.id} name={ind.displayName} value={ind.value} sentiment={ind.indication} />
                          ))}
                        </div>
                      </div>

                      {/* MA Crossovers */}
                      <div>
                        <h4 className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                          <TrendingUp className="w-3 h-3" /> MA Crossovers
                        </h4>
                        <div className="space-y-1.5">
                          {tech.crossover?.map((cross: any) => (
                            <div key={cross.key} className="flex justify-between items-center p-2.5 bg-slate-950 rounded-xl border border-slate-800/50">
                              <span className="text-[10px] font-black text-slate-500 uppercase">{cross.period}</span>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-slate-300 font-bold">{cross.displayValue}</span>
                                <SentimentBadge sentiment={cross.indication} />
                              </div>
                            </div>
                          ))}
                          {(!tech.crossover || tech.crossover.length === 0) && (
                            <p className="text-[9px] text-slate-600 italic p-4 text-center border border-dashed border-slate-800 rounded-xl">No active crossovers</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              )}
            </div>

            <div className="space-y-4">
              <Card title="Market Sentiment" icon={Zap}>
                <div className="pt-1">
                  <TechnicalAnalysisWidget symbol={symbol} height={380} />
                </div>
              </Card>

              {/* SMA / EMA Consolidated */}
              {tech && (tech.sma?.length > 0 || tech.ema?.length > 0) && (
                <Card title="Moving Averages" icon={TrendingUp}>
                  <div className="pt-2 overflow-x-auto">
                    <table className="w-full text-[10px] text-left">
                      <thead>
                        <tr className="text-slate-500 font-black uppercase tracking-widest border-b border-slate-800">
                          <th className="pb-2">Period</th>
                          <th className="pb-2 text-right">SMA</th>
                          <th className="pb-2 text-right">EMA</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/30">
                        {['5', '10', '20', '50', '100', '200'].map(period => {
                          const s = tech.sma?.find((m: any) => m.key === period);
                          const e = tech.ema?.find((m: any) => m.key === period);
                          if (!s && !e) return null;
                          return (
                            <tr key={period} className="group hover:bg-slate-900/40 transition-colors">
                              <td className="py-2.5 font-black text-slate-400">MA {period}</td>
                              <td className="py-2.5 text-right">
                                {s ? (
                                  <div className="flex items-center justify-end gap-1.5">
                                    <span className="text-white font-bold tabular-nums">₹{s.value}</span>
                                    <SentimentBadge sentiment={s.indication} className="scale-75 origin-right" />
                                  </div>
                                ) : '—'}
                              </td>
                              <td className="py-2.5 text-right">
                                {e ? (
                                  <div className="flex items-center justify-end gap-1.5">
                                    <span className="text-white font-bold tabular-nums">₹{e.value}</span>
                                    <SentimentBadge sentiment={e.indication} className="scale-75 origin-right" />
                                  </div>
                                ) : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </div>
          </div>

          {/* Unified Pivot Hub */}
          <Card title="Pivot Alignment Dashboard" icon={Filter}>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-2">
              {/* MoneyControl Standard Pivots */}
              {tech?.pivotLevels && tech.pivotLevels.length > 0 && (
                <div className="space-y-4">
                  <p className="text-[9px] font-black text-blue-500 uppercase tracking-widest border-l-2 border-blue-500 pl-2">MC Classic Pivots</p>
                  {tech.pivotLevels.map((pg: any) => (
                    <div key={pg.key} className="p-3 bg-slate-950 rounded-xl border border-slate-800/50">
                      <p className="text-[8px] font-black text-slate-500 uppercase mb-2 text-center">{pg.key}</p>
                      <div className="grid grid-cols-5 gap-1 text-center">
                        <div className="p-1.5 bg-slate-900 rounded-lg border border-rose-500/10">
                          <p className="text-[7px] font-black text-rose-400">S2</p>
                          <p className="text-[10px] font-black text-white">₹{pg.pivotLevel.s2}</p>
                        </div>
                        <div className="p-1.5 bg-slate-900 rounded-lg border border-rose-500/5">
                          <p className="text-[7px] font-black text-rose-300">S1</p>
                          <p className="text-[10px] font-black text-white">₹{pg.pivotLevel.s1}</p>
                        </div>
                        <div className="p-1.5 bg-slate-900 rounded-lg border border-blue-500/20 ring-1 ring-blue-500/10">
                          <p className="text-[7px] font-black text-blue-400">PP</p>
                          <p className="text-[10px] font-black text-white">₹{pg.pivotLevel.pivotPoint}</p>
                        </div>
                        <div className="p-1.5 bg-slate-900 rounded-lg border border-emerald-500/5">
                          <p className="text-[7px] font-black text-emerald-300">R1</p>
                          <p className="text-[10px] font-black text-white">₹{pg.pivotLevel.r1}</p>
                        </div>
                        <div className="p-1.5 bg-slate-900 rounded-lg border border-emerald-500/10">
                          <p className="text-[7px] font-black text-emerald-400">R2</p>
                          <p className="text-[10px] font-black text-white">₹{pg.pivotLevel.r2}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* TradeBrains Fibonacci/Standard */}
              {tb?.pivotData && (
                <div className="space-y-4">
                  <p className="text-[9px] font-black text-violet-500 uppercase tracking-widest border-l-2 border-violet-500 pl-2">TradeBrains Multi-Pivots</p>
                  {[
                    { label: 'Fibonacci', data: tb.pivotData.fibonacci },
                    { label: 'Standard',  data: tb.pivotData.standard  },
                  ].filter(l => l.data).map(({ label, data }) => (
                    <div key={label} className="p-3 bg-slate-950 rounded-xl border border-slate-800/50">
                      <p className="text-[8px] font-black text-slate-500 uppercase mb-2 text-center">{label}</p>
                      <div className="grid grid-cols-7 gap-1 text-center">
                        {[
                          { k: 'support_three',label: 'S3', cls: 'text-rose-500' },
                          { k: 'support_two',  label: 'S2', cls: 'text-rose-400' },
                          { k: 'support_one',  label: 'S1', cls: 'text-rose-300' },
                          { k: 'pivot',        label: 'PP', cls: 'text-violet-400' },
                          { k: 'res_one',      label: 'R1', cls: 'text-emerald-300' },
                          { k: 'res_two',      label: 'R2', cls: 'text-emerald-400' },
                          { k: 'res_three',    label: 'R3', cls: 'text-emerald-500' },
                        ].map(({ k, label: lbl, cls }) => (
                          <div key={k} className="p-1 bg-slate-900 rounded-md">
                            <p className={cn("text-[6px] font-black uppercase", cls)}>{lbl}</p>
                            <p className="text-[9px] font-bold text-white tabular-nums">{data[k] ? Math.round(Number(data[k])) : '—'}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          {(mc as any)?.technical?.pivotLevels && (
            <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50 mt-3">
              <div className="text-sm font-semibold text-slate-300 mb-3">Pivot Levels</div>
              {Object.entries((mc as any).technical.pivotLevels).map(([method, levels]: [string, any]) => (
                <div key={method} className="mb-3">
                  <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">{method}</div>
                  <div className="grid grid-cols-7 gap-1 text-center">
                    {['S3', 'S2', 'S1', 'P', 'R1', 'R2', 'R3'].map(label => {
                      const val = levels?.[label.toLowerCase()] ?? levels?.[label];
                      const isP = label === 'P';
                      const isR = label.startsWith('R');
                      return (
                        <div key={label} className={`rounded p-1.5 ${isP ? 'bg-amber-500/20 border border-amber-500/40' : isR ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
                          <div className={`text-xs font-bold ${isP ? 'text-amber-400' : isR ? 'text-emerald-400' : 'text-red-400'}`}>{label}</div>
                          <div className="text-xs text-slate-300 font-mono mt-0.5">
                            {val ? parseFloat(val).toFixed(0) : '—'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
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
              </div>
            );
          })()}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* ANALYSIS TAB                                                   */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'analysis' && (
        <div className="space-y-6">

          {/* Intelligence Hub: Qualitative Factors */}
          {(swot || tb?.insights) && (
            <Card title="Intelligence Hub: Qualitative Core" icon={Search}>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-2">
                {/* Alpha Drivers */}
                <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-2xl p-3">
                  <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                    <TrendingUp className="w-3 h-3" /> Alpha Drivers & Strengths
                  </p>
                  <div className="space-y-1.5">
                    {(() => {
                      const ins = tb?.insights;
                      const pros = Array.isArray(ins?.pros) ? ins.pros : Array.isArray(ins?.positives) ? ins.positives : Array.isArray(ins?.strengths) ? ins.strengths : [];
                      return pros.slice(0, 3).map((p: string, i: number) => (
                        <div key={i} className="flex items-start gap-2 text-[10px] text-slate-300 font-medium leading-relaxed bg-emerald-500/5 p-1.5 rounded-lg">
                          <span className="text-emerald-400 font-black">✓</span> {p}
                        </div>
                      ));
                    })()}
                    {swot?.strengths?.slice(0, 3).map((s: string, i: number) => (
                      <div key={`s-${i}`} className="flex items-start gap-2 text-[10px] text-slate-300 font-medium leading-relaxed bg-blue-500/5 p-1.5 rounded-lg">
                        <Zap className="w-3 h-3 text-blue-400 shrink-0" /> {s}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Risk Vectors */}
                <div className="bg-rose-500/5 border border-rose-500/10 rounded-2xl p-3">
                  <p className="text-[9px] font-black text-rose-500 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                    <AlertCircle className="w-3 h-3" /> Risk Vectors & Weaknesses
                  </p>
                  <div className="space-y-1.5">
                    {(() => {
                      const ins = tb?.insights;
                      const cons = Array.isArray(ins?.cons) ? ins.cons : Array.isArray(ins?.negatives) ? ins.negatives : Array.isArray(ins?.weaknesses) ? ins.weaknesses : [];
                      return cons.slice(0, 3).map((c: string, i: number) => (
                        <div key={i} className="flex items-start gap-2 text-[10px] text-slate-300 font-medium leading-relaxed bg-rose-500/5 p-1.5 rounded-lg">
                          <AlertCircle className="w-3 h-3 text-rose-500 shrink-0" /> {c}
                        </div>
                      ));
                    })()}
                    {swot?.weaknesses?.slice(0, 3).map((w: string, i: number) => (
                      <div key={`w-${i}`} className="flex items-start gap-2 text-[10px] text-slate-300 font-medium leading-relaxed bg-amber-500/5 p-1.5 rounded-lg">
                        <Info className="w-3 h-3 text-amber-500 shrink-0" /> {w}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* Unified Shareholding Hub */}
          {(detailedInsights?.shareholding || tb?.shareHoldingGraph) && (
            <Card title="Shareholding Intelligence" icon={PieChart}>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-2">
                <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                  <p className="text-[9px] font-black text-blue-500 uppercase tracking-widest mb-3 border-l-2 border-blue-500 pl-2">Ownership Dynamics</p>
                  <div className="space-y-1.5">
                    {detailedInsights?.shareholding?.slice(0, 4).map((sh: any, i: number) => (
                      <div key={i} className="flex justify-between items-center p-2 bg-slate-900/30 rounded-lg border border-slate-800/30">
                        <span className="text-[9px] font-black text-slate-500 uppercase truncate max-w-[40%]">{sh.shorttext}</span>
                        <span className={cn("text-[9px] font-black text-right flex-1",
                          sh.color === 'positive' ? "text-emerald-400" : sh.color === 'negative' ? "text-rose-400" : "text-slate-300"
                        )}>{sh.longtext}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {tb?.shareHoldingGraph?.insights && (
                  <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                    <p className="text-[9px] font-black text-violet-500 uppercase tracking-widest mb-3 border-l-2 border-violet-500 pl-2">Shareholding Trends</p>
                    <div className="space-y-1.5">
                      {(() => {
                        const shi = tb.shareHoldingGraph.insights;
                        const all = [...(shi.Blue || []), ...(shi.Green || []), ...(shi.Red || [])];
                        return all.slice(0, 4).map((ins: string, i: number) => {
                          const isPos = shi.Blue?.includes(ins) || shi.Green?.includes(ins);
                          return (
                            <div key={i} className={cn("p-2 rounded-lg border text-[9px] font-medium leading-tight flex items-start gap-1.5",
                              isPos ? "bg-emerald-500/5 border-emerald-500/10 text-emerald-200" : "bg-rose-500/5 border-rose-500/10 text-rose-200"
                            )}>
                              <span className={cn("shrink-0 font-black", isPos ? "text-emerald-400" : "text-rose-400")}>{isPos ? '↑' : '↓'}</span>
                              <span className="truncate">{ins}</span>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          )}

        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* ANALYST TAB                                                    */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'analyst' && (
        <div className="space-y-6">

          {/* Analyst Intelligence Dashboard */}
          {(ar || pf) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Analyst Consensus */}
              {ar && (
                <Card title="Market Consensus" icon={Users}>
                  <div className="space-y-3 pt-1">
                    <div className="flex justify-between items-center">
                      <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Sentiment</span>
                      <SentimentBadge sentiment={ar.finalRating} />
                    </div>
                    <div className="grid grid-cols-5 gap-1.5">
                      {ar.ratings?.map((r: any, i: number) => {
                        const val = parseInt(r.value);
                        const isBuy  = r.name === 'Buy'  || r.name === 'Outperform';
                        const isSell = r.name === 'Sell' || r.name === 'Underperform';
                        return (
                          <div key={i} className="text-center p-1.5 bg-slate-900/40 rounded-lg border border-slate-800/30">
                            <p className="text-xs font-black text-white italic">{val}%</p>
                            <p className={cn("text-[6px] font-black uppercase tracking-tighter", isBuy ? "text-emerald-500" : isSell ? "text-rose-500" : "text-amber-500")}>{r.name.slice(0, 4)}</p>
                          </div>
                        );
                      })}
                    </div>
                    {ar.analystCount && (
                      <p className="text-[8px] text-slate-600 italic text-center font-bold uppercase tracking-widest mt-2">
                        Poll: {ar.analystCount} Analysts
                      </p>
                    )}
                  </div>
                </Card>
              )}

              {/* Price Forecast */}
              {pf && (
                <Card title="Forward Price Targets" icon={TrendingUp}>
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    {[
                      { label: 'High', val: pf.high, color: 'text-emerald-400', bg: 'bg-emerald-500/5' },
                      { label: 'Mean', val: pf.mean, color: 'text-blue-400',    bg: 'bg-blue-500/5'    },
                      { label: 'Low',  val: pf.low,  color: 'text-rose-400',    bg: 'bg-rose-500/5'    },
                    ].map(t => (
                      <div key={t.label} className={cn("p-2 rounded-xl border border-white/5 text-center", t.bg)}>
                        <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1">{t.label}</p>
                        <p className={cn("text-sm font-black italic", t.color)}>₹{t.val}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 h-1 w-full bg-slate-900 rounded-full overflow-hidden flex">
                    <div className="h-full bg-rose-500" style={{ width: '20%' }} />
                    <div className="h-full bg-blue-500" style={{ width: '60%' }} />
                    <div className="h-full bg-emerald-500" style={{ width: '20%' }} />
                  </div>
                </Card>
              )}
            </div>
          )}

          {/* Analyst Consensus Trend */}
          {consensus && (
            <Card title="Analyst Consensus Trend" icon={Users}>
              <div className="space-y-3 pt-2">
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2">Rating Distribution Over Time</p>
                <div className="flex flex-wrap gap-2">
                  {consensus.categories?.map((cat: any, i: number) => (
                    <span key={i} className="text-[9px] font-bold text-slate-400 bg-slate-950 px-2 py-1 rounded border border-slate-800">{cat}</span>
                  ))}
                </div>
                <div className="space-y-2">
                  {consensus.graphData?.map((g: any, i: number) => {
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
                    {valuation.list.map((row: any, i: number) => (
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

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* TRENDLYNE TAB                                                  */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'trendlyne' && (
        <div className="space-y-6">
          {loadingTlMetrics || loadingTlTa ? (
            <div className="flex items-center justify-center p-8 bg-slate-900/10 border border-slate-800 border-dashed rounded-2xl">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 animate-pulse">Loading Trendlyne Data...</span>
            </div>
          ) : (
            <>
              {trendlyneMetrics?.body && (
                <Card title="Stock Metrics (Trendlyne)" icon={BarChart3}>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2">
                    {Object.entries(trendlyneMetrics.body).filter(([key]) => key !== 'prepend_params' && key !== 'head').map(([key, metric]: [string, any]) => (
                      <div key={key} className={cn("p-3 rounded-xl border flex flex-col justify-between",
                        metric.color1 === 'positive' ? "bg-emerald-500/5 border-emerald-500/20" :
                        metric.color1 === 'negative' ? "bg-rose-500/5 border-rose-500/20" :
                        "bg-slate-950 border-slate-800"
                      )}>
                        <div>
                          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 leading-tight">{metric.title}</p>
                          <p className="text-[11px] text-slate-300 mb-1">{metric.st1 || metric.st2 || '—'}</p>
                        </div>
                        <p className={cn("text-lg font-black italic", 
                          metric.color1 === 'positive' ? "text-emerald-400" :
                          metric.color1 === 'negative' ? "text-rose-400" :
                          "text-slate-300"
                        )}>
                          {metric.value} {metric.unit ? <span className="text-[10px]">{metric.unit}</span> : null}
                        </p>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
              {trendlyneTa?.body?.parameters && (
                <Card title="Advanced Technical Analysis (Trendlyne)" icon={Activity}>
                  <div className="space-y-6 pt-2">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex flex-col items-center justify-center">
                        <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">RSI (14)</span>
                        <span className={cn("text-xl font-black italic mt-1", trendlyneTa.body.parameters.rsi?.color === 'positive' ? 'text-emerald-400' : trendlyneTa.body.parameters.rsi?.color === 'negative' ? 'text-rose-400' : 'text-slate-300')}>{trendlyneTa.body.parameters.rsi?.value}</span>
                        <span className="text-[8px] text-slate-400 text-center mt-1">{trendlyneTa.body.parameters.rsi?.insight?.shorttext}</span>
                      </div>
                      <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex flex-col items-center justify-center">
                        <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">MACD</span>
                        <span className={cn("text-xl font-black italic mt-1", trendlyneTa.body.parameters.macd?.color === 'positive' ? 'text-emerald-400' : trendlyneTa.body.parameters.macd?.color === 'negative' ? 'text-rose-400' : 'text-slate-300')}>{trendlyneTa.body.parameters.macd?.value}</span>
                        <span className="text-[8px] text-slate-400 text-center mt-1">{trendlyneTa.body.parameters.macd?.insight?.shorttext}</span>
                      </div>
                      <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex flex-col items-center justify-center">
                        <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Momentum</span>
                        <span className={cn("text-xl font-black italic mt-1", trendlyneTa.body.parameters.momentum?.color === 'positive' ? 'text-emerald-400' : trendlyneTa.body.parameters.momentum?.color === 'negative' ? 'text-rose-400' : 'text-slate-300')}>{trendlyneTa.body.parameters.momentum?.value}</span>
                        <span className="text-[8px] text-slate-400 text-center mt-1">{trendlyneTa.body.parameters.momentum?.insight?.shorttext}</span>
                      </div>
                      <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex flex-col items-center justify-center">
                        <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">MFI</span>
                        <span className={cn("text-xl font-black italic mt-1", trendlyneTa.body.parameters.mfi?.color === 'positive' ? 'text-emerald-400' : trendlyneTa.body.parameters.mfi?.color === 'negative' ? 'text-rose-400' : 'text-slate-300')}>{trendlyneTa.body.parameters.mfi?.value}</span>
                        <span className="text-[8px] text-slate-400 text-center mt-1">{trendlyneTa.body.parameters.mfi?.insight?.shorttext}</span>
                      </div>
                    </div>
                    {trendlyneTa.body.parameters.ma_signal && (
                      <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Moving Averages Signal</p>
                        <div className="flex gap-4 items-center">
                          <div className="flex-1 text-center">
                            <span className="block text-xl font-black text-emerald-400">{trendlyneTa.body.parameters.ma_signal.bullish}</span>
                            <span className="text-[9px] text-slate-500 uppercase">Bullish</span>
                          </div>
                          <div className="flex-1 text-center">
                            <span className="block text-xl font-black text-rose-400">{trendlyneTa.body.parameters.ma_signal.bearish}</span>
                            <span className="text-[9px] text-slate-500 uppercase">Bearish</span>
                          </div>
                        </div>
                        <p className="text-[9px] text-center mt-3 text-slate-400">{trendlyneTa.body.parameters.ma_signal.sma_insight}</p>
                        <p className="text-[9px] text-center text-slate-400">{trendlyneTa.body.parameters.ma_signal.ema_insight}</p>
                      </div>
                    )}
                  </div>
                </Card>
              )}
              {!(trendlyneMetrics as any)?.body && !(trendlyneTa as any)?.body?.parameters && (
                <div className="text-center p-8 bg-slate-950 border border-slate-800 rounded-2xl">
                  <p className="text-slate-500 text-sm font-bold">No Trendlyne data available for this stock.</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── F&O Tab ── */}
      {activeTab === 'fno' && (
        <div className="space-y-4">
          {(mc as any)?.fnoExpiry && (
            <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
              <div className="text-sm font-semibold text-slate-300 mb-3">Futures — {symbol}</div>
              {(mc as any)?.fnoFutures?.data?.futureData ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-700/50">
                        {['Expiry', 'LTP', 'Change%', 'OI', 'OI Change', 'Volume'].map(h => (
                          <th key={h} className="text-left pb-2 pr-4 text-slate-400 font-semibold whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {((mc as any).fnoFutures.data.futureData || []).slice(0, 5).map((row: any, i: number) => {
                        const chg = parseFloat(row.pChange || row.change || 0);
                        return (
                          <tr key={i} className="border-b border-slate-700/20">
                            <td className="py-2 pr-4 text-slate-300">{row.expiryDate || row.expiry}</td>
                            <td className="py-2 pr-4 font-mono text-white">₹{row.lastPrice || row.ltp}</td>
                            <td className={`py-2 pr-4 font-bold ${chg >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                            </td>
                            <td className="py-2 pr-4 text-slate-300">{row.openInterest || row.oi}</td>
                            <td className="py-2 pr-4 text-slate-400">{row.changeinOpenInterest || row.oiChange}</td>
                            <td className="py-2 text-slate-400">{row.totalTradedVolume || row.volume}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-xs text-slate-500 text-center py-4">No futures data available for {symbol}</div>
              )}
            </div>
          )}

          {(indexFnoData as any)?.futures?.refresh_details && (
            <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
              <div className="text-sm font-semibold text-slate-300 mb-3">Index F&O — NIFTY Futures</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700/50">
                      {['Expiry', 'LTP', 'Change', 'OI Lots', 'Volume'].map(h => (
                        <th key={h} className="text-left pb-2 pr-4 text-slate-400 font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {((indexFnoData as any).futures.fno_list || []).slice(0, 3).map((row: any, i: number) => {
                      const chg = parseFloat(row.pChange || 0);
                      return (
                        <tr key={i} className="border-b border-slate-700/20">
                          <td className="py-2 pr-4 text-slate-300">{row.expiry}</td>
                          <td className="py-2 pr-4 font-mono text-white">{row.lastPrice}</td>
                          <td className={`py-2 pr-4 font-bold ${chg >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                          </td>
                          <td className="py-2 pr-4 text-slate-300">{row.openInterest}</td>
                          <td className="py-2 text-slate-400">{row.totalTradedVolume}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!(mc as any)?.fnoExpiry && !(indexFnoData as any)?.futures?.refresh_details && (
            <div className="text-center py-8 text-slate-500 text-sm">
              No F&amp;O data available. This stock may not be in the F&amp;O segment.
            </div>
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
