import React, { useState, useMemo } from 'react';
import { motion } from 'motion/react';
import { format } from 'date-fns';
import {
  ResponsiveContainer, ComposedChart, CartesianGrid, XAxis, YAxis, Tooltip,
  Area, Bar, Line, ReferenceLine, ReferenceArea,
} from 'recharts';
import {
  ArrowLeft, ArrowUpRight, TrendingUp, TrendingDown, Heart, Info, Zap, Activity, AlertCircle,
  BrainCircuit, Bookmark, Bookmark as WatchlistIcon,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import { useNewsFeed } from '../services/newsService';
import { detectCandlestickPatterns } from '../lib/candlestickUtils';
import type { MarketData } from '../services/marketService';
import stockData from '../data/stocklist';
import { nseStocksData } from '../data/nseStocks';
import { Card } from './Card';
import { PageFallback } from './PageFallback';
import { MCErrorBoundary } from './MCErrorBoundary';
import MCStockInfoPanel from './MCStockInfoPanel';
import { FinologyPanel } from './FinologyPanel';
// Ported from v2's V2StockDetails (2026-08-20 v1 consolidation) -- self-contained, so reusable
// as-is; genuinely absent from both this page and the separate Stock Intelligence Hub page.
import { AiInsightsTab } from '../components/v2/views/stock-analysis/AiInsightsTab';
import { V1PeadConcallWidget } from './V1PeadConcallWidget';
import { V1TradeRiskCalculatorWidget } from './V1TradeRiskCalculatorWidget';

// Same O(1) lookup maps App.tsx builds at module scope for the same purpose (avoids O(n)
// .find() on every stock detail open) -- duplicated here rather than imported from App.tsx,
// since App.tsx is the eagerly-loaded root and importing FROM it would defeat the point of
// lazy-loading this component out of its bundle.
const _stockDataMap = new Map(stockData.map(s => [s.symbol.toUpperCase(), s]));
const _nseSymbolMap = new Map(nseStocksData.map(s => [s.symbol, s]));

const V1TechnicalAnalysis   = React.lazy(() => import('./V1TechnicalAnalysis').then(m => ({ default: m.V1TechnicalAnalysis })));
const V1FundamentalInsights = React.lazy(() => import('./V1FundamentalInsights').then(m => ({ default: m.V1FundamentalInsights })));
const V1MFAnalysis          = React.lazy(() => import('./V1MFAnalysis').then(m => ({ default: m.V1MFAnalysis })));
const V1NewsTab             = React.lazy(() => import('./V1NewsTab').then(m => ({ default: m.V1NewsTab })));
const V1OptionChain         = React.lazy(() => import('./V1OptionChain').then(m => ({ default: m.V1OptionChain })));
const V1FnOSignals          = React.lazy(() => import('./V1FnOSignals').then(m => ({ default: m.V1FnOSignals })));

// Extracted from App.tsx (2026-08-02 perf pass) so it's lazy-loaded instead of always
// bundled into the main entry chunk -- this is the largest single inline component (~770
// lines) that was always eagerly loaded even for users who never open a stock-detail page.
export const V1StockDetails: React.FC<{
  symbol: string;
  stock?: MarketData;
  onBack: () => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
  onSelectStock: (symbol: string) => void;
}> = ({ symbol, stock: initialStock, onBack, watchlist, onToggleWatchlist, onSelectStock }) => {
  const allNews = useNewsFeed();
  const news = useMemo(
    () => allNews.filter(n => n.relatedSymbols?.includes(symbol)),
    [allNews, symbol],
  );
  const [activeTab, setActiveTab] = useState('insights');
  const [report, setReport] = useState<any>(null);
  const { data: unifiedData } = trpc.getAlphaQuantDetail.useQuery({ symbol });
  // AI Insights tab -- ported from v2's V2StockDetails (2026-08-20 v1 consolidation).
  const { data: aiInsights } = trpc.getAiInsights.useQuery({ symbol });
  const { data: profileAnalysis } = trpc.getCompanyProfileAnalysis.useQuery({ symbol });
  // Fixed 2026-07-30 (Finding #89, full-stack audit): the "Technical Scorecard" sidebar
  // below used to hardcode RSI/MACD/Bollinger/pivot points -- directly contradicting the
  // real values on this same page's Technical tab (TechnicalAnalysis component, which
  // already fetches this exact query). Reused rather than duplicated.
  const { data: tech } = trpc.getTechnicalDetails.useQuery({ symbol, dur: 'D' });
  // Fixed 2026-07-30 (Finding #90, full-stack audit): the "Institutional Flow (FII/DII)"
  // card in the F&O tab below used to hardcode +₹4,250 Cr / -₹1,120 Cr and a permanently
  // static "15 mins ago" timestamp for every stock, every session. This is market-wide
  // (not per-stock) FII/DII net flow -- the closest real data this platform has for that
  // card, and what the audit itself points at (getFiiDiiFlow/getInstitutionalFlows).
  // Standardized on days:10 (2026-08-02 perf pass, see the flowSeries call above) so this
  // dedupes with every other getFiiDiiFlow caller sharing the same query key -- only the
  // latest row (fiiDiiFlow?.[0]) is actually used below.
  const { data: fiiDiiFlow } = trpc.getFiiDiiFlow.useQuery({ days: 10 });

  // Resolve MC symbol (scId) from stocklist mapping for MoneyControl API calls
  const stockMapping = _stockDataMap.get(symbol.toUpperCase());
  const mcScId = stockMapping?.mcsymbol || symbol;

  // Fetch stock data if it wasn't provided in the initial props
  const { data: liveStock, isLoading, isError } = trpc.getLiveStockQuote.useQuery(
    { symbol },
    { enabled: !initialStock, refetchInterval: 30000, retry: 1 }
  );

  const stock = initialStock || liveStock;

  // Fallback name/sector from NSE master list when live data is unavailable
  const nseEntry = !stock ? (_nseSymbolMap.get(symbol) ?? null) : null;
  const displayName = stock?.name ?? nseEntry?.name ?? symbol;

  const reportMutation = trpc.generateTrendReport.useMutation({
    onSuccess: (data) => {
      setReport(data);
    }
  });

  const [aiAnalysis, setAiAnalysis] = useState<any>(null);
  const aiAnalysisMutation = trpc.getAIAnalysis.useMutation({
    onSuccess: (data) => setAiAnalysis(data),
  });

  // Auto-run AI analysis once stock data is available, run only once per symbol
  React.useEffect(() => {
    if (!stock || aiAnalysis || aiAnalysisMutation.isPending) return;
    aiAnalysisMutation.mutate({
      symbol,
      data: {
        price: stock.price,
        change: stock.change,
        changePct: stock.changePct,
        volume: stock.volume,
        high: stock.high,
        low: stock.low,
        name: stock.name,
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock?.price, symbol]);

  // Real OHLCV chart data (Finding #75, 2026-07-28 audit): this used to generate 40
  // Math.random() candles and run real pattern-detection/support-resistance logic on top of
  // them — a fabricated conclusion presented as real technical analysis. Now sourced from
  // getOHLCData (the same procedure v4's StockIntelligencePage already uses correctly).
  // VWAP/Bollinger bands are computed the same way the old code did, just from real OHLCV.
  const { data: ohlcResp } = trpc.getOHLCData.useQuery({ symbol, dur: '3m' });
  const chartData = useMemo(() => {
    const rows: any[] = (ohlcResp as any)?.data ?? [];
    const BOLL_WINDOW = 20;
    return rows.map((r: any, i: number) => {
      const open = Number(r.open), high = Number(r.high), low = Number(r.low), close = Number(r.close);
      const volume = Number(r.volume) || 0;
      const windowRows = rows.slice(Math.max(0, i - BOLL_WINDOW + 1), i + 1);
      const windowVol = windowRows.reduce((s: number, x: any) => s + (Number(x.volume) || 0), 0);
      const vwap = windowVol > 0
        ? windowRows.reduce((s: number, x: any) =>
            s + ((Number(x.high) + Number(x.low) + Number(x.close)) / 3) * (Number(x.volume) || 0), 0) / windowVol
        : (high + low + close) / 3;
      const windowCloses = windowRows.map((x: any) => Number(x.close));
      const mean = windowCloses.reduce((s: number, v: number) => s + v, 0) / windowCloses.length;
      const stdDev = Math.sqrt(windowCloses.reduce((s: number, v: number) => s + (v - mean) ** 2, 0) / windowCloses.length);
      return {
        time: r.time, open, high, low, close, price: close, volume,
        vwap,
        bollinger: [mean - 2 * stdDev, mean + 2 * stdDev],
      };
    });
  }, [ohlcResp]);

  const patterns = React.useMemo(() => {
    const candles = chartData.map(d => ({
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      timestamp: d.time
    }));
    return detectCandlestickPatterns(candles);
  }, [chartData]);

  const levels = React.useMemo(() => {
    if (!chartData.length) return { support: 0, resistance: 0 };
    const prices = chartData.map(d => d.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min;

    // Simple logic for robust levels
    return {
      support: min + range * 0.1,
      resistance: max - range * 0.1,
      min,
      max
    };
  }, [chartData]);

  // Full-page loading while fetching live quote
  if (!initialStock && isLoading) {
    return (
      <div className="p-20 text-center">
        <button onClick={onBack} className="mb-8 p-2 glass border border-slate-800/50 rounded-xl text-slate-400 hover:text-white transition-all inline-block">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="text-2xl font-black text-white italic tracking-tighter uppercase mb-2">{symbol}</div>
        <div className="animate-pulse text-slate-400 text-sm">Loading live data...</div>
      </div>
    );
  }

  const priceLoading = !stock && !isError && isLoading;
  const priceUnavailable = !stock && (isError || (!isLoading && !initialStock));

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="p-2 glass border border-slate-800/50 rounded-xl text-slate-400 hover:text-white transition-all"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-black text-white italic tracking-tighter uppercase">{symbol}</h1>
              {priceLoading
                ? <div className="h-6 w-40 bg-slate-800 rounded animate-pulse" />
                : <span className="text-slate-400 font-bold text-sm glass px-3 py-1 rounded-lg border border-slate-800/50">{displayName}</span>
              }
              <button
                onClick={() => onToggleWatchlist(symbol)}
                className={cn(
                  "p-2 rounded-xl border transition-all",
                  watchlist.includes(symbol) ? "bg-amber-500/10 border-amber-500/20 text-amber-500" : "glass border-slate-800/50 text-slate-400 hover:text-slate-400"
                )}
              >
                <WatchlistIcon className={cn("w-5 h-5", watchlist.includes(symbol) && "fill-amber-500")} />
              </button>
            </div>
            <div className="flex items-center gap-3 mt-1">
              {priceLoading
                ? <div className="h-7 w-32 bg-slate-800 rounded animate-pulse" />
                : priceUnavailable
                  ? <span className="text-sm text-slate-400 italic">Live price unavailable</span>
                  : <>
                      <span className="text-2xl font-black text-white tabular-nums">₹{stock?.price?.toLocaleString() ?? '—'}</span>
                      <span className={cn(
                        "font-bold text-sm flex items-center gap-1",
                        stock?.changePct == null ? "text-slate-400" : stock.changePct >= 0 ? "text-emerald-400" : "text-rose-400"
                      )}>
                        {stock?.changePct != null && (stock.changePct >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />)}
                        {stock?.changePct == null ? '—' : `${stock.changePct >= 0 ? '+' : ''}${stock.changePct}%`}
                      </span>
                    </>
              }
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <button className="flex-1 md:flex-none bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-3 rounded-2xl font-black text-sm transition-all shadow-[0_10px_20px_rgba(37,99,235,0.2)] font-display uppercase tracking-widest">
            Invest Now
          </button>
          <button className="p-3 glass border border-slate-800/50 rounded-2xl text-slate-400 hover:text-white transition-all">
            <Heart className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-800/50 pb-px overflow-x-auto hide-scrollbar">
        {[
          { id: 'insights', label: 'Overview' },
          { id: 'ai-insights', label: 'AI Insights' },
          { id: 'technicals', label: 'Technical' },
          { id: 'fundamentals', label: 'Fundamental' },
          { id: 'financials', label: 'Financials' },
          { id: 'peers', label: 'Peers' },
          { id: 'analysis', label: 'Analysis' },
          { id: 'mf', label: 'MF Insights' },
          { id: 'fno', label: 'F&O Insights' },
          { id: 'trendlyne', label: 'Trendlyne' },
          { id: 'news', label: 'News Feed' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "px-6 py-3 text-[10px] font-black font-display uppercase tracking-widest transition-all whitespace-nowrap border-b-2",
              activeTab === tab.id ? "border-indigo-500 text-indigo-500" : "border-transparent text-slate-400 hover:text-white"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Main Content Area */}
        <div className="col-span-12 lg:col-span-8 space-y-6">
          {activeTab === 'insights' && (
            <div className="space-y-6">
              <MCErrorBoundary>
                <MCStockInfoPanel symbol={symbol} scId={mcScId} section="overview" onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />
              </MCErrorBoundary>

              {/* Real-time Candlestick Pattern Recognition */}
              {patterns.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-4 glass-strong border border-indigo-500/20 rounded-2xl relative overflow-hidden"
                >
                  <div className="absolute top-0 right-0 p-3 opacity-10">
                    <Activity className="w-16 h-16 text-indigo-500" />
                  </div>
                  <div className="relative z-10 flex items-start gap-4">
                    <div className="p-3 bg-indigo-500/10 rounded-xl">
                      <Zap className="w-5 h-5 text-indigo-400" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-black text-indigo-400 font-display uppercase tracking-widest">AI Pattern Recognition Engine</span>
                        <div className="flex gap-1">
                           <div className="w-1 h-1 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                           <div className="w-1 h-1 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '200ms' }} />
                           <div className="w-1 h-1 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '400ms' }} />
                        </div>
                      </div>
                      <h4 className="text-lg font-black text-white italic tracking-tighter uppercase">
                        Current Pattern: {patterns[patterns.length - 1].name}
                      </h4>
                      <p className="text-xs text-slate-400 font-medium italic mt-1 leading-relaxed">
                        {patterns[patterns.length - 1].description}
                      </p>
                      <div className="flex items-center gap-4 mt-3">
                         <div className="flex items-center gap-1.5">
                            <span className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest">Sentiment:</span>
                            <span className={cn(
                              "text-[9px] font-black uppercase px-2 py-0.5 rounded",
                              patterns[patterns.length - 1].sentiment === 'bullish' ? "bg-emerald-500/10 text-emerald-400" :
                              patterns[patterns.length - 1].sentiment === 'bearish' ? "bg-rose-500/10 text-rose-400" : "bg-slate-800 text-slate-400"
                            )}>
                              {patterns[patterns.length - 1].sentiment}
                            </span>
                         </div>
                         <div className="flex items-center gap-1.5">
                            <span className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest">Confidence:</span>
                            <span className="text-[9px] font-black text-white uppercase">{patterns[patterns.length - 1].confidence}</span>
                         </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}

              <Card title="Market Sentiment Summary" icon={Info}>
                   <div className="space-y-4">
                      <p className="text-xs text-slate-400 leading-relaxed italic">
                        {stock?.name ?? displayName} is currently showing a {stock?.changePct == null ? 'neutral' : stock.changePct > 0 ? 'bullish' : 'bearish'} bias. The technical rating stands at <span className="text-slate-200 font-bold">{(unifiedData as any)?.technicalRating?.text || 'Neutral'}</span> with high institutional interest observed in recent sessions.
                      </p>
                      <div className="flex gap-4">
                         <div className="flex-1 p-3 glass-strong rounded-xl border border-slate-800/50">
                            <span className="text-[8px] font-black text-slate-400 uppercase block mb-1">52W High</span>
                            <span className="text-xs font-bold text-white">{stock?.high52w ? `₹${stock.high52w}` : '—'}</span>
                         </div>
                         <div className="flex-1 p-3 glass-strong rounded-xl border border-slate-800/50">
                            <span className="text-[8px] font-black text-slate-400 uppercase block mb-1">52W Low</span>
                            <span className="text-xs font-bold text-white">{stock?.low52w ? `₹${stock.low52w}` : '—'}</span>
                         </div>
                      </div>
                   </div>
                </Card>

              {/* AI Analyst Report Component */}
              <div className="mt-8">
                 <Card title="AI Strategic Analyst Report" icon={Zap} className="border-indigo-500/20">
                    {!report ? (
                      <div className="py-12 flex flex-col items-center justify-center text-center">
                        <div className="w-16 h-16 bg-indigo-500/10 rounded-full flex items-center justify-center mb-4">
                          <Activity className="w-8 h-8 text-indigo-500 animate-pulse" />
                        </div>
                        <h4 className="text-lg font-black text-white italic uppercase tracking-tighter mb-2">Detailed Report Not Generated</h4>
                        <p className="text-slate-400 text-xs max-w-md mb-6 uppercase font-bold tracking-widest leading-loose">
                          Harness the power of Bharat Stock AI to generate a high-fidelity intelligence report including fundamental analysis, technical positioning, and risk scoring.
                        </p>
                        <button
                          onClick={() => reportMutation.mutate({ symbol })}
                          disabled={reportMutation.isPending}
                          className={cn(
                            "px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-2xl transition-all shadow-lg flex items-center gap-2 uppercase text-xs tracking-widest",
                            reportMutation.isPending && "opacity-50 cursor-not-allowed"
                          )}
                        >
                          {reportMutation.isPending ? <Activity className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                          {reportMutation.isPending ? 'Generating Intelligence...' : 'Generate AI Report'}
                        </button>
                      </div>
                    ) : (
                      <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="space-y-8"
                      >
                        <div className="flex flex-col md:flex-row justify-between items-start gap-4 pb-6 border-b border-slate-800/50">
                          <div>
                            <h3 className="text-2xl font-black text-white italic tracking-tighter uppercase mb-1">{report.title}</h3>
                            <div className="flex items-center gap-4">
                              <span className="text-[10px] font-black text-indigo-500 font-display uppercase tracking-widest flex items-center gap-1">
                                <Bookmark className="w-3 h-3" />
                                Institutional Grade
                              </span>
                              <span className="text-[10px] font-bold text-slate-400 font-display uppercase tracking-widest">
                                Timestamp: {report.generatedAt ? format(new Date(report.generatedAt), 'MMM dd, yyyy HH:mm') : 'Live'}
                              </span>
                            </div>
                          </div>
                          <div className={cn(
                            "px-4 py-2 rounded-xl border flex items-center gap-3",
                            report.outlook === 'BULLISH' ? "bg-emerald-500/10 border-emerald-500/20" : "bg-rose-500/10 border-rose-500/20"
                          )}>
                             <div className="text-right">
                               <p className="text-[8px] font-black text-slate-400 font-display uppercase tracking-widest">Overall Outlook</p>
                               <p className={cn(
                                 "text-sm font-black italic",
                                 report.outlook === 'BULLISH' ? "text-emerald-400" : "text-rose-400"
                               )}>{report.outlook}</p>
                             </div>
                             {report.outlook === 'BULLISH' ? <TrendingUp className="text-emerald-400 w-5 h-5" /> : <TrendingDown className="text-rose-400 w-5 h-5" />}
                          </div>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                           <div className="lg:col-span-2 space-y-6">
                              <div>
                                <h5 className="text-[11px] font-black text-slate-300 font-display uppercase tracking-widest border-l-2 border-indigo-500 pl-3 mb-3">Executive Summary</h5>
                                <p className="text-sm text-slate-400 leading-relaxed italic font-medium">
                                  {report.summary}
                                </p>
                              </div>

                              <div>
                                <h5 className="text-[11px] font-black text-slate-300 font-display uppercase tracking-widest border-l-2 border-pink-500 pl-3 mb-3">Investment Thesis</h5>
                                <div className="p-5 glass-strong rounded-2xl border border-slate-800/50 relative overflow-hidden">
                                  <div className="absolute top-0 right-0 p-4 opacity-5">
                                    <Activity className="w-24 h-24 text-slate-400" />
                                  </div>
                                  <p className="text-sm text-slate-300 leading-relaxed font-medium italic relative z-10">
                                    {report.investmentThesis}
                                  </p>
                                </div>
                              </div>
                           </div>

                           <div className="space-y-6">
                              <div>
                                <h5 className="text-[11px] font-black text-slate-300 font-display uppercase tracking-widest border-l-2 border-rose-500 pl-3 mb-3">Risk Assessment</h5>
                                <div className="space-y-3">
                                  {report.riskFactors.map((risk: string, i: number) => (
                                    <div key={i} className="flex gap-3 p-3 glass-strong rounded-xl border border-rose-500/10 group hover:border-rose-500/20 transition-all">
                                      <AlertCircle className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5" />
                                      <p className="text-[11px] text-slate-400 font-bold leading-snug">{risk}</p>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              <div className="p-4 bg-indigo-500/5 border border-indigo-500/10 rounded-2xl">
                                <h6 className="text-[10px] font-black text-indigo-400 font-display uppercase tracking-widest mb-2 flex items-center gap-2">
                                  <Zap className="w-3 h-3 fill-indigo-400" />
                                  AI Probability Core
                                </h6>
                                <p className="text-[10px] text-slate-400 font-bold leading-relaxed">
                                  {typeof unifiedData?.score?.confidence === 'number'
                                    ? `Our quant scoring engine holds ${unifiedData.score.confidence.toFixed(1)}% confidence in the current ${report.outlook.toLowerCase()} classification, based on the technical, fundamental, momentum, valuation and delivery factor blend.`
                                    : `Quant confidence for this classification is not yet available for ${symbol}.`}
                                </p>
                              </div>
                           </div>
                        </div>
                      </motion.div>
                    )}
                 </Card>
              </div>
            </div>
          )}

          {activeTab === 'technicals' && (
            <div className="space-y-6">
              <Card title="Interactive Technical Chart" icon={Activity}>
                <div className="flex gap-4 mb-6 overflow-x-auto pb-2 hide-scrollbar">
                    {['1m', '5m', '15m', '1H', '1D', '1W'].map(tf => (
                      <button key={tf} className={cn(
                        "px-4 py-1.5 rounded-lg text-[10px] font-black font-display uppercase tracking-widest transition-all border",
                        tf === '15m' ? "bg-indigo-600 border-indigo-600 text-white" : "glass-strong border-slate-800/50 text-slate-400 hover:text-white"
                      )}>
                        {tf}
                      </button>
                    ))}
                </div>

                <div className="h-[400px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={chartData}>
                        <defs>
                          <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.1}/>
                            <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                        <XAxis dataKey="time" hide />
                        <YAxis hide domain={['auto', 'auto']} />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5)' }}
                          itemStyle={{ fontSize: '10px', fontWeight: '900', textTransform: 'uppercase' }}
                          labelStyle={{ color: '#64748b', fontSize: '10px', fontWeight: 'bold', marginBottom: '4px' }}
                          content={({ active, payload }) => {
                            if (active && payload && payload.length) {
                              const data = payload[0].payload;
                              return (
                                <div className="glass-strong border border-slate-800/50 p-3 rounded-xl shadow-2xl backdrop-blur-md">
                                  <p className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest mb-2 border-b border-slate-800/50 pb-1">{data.time}</p>
                                  <div className="space-y-1.5">
                                    <div className="flex justify-between gap-4">
                                      <span className="text-[10px] font-bold text-slate-400">O:</span>
                                      <span className="text-[10px] font-black text-white">₹{data.open.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                      <span className="text-[10px] font-bold text-slate-400">H:</span>
                                      <span className="text-[10px] font-black text-emerald-400">₹{data.high.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                      <span className="text-[10px] font-bold text-slate-400">L:</span>
                                      <span className="text-[10px] font-black text-rose-400">₹{data.low.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                      <span className="text-[10px] font-bold text-slate-400">C:</span>
                                      <span className="text-[10px] font-black text-white">₹{data.close.toFixed(2)}</span>
                                    </div>
                                  </div>
                                </div>
                              );
                            }
                            return null;
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="bollinger"
                          stroke="none"
                          fill="#6366f1"
                          fillOpacity={0.05}
                          name="Volatility Band"
                        />
                        <Bar
                          dataKey="price"
                          fill="#6366f1"
                          opacity={0.1}
                          barSize={2}
                        />
                        <Line type="monotone" dataKey="price" stroke="#fff" strokeWidth={2} dot={false} name="Price" activeDot={{ r: 4, fill: '#6366f1', stroke: '#fff', strokeWidth: 2 }} />
                        <Line type="monotone" dataKey="vwap" stroke="#ec4899" strokeWidth={1} dot={false} name="VWAP" strokeDasharray="3 3" />

                        <ReferenceLine
                          y={levels.resistance}
                          stroke="#f43f5e"
                          strokeWidth={1.5}
                          strokeDasharray="4 4"
                        />
                        <ReferenceLine
                          y={levels.support}
                          stroke="#10b981"
                          strokeWidth={1.5}
                          strokeDasharray="4 4"
                        />

                        {patterns.length > 0 && patterns[patterns.length - 1].sentiment !== 'neutral' && (
                          <ReferenceArea
                            {...({
                              x1: chartData[chartData.length - 3].time,
                              x2: chartData[chartData.length - 1].time,
                              fill: patterns[patterns.length - 1].sentiment === 'bullish' ? '#10b981' : '#f43f5e',
                              fillOpacity: 0.08,
                              stroke: patterns[patterns.length - 1].sentiment === 'bullish' ? '#10b981' : '#f43f5e',
                              strokeOpacity: 0.2,
                              strokeDasharray: "3 3"
                            } as any)}
                          />
                        )}
                      </ComposedChart>
                    </ResponsiveContainer>
                </div>
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <V1PeadConcallWidget symbol={symbol} />
                <V1TradeRiskCalculatorWidget initialEntry={initialStock?.price ?? 1000} symbol={symbol} />
              </div>

              <React.Suspense fallback={<PageFallback />}><V1TechnicalAnalysis symbol={symbol} /></React.Suspense>
              <MCErrorBoundary>
                <MCStockInfoPanel symbol={symbol} scId={mcScId} section="technical" onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />
              </MCErrorBoundary>
            </div>
          )}
          {activeTab === 'ai-insights' && (
            <div className="space-y-6">
              {profileAnalysis && (
                <div className="v1-card p-5">
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
                    <span className="text-xs text-slate-400 font-display uppercase tracking-wide">Growth Score</span>
                    <div className="flex-1 bg-slate-900 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-gradient-to-r from-emerald-600 to-emerald-400 h-full rounded-full transition-all duration-1000"
                        style={{ width: `${(profileAnalysis as any).growth_score}%` }}
                      />
                    </div>
                    <span className="text-xs font-data text-emerald-400">{(profileAnalysis as any).growth_score}/100</span>
                  </div>
                </div>
              )}
              <AiInsightsTab insights={aiInsights} />
            </div>
          )}
          {activeTab === 'fundamentals' && (
            <div className="space-y-6">
              <React.Suspense fallback={<PageFallback />}><V1FundamentalInsights symbol={symbol} /></React.Suspense>
            </div>
          )}
          {activeTab === 'financials' && (
            <div className="space-y-6">
               <MCErrorBoundary>
                 <MCStockInfoPanel symbol={symbol} scId={mcScId} section="fundamental" onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />
               </MCErrorBoundary>
            </div>
          )}
          {activeTab === 'peers' && (
            <div className="space-y-6">
               <MCErrorBoundary>
                 <MCStockInfoPanel symbol={symbol} scId={mcScId} section="peers" onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />
               </MCErrorBoundary>
               <FinologyPanel symbol={symbol} />
            </div>
          )}

          {activeTab === 'analysis' && (
            <div className="space-y-6">
               <MCErrorBoundary>
                 <MCStockInfoPanel symbol={symbol} scId={mcScId} section="insights" onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />
               </MCErrorBoundary>
            </div>
          )}
          {activeTab === 'mf' && <React.Suspense fallback={<PageFallback />}><V1MFAnalysis symbol={symbol} /></React.Suspense>}
          {activeTab === 'news' && <React.Suspense fallback={<PageFallback />}><V1NewsTab symbol={symbol} /></React.Suspense>}

          {activeTab === 'trendlyne' && (
            <div className="space-y-6">
               <MCErrorBoundary>
                 <MCStockInfoPanel symbol={symbol} scId={mcScId} section="trendlyne" onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />
               </MCErrorBoundary>
            </div>
          )}

          {activeTab === 'fno' && (
            <div className="space-y-6">
               <React.Suspense fallback={<PageFallback />}>
                 <V1OptionChain symbol={symbol} stockPrice={stock?.price ?? 0} />
                 <V1FnOSignals symbol={symbol} />
               </React.Suspense>

               <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Card title="Market-Wide Institutional Flow (FII/DII)" icon={TrendingUp}>
                     <div className="space-y-4">
                        {(() => {
                          const latest = Array.isArray(fiiDiiFlow) && fiiDiiFlow.length > 0 ? fiiDiiFlow[0] as any : null;
                          const fmtCr = (n: number | null | undefined) =>
                            n == null ? '—' : `${n >= 0 ? '+' : ''}₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;
                          return (
                            <>
                              <div className="flex justify-between items-center p-3 glass-strong rounded-xl border border-slate-800/50">
                                 <span className="text-xs font-bold text-slate-400">Net FII Position</span>
                                 <span className={cn("font-black", latest?.fii_net == null ? "text-slate-400" : latest.fii_net >= 0 ? "text-emerald-400" : "text-rose-400")}>
                                   {fmtCr(latest?.fii_net)}
                                 </span>
                              </div>
                              <div className="flex justify-between items-center p-3 glass-strong rounded-xl border border-slate-800/50">
                                 <span className="text-xs font-bold text-slate-400">DII Activity</span>
                                 <span className={cn("font-black", latest?.dii_net == null ? "text-slate-400" : latest.dii_net >= 0 ? "text-emerald-400" : "text-rose-400")}>
                                   {fmtCr(latest?.dii_net)}
                                 </span>
                              </div>
                              <p className="text-[9px] text-slate-400 italic text-center font-display uppercase tracking-widest mt-2 font-bold">
                                {latest?.date ? `As of ${latest.date}` : 'No flow data captured yet'}
                              </p>
                            </>
                          );
                        })()}
                     </div>
                  </Card>
               </div>
            </div>
          )}

          {/* Other tabs can be implemented similarly */}
          {activeTab !== 'insights' && activeTab !== 'ai-insights' && activeTab !== 'fno' && activeTab !== 'technicals' && activeTab !== 'fundamentals' && activeTab !== 'financials' && activeTab !== 'peers' && activeTab !== 'mf' && activeTab !== 'news' && activeTab !== 'mc' && activeTab !== 'trendlyne' && (
            <div className="flex flex-col items-center justify-center py-20 glass-strong rounded-2xl border border-slate-800/50 border-dashed">
               <Activity className="w-12 h-12 text-slate-200 animate-pulse mb-4" />
               <h3 className="text-slate-400 font-black text-lg uppercase tracking-tighter italic">Coming to Bharat Stock Pro</h3>
               <p className="text-slate-400 text-[10px] uppercase font-bold tracking-widest mt-2">{activeTab} section under maintenance</p>
            </div>
          )}        </div>

        {/* Sidebar Insights */}
        <div className="col-span-12 lg:col-span-4 space-y-6">
          <Card title="Technical Scorecard" icon={Activity}>
             <div className="space-y-6 pt-2">
                {(() => {
                  // Fixed 2026-07-30 (Finding #89): all values below now come from the same
                  // getTechnicalDetails query the Technical tab (TechnicalAnalysis component)
                  // already renders correctly two tabs over.
                  const techIndicators = (tech as any)?.data?.indicators ?? [];
                  const rsiInd = techIndicators.find((i: any) => i.displayName?.includes('RSI'));
                  const macdInd = techIndicators.find((i: any) => i.displayName?.includes('MACD'));
                  const bbInd = techIndicators.find((i: any) => i.displayName?.includes('Bollinger'));
                  const rsiVal = rsiInd ? parseFloat(rsiInd.value) : null;
                  const rsiPct = rsiVal != null && !isNaN(rsiVal) ? Math.min(100, Math.max(0, rsiVal)) : null;
                  const classicPivot = (tech as any)?.data?.pivotLevels?.find((p: any) => p.key === 'Classic')?.pivotLevel;

                  return (
                    <>
                      <div>
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest">RSI (14)</span>
                          <span className="text-amber-400 font-bold text-xs uppercase tracking-tighter">
                            {rsiInd ? `${rsiInd.indication} (${rsiVal})` : '—'}
                          </span>
                        </div>
                        <div className="w-full h-2 glass-strong rounded-full relative overflow-hidden border border-slate-800/50">
                          <div className="absolute inset-y-0 left-[30%] right-[70%] bg-indigo-500/10 border-x border-indigo-500/20" />
                          {rsiPct != null && (
                            <div className="absolute top-0 h-full w-1 bg-amber-400" style={{ left: `${rsiPct}%` }} />
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="p-3 glass-strong rounded-xl border border-slate-800/50">
                          <p className="text-[8px] font-black text-slate-400 font-display uppercase tracking-widest mb-1">MACD</p>
                          <p className={cn("text-xs font-bold italic", macdInd?.indication === 'Bullish' ? "text-emerald-400" : macdInd?.indication === 'Bearish' ? "text-rose-400" : "text-slate-300")}>
                            {macdInd ? macdInd.indication : '—'}
                          </p>
                        </div>
                        <div className="p-3 glass-strong rounded-xl border border-slate-800/50">
                          <p className="text-[8px] font-black text-slate-400 font-display uppercase tracking-widest mb-1">Bollinger</p>
                          <p className="text-xs font-bold text-slate-300 italic">{bbInd ? bbInd.indication : '—'}</p>
                        </div>
                      </div>

                      <div className="space-y-2">
                         <p className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest pl-1">Pivot Points (Classic)</p>
                         <div className="space-y-1">
                            {[
                              { label: 'R2', val: classicPivot?.r2, color: 'text-emerald-400' },
                              { label: 'R1', val: classicPivot?.r1, color: 'text-emerald-500' },
                              { label: 'PP', val: classicPivot?.pivotPoint, color: 'text-white' },
                              { label: 'S1', val: classicPivot?.s1, color: 'text-rose-500' },
                              { label: 'S2', val: classicPivot?.s2, color: 'text-rose-400' },
                            ].map(p => {
                               const displayVal = typeof p.val === 'number' ? `₹${p.val.toFixed(2)}` : '—';
                               return (
                                 <div key={p.label} className="flex justify-between items-center px-4 py-2 glass-strong rounded-lg border border-slate-800/30">
                                    <span className={cn("text-[9px] font-black font-display uppercase tracking-widest", p.color)}>{p.label}</span>
                                    <span className="text-xs font-bold tabular-nums text-slate-300">{displayVal}</span>
                                 </div>
                               );
                             })}
                         </div>
                      </div>
                    </>
                  );
                })()}

                <div className="pt-2">
                  {aiAnalysisMutation.isPending ? (
                    <div className="p-4 glass-strong border border-indigo-500/20 rounded-xl space-y-2 animate-pulse">
                      <div className="flex items-center gap-2">
                        <Activity className="w-4 h-4 text-indigo-400 animate-spin" />
                        <span className="text-[10px] font-black text-indigo-400 font-display uppercase tracking-widest">AI Analysing...</span>
                      </div>
                      <div className="h-2 bg-slate-800 rounded w-3/4" />
                      <div className="h-2 bg-slate-800 rounded w-1/2" />
                    </div>
                  ) : aiAnalysis && !aiAnalysis.error ? (
                    <div className="p-4 glass-strong border border-indigo-500/30 rounded-xl space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[9px] font-black text-indigo-400 font-display uppercase tracking-widest flex items-center gap-1">
                          <BrainCircuit className="w-3 h-3" /> AI Signal
                        </span>
                        <span className={cn(
                          "text-[10px] font-black uppercase px-2 py-0.5 rounded",
                          aiAnalysis.signal === 'BUY' ? "bg-emerald-500/10 text-emerald-400" :
                          aiAnalysis.signal === 'SELL' ? "bg-rose-500/10 text-rose-400" : "bg-amber-500/10 text-amber-400"
                        )}>{aiAnalysis.signal}</span>
                      </div>
                      <div className="grid grid-cols-3 gap-1.5 text-center">
                        {[
                          { label: 'Entry', val: aiAnalysis.entry, color: 'text-indigo-400' },
                          { label: 'Target', val: aiAnalysis.target, color: 'text-emerald-400' },
                          { label: 'SL', val: aiAnalysis.stopLoss, color: 'text-rose-400' },
                        ].map(({ label, val, color }) => (
                          <div key={label} className="p-1.5 bg-slate-900/60 rounded-lg">
                            <p className="text-[8px] font-black text-slate-400 uppercase mb-0.5">{label}</p>
                            <p className={cn("text-[10px] font-black tabular-nums", color)}>₹{val?.toFixed(1)}</p>
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[8px] font-black text-slate-400 uppercase">Confidence</span>
                        <div className="flex-1 bg-slate-900 rounded-full h-1.5 overflow-hidden">
                          <div className="bg-indigo-500 h-full rounded-full" style={{ width: `${aiAnalysis.confidence}%` }} />
                        </div>
                        <span className="text-[9px] font-black text-indigo-400">{aiAnalysis.confidence}%</span>
                      </div>
                      <p className="text-[10px] text-slate-400 leading-relaxed italic line-clamp-3">{aiAnalysis.reasoning}</p>
                    </div>
                  ) : (
                    <button
                      onClick={() => stock && aiAnalysisMutation.mutate({ symbol, data: { price: stock.price, change: stock.change, changePct: stock.changePct, volume: stock.volume, high: stock.high, low: stock.low, name: stock.name } })}
                      disabled={!stock}
                      className="w-full py-3 rounded-xl border font-black text-[10px] font-display uppercase tracking-widest transition-all bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-700 shadow-[0_5px_15px_rgba(37,99,235,0.3)] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Run AI Analysis
                    </button>
                  )}
                </div>
             </div>
          </Card>

          <Card title={`Latest ${symbol} News`} icon={Info}>
             <div className="space-y-4 max-h-[500px] overflow-y-auto pr-2 hide-scrollbar">
                {news.length > 0 ? news.map(item => (
                   <div key={item.id} className="group cursor-pointer">
                      <p className="text-[8px] font-bold text-slate-400 font-display uppercase tracking-widest mb-1">{item.time}</p>
                      <h4 className="text-xs font-bold text-slate-300 leading-snug group-hover:text-white transition-colors">
                        {item.title}
                      </h4>
                      <div className="mt-2 text-[9px] text-indigo-500 font-black uppercase tracking-tighter group-hover:underline">Read Full Insight</div>
                   </div>
                )) : (
                  <div className="text-center py-8">
                     <p className="text-[10px] text-slate-400 font-bold font-display uppercase tracking-widest italic">No specific news for {symbol}</p>
                  </div>
                )}
             </div>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default V1StockDetails;
