import React from 'react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import stockData from '../data/stocklist';
import {
  TrendingUp, TrendingDown, Activity, Zap, Info, AlertCircle,
  BarChart3, PieChart, Users, Filter, ArrowUpRight,
  CheckCircle2, BrainCircuit, Search, Database, History, Newspaper, Gift
} from 'lucide-react';
import { motion } from 'motion/react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ComposedChart
} from 'recharts';
import { 
  TechnicalAnalysisWidget, 
  AdvancedChartWidget 
} from './TradingViewWidgets';
import { McNewsCard, McNewsLinks, McNewsEmptyState } from './McNewsCard';

const ACTION_TYPE_COLORS: Record<string, string> = {
  dividend: 'text-emerald-400 bg-emerald-500/10',
  bonus: 'text-indigo-400 bg-indigo-500/10',
  split: 'text-sky-400 bg-sky-500/10',
  rights: 'text-amber-400 bg-amber-500/10',
};


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

const TrendlyneDVMCards: React.FC<{ dvm: any }> = ({ dvm }) => {
  if (!dvm) return null;
  const params = [
    { label: 'Quality / Durability', val: dvm.quality?.score ?? dvm.durability?.score, insight: dvm.quality?.insight ?? dvm.durability?.insight, color: 'text-emerald-400', barColor: 'bg-emerald-500' },
    { label: 'Valuation', val: dvm.valuation?.score, insight: dvm.valuation?.insight, color: 'text-amber-400', barColor: 'bg-amber-500' },
    { label: 'Technicals / Momentum', val: dvm.technicals?.score ?? dvm.momentum?.score, insight: dvm.technicals?.insight ?? dvm.momentum?.insight, color: 'text-blue-400', barColor: 'bg-blue-500' },
  ].filter(p => p.val !== undefined && p.val !== null);

  if (params.length === 0) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {params.map((p) => (
        <div key={p.label} className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-2xl flex flex-col justify-between hover:border-slate-700 transition-colors">
          <div>
            <div className="flex justify-between items-center mb-1">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{p.label}</span>
              <span className={cn("text-xs font-black italic", p.color)}>{p.val}/100</span>
            </div>
            <p className="text-[10px] font-bold text-slate-200 leading-tight">{p.insight}</p>
          </div>
          <div className="mt-3">
            <div className="h-1 w-full bg-slate-900 rounded-full overflow-hidden">
              <div className={cn("h-full rounded-full", p.barColor)} style={{ width: `${p.val}%` }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

const TrendlyneSWOTCard: React.FC<{ swot: any }> = ({ swot }) => {
  if (!swot) return null;
  const categories = [
    { key: 'strengths', label: 'Strengths', badgeColor: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20', iconColor: 'text-emerald-400' },
    { key: 'weaknesses', label: 'Weaknesses', badgeColor: 'bg-rose-500/10 text-rose-400 border border-rose-500/20', iconColor: 'text-rose-400' },
    { key: 'opportunities', label: 'Opportunities', badgeColor: 'bg-blue-500/10 text-blue-400 border border-blue-500/20', iconColor: 'text-blue-400' },
    { key: 'threats', label: 'Threats', badgeColor: 'bg-amber-500/10 text-amber-400 border border-amber-500/20', iconColor: 'text-amber-400' },
  ];

  const hasAnySwot = categories.some(cat => Array.isArray(swot[cat.key]) && swot[cat.key].length > 0);
  if (!hasAnySwot) return null;

  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
      <h4 className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-4 flex items-center gap-1.5 border-l-2 border-indigo-500 pl-2">
        Trendlyne SWOT Analysis
      </h4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {categories.map(cat => {
          const items = swot[cat.key];
          if (!Array.isArray(items) || items.length === 0) return null;
          return (
            <div key={cat.key} className="space-y-2">
              <div className="flex items-center">
                <span className={cn("text-[9px] font-black px-2 py-0.5 rounded border uppercase tracking-wider", cat.badgeColor)}>
                  {cat.label} ({items.length})
                </span>
              </div>
              <div className="space-y-1.5">
                {items.map((item: string, idx: number) => (
                  <div key={idx} className="flex items-start gap-2 text-[10px] text-slate-400 leading-relaxed bg-slate-900/35 p-2 rounded-lg border border-slate-800/40 hover:border-slate-800 transition-colors">
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
};

const TrendlyneChecklistCard: React.FC<{ checklist: any }> = ({ checklist }) => {
  if (!checklist) return null;
  const cdata = checklist.checklistData || {};
  const sections = Object.keys(cdata);
  const score = checklist.score || 0;
  const total = checklist.total || 0;
  const yesCount = checklist.yesCount || 0;
  
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 border-b border-slate-800/50 pb-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Trendlyne Checklist</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-black text-slate-500 uppercase">Pass Rate:</span>
          <span className={cn("text-xs font-black px-2 py-0.5 rounded border uppercase tracking-wider",
            score >= 60 ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
            score >= 35 ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
            "bg-rose-500/10 text-rose-400 border-rose-500/20"
          )}>
            {score.toFixed(1)}% ({yesCount}/{total})
          </span>
        </div>
      </div>
      
      {checklist.insight && (
        <p className="text-[10px] text-slate-400 italic mb-4 leading-relaxed font-medium bg-slate-900/40 p-2.5 rounded-xl border border-slate-800/60">
          Insight: {checklist.insight}
        </p>
      )}

      {sections.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sections.map(sectionName => {
            const items = cdata[sectionName];
            if (!Array.isArray(items) || items.length === 0) return null;
            return (
              <div key={sectionName} className="p-3 bg-slate-900/20 border border-slate-800/40 rounded-xl">
                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-2 border-b border-slate-800/60 pb-1">
                  {sectionName.toUpperCase()}
                </p>
                <div className="space-y-1.5">
                  {items.map((item: any, idx: number) => (
                    <div key={idx} className="flex items-center justify-between p-1.5 bg-slate-950/30 rounded border border-slate-800/30">
                      <span className="text-[9px] text-slate-400 font-bold leading-tight truncate mr-2" title={item.question}>
                        {item.question}
                      </span>
                      <span className={cn("text-[9px] font-black shrink-0", 
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
        <p className="text-center py-4 text-slate-500 text-[10px] font-bold">No checklist questions available.</p>
      )}
    </div>
  );
};

interface MCStockInfoPanelProps {
  symbol: string;
  scId: string;
  section?: 'all' | 'technical' | 'fundamental' | 'earnings' | 'insights' | 'overview' | 'shareholding' | 'peers' | 'trendlyne' | 'news' | 'actions';
  onSelectStock?: (symbol: string) => void;
  watchlist?: string[];
  onToggleWatchlist?: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
}

type Timeframe = 'D' | 'W' | 'M';
type Tab = 'overview' | 'technical' | 'financials' | 'earnings' | 'fno' | 'ai_report' | 'news' | 'actions';

function PanelSectionHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2 border-b border-slate-800/70 pb-2.5">
      <div>
        <h3 className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-200">{title}</h3>
        {subtitle ? <p className="mt-1 text-[10px] font-semibold text-slate-500">{subtitle}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

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
    section === 'earnings' ? 'earnings' :
    section === 'insights' ? 'ai_report' :
    section === 'overview' ? 'overview' :
    section === 'shareholding' ? 'financials' :
    section === 'trendlyne' ? 'ai_report' :
    section === 'news' ? 'news' :
    section === 'actions' ? 'actions' :
    section === 'peers' ? 'financials' : 'overview'
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
    else if (section === 'earnings') setActiveTab('earnings');
    else if (section === 'insights') setActiveTab('ai_report');
    else if (section === 'overview') setActiveTab('overview');
    else if (section === 'shareholding') setActiveTab('financials');
    else if (section === 'peers') setActiveTab('financials');
    else if (section === 'trendlyne') setActiveTab('ai_report');
    else if (section === 'news') setActiveTab('news');
    else if (section === 'actions') setActiveTab('actions');
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
    { enabled: isVisible && activeTab === 'ai_report', staleTime: 60000 }
  );

  const { data: trendlyneTa, isLoading: loadingTlTa } = trpc.getTrendlyneAdvTechnicalAnalysis.useQuery(
    { symbol, timeframe },
    { enabled: isVisible, staleTime: 60000 }
  );

  const { data: trendlyneOverview, isLoading: loadingTlOverview } = trpc.getTrendlyneOverview.useQuery(
    { symbol },
    { enabled: isVisible && (activeTab === 'ai_report' || activeTab === 'overview'), staleTime: 60000 }
  );

  const { data: vwapData } = trpc.getMcVwapChart.useQuery(
    { symbol },
    { enabled: isVisible && (activeTab === 'overview' || activeTab === 'technical'), staleTime: 300000 }
  );

  const { data: _overviewData } = trpc.getCompanyOverview.useQuery(
    { symbol },
    { enabled: isVisible && activeTab === 'overview', staleTime: 300000 }
  );
  const overviewData = _overviewData as any;

  const { data: profileAnalysis } = trpc.getCompanyProfileAnalysis.useQuery(
    { symbol },
    { enabled: isVisible && activeTab === 'overview', staleTime: 300000 }
  );

  const { data: nseStock } = trpc.getNSEStockBySymbol.useQuery(
    { symbol },
    { enabled: isVisible }
  );

  const nseStockData = nseStock as any;

  const { data: peersData, isLoading: loadingPeers } = trpc.getNSEStocksBySector.useQuery(
    { sector: nseStockData?.sector ?? '' },
    { enabled: isVisible && (activeTab === 'financials' || activeTab === 'earnings') && !!nseStockData?.sector }
  );

  // "Results & Earnings" tab content -- previously this tab fetched nothing of its own and
  // silently rendered the Financials tab's content under a relabeled header (the "Forecasts,
  // surprises, ratings and action calendar" subtitle described data that was never queried).
  const { data: mcAnalystRating } = trpc.getMcAnalystRating.useQuery(
    { symbol },
    { enabled: isVisible && activeTab === 'earnings', staleTime: 3600000 }
  );
  const { data: mcEarningsForecast } = trpc.getMcEarningsForecast.useQuery(
    { symbol },
    { enabled: isVisible && activeTab === 'earnings', staleTime: 3600000 }
  );
  const { data: mcPriceForecast } = trpc.getMcPriceForecast.useQuery(
    { symbol },
    { enabled: isVisible && activeTab === 'earnings', staleTime: 3600000 }
  );
  const { data: mcConsensus } = trpc.getMcConsensus.useQuery(
    { symbol },
    { enabled: isVisible && activeTab === 'earnings', staleTime: 3600000 }
  );
  const { data: corporateActions } = trpc.getCorporateActions.useQuery(
    { symbol },
    { enabled: isVisible && activeTab === 'earnings', staleTime: 3600000 }
  );


  const { data: indexFnoData } = trpc.getIndexFno.useQuery(
    { id: 'NIFTY' },
    { enabled: isVisible && activeTab === 'fno', staleTime: 60000 }
  );

  const [selectedExpiry, setSelectedExpiry] = React.useState<string>('');

  const { data: expiriesList } = trpc.getTrendlyneStockExpiries.useQuery(
    { symbol },
    { enabled: isVisible && activeTab === 'fno', staleTime: 300000 }
  );

  React.useEffect(() => {
    if (expiriesList && expiriesList.length > 0 && !selectedExpiry) {
      setSelectedExpiry(expiriesList[0]);
    }
  }, [expiriesList, selectedExpiry]);

  React.useEffect(() => {
    setSelectedExpiry('');
  }, [symbol]);

  const { data: trendlyneOc, isLoading: loadingOc } = trpc.getTrendlyneStockOptionChain.useQuery(
    { symbol, expiryDate: selectedExpiry || undefined },
    { enabled: isVisible && activeTab === 'fno', staleTime: 30000 }
  );

  const { data: niftyTraderData } = trpc.getNiftyTraderData.useQuery(
    { symbol },
    { enabled: isVisible, staleTime: 60000 }
  );

  const { data: mcNewsData, isLoading: loadingMcNews } = trpc.getMcStockNews.useQuery(
    { symbol },
    { enabled: isVisible && activeTab === 'news', staleTime: 60000 }
  );

  // Deep corporate-action history (dividends/bonus/splits/rights), 2026-08-07 urls.txt
  // open-source sourcing pass — DB-backed, unlike the live-only getCorporateActions.
  const { data: actionHistory, isLoading: loadingActionHistory } = trpc.getCorporateActionHistory.useQuery(
    { symbol },
    { enabled: isVisible && activeTab === 'actions', staleTime: 300000 }
  );
  const { data: filedActions, isLoading: loadingFiledActions } = trpc.getFiledCorporateActionsCalendar.useQuery(
    { symbol, daysBack: 180, daysForward: 180 },
    { enabled: isVisible && activeTab === 'actions', staleTime: 300000 }
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

  const providerStatus = [
    { name: 'MoneyControl', ok: !!eq || !!tech || !!classification },
    { name: 'Trendlyne', ok: !!trendlyneOverview || !!trendlyneTa },
    { name: 'TradeBrains', ok: !!tb },
    { name: 'NSE/NiftyTrader', ok: !!niftyTraderData || !!nseStockData },
  ];

  const TABS: { key: Tab; label: string }[] = [
    { key: 'overview',   label: 'Overview Cockpit' },
    { key: 'technical',  label: 'Technical Gauges' },
    { key: 'financials', label: 'Financials & Peers' },
    { key: 'earnings',   label: 'Results & Earnings' },
    { key: 'fno',        label: 'Options & Flow (F&O)' },
    { key: 'ai_report',  label: 'AI Auditor Report' },
    { key: 'news',       label: 'Stock News' },
    { key: 'actions',    label: 'Corporate Actions' },
  ];


  return (
    <div ref={containerRef} className="space-y-6">

      <div className="rounded-2xl border border-slate-800 bg-slate-950/55 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Institutional Stock Intelligence</p>
            <h2 className="mt-1 text-lg font-black tracking-tight text-white">{symbol}</h2>
            <p className="mt-1 text-[10px] font-semibold text-slate-400">
              Multi-provider research surface across valuation, ownership, earnings, options and technical context.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className={cn(
              "text-base font-black tabular-nums",
              parseFloat(String(changePct || 0)) >= 0 ? "text-emerald-400" : "text-rose-400"
            )}>
              ₹{currentPrice}
            </div>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">
              {changePct ? `${parseFloat(String(changePct)) >= 0 ? '+' : ''}${changePct}%` : 'day move unavailable'}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {providerStatus.map((src) => (
            <span
              key={src.name}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-widest",
                src.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-slate-700 bg-slate-900 text-slate-500"
              )}
            >
              {src.name}
            </span>
          ))}
        </div>
      </div>

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
            {niftyTraderData?.analysisData?.symbolData?.created_at && (
              <div className="flex items-center gap-2 pl-4 border-l border-slate-800">
                <Activity className="w-4 h-4 text-indigo-500" />
                <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">NiftyTrader</span>
                <span className="text-[9px] font-black px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400">
                  Updated: {new Date(niftyTraderData.analysisData.symbolData.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                </span>
              </div>
            )}
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

      {/* ── Trendlyne Price Return Insights (Visible on top across all tabs) ── */}
      {trendlyneTa?.body?.parameters?.price_analysis && (
        <div className="bg-slate-950/40 border border-slate-800/80 rounded-2xl p-3 space-y-2">
          <PanelSectionHeader
            title="Price Regime"
            subtitle="Trendlyne benchmark-relative return posture"
          />
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-indigo-500" />
              Trendlyne Performance Returns ({trendlyneTa.body.parameters.beta_benchmark_index || 'NIFTY 50'})
            </span>
            {trendlyneTa.body.parameters.last_modified && (
              <span className="text-[8px] text-slate-500">
                Updated: {trendlyneTa.body.parameters.last_modified}
              </span>
            )}
          </div>
          
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
            {trendlyneTa.body.parameters.price_analysis.map((item: any, idx: number) => {
              const isPositive = item.colorSafe === 'positive' || item.color === 'positive';
              const isNegative = item.colorSafe === 'negative' || item.color === 'negative';
              const changePctVal = item.changePercentSafe != null ? item.changePercentSafe : item.changePercent;
              const changePctFormatted = typeof changePctVal === 'number' ? changePctVal.toFixed(2) : changePctVal;
              
              return (
                <div 
                  key={idx} 
                  className="flex-shrink-0 min-w-[100px] p-2 bg-slate-950/60 rounded-xl border border-slate-800/40 flex flex-col justify-between hover:border-slate-700 transition-colors"
                >
                  <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">{item.name}</span>
                  <span className={cn(
                    "text-xs font-black italic mt-1",
                    isPositive ? "text-emerald-400" : isNegative ? "text-rose-400" : "text-slate-300"
                  )}>
                    {isPositive ? '+' : ''}{changePctFormatted}%
                  </span>
                  {item.low != null && item.high != null && (
                    <span className="text-[7px] text-slate-500 font-bold mt-0.5">
                      L: {item.low} | H: {item.high}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          
          {trendlyneTa.body.parameters.price_insight && trendlyneTa.body.parameters.price_insight.length > 0 && (
            <div className="space-y-1 pt-1 border-t border-slate-800/50">
              {trendlyneTa.body.parameters.price_insight.map((insight: any, idx: number) => (
                <div key={idx} className={cn("text-[9px] px-2 py-0.5 rounded border flex items-center gap-1.5", 
                  insight.color === 'positive' ? "bg-emerald-500/5 border-emerald-500/10 text-emerald-400" :
                  insight.color === 'negative' ? "bg-rose-500/5 border-rose-500/10 text-rose-400" :
                  "bg-slate-900 border-slate-800 text-slate-400"
                )}>
                  <span className="inline-block w-1 h-1 rounded-full bg-current shrink-0" />
                  <span>{insight.longtext || insight.shorttext || String(insight)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TAB BAR (Only show if section is 'all' or undefined) ── */}
      {(!section || section === 'all') && (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-1.5">
          <div className="mb-1.5 px-2 text-[9px] font-black uppercase tracking-[0.16em] text-slate-500">Research Lenses</div>
          <div className="flex overflow-x-auto gap-1 scrollbar-none">
            {TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  "rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all whitespace-nowrap",
                  activeTab === tab.key
                    ? "border-blue-500 bg-blue-500/10 text-blue-300"
                    : "border-transparent text-slate-500 hover:border-slate-700 hover:bg-slate-900/60 hover:text-slate-300"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── KEY STATS (Show in 'all' or 'overview') ── */}
      {(!section || section === 'all' || activeTab === 'overview') && (() => {
        const qVal = trendlyneOverview?.dvm?.quality?.score ?? trendlyneOverview?.dvm?.durability?.score ?? null;
        const vVal = trendlyneOverview?.dvm?.valuation?.score ?? null;
        const tVal = trendlyneOverview?.dvm?.technicals?.score ?? trendlyneOverview?.dvm?.momentum?.score ?? null;
        return (
          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-8 gap-2">
            <CompactMetricCard label="Price" value={`₹${currentPrice}`} sub={changePct ? `${parseFloat(String(changePct)) >= 0 ? '+' : ''}${changePct}%` : undefined}
              color={parseFloat(String(changePct || 0)) >= 0 ? 'text-emerald-400' : 'text-rose-400'} icon={Activity} />
            <CompactMetricCard label="P/E (TTM)" value={eq?.PE || sp?.scTtm || essentials?.pe || tb?.keyMetrics?.pe || '—'} sub={`Sec: ${essentials?.sectorPe || eq?.IND_PE || tb?.keyMetrics?.industry_pe || '—'}`} icon={BarChart3} />
            <CompactMetricCard label="P/B Ratio" value={eq?.PB || essentials?.pb || sp?.priceBook || '—'} icon={PieChart} />
            <CompactMetricCard label="ROE %" value={tb?.keyMetrics?.roe != null ? `${Number(tb.keyMetrics.roe).toFixed(1)}%` : '—'} color="text-emerald-400" icon={TrendingUp} />
            <CompactMetricCard label="Market Cap" value={essentials?.marketCap || eq?.MKTCAP ? `₹${String(eq?.MKTCAP || essentials?.marketCap || '0').replace(/[^\d.]/g, '')}Cr` : '—'} color="text-blue-400" icon={Users} />
            <CompactMetricCard label="Div Yield" value={essentials?.dividendYield ? `${essentials.dividendYield}%` : eq?.DY ? `${eq.DY}%` : tb?.keyMetrics?.divyield ? `${tb.keyMetrics.divyield}%` : '—'} color="text-amber-400" icon={Zap} />
            {trendlyneOverview?.dvm && (
              <CompactMetricCard 
                label="Trendlyne DVM" 
                value={qVal !== null && vVal !== null && tVal !== null ? `${qVal} | ${vVal} | ${tVal}` : '—'} 
                sub="Qual | Val | Tech" 
                icon={TrendingUp} 
                color="text-indigo-400"
              />
            )}
            {trendlyneOverview?.checklist && (
              <CompactMetricCard 
                label="TL Checklist" 
                value={`${trendlyneOverview.checklist.score.toFixed(0)}%`} 
                sub={`${trendlyneOverview.checklist.yesCount}/${trendlyneOverview.checklist.total} Pass`} 
                icon={CheckCircle2} 
                color={trendlyneOverview.checklist.score >= 60 ? 'text-emerald-400' : trendlyneOverview.checklist.score >= 35 ? 'text-amber-400' : 'text-rose-400'} 
              />
            )}
          </div>
        );
      })()}

      {activeTab === 'overview' && (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 space-y-4">
          <PanelSectionHeader
            title="Overview Synthesis"
            subtitle="Unified multi-engine read with valuation and profile context"
          />
          {/* High-Density Intelligence Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
                      <p className="text-[6px] font-black text-slate-405 uppercase tracking-tighter">{factor.label}</p>
                    </div>
                  ))}
                </div>
                {(() => {
                  const f = alphaData.factors;
                  const aggregateRaw = (f.technical + f.fundamental + f.momentum + f.valuation + f.delivery) / 5 * 10;
                  const aggregatePct = Math.max(0, Math.min(100, aggregateRaw));
                  return (
                    <div className="mt-3">
                      <div className="flex items-center justify-between text-[8px] font-black uppercase tracking-widest text-slate-405 mb-1">
                        <span>Aggregate (derived)</span>
                        <span className="text-blue-400">{aggregatePct.toFixed(0)}%</span>
                      </div>
                      <div className="h-0.5 w-full bg-slate-900 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${aggregatePct}%` }} />
                      </div>
                    </div>
                  );
                })()}
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
                          <span className="text-[7px] font-black text-slate-405 uppercase tracking-tight">{d.label}</span>
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
          </div>

          {/* Company Profile (Trendlyne) */}
          {/* ── AI PROFILE ANALYSIS ── */}
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

          {overviewData?.companyProfileData?.companyDescription && (
            <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
              <h4 className="text-[10px] font-black text-emerald-400 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5" /> Company Profile
              </h4>
              <div className="text-[11px] text-slate-400 font-medium leading-relaxed whitespace-pre-wrap">
                {overviewData.companyProfileData.companyDescription}
              </div>
            </div>
          )}

          {/* Market FAQs (Trendlyne) */}
          {overviewData?.faq && overviewData.faq.length > 0 && (
            <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
              <h4 className="text-[10px] font-black text-rose-400 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5" /> Market FAQs
              </h4>
              <div className="space-y-3">
                {overviewData.faq.slice(0, 3).map((f, i) => (
                  <div key={i} className="p-3 bg-slate-900/50 rounded-xl border border-slate-800/50">
                    <p className="text-[11px] font-black text-slate-200 mb-1">{f.question}</p>
                    <p className="text-[10px] font-medium text-slate-400 leading-relaxed" dangerouslySetInnerHTML={{ __html: f.answer }} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Qualitative Drivers: SWOT / Pros-Cons */}
          {(swot || tb?.insights) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Alpha Drivers */}
              <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-2xl p-3">
                <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5" /> Alpha Drivers & Strengths
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
                      <Zap className="w-3.5 h-3.5 text-blue-400 shrink-0" /> {s}
                    </div>
                  ))}
                </div>
              </div>

              {/* Risk Vectors */}
              <div className="bg-rose-500/5 border border-rose-500/10 rounded-2xl p-3">
                <p className="text-[9px] font-black text-rose-500 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5" /> Risk Vectors & Weaknesses
                </p>
                <div className="space-y-1.5">
                  {(() => {
                    const ins = tb?.insights;
                    const cons = Array.isArray(ins?.cons) ? ins.cons : Array.isArray(ins?.negatives) ? ins.negatives : Array.isArray(ins?.weaknesses) ? ins.weaknesses : [];
                    return cons.slice(0, 3).map((c: string, i: number) => (
                      <div key={i} className="flex items-start gap-2 text-[10px] text-slate-300 font-medium leading-relaxed bg-rose-500/5 p-1.5 rounded-lg">
                        <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" /> {c}
                      </div>
                    ));
                  })()}
                  {swot?.weaknesses?.slice(0, 3).map((w: string, i: number) => (
                    <div key={`w-${i}`} className="flex items-start gap-2 text-[10px] text-slate-300 font-medium leading-relaxed bg-amber-500/5 p-1.5 rounded-lg">
                      <Info className="w-3.5 h-3.5 text-amber-500 shrink-0" /> {w}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Expert Classification & Checklist */}
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
                    <CheckCircle2 className="w-3.5 h-3.5" /> MC Expert Analysis
                  </p>
                  <p className="text-[11px] text-slate-300 font-medium italic leading-relaxed">{classification.longDesc}</p>
                </div>
                <div className="flex items-center gap-3 mt-3 relative z-10">
                  <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Score</span>
                  <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                    <motion.div initial={{ width: 0 }} animate={{ width: `${classification.stockScore}%` }}
                      className={cn("h-full rounded-full", classification.stockScore >= 70 ? "bg-emerald-500" : classification.stockScore >= 50 ? "bg-amber-500" : "bg-rose-500")} />
                  </div>
                  <span className={cn("text-[10px] font-black italic",
                    classification.stockScore >= 70 ? "text-emerald-400" : classification.stockScore >= 50 ? "text-amber-400" : "text-rose-400"
                  )}>{classification.stockScore}<span className="text-[7px] text-slate-400 font-bold ml-0.5">/100</span></span>
                </div>
              </div>
            )}

            {/* MC Investment Checklist */}
            {essentials?.checklist && (
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">MC Checklist</span>
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
                    const colorMap = { financials: 'text-blue-500', industry: 'text-purple-500', ownership: 'text-amber-500', others: 'text-slate-400' };
                    const items = essentials.checklist![key];
                    if (!items?.length) return null;
                    return (
                      <div key={key}>
                        <p className={cn("text-[7px] font-black uppercase tracking-widest mb-1.5 border-b border-slate-800/50 pb-0.5", colorMap[key])}>{labelMap[key]}</p>
                        <div className="grid grid-cols-1 gap-1">
                          {items.slice(0, 3).map((item, i) => (
                            <div key={i} className="flex items-center justify-between px-1.5 py-1 bg-slate-900/30 rounded border border-slate-800/20">
                              <span className="text-[8px] text-slate-400 font-bold leading-tight truncate mr-2">{item.question}</span>
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

          {/* Company Profile (Rendered directly in Overview Tab) */}
          {(tb?.profile || tb?.overviewData?.stock_mentions) && (
            <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 border-l-2 border-slate-500 pl-2">
                Company Profile
              </p>
              <div className="flex flex-wrap gap-3">
                {tb?.profile && (
                  <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 bg-slate-900/35 border border-white/[0.06] rounded-xl">
                    {tb.profile.founded_year && (
                      <span className="text-[10px] font-bold text-slate-400">Founded <span className="text-slate-200 font-black">{tb.profile.founded_year}</span></span>
                    )}
                    {tb.profile.chairman && (
                      <span className="text-[10px] font-bold text-slate-400">Chairman <span className="text-slate-200 font-black">{tb.profile.chairman}</span></span>
                    )}
                    {tb.profile.website && (
                      <a href={tb.profile.website} target="_blank" rel="noopener noreferrer"
                        className="text-[10px] font-black text-indigo-400 hover:text-indigo-300 uppercase tracking-widest">
                        Website ↗
                      </a>
                    )}
                    {tb.profile.address && (
                      <span className="text-[10px] font-bold text-slate-400 truncate max-w-sm">{tb.profile.address}</span>
                    )}
                  </div>
                )}
                {Array.isArray(tb?.overviewData?.stock_mentions?.ace_investors) && tb.overviewData.stock_mentions.ace_investors.length > 0 && (
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-indigo-500/5 border border-indigo-500/20 rounded-xl">
                    <Users className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                    <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Ace Investors:</span>
                    <span className="text-[10px] font-bold text-slate-200">
                      {tb.overviewData.stock_mentions.ace_investors.map((a: any) => a.name || a).join(', ')}
                    </span>
                  </div>
                )}
              </div>
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
      {(activeTab === 'financials' || activeTab === 'earnings') && (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 space-y-6">
          <PanelSectionHeader
            title={activeTab === 'earnings' ? 'Results & Earnings' : 'Financials Core'}
            subtitle={activeTab === 'earnings' ? 'Forecasts, surprises, ratings and action calendar' : 'Valuation matrix, profitability and events'}
          />

          {activeTab === 'earnings' && (() => {
            const rating = mcAnalystRating as any;
            const forecast = mcEarningsForecast as any;
            const priceTarget = mcPriceForecast as any;
            const consensus = mcConsensus as any;
            const actions = corporateActions as any;
            const hasRating = rating && rating.finalRating;
            const hasPriceTarget = priceTarget && (priceTarget.high || priceTarget.mean || priceTarget.low);
            const hasForecast = forecast && (forecast.eps?.length || forecast.revenue?.length || forecast.netProfit?.length);
            const hasConsensus = consensus && Array.isArray(consensus.graphData) && consensus.graphData.length > 0;
            const actionsList = Array.isArray(actions) ? actions : [];
            const latestRow = (rows?: { date: string; high: string; low: string; avg: string; actual: string }[]) =>
              rows && rows.length > 0 ? rows[rows.length - 1] : null;

            return (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                <Card title="Analyst Rating & Price Target" icon={BarChart3}>
                  {!hasRating && !hasPriceTarget ? (
                    <div className="text-[10px] font-semibold text-slate-500 py-4">No analyst coverage data captured yet for {symbol}.</div>
                  ) : (
                    <div className="space-y-3 pt-2">
                      {hasRating && (
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <div>
                            <span className={cn(
                              'text-sm font-black uppercase tracking-wide',
                              /buy/i.test(rating.finalRating) ? 'text-emerald-400' : /sell/i.test(rating.finalRating) ? 'text-rose-400' : 'text-amber-400'
                            )}>{rating.finalRating}</span>
                            <div className="text-[10px] text-slate-500 mt-0.5">{rating.analystCount} analysts covering</div>
                          </div>
                          {Array.isArray(rating.ratings) && (
                            <div className="flex gap-1.5 flex-wrap">
                              {rating.ratings.map((r: any, i: number) => (
                                <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">{r.name}: {r.value}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {hasPriceTarget && (
                        <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800/60">
                          <CompactMetricCard label="Low Target" value={priceTarget.low != null ? `₹${priceTarget.low}` : '—'} color="text-rose-400" />
                          <CompactMetricCard label="Mean Target" value={priceTarget.mean != null ? `₹${priceTarget.mean}` : '—'} />
                          <CompactMetricCard label="High Target" value={priceTarget.high != null ? `₹${priceTarget.high}` : '—'} color="text-emerald-400" />
                        </div>
                      )}
                      {hasConsensus && (
                        <div className="pt-2 border-t border-slate-800/60">
                          <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Latest Consensus Mix</div>
                          <div className="flex flex-wrap gap-1.5">
                            {consensus.graphData.map((series: any, i: number) => (
                              Array.isArray(series.data) && series.data.length > 0 && (
                                <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                                  {series.name}: {series.data[series.data.length - 1]}
                                </span>
                              )
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </Card>

                <Card title="Earnings Estimates (latest period)" icon={History}>
                  {!hasForecast ? (
                    <div className="text-[10px] font-semibold text-slate-500 py-4">No earnings estimate data captured yet for {symbol}.</div>
                  ) : (
                    <div className="space-y-2.5 pt-2">
                      {([
                        ['EPS', latestRow(forecast.eps)],
                        ['Net Profit', latestRow(forecast.netProfit)],
                        ['Revenue', latestRow(forecast.revenue)],
                      ] as [string, ReturnType<typeof latestRow>][]).map(([label, row]) => row && (
                        <div key={label} className="p-2.5 bg-slate-950/60 rounded-xl border border-slate-800/50">
                          <div className="flex items-center justify-between text-[9px] text-slate-500 uppercase tracking-widest mb-1">
                            <span>{label}</span><span>{row.date}</span>
                          </div>
                          <div className="grid grid-cols-4 gap-2 text-center">
                            <div><div className="text-xs font-mono font-bold text-slate-100">{row.avg}</div><div className="text-[8px] text-slate-600">Avg Est</div></div>
                            <div><div className="text-xs font-mono font-bold text-rose-400">{row.low}</div><div className="text-[8px] text-slate-600">Low Est</div></div>
                            <div><div className="text-xs font-mono font-bold text-emerald-400">{row.high}</div><div className="text-[8px] text-slate-600">High Est</div></div>
                            <div><div className="text-xs font-mono font-bold text-indigo-300">{row.actual || '—'}</div><div className="text-[8px] text-slate-600">Actual</div></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <Card title="Corporate Actions" icon={History} className="lg:col-span-2">
                  {actionsList.length === 0 ? (
                    <div className="text-[10px] font-semibold text-slate-500 py-4">No recent corporate actions for {symbol}.</div>
                  ) : (
                    <div className="space-y-1.5 max-h-72 overflow-y-auto terminal-scrollbar pt-2">
                      {actionsList.map((a: any, i: number) => (
                        <div key={i} className="flex justify-between text-[11px] text-slate-400 border-b border-slate-800/40 pb-1">
                          <span>{a.action_type ?? a.purpose}</span>
                          <span className="font-mono text-slate-300">{a.ex_date}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            );
          })()}

          {/* High-Density Valuation & Key Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            {/* Dividends (Trendlyne) */}
            {overviewData?.eventsData?.dividendTableData && overviewData.eventsData.dividendTableData.length > 0 && (
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
                <h4 className="text-[10px] font-black text-amber-400 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5" /> Recent Dividends
                </h4>
                <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1 terminal-scrollbar">
                  {overviewData.eventsData.dividendTableData.map((d: any, i: number) => (
                    <div key={i} className="flex justify-between items-center p-2.5 bg-slate-900/50 rounded-xl border border-slate-800/50">
                      <div>
                        <p className="text-[10px] font-black text-amber-400 uppercase tracking-widest">{d.dividendType || 'Dividend'}</p>
                        <p className="text-[11px] font-bold text-slate-200 mt-0.5">₹{d.dividendAmount}</p>
                      </div>
                      <span className="text-[9px] font-black text-slate-400 bg-slate-950 border border-slate-800 px-2 py-1 rounded">
                        {d.exDate}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Board Meetings (Trendlyne) */}
            {overviewData?.eventsData?.boardMeetingTableData && overviewData.eventsData.boardMeetingTableData.length > 0 && (
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
                <h4 className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5" /> Board Meetings
                </h4>
                <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1 terminal-scrollbar">
                  {overviewData.eventsData.boardMeetingTableData.map((action: any, i: number) => (
                    <div key={i} className="flex justify-between items-center p-2.5 bg-slate-900/50 rounded-xl border border-slate-800/50">
                      <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest leading-tight w-40 truncate">
                        {action.purpose || 'Meeting'}
                      </p>
                      <span className="text-[9px] font-black text-slate-400 bg-slate-950 border border-slate-800 px-2 py-1 rounded">
                        {action.boardMeetDate}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
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
                        {Number(val) >= 0 ? '+' : ''}{String(val)}%
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

          {/* Industry Comparison (getMcConsolidated.detailedInsights.industryComparison — had no UI) */}
          {Array.isArray(detailedInsights?.industryComparison) && detailedInsights.industryComparison.length > 0 && (
            <Card title="Industry Comparison" icon={Users}>
              <div className="space-y-2 pt-2">
                {detailedInsights.industryComparison.map((ic: any, i: number) => (
                  <div key={i} className="flex items-center justify-between p-3 bg-slate-950 rounded-xl border border-slate-800/50">
                    <div className="min-w-0">
                      <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest truncate">{ic.title}</p>
                      <p className="text-[9px] text-slate-500 font-medium mt-0.5">{ic.shortDesc}</p>
                    </div>
                    {ic.value != null && (
                      <span className={cn("text-sm font-black italic shrink-0 ml-3",
                        ic.color === 'green' ? "text-emerald-400" : ic.color === 'red' ? "text-rose-400" : "text-amber-400"
                      )}>{ic.value}</span>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Earnings Call Transcripts (getMcConsolidated.detailedInsights.earningTranscripts — had no UI) */}
          {Array.isArray(detailedInsights?.earningTranscripts) && detailedInsights.earningTranscripts.length > 0 && (
            <Card title="Earnings Call Transcripts" icon={Newspaper}>
              <div className="space-y-2 pt-2">
                {detailedInsights.earningTranscripts.slice(0, 8).map((et: any, i: number) => (
                  <a
                    key={i}
                    href={et.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-3 bg-slate-950 rounded-xl border border-slate-800/50 hover:border-indigo-500/40 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest truncate">{et.title}</p>
                      {et.description && <p className="text-[9px] text-slate-500 font-medium mt-0.5 truncate">{et.description}</p>}
                    </div>
                    {et.datetime && <p className="text-[9px] text-slate-600 font-bold shrink-0 ml-3">{String(et.datetime).slice(0, 10)}</p>}
                  </a>
                ))}
              </div>
            </Card>
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

          {/* Growth & CAGR Analysis */}
          {tb?.cagrData && (
            <Card title="Growth & CAGR Analysis" icon={TrendingUp}>
              <div className="overflow-x-auto pt-2">
                <table className="w-full text-left text-[10px]">
                  <thead>
                    <tr className="text-slate-500 font-black uppercase tracking-widest border-b border-slate-800">
                      <th className="pb-2">Metric</th>
                      <th className="pb-2 text-right">1 Year</th>
                      <th className="pb-2 text-right">3 Years</th>
                      <th className="pb-2 text-right">5 Years</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/30">
                    {[
                      { label: 'Revenue Growth', d: tb.cagrData.sales_growth },
                      { label: 'Operating Profit Growth', d: tb.cagrData.operating_profit_growth },
                      { label: 'Net Profit Growth', d: tb.cagrData.net_profit_growth },
                      { label: 'Dividend Growth', d: tb.cagrData.dps },
                      { label: 'Stock CAGR', d: tb.cagrData.stock_growth },
                    ].filter(item => item.d && item.d.value).map((item, i) => {
                      const v1 = item.d.value.one_year;
                      const v3 = item.d.value.three_year;
                      const v5 = item.d.value.five_year;
                      const formatVal = (v: any) => {
                        if (v == null || v === '') return '—';
                        const n = Number(v);
                        return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
                      };
                      const getColor = (v: any) => {
                        if (v == null || v === '') return 'text-slate-400';
                        return Number(v) >= 0 ? 'text-emerald-400' : 'text-rose-400';
                      };
                      return (
                        <tr key={i} className="group hover:bg-slate-900/30 transition-colors">
                          <td className="py-2.5 font-black text-slate-350">{item.label}</td>
                          <td className={cn("py-2.5 text-right font-bold tabular-nums", getColor(v1))}>{formatVal(v1)}</td>
                          <td className={cn("py-2.5 text-right font-bold tabular-nums", getColor(v3))}>{formatVal(v3)}</td>
                          <td className={cn("py-2.5 text-right font-bold tabular-nums", getColor(v5))}>{formatVal(v5)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Shareholding & Ownership Suite */}
          {((tb?.shareHoldingGraph?.holdings) || (mc?.shareholdingPattern)) && (
            <Card title="Shareholding & Ownership Analysis" icon={PieChart}>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-2">
                
                {/* Latest Ownership Pie Breakdown */}
                <div className="space-y-4">
                  <p className="text-[9px] font-black text-blue-500 uppercase tracking-widest border-l-2 border-blue-500 pl-2">Latest Holdings</p>
                  
                  {(() => {
                    let holdingsList: { name: string; value: string | number }[] = [];
                    let pledge = "0.00";
                    
                    if (tb?.shareHoldingGraph?.holdings) {
                      const qKeys = Object.keys(tb.shareHoldingGraph.holdings).sort();
                      const latestQ = qKeys[qKeys.length - 1];
                      if (latestQ) {
                        const h = tb.shareHoldingGraph.holdings[latestQ];
                        holdingsList = [
                          { name: 'Promoters', value: h.promoters_holding },
                          { name: 'FIIs', value: h.fiis_holding },
                          { name: 'DIIs', value: h.diis_holding },
                          { name: 'Public', value: h.public_holding },
                        ];
                      }
                    }
                    
                    // Fallback to moneycontrol shareholdingPattern
                    if (holdingsList.length === 0 && mc?.shareholdingPattern?.list) {
                      holdingsList = mc.shareholdingPattern.list.map((item: any) => ({
                        name: item.name === 'Promoter' ? 'Promoters' : item.name === 'FII' ? 'FIIs' : item.name === 'DII' ? 'DIIs' : item.name,
                        value: item.value
                      }));
                    }
                    
                    pledge = mc?.shareholdingPattern?.promoterPledging || tb?.shareHoldingGraph?.promoterPledging || "0.00";
                    const pledgeNum = parseFloat(String(pledge || 0));

                    if (holdingsList.length === 0) return <p className="text-[10px] text-slate-500 italic">No holdings data available</p>;
                    
                    return (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                          {holdingsList.map((h, i) => (
                            <div key={i} className="p-3 bg-slate-950 rounded-xl border border-slate-800/50">
                              <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1">{h.name}</p>
                              <p className="text-sm font-black text-white italic">{Number(h.value).toFixed(2)}%</p>
                            </div>
                          ))}
                        </div>
                        
                        {pledgeNum > 0 ? (
                          <div className="flex items-center gap-2 px-3 py-2 bg-rose-500/10 border border-rose-500/20 rounded-xl">
                            <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
                            <div>
                              <p className="text-[9px] font-black text-rose-400 uppercase tracking-widest">Promoter Pledging Detected</p>
                              <p className="text-[10px] text-slate-350 font-bold">{pledgeNum.toFixed(2)}% of promoter holding is pledged.</p>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/5 border border-emerald-500/10 rounded-xl">
                            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                            <p className="text-[9px] font-black text-emerald-400 uppercase tracking-widest">Zero Promoter Shares Pledged</p>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Stacked Recharts Bar Chart for Quarterly Trends */}
                <div className="lg:col-span-2 space-y-4">
                  <p className="text-[9px] font-black text-violet-500 uppercase tracking-widest border-l-2 border-violet-500 pl-2">Quarterly Historical Trends</p>
                  <div className="bg-slate-950/40 border border-slate-800/40 rounded-2xl p-2.5 overflow-hidden">
                    {(() => {
                      const holdings = tb?.shareHoldingGraph?.holdings;
                      if (!holdings) return <div className="h-40 flex items-center justify-center text-slate-700 text-[10px] font-black uppercase tracking-widest italic">No historical trend data</div>;
                      
                      const chartData = Object.entries(holdings).sort(([a], [b]) => a.localeCompare(b)).map(([quarter, val]: [string, any]) => {
                        const year = quarter.substring(2, 4);
                        const monthNum = quarter.substring(4, 6);
                        let qLabel = quarter;
                        if (monthNum === '03') qLabel = `Mar '${year}`;
                        else if (monthNum === '06') qLabel = `Jun '${year}`;
                        else if (monthNum === '09') qLabel = `Sep '${year}`;
                        else if (monthNum === '12') qLabel = `Dec '${year}`;
                        return {
                          quarter: qLabel,
                          Promoter: val.promoters_holding,
                          FII: val.fiis_holding,
                          DII: val.diis_holding,
                          Public: val.public_holding
                        };
                      });
                      
                      return (
                        <ResponsiveContainer width="100%" height={180}>
                          <BarChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                            <XAxis dataKey="quarter" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} />
                            <YAxis tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} domain={[0, 100]} />
                            <Tooltip 
                              contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px' }}
                              labelStyle={{ fontSize: 9, fontWeight: 900, color: '#94a3b8' }}
                              itemStyle={{ fontSize: 10, fontWeight: 700 }}
                            />
                            <Legend wrapperStyle={{ fontSize: 8, paddingTop: 10 }} />
                            <Bar dataKey="Promoter" stackId="a" fill="#2563eb" name="Promoter" />
                            <Bar dataKey="FII" stackId="a" fill="#10b981" name="FII" />
                            <Bar dataKey="DII" stackId="a" fill="#8b5cf6" name="DII" />
                            <Bar dataKey="Public" stackId="a" fill="#f59e0b" name="Public" />
                          </BarChart>
                        </ResponsiveContainer>
                      );
                    })()}
                  </div>
                </div>

              </div>
            </Card>
          )}

          {/* NiftyTrader Financial Data */}
          {niftyTraderData && (
            <div className="space-y-6">
              {/* NiftyTrader Financial Key Metrics */}
              {niftyTraderData.financialData?.[0] && (() => {
                const fin = niftyTraderData.financialData[0];
                return (
                  <Card title="NiftyTrader Key Financial Metrics" icon={Database}>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 pt-2">
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
                      ].map((m, i) => (
                        <CompactMetricCard key={i} label={m.label} value={String(m.val ?? '—')} color="text-slate-300" />
                      ))}
                    </div>
                  </Card>
                );
              })()}

              {/* Historical Annual Performance */}
              {niftyTraderData.industryData?.lstfutureprojectval && (() => {
                const annuals = [...niftyTraderData.industryData.lstfutureprojectval].sort((a: any, b: any) => {
                  const parseYear = (str: string) => parseInt(str.replace(/[^\d]/g, ''), 10) || 0;
                  return parseYear(a.year) - parseYear(b.year);
                });

                if (annuals.length === 0) return null;

                return (
                  <Card title="Historical Annual Performance (NiftyTrader)" icon={History}>
                    <div className="overflow-x-auto pt-2">
                      <table className="w-full text-left text-[10px]">
                        <thead>
                          <tr className="text-slate-500 font-black uppercase tracking-widest border-b border-slate-800">
                            <th className="pb-2">Year</th>
                            <th className="pb-2 text-right">Sales Revenue (Cr)</th>
                            <th className="pb-2 text-right">Net Profit (Cr)</th>
                            <th className="pb-2 text-right">NPM %</th>
                            <th className="pb-2 text-right">Actual EPS</th>
                            <th className="pb-2 text-right">Reserves (Cr)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/30">
                          {annuals.map((row: any, idx: number) => {
                            const marginPct = (row.npm * 100).toFixed(1);
                            return (
                              <tr key={idx} className="group hover:bg-slate-900/30 font-mono text-[10px] text-slate-350">
                                <td className="py-2.5 font-bold text-slate-100">{row.year}</td>
                                <td className="py-2.5 text-right">₹{row.sales_Revenue ? parseFloat(row.sales_Revenue).toLocaleString('en-IN') : '—'}</td>
                                <td className={cn("py-2.5 text-right font-bold", 
                                  parseFloat(row.netProfit) >= 0 ? "text-emerald-400" : parseFloat(row.netProfit) < 0 ? "text-rose-400" : "text-slate-400"
                                )}>
                                  ₹{row.netProfit ? parseFloat(row.netProfit).toLocaleString('en-IN') : '—'}
                                </td>
                                <td className="py-2.5 text-right">{row.npm != null ? `${marginPct}%` : '—'}</td>
                                <td className="py-2.5 text-right">₹{row.actualEPS || row.epSinRs || '—'}</td>
                                <td className="py-2.5 text-right">{row.reserves ? `₹${parseFloat(row.reserves).toLocaleString('en-IN')}` : '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                );
              })()}

              {/* Recent Quarterly Performance */}
              {niftyTraderData.industryData?.lastThreeQTRModel && (() => {
                const quarters = niftyTraderData.industryData.lastThreeQTRModel;
                if (quarters.length === 0) return null;
                return (
                  <Card title="Recent Quarterly Performance (NiftyTrader)" icon={BarChart3}>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-2">
                      {quarters.map((q: any, idx: number) => (
                        <div key={idx} className="p-3 bg-slate-950 rounded-xl border border-slate-800/50">
                          <span className="text-[9px] font-black text-slate-500 uppercase tracking-wider block mb-1">{q.year}</span>
                          <div className="space-y-1">
                            <div className="flex justify-between items-center text-[10px]">
                              <span className="text-slate-450 font-bold">Sales:</span>
                              <span className="font-mono font-black text-slate-200">₹{parseFloat(q.sales_Revenue || '0').toLocaleString('en-IN')}Cr</span>
                            </div>
                            <div className="flex justify-between items-center text-[10px]">
                              <span className="text-slate-455 font-bold">Profit:</span>
                              <span className={cn("font-mono font-black", 
                                parseFloat(q.netProfit || '0') >= 0 ? "text-emerald-400" : "text-rose-400"
                              )}>₹{parseFloat(q.netProfit || '0').toLocaleString('en-IN')}Cr</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                );
              })()}
            </div>
          )}

        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* TECHNICAL TAB                                                  */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'technical' && (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 space-y-6">
          <PanelSectionHeader
            title="Technical Gauges"
            subtitle="Price structure, indicator stack and momentum diagnostics"
          />
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

              {/* VWAP Intraday Chart */}
              {(vwapData as any)?.NSE && (vwapData as any).NSE.length > 0 && (
                <Card title="VWAP — Intraday (NSE)" icon={Activity}>
                  <div className="pt-2">
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
                </Card>
              )}

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

              {/* Multi-Timeframe Confluence */}
              {(techD || techW || techM) && (
                <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5 mb-2">
                    <Activity className="w-3 h-3 text-blue-500" /> Multi-TF Confluence
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
                          <p className="text-[7px] font-black text-slate-500 uppercase mb-0.5">{label}</p>
                          <p className={cn("text-[8px] font-black uppercase leading-tight truncate",
                            isBull ? "text-emerald-400" : isBear ? "text-rose-400" : "text-slate-450"
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
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 flex flex-col">
                <div className="flex items-center gap-1.5 mb-2">
                  <Zap className="w-3 h-3 text-amber-400" />
                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Active Signals ({allScreeners.length})</span>
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
                  {allScreeners.length === 0 && <p className="text-[8px] text-slate-400 italic font-bold text-center mt-4">No active signals</p>}
                </div>
              </div>
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

          {/* Historical Rating sentiment (mc.historicalRating — had no UI; the underlying
              trend history is MC Pro-locked, only today's sentiment snapshot is public) */}
          {historicalRating?.data?.[0] && (() => {
            const h = historicalRating.data[0];
            const sentiment: string = h.currSentiment || '';
            const isBull = /bullish/i.test(sentiment);
            const isBear = /bearish/i.test(sentiment);
            return (
              <div className={cn("p-3 rounded-2xl border flex items-center justify-between gap-3 text-xs",
                isBull ? "bg-emerald-500/5 border-emerald-500/20" : isBear ? "bg-rose-500/5 border-rose-500/20" : "bg-slate-950 border-slate-800"
              )}>
                <span className="text-slate-500 uppercase tracking-widest text-[9px] font-black">Sentiment on {h.currdate}</span>
                <span className={cn("font-black italic", isBull ? "text-emerald-400" : isBear ? "text-rose-400" : "text-slate-300")}>
                  {sentiment || 'Neutral'} @ ₹{h.closePrice}
                </span>
                {historicalRating.displayLock === 'Y' && (
                  <span className="text-[9px] text-slate-600 italic">Trend history is MC Pro</span>
                )}
              </div>
            );
          })()}

          {/* Detailed Technical Indicators (mc.technicalAnalysisV2 — had no UI; distinct from
              the buy/sell-count summary above, this is the actual indicator readout) */}
          {technicalAnalysisV2?.data && (
            <Card title="Detailed Technical Indicators" icon={Activity}>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 pt-2">
                {(technicalAnalysisV2.data.indicators || []).map((ind: any) => (
                  <div key={ind.id} className="p-2 bg-slate-950 rounded-xl border border-slate-800/50 text-center">
                    <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest truncate">{ind.displayName}</p>
                    <p className="text-sm font-black text-slate-200 font-mono mt-0.5">
                      {(ind.values || []).map((v: any) => v.value).join(' / ')}
                    </p>
                  </div>
                ))}
              </div>
              {Array.isArray(technicalAnalysisV2.data.crossover) && technicalAnalysisV2.data.crossover.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3 pt-3 border-t border-slate-800/60">
                  {technicalAnalysisV2.data.crossover.map((c: any) => (
                    <div key={c.key} className="p-2 bg-slate-950 rounded-xl border border-slate-800/50 text-center">
                      <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">{c.displayValue}</p>
                      <p className="text-[10px] text-slate-300 mt-0.5">{c.indication || c.period}</p>
                    </div>
                  ))}
                </div>
              )}
              {(technicalAnalysisV2.data.smaNote || technicalAnalysisV2.data.crossNote || technicalAnalysisV2.data.indicatorNote) && (
                <div className="mt-3 pt-3 border-t border-slate-800/60 space-y-1">
                  {[technicalAnalysisV2.data.smaNote, technicalAnalysisV2.data.crossNote, technicalAnalysisV2.data.indicatorNote]
                    .filter(Boolean)
                    .map((note: string, i: number) => (
                      <p key={i} className="text-[10px] text-slate-400 italic">{note}</p>
                    ))}
                </div>
              )}
            </Card>
          )}

          {/* Chart Patterns (mc.chartPatterns — had no UI, AND the fetcher itself was broken:
              the MC endpoint silently ignores its sc_id filter param and always returned the
              same market-wide list; fixed in mcApiService.ts to filter on each row's own
              meta_data.price_key, the only field that actually identifies the stock) */}
          {Array.isArray(chartPatterns?.data) && chartPatterns.data.length > 0 && (
            <Card title="Chart Patterns Detected" icon={BarChart3}>
              <div className="space-y-2 pt-2">
                {chartPatterns.data.map((p: any, i: number) => {
                  let meta: any = {};
                  try { meta = JSON.parse(p.meta_data || '{}'); } catch { /* ignore */ }
                  const isBuy = meta.pattern_type === 'buy';
                  return (
                    <div key={i} className="p-3 bg-slate-950 rounded-xl border border-slate-800/50">
                      <div className="flex items-center justify-between">
                        <div className="min-w-0">
                          <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest truncate">{p.pattern_name}</p>
                          <p className={cn("text-[9px] font-bold mt-0.5", isBuy ? "text-emerald-400" : "text-rose-400")}>
                            {p.comment} · {p.p_status} · {p.time_frame}
                          </p>
                        </div>
                        {meta.target_return_prcnt != null && (
                          <span className="text-sm font-black text-emerald-400 italic shrink-0 ml-3">+{meta.target_return_prcnt}%</span>
                        )}
                      </div>
                      {(meta.entry_price || meta.target_price || meta.stoploss_price) && (
                        <div className="flex gap-4 mt-2 text-[9px] font-mono text-slate-500">
                          {meta.entry_price && <span>Entry ₹{meta.entry_price}</span>}
                          {meta.target_price && <span className="text-emerald-500">Target ₹{meta.target_price}</span>}
                          {meta.stoploss_price && <span className="text-rose-500">Stop ₹{meta.stoploss_price}</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* NiftyTrader Technical Data */}
          {niftyTraderData && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-4">
              {/* Gaps Analysis */}
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
                <h4 className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-3 flex items-center gap-1.5 border-l-2 border-indigo-500 pl-2">
                  NiftyTrader Gap Analysis
                </h4>
                <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1 terminal-scrollbar">
                  {niftyTraderData.analysisData?.msg_data?.length ? (
                    niftyTraderData.analysisData.msg_data.map((msg: string, idx: number) => {
                      const isSupport = msg.toLowerCase().includes('support');
                      return (
                        <div key={idx} className={cn("p-2.5 rounded-xl border text-[10px] leading-relaxed font-mono flex items-start gap-2",
                          isSupport ? "bg-emerald-950/20 border-emerald-900/40 text-emerald-450" : "bg-rose-950/20 border-rose-900/40 text-rose-455"
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

              {/* MA Comparison and Delivery Pattern */}
              <div className="space-y-4">
                <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Delivery & Patterns</h4>
                  <div className="grid grid-cols-2 gap-3">
                    {niftyTraderData.analysisData?.priceTable?.[0] && (() => {
                      const latest = niftyTraderData.analysisData.priceTable[0];
                      return (
                        <div className="p-3 bg-slate-900/45 border border-slate-800 rounded-xl">
                          <span className="text-[8px] font-black text-slate-500 uppercase tracking-wider block mb-1">Delivery %</span>
                          <span className="text-base font-black text-slate-100 font-mono">
                            {latest.delivery_percentage ? `${latest.delivery_percentage}%` : "N/A"}
                          </span>
                          <span className="text-[8px] font-bold text-slate-500 block mt-0.5">
                            Vol: {latest.volume?.toLocaleString('en-IN')}
                          </span>
                        </div>
                      );
                    })()}
                    {niftyTraderData.analysisData?.stocktrend && (() => {
                      const trend = niftyTraderData.analysisData.stocktrend;
                      const hasNr7 = trend.nr7_today?.toLowerCase() === 'yes';
                      return (
                        <div className={cn("p-3 border rounded-xl",
                          hasNr7 ? "bg-blue-950/20 border-blue-900/40" : "bg-slate-900/45 border-slate-800"
                        )}>
                          <span className="text-[8px] font-black text-slate-500 uppercase tracking-wider block mb-1">NR7 Pattern</span>
                          <span className={cn("text-base font-black font-mono", hasNr7 ? "text-blue-400 animate-pulse" : "text-slate-400")}>
                            {trend.nr7_today || "NO"}
                          </span>
                          <span className="text-[8px] font-bold text-slate-500 block mt-0.5">
                            Narrow Range 7
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                </div>

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
                    <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
                      <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Simple Moving Averages</h4>
                      <div className="grid grid-cols-5 gap-2">
                        {smas.map((sma) => {
                          const isAbove = currentPrice >= (sma.val || 0);
                          return (
                            <div key={sma.label} className="p-2 bg-slate-900/45 border border-slate-800/60 rounded-xl text-center">
                              <span className="text-[8px] font-black text-slate-500 uppercase block mb-1">{sma.label.split(' ')[0]}</span>
                              <span className="text-[10px] font-black text-slate-200 font-mono block">₹{Math.round(sma.val || 0)}</span>
                              <span className={cn("text-[7px] font-black font-mono px-1 py-0.5 rounded uppercase mt-1 inline-block",
                                isAbove ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                              )}>
                                {isAbove ? "ABOVE" : "BELOW"}
                              </span>
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

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* PEERS PANEL (Rendered under Financials & Peers)               */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {(activeTab === 'financials' || activeTab === 'earnings') && (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 space-y-6">
          <PanelSectionHeader
            title="Peers & Relative Positioning"
            subtitle="Sector-level comparables for context, not direct recommendations"
          />
          {loadingPeers ? (
            <div className="flex items-center justify-center p-8 bg-slate-900/10 border border-slate-800 border-dashed rounded-2xl">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 animate-pulse">Loading Peer Data...</span>
            </div>
          ) : (
            <>
              {/* Industry Comparison Matrix */}
              {(() => {
                const list = peersData?.stocks || [];
                const topPeers = list.filter((p: any) => p.symbol.toUpperCase() !== symbol.toUpperCase()).slice(0, 4);
                if (topPeers.length === 0) return null;
                return (
                  <Card title="Industry Comparison Matrix (Top Peers)" icon={BarChart3}>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
                      {topPeers.map((peer: any, i: number) => {
                        const mcap = peer.market_cap ? Number(peer.market_cap) : 0;
                        const formattedMcap = mcap > 0 ? `₹${mcap.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr` : '—';
                        return (
                          <div 
                            key={i} 
                            onClick={() => onSelectStock && onSelectStock(peer.symbol)}
                            className="p-3.5 bg-slate-950/60 hover:bg-slate-900/60 border border-slate-800 hover:border-blue-500/50 rounded-xl transition-all cursor-pointer group active:scale-[0.98]"
                          >
                            <div className="flex justify-between items-start mb-2">
                              <div>
                                <p className="text-xs font-black text-white group-hover:text-blue-400 transition-colors uppercase">{peer.symbol}</p>
                                <p className="text-[9px] text-slate-500 font-bold truncate max-w-[120px]">{peer.name}</p>
                              </div>
                              <span className="text-[8px] font-black text-slate-400 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">#{i + 1}</span>
                            </div>
                            <div className="space-y-1 text-[10px]">
                              <div className="flex justify-between">
                                <span className="text-slate-500 font-bold">M.Cap:</span>
                                <span className="text-slate-300 font-black">{formattedMcap}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-slate-500 font-bold">P/E Ratio:</span>
                                <span className={cn(
                                  "font-black",
                                  peer.pe_ratio != null && peer.pe_ratio > 0 ? "text-amber-400" : "text-slate-400"
                                )}>{peer.pe_ratio != null && peer.pe_ratio > 0 ? peer.pe_ratio.toFixed(1) : '—'}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-slate-500 font-bold">Div Yield:</span>
                                <span className="text-emerald-400 font-black">{peer.dividend_yield != null ? `${peer.dividend_yield.toFixed(2)}%` : '—'}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </Card>
                );
              })()}

              {/* Sector Peers Table */}
              <Card title={`Sector Peers: ${nseStockData?.sector || '—'} (${peersData?.count || 0} stocks)`} icon={Filter}>
                <div className="overflow-x-auto pt-2">
                  <table className="w-full text-left text-[10px]">
                    <thead>
                      <tr className="text-slate-500 font-black uppercase tracking-widest border-b border-slate-800">
                        <th className="pb-2">Symbol</th>
                        <th className="pb-2">Company Name</th>
                        <th className="pb-2 text-right">Market Cap (Cr)</th>
                        <th className="pb-2 text-right">P/E Ratio</th>
                        <th className="pb-2 text-right">Div Yield (%)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/30">
                      {(peersData?.stocks || []).map((peer: any, i: number) => {
                        const isCurrent = peer.symbol.toUpperCase() === symbol.toUpperCase();
                        const mcap = peer.market_cap ? Number(peer.market_cap) : 0;
                        return (
                          <tr 
                            key={i} 
                            onClick={() => onSelectStock && onSelectStock(peer.symbol)}
                            className={cn(
                              "group hover:bg-slate-900/35 transition-colors cursor-pointer",
                              isCurrent ? "bg-blue-600/10 border-l-2 border-blue-500 text-blue-400" : ""
                            )}
                          >
                            <td className={cn("py-2.5 font-black uppercase tracking-widest", isCurrent ? "text-blue-400 pl-1" : "text-white group-hover:text-blue-400 transition-colors")}>
                              {peer.symbol}
                            </td>
                            <td className="py-2.5 font-bold text-slate-350 truncate max-w-[200px]">
                              {peer.name}
                            </td>
                            <td className="py-2.5 text-right font-bold tabular-nums text-slate-200">
                              {mcap > 0 ? mcap.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : '—'}
                            </td>
                            <td className="py-2.5 text-right font-bold tabular-nums text-slate-300">
                              {peer.pe_ratio != null && peer.pe_ratio > 0 ? peer.pe_ratio.toFixed(1) : '—'}
                            </td>
                            <td className="py-2.5 text-right font-bold tabular-nums text-emerald-400">
                              {peer.dividend_yield != null ? `${peer.dividend_yield.toFixed(2)}%` : '—'}
                            </td>
                          </tr>
                        );
                      })}
                      {(!peersData?.stocks || peersData.stocks.length === 0) && (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-slate-500 italic">No peer stocks found in this sector.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>

              {/* NiftyTrader Peer Comparison Table */}
              {niftyTraderData?.industryData?.lstFinancires && (() => {
                const peers = niftyTraderData.industryData.lstFinancires;
                return (
                  <Card title="NiftyTrader Industry Peer Comparison" icon={PieChart}>
                    <div className="overflow-x-auto pt-2">
                      <table className="w-full text-left text-[10px]">
                        <thead>
                          <tr className="text-slate-500 font-black uppercase tracking-widest border-b border-slate-800">
                            <th className="pb-2">Symbol</th>
                            <th className="pb-2">Company Name</th>
                            <th className="pb-2 text-right">Market Cap (Cr)</th>
                            <th className="pb-2 text-right">CMP</th>
                            <th className="pb-2 text-right">P/E Ratio</th>
                            <th className="pb-2 text-right">Sales Growth %</th>
                            <th className="pb-2 text-right">Book Value</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/30 font-mono">
                          {peers.map((peer: any, idx: number) => {
                            const isCurrent = peer.symbol?.toUpperCase() === symbol.toUpperCase();
                            return (
                              <tr key={idx} className={cn("hover:bg-slate-900/30 text-slate-300 transition-colors", isCurrent && "bg-blue-950/20 text-blue-400")}>
                                <td className="py-2.5 font-black uppercase tracking-widest">{peer.symbol}</td>
                                <td className="py-2.5 font-sans font-bold text-slate-350 truncate max-w-[150px]" title={peer.company_Name}>{peer.company_Name}</td>
                                <td className="py-2.5 text-right font-bold tabular-nums">{peer.market_Cap ? parseFloat(peer.market_Cap).toLocaleString('en-IN') : '—'}</td>
                                <td className="py-2.5 text-right font-bold tabular-nums">₹{peer.current_price || peer.cmp || '—'}</td>
                                <td className="py-2.5 text-right font-bold tabular-nums">{peer.stock_PE || '—'}</td>
                                <td className={cn("py-2.5 text-right font-bold tabular-nums",
                                  parseFloat(peer.sales_Growth) >= 0 ? "text-emerald-400" : parseFloat(peer.sales_Growth) < 0 ? "text-rose-400" : "text-slate-400"
                                )}>{peer.sales_Growth ? `${peer.sales_Growth}%` : '—'}</td>
                                <td className="py-2.5 text-right font-bold tabular-nums">₹{peer.book_Value || '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* ANALYSIS SECTION (Rendered under AI Auditor Report)            */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'ai_report' && (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 space-y-6">
          <PanelSectionHeader
            title="AI Auditor Report"
            subtitle="Qualitative synthesis, technical overlays and ownership intelligence"
          />

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

          {/* Trendlyne Advanced Technical Analysis (Integrated under Analysis Tab) */}
          {trendlyneTa?.body?.parameters && (
            <>
              {/* Beta & Volatility Dynamics */}
              {trendlyneTa.body.parameters.beta_analysis && (
                <Card 
                  title={`Beta & Volatility Dynamics (${trendlyneTa.body.parameters.beta_benchmark_index || 'NIFTY 50'})`} 
                  icon={TrendingUp}
                >
                  <div className="space-y-4 pt-2">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {trendlyneTa.body.parameters.beta_analysis.map((beta: any, idx: number) => (
                        <div key={idx} className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/50 flex flex-col items-center justify-center">
                          <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">{beta.label} Beta</span>
                          <span className={cn("text-lg font-black italic mt-1", 
                            beta.color === 'positive' ? 'text-emerald-400' : 
                            beta.color === 'negative' ? 'text-rose-400' : 'text-slate-300'
                          )}>
                            {beta.data}
                          </span>
                        </div>
                      ))}
                    </div>
                    {trendlyneTa.body.parameters.beta_insight && trendlyneTa.body.parameters.beta_insight.length > 0 && (
                      <div className="bg-slate-950/40 border border-slate-800/50 p-3 rounded-xl space-y-1.5">
                        {trendlyneTa.body.parameters.beta_insight.map((insight: any, idx: number) => (
                          <div key={idx} className="flex items-start gap-2 text-[10px] text-slate-300">
                            <span className={cn("inline-block w-1.5 h-1.5 rounded-full mt-1.5 shrink-0", 
                              insight.color === 'positive' ? 'bg-emerald-500' : 
                              insight.color === 'negative' ? 'bg-rose-500' : 'bg-slate-500'
                            )} />
                            <span>{insight.longtext || insight.shorttext || String(insight)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </Card>
              )}

              {/* Oscillators Dashboard & Technical Insights */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Oscillators & Indicators Dashboard */}
                {trendlyneTa.body.parameters.oscillator_parameter && (
                  <Card title="Oscillators & Indicators Dashboard" icon={Activity}>
                    <div className="space-y-4 pt-2">
                      {trendlyneTa.body.parameters.oscillator_signal && (
                        <div className={cn("p-3 rounded-xl border flex items-center justify-between",
                          trendlyneTa.body.parameters.oscillator_signal.color === 'positive' ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400' :
                          trendlyneTa.body.parameters.oscillator_signal.color === 'negative' ? 'bg-rose-500/5 border-rose-500/20 text-rose-400' :
                          'bg-slate-900 border-slate-800 text-slate-300'
                        )}>
                          <span className="text-[10px] font-black uppercase tracking-wider">Overall Signal</span>
                          <span className="text-[10px] font-black italic">{trendlyneTa.body.parameters.oscillator_signal.insight}</span>
                        </div>
                      )}
                      
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {trendlyneTa.body.parameters.oscillator_parameter.map((osc: any, idx: number) => (
                          <div key={idx} className="flex items-center justify-between p-2 bg-slate-950/30 rounded-lg border border-slate-800/50 hover:bg-slate-950/60 hover:border-slate-300 transition-all">
                            <div className="flex-1 min-w-0 pr-2">
                              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest truncate">{osc.name}</p>
                              {osc.description && (
                                <p className="text-[7px] text-slate-500 line-clamp-1 hover:line-clamp-none mt-0.5 leading-tight">{osc.description}</p>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[10px] font-black text-slate-300 tabular-nums">{osc.value}</span>
                              {osc.color && (
                                <span className={cn("text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-tighter",
                                  osc.color === 'positive' ? "bg-emerald-500/10 text-emerald-400" :
                                  osc.color === 'negative' ? "bg-rose-500/10 text-rose-400" :
                                  "bg-slate-900 text-slate-400 border border-slate-800/50"
                                )}>
                                  {osc.color === 'positive' ? 'Bullish' : osc.color === 'negative' ? 'Bearish' : 'Neutral'}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Card>
                )}

                {/* Trendlyne Technical Insights */}
                {trendlyneTa.body.parameters.technicals_insight && trendlyneTa.body.parameters.technicals_insight.length > 0 && (
                  <Card title="Trendlyne Technical Insights" icon={BrainCircuit}>
                    <div className="space-y-2 pt-2">
                      {trendlyneTa.body.parameters.technicals_insight.map((insight: any, idx: number) => (
                        <div key={idx} className={cn("p-3 rounded-xl border flex items-start gap-2.5 text-[10px]",
                          insight.color === 'positive' ? 'bg-emerald-500/5 border-emerald-500/20 text-slate-200' :
                          insight.color === 'negative' ? 'bg-rose-500/5 border-rose-500/20 text-slate-200' :
                          'bg-slate-900 border-slate-800 text-slate-200'
                        )}>
                          <span className={cn("inline-block w-1.5 h-1.5 rounded-full mt-1.5 shrink-0", 
                            insight.color === 'positive' ? 'bg-emerald-500' : 
                            insight.color === 'negative' ? 'bg-rose-500' : 'bg-slate-500'
                          )} />
                          <div>
                            <p className="font-bold leading-relaxed">{insight.longtext || insight.shorttext}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            </>
          )}

        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* ANALYST RECOMMENDATIONS (Rendered under AI Auditor Report)     */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'ai_report' && (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 space-y-6">
          <PanelSectionHeader
            title="Analyst & Forecast Lens"
            subtitle="Consensus trend, target dispersion and valuation expectations"
          />

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
      {/* TRENDLYNE METRICS (Rendered under AI Auditor Report)           */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'ai_report' && (
        <div className="space-y-6">
          {loadingTlMetrics || loadingTlTa || loadingTlOverview ? (
            <div className="flex items-center justify-center p-8 bg-slate-900/10 border border-slate-800 border-dashed rounded-2xl">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 animate-pulse">Loading Trendlyne Data...</span>
            </div>
          ) : (
            <>
              {trendlyneOverview && (
                <>
                  <TrendlyneDVMCards dvm={trendlyneOverview.dvm} />
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <TrendlyneSWOTCard swot={trendlyneOverview.swot} />
                    <TrendlyneChecklistCard checklist={trendlyneOverview.checklist} />
                  </div>
                </>
              )}
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
        <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 space-y-6">
          <PanelSectionHeader
            title="Options & Flow"
            subtitle="OI structure, PCR, max pain and rollover posture"
          />
          
          {/* Expiry Selector & Contract Headers */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-950/40 border border-slate-800/80 rounded-2xl p-4">
            <div>
              <h3 className="text-sm font-black text-white flex items-center gap-1.5 uppercase tracking-wider">
                <Activity className="w-4 h-4 text-purple-400" />
                {symbol} Derivatives
              </h3>
              {trendlyneOc?.data?.body?.contractLastUpdated && (
                <p className="text-[9px] text-slate-500 font-bold uppercase mt-0.5">
                  Last Updated: {trendlyneOc.data.body.contractLastUpdated}
                </p>
              )}
            </div>
            
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Expiry:</span>
              {expiriesList && expiriesList.length > 0 ? (
                <select
                  value={selectedExpiry}
                  onChange={(e) => setSelectedExpiry(e.target.value)}
                  className="bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-200 font-black uppercase tracking-wider cursor-pointer"
                >
                  {expiriesList.map((exp: string) => {
                    const formattedDate = new Date(exp).toLocaleDateString('en-IN', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric'
                    });
                    return (
                      <option key={exp} value={exp} className="bg-slate-950 text-slate-200 font-mono text-[10px] uppercase">
                        {formattedDate}
                      </option>
                    );
                  })}
                </select>
              ) : (
                <span className="text-[10px] text-slate-400 font-bold animate-pulse">Loading Expiries…</span>
              )}
            </div>
          </div>

          {loadingOc ? (
            <div className="flex items-center justify-center p-12 border border-slate-800/50 border-dashed rounded-2xl">
              <span className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-600 animate-pulse">Loading Options Chain…</span>
            </div>
          ) : trendlyneOc?.success && trendlyneOc?.data?.body ? (() => {
            const body = trendlyneOc.data.body;
            const stockLevel = body.stockLevelData || {};
            const pcrMetrics = stockLevel.PCR_metrcs || {};
            const expPcr = body.expiryLevelPCRValues || {};
            
            // Calculate Support & Resistance
            const list = body.tableDataV2 || [];
            let maxCallOi = -1;
            let maxPutOi = -1;
            let resistanceStrike = null;
            let supportStrike = null;
            
            list.forEach((row: any) => {
              const callOi = row.c?.open_interest || 0;
              const putOi = row.p?.open_interest || 0;
              if (callOi > maxCallOi) {
                maxCallOi = callOi;
                resistanceStrike = row.strike;
              }
              if (putOi > maxPutOi) {
                maxPutOi = putOi;
                supportStrike = row.strike;
              }
            });

            // Filter strikes closest to At-The-Money (ATM)
            const atm = body.atTheMoney || stockLevel.currentPrice || 0;
            const sorted = [...list].sort((a, b) => a.strike - b.strike);
            let closestIdx = 0;
            let minDiff = Infinity;
            for (let i = 0; i < sorted.length; i++) {
              const diff = Math.abs(sorted[i].strike - atm);
              if (diff < minDiff) {
                minDiff = diff;
                closestIdx = i;
              }
            }
            const start = Math.max(0, closestIdx - 6);
            const end = Math.min(sorted.length, closestIdx + 7);
            const slicedStrikes = sorted.slice(start, end);

            return (
              <div className="space-y-4">
                
                {/* Insights / Metrics Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  <div className="bg-slate-950/40 border border-slate-800/80 rounded-xl p-3 flex flex-col justify-between">
                    <span className="text-[8px] font-black text-slate-500 uppercase tracking-wider">Expiry PCR (OI)</span>
                    <span className={cn(
                      "text-base font-black tracking-tight mt-1",
                      (expPcr.pcr_oi ?? 0) >= 1.3 ? "text-emerald-400" : (expPcr.pcr_oi ?? 0) <= 0.6 ? "text-rose-400" : "text-slate-200"
                    )}>
                      {expPcr.pcr_oi != null ? expPcr.pcr_oi.toFixed(2) : '—'}
                    </span>
                    <span className="text-[7px] font-black text-slate-600 uppercase mt-0.5">
                      {(expPcr.pcr_oi ?? 0) >= 1.3 ? 'Contrarian Bullish' : (expPcr.pcr_oi ?? 0) <= 0.6 ? 'Oversold / Bearish' : 'Neutral'}
                    </span>
                  </div>

                  <div className="bg-slate-950/40 border border-slate-800/80 rounded-xl p-3 flex flex-col justify-between">
                    <span className="text-[8px] font-black text-slate-500 uppercase tracking-wider">Max Pain Point</span>
                    <span className="text-base font-black tracking-tight text-blue-400 mt-1">
                      {body.maxPain != null ? `₹${body.maxPain}` : '—'}
                    </span>
                    <span className="text-[7px] font-black text-slate-600 uppercase mt-0.5">
                      Magnet Strike Level
                    </span>
                  </div>

                  <div className="bg-slate-950/40 border border-slate-800/80 rounded-xl p-3 flex flex-col justify-between">
                    <span className="text-[8px] font-black text-slate-500 uppercase tracking-wider">Rollover Score</span>
                    <span className="text-base font-black tracking-tight text-amber-400 mt-1">
                      {stockLevel.rollover_percent != null ? `${stockLevel.rollover_percent.toFixed(1)}%` : '—'}
                    </span>
                    <span className="text-[7px] font-black text-slate-600 uppercase mt-0.5">
                      Cost: {stockLevel.rollover_cost_percent != null ? `${stockLevel.rollover_cost_percent.toFixed(2)}%` : '—'}
                    </span>
                  </div>

                  <div className="bg-slate-950/40 border border-slate-800/80 rounded-xl p-3 flex flex-col justify-between">
                    <span className="text-[8px] font-black text-slate-500 uppercase tracking-wider">MWPL Limit %</span>
                    <span className="text-base font-black tracking-tight text-purple-400 mt-1">
                      {body.MWPL != null ? `${body.MWPL}%` : '—'}
                    </span>
                    <span className="text-[7px] font-black text-slate-600 uppercase mt-0.5">
                      Market Position Limit
                    </span>
                  </div>
                </div>

                {/* Open Interest (OI) Profile Chart */}
                {slicedStrikes.length > 0 && (
                  <div className="bg-slate-950/40 border border-slate-800/80 rounded-2xl p-4">
                    <h4 className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-1.5">
                      <BarChart3 className="w-3.5 h-3.5 text-blue-500" />
                      Open Interest Profile (Call vs Put)
                    </h4>
                    <div className="h-48 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={slicedStrikes.map((r: any) => ({
                            strike: r.strike,
                            callOi: r.c?.open_interest ? r.c.open_interest / 1000 : 0,
                            putOi: r.p?.open_interest ? r.p.open_interest / 1000 : 0
                          }))}
                          margin={{ top: 5, right: 0, left: -20, bottom: 5 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                          <XAxis 
                            dataKey="strike" 
                            stroke="#ffffff40" 
                            fontSize={9} 
                            tickMargin={5}
                            axisLine={false}
                            tickLine={false}
                          />
                          <YAxis 
                            stroke="#ffffff40" 
                            fontSize={9}
                            tickFormatter={(val) => `${val}k`}
                            axisLine={false}
                            tickLine={false}
                          />
                          <Tooltip
                            contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '0.75rem', fontSize: '10px' }}
                            itemStyle={{ fontWeight: 800 }}
                            formatter={(value: number) => [`${value.toFixed(1)}k Lots`, undefined]}
                            labelFormatter={(label) => `Strike: ₹${label}`}
                            cursor={{ fill: '#ffffff05' }}
                          />
                          <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} iconType="circle" />
                          <Bar dataKey="callOi" name="Call OI" fill="#f43f5e" radius={[2, 2, 0, 0]} />
                          <Bar dataKey="putOi" name="Put OI" fill="#10b981" radius={[2, 2, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* Support & Resistance Intelligence Card */}
                {(supportStrike !== null || resistanceStrike !== null) && (
                  <div className="bg-slate-950/30 border border-slate-800/60 rounded-2xl p-4 space-y-2">
                    <h4 className="text-[10px] font-black uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5 text-blue-500" />
                      Derivatives Structural Floor & Ceiling
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                      {supportStrike !== null && (
                        <div className="flex items-center justify-between border border-slate-800/60 rounded-xl px-3 py-2 bg-emerald-500/[0.02]">
                          <div>
                            <p className="text-[8px] font-black text-emerald-500 uppercase tracking-wider">Option Support Base</p>
                            <p className="text-sm font-black text-white mt-0.5">Strike ₹{supportStrike}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-[8px] font-black text-slate-500 uppercase">Put OI</p>
                            <p className="text-xs font-black text-emerald-400 tabular-nums">{(maxPutOi / 1000).toFixed(1)}k</p>
                          </div>
                        </div>
                      )}
                      {resistanceStrike !== null && (
                        <div className="flex items-center justify-between border border-slate-800/60 rounded-xl px-3 py-2 bg-rose-500/[0.02]">
                          <div>
                            <p className="text-[8px] font-black text-rose-500 uppercase tracking-wider">Option Resistance Wall</p>
                            <p className="text-sm font-black text-white mt-0.5">Strike ₹{resistanceStrike}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-[8px] font-black text-slate-500 uppercase">Call OI</p>
                            <p className="text-xs font-black text-rose-400 tabular-nums">{(maxCallOi / 1000).toFixed(1)}k</p>
                          </div>
                        </div>
                      )}
                    </div>
                    <p className="text-[9px] text-slate-500 font-medium">
                      Maximum concentration of writing is sitting at ₹{resistanceStrike} (resistance) and ₹{supportStrike} (support). Standard pivots are mapped below for intraday convergence.
                    </p>
                  </div>
                )}

                {/* Option Chain Table */}
                <div className="border border-white/[0.06] rounded-2xl overflow-hidden bg-slate-950/20">
                  <div className="px-4 py-2 bg-slate-900/30 border-b border-white/[0.06] flex items-center justify-between">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Option Chain Table (ATM Slice)</span>
                    <span className="text-[9px] text-slate-500 font-bold">ATM Strike: ₹{atm}</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-white/[0.06] text-[9px] font-black uppercase tracking-widest text-slate-500 bg-slate-900/20">
                          <th className="py-2 px-3 text-left">OI (Call)</th>
                          <th className="py-2 px-2 text-left">Chg%</th>
                          <th className="py-2 px-2 text-right">IV</th>
                          <th className="py-2 px-3 text-right">LTP (Call)</th>
                          <th className="py-2 px-3 text-center bg-slate-900/40">Strike</th>
                          <th className="py-2 px-3 text-left">LTP (Put)</th>
                          <th className="py-2 px-2 text-left">IV</th>
                          <th className="py-2 px-2 text-right">Chg%</th>
                          <th className="py-2 px-3 text-right">OI (Put)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.03]">
                        {slicedStrikes.map((row: any) => {
                          const isAtmRow = Math.abs(row.strike - atm) < 0.01 || (row.strike === atm);
                          const c = row.c || {};
                          const p = row.p || {};
                          
                          // Determine ITM status
                          const isCallItm = row.strike < atm;
                          const isPutItm = row.strike > atm;

                          const formatBuildUp = (bu: string | null) => {
                            if (!bu) return null;
                            const isGreen = bu === 'Long Buildup' || bu === 'Short Covering';
                            return (
                              <span className={cn(
                                "text-[7px] font-black uppercase px-1 py-0.5 rounded leading-none shrink-0",
                                isGreen ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                              )}>
                                {bu.replace(' Buildup', '').replace(' Covering', ' Cov')}
                              </span>
                            );
                          };

                          return (
                            <tr
                              key={row.strike}
                              className={cn(
                                "hover:bg-slate-900/30 transition-all font-bold",
                                isAtmRow ? "bg-blue-500/[0.04] border-y border-blue-500/30" : ""
                              )}
                            >
                              {/* CALL SIDE */}
                              <td className={cn("py-2 px-3 text-slate-300 font-mono", isCallItm ? "bg-blue-500/[0.01]" : "")}>
                                <div className="flex items-center gap-1.5 justify-between">
                                  <span>{c.open_interest != null ? (c.open_interest / 1000).toFixed(1) + 'k' : '—'}</span>
                                  {formatBuildUp(c.built_up)}
                                </div>
                              </td>
                              <td className={cn("py-2 px-2 font-mono tabular-nums", isCallItm ? "bg-blue-500/[0.01]" : "", (c.oi_changeP ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                                {c.oi_changeP != null ? `${c.oi_changeP >= 0 ? '+' : ''}${c.oi_changeP.toFixed(1)}%` : '—'}
                              </td>
                              <td className={cn("py-2 px-2 text-right text-slate-500 font-mono", isCallItm ? "bg-blue-500/[0.01]" : "")}>
                                {c.iv != null ? `${c.iv.toFixed(1)}%` : '—'}
                              </td>
                              <td className={cn("py-2 px-3 text-right text-white font-mono", isCallItm ? "bg-blue-500/[0.01]" : "")}>
                                {c.current_price != null ? `₹${c.current_price.toFixed(2)}` : '—'}
                              </td>

                              {/* STRIKE (CENTER) */}
                              <td className={cn(
                                "py-2 px-3 text-center bg-slate-900/40 text-blue-400 font-black tabular-nums border-x border-white/[0.04]",
                                isAtmRow ? "text-blue-300 font-extrabold" : ""
                              )}>
                                {row.strike.toFixed(1)}
                              </td>

                              {/* PUT SIDE */}
                              <td className={cn("py-2 px-3 text-left text-white font-mono", isPutItm ? "bg-blue-500/[0.01]" : "")}>
                                {p.current_price != null ? `₹${p.current_price.toFixed(2)}` : '—'}
                              </td>
                              <td className={cn("py-2 px-2 text-slate-500 font-mono", isPutItm ? "bg-blue-500/[0.01]" : "")}>
                                {p.iv != null ? `${p.iv.toFixed(1)}%` : '—'}
                              </td>
                              <td className={cn("py-2 px-2 text-right font-mono tabular-nums", isPutItm ? "bg-blue-500/[0.01]" : "", (p.oi_changeP ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                                {p.oi_changeP != null ? `${p.oi_changeP >= 0 ? '+' : ''}${p.oi_changeP.toFixed(1)}%` : '—'}
                              </td>
                              <td className={cn("py-2 px-3 text-slate-300 font-mono", isPutItm ? "bg-blue-500/[0.01]" : "")}>
                                <div className="flex items-center gap-1.5 justify-between">
                                  {formatBuildUp(p.built_up)}
                                  <span>{p.open_interest != null ? (p.open_interest / 1000).toFixed(1) + 'k' : '—'}</span>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            );
          })() : (
            <div className="text-center py-10 bg-slate-950 border border-slate-800 rounded-2xl">
              <p className="text-slate-500 text-sm font-bold">This symbol may not have derivative options contracts available.</p>
            </div>
          )}
          
          {/* Keep Moneycontrol Futures as Collapsible secondary detail */}
          {(mc as any)?.fnoExpiry && (
            <div className="border-t border-slate-800/80 pt-3">
              <details className="group cursor-pointer">
                <summary className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2 hover:text-slate-300 select-none">
                  <span>View Underlying Futures Contracts</span>
                  <span className="text-[8px] group-open:rotate-180 transition-transform">▼</span>
                </summary>
                <div className="mt-3 bg-slate-800/20 rounded-xl p-4 border border-slate-800/60">
                  <div className="text-xs font-semibold text-slate-300 mb-3">Futures — {symbol}</div>
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
                              <tr key={i} className="border-b border-slate-700/20 font-medium">
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
                    <div className="text-xs text-slate-500 text-center">No futures data available.</div>
                  )}
                </div>
              </details>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: STOCK NEWS ── */}
      {activeTab === 'news' && (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 space-y-4">
          <PanelSectionHeader
            title="News Flow"
            subtitle="MoneyControl stock-specific stream with time-stamped items"
          />
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest flex items-center gap-2">
              <Newspaper className="w-4 h-4 text-blue-400" />
              <span>MoneyControl Live News — {symbol}</span>
            </h3>
            {mcNewsData && mcNewsData.count > 0 && (
              <span className="text-[10px] font-mono text-slate-500 bg-slate-800 px-2 py-0.5 rounded-full">
                Latest {mcNewsData.count}
              </span>
            )}
          </div>

          {loadingMcNews ? (
            <div className="text-center py-12 bg-slate-900/30 border border-slate-800 rounded-2xl animate-pulse">
              <p className="text-xs text-slate-400 font-bold">Fetching latest news for {symbol}…</p>
            </div>
          ) : !mcNewsData || mcNewsData.news.length === 0 ? (
            <McNewsEmptyState status={mcNewsData?.status} symbol={symbol} />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {mcNewsData.news.map((item, idx) => (
                <McNewsCard key={item.posturl || idx} item={item} accent="blue" />
              ))}
            </div>
          )}

          <McNewsLinks
            additionalLinks={mcNewsData?.additional_links}
            moreLink={mcNewsData?.more_link}
            accent="blue"
          />
        </div>
      )}

      {/* ── TAB: CORPORATE ACTIONS ── */}
      {activeTab === 'actions' && (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 space-y-6">
          <PanelSectionHeader
            title="Corporate Action History"
            subtitle="Dividends, bonus issues, stock splits and rights issues — the record ohlcv_adjust.py cross-checks against for split/bonus price adjustment"
          />
          <div>
            <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest flex items-center gap-2 mb-3">
              <Gift className="w-4 h-4 text-indigo-400" />
              <span>MoneyControl — {symbol}</span>
            </h3>
            {loadingActionHistory ? (
              <div className="text-center py-8 bg-slate-900/30 border border-slate-800 rounded-2xl animate-pulse">
                <p className="text-xs text-slate-400 font-bold">Fetching corporate-action history…</p>
              </div>
            ) : !actionHistory || actionHistory.length === 0 ? (
              <div className="text-center py-8 bg-slate-900/30 border border-slate-800 rounded-2xl">
                <p className="text-xs text-slate-500 font-semibold">No dividend, bonus, split or rights history on record for {symbol}.</p>
              </div>
            ) : (
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs min-w-[480px]">
                  <thead>
                    <tr className="text-[10px] text-slate-500 uppercase tracking-wider border-b border-slate-800/60">
                      <th className="text-left px-2 py-2 font-medium">Date</th>
                      <th className="text-left px-2 py-2 font-medium">Type</th>
                      <th className="text-right px-2 py-2 font-medium">Ratio / Amount</th>
                      <th className="text-left px-2 py-2 font-medium">Announced</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/30">
                    {actionHistory.map((a: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-800/40">
                        <td className="px-2 py-1.5 font-mono text-slate-300">{a.record_date || '—'}</td>
                        <td className="px-2 py-1.5">
                          <span className={cn("text-[9px] px-2 py-0.5 rounded font-bold uppercase",
                            ACTION_TYPE_COLORS[a.action_type] || "text-slate-400 bg-slate-500/10")}>
                            {a.action_type}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-slate-200">
                          {a.ratio_text ? a.ratio_text
                            : a.amount != null ? `₹${Number(a.amount).toFixed(2)}`
                            : '—'}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-slate-500">{a.announce_date || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest flex items-center gap-2 mb-3">
              <Database className="w-4 h-4 text-emerald-400" />
              <span>Filed with NSE (last/next 6 months)</span>
            </h3>
            {loadingFiledActions ? (
              <div className="text-center py-6 bg-slate-900/30 border border-slate-800 rounded-2xl animate-pulse">
                <p className="text-xs text-slate-400 font-bold">Checking NSE filings…</p>
              </div>
            ) : !filedActions || filedActions.length === 0 ? (
              <p className="text-xs text-slate-500 font-semibold">No NSE-filed corporate action in this window.</p>
            ) : (
              <div className="space-y-2">
                {filedActions.map((f: any, i: number) => (
                  <a
                    key={i}
                    href={f.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-2.5 bg-slate-950/50 border border-slate-800/60 rounded-lg hover:border-slate-700 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[9px] px-2 py-0.5 rounded font-bold uppercase text-emerald-400 bg-emerald-500/10 shrink-0">
                        {(f.category || '').split('|')[0] || 'filing'}
                      </span>
                      <span className="text-[10px] text-slate-500 font-mono shrink-0">{f.filing_date}</span>
                    </div>
                    <p className="text-xs text-slate-200 mt-1.5 leading-snug line-clamp-2">{f.headline}</p>
                  </a>
                ))}
              </div>
            )}
          </div>
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
