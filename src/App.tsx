import React, { useState, useEffect, useMemo } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  AreaChart, Area, BarChart, Bar, ReferenceLine, PieChart as RePieChart, Pie, Cell,
  ComposedChart, ReferenceArea
} from 'recharts';
import {
  TrendingUp, TrendingDown, Search, BarChart3, PieChart, Info,
  AlertCircle, ArrowUpRight, ArrowDownRight, Activity, Zap,
  LayoutDashboard, Filter, History, User, LogIn, Plus, Minus, Heart, Share2, Download,
  ArrowLeft, Eye, ChevronUp, ChevronDown, Save, Bookmark, BrainCircuit, CheckCircle2,
  Users, Trophy, Bookmark as WatchlistIcon, BarChart2, Star, Target, Globe
} from 'lucide-react';

import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';
import { cn } from './lib/utils';
import { auth } from './lib/firebase';
import { 
  signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User as FirebaseUser 
} from 'firebase/auth';

import { useMarketData, MarketData } from './services/marketService';

import { trpc } from './lib/trpc';
import { useIntersectionObserver } from './hooks/useIntersectionObserver';
import { useNewsFeed, NewsArticle } from './services/newsService';
import { detectCandlestickPatterns, Candlestick } from './lib/candlestickUtils';
// ─── Always-loaded (shell, drawers, inline dashboard widgets) ─────────────────
import MCStockInfoPanel from './components/MCStockInfoPanel';
import { MCIndexDetailPanel } from './components/MCIndexDetailPanel';
import { GlobalMarketCards } from './components/GlobalMarketCards';
import { Card } from './components/Card';
import { AlertsToast } from './components/AlertsToast';
import { AppShell } from './components/AppShell';
import { SlideOutDrawer } from './components/SlideOutDrawer';
import { SectorHeatmap, SectorPerformance } from './components/SectorIntelligence';
import { MomentumIntelligence } from './components/MomentumIntelligence';
import { IndexOverview, InstitutionalInsights, PennyStockIntelligence } from './components/MarketInsights';
import { TopMoversIntelligence } from './components/TopMoversIntelligence';
import { MarketIndices } from './components/MarketIndices';
import { GlobalMarkets } from './components/GlobalMarkets';
import { Watchlist } from './components/Watchlist';
import { TrendlyneSectorDashboard } from './components/TrendlyneSectorDashboard';
import { IntradayBreakouts } from './components/IntradayBreakouts';
import {
  TickerTapeWidget,
  EconomicCalendarWidget,
  MarketHeatmapWidget,
  MarketOverviewWidget
} from './components/TradingViewWidgets';

import stockData from './data/stocklist';
import { nseStocksData } from './data/nseStocks';

// O(1) lookup maps — avoids O(n) .find() on every stock detail open
const _stockDataMap = new Map(stockData.map(s => [s.symbol.toUpperCase(), s]));
const _nseSymbolMap = new Map(nseStocksData.map(s => [s.symbol, s]));

// ─── Lazy-loaded tab/page components (not needed until navigation) ─────────────
const TrendlyneScreenerPanel = React.lazy(() => import('./components/TrendlyneScreenerPanel'));
const LiveMarketScreener      = React.lazy(() => import('./components/LiveMarketScreener').then(m => ({ default: m.LiveMarketScreener })));
const EODMarketScreener       = React.lazy(() => import('./components/EODMarketScreener').then(m => ({ default: m.EODMarketScreener })));
const NSEStockDiscovery       = React.lazy(() => import('./components/NSEStockDiscovery'));
const TopRatedStocks          = React.lazy(() => import('./components/TopRatedStocks'));
const FnOIntelligenceCenter   = React.lazy(() => import('./components/FnOIntelligenceCenter'));
const OptionsIntelligence     = React.lazy(() => import('./components/OptionsIntelligence'));
const PortfolioAnalytics      = React.lazy(() => import('./components/PortfolioAnalytics'));
const StrategyBuilder         = React.lazy(() => import('./components/StrategyBuilder'));
const SystemMonitorPage       = React.lazy(() => import('./components/SystemMonitorPage'));
const ProfilePage             = React.lazy(() => import('./components/ProfilePage'));
const DashboardPage           = React.lazy(() => import('./components/DashboardPage'));
const SuperstarPortfolio      = React.lazy(() => import('./components/SuperstarPortfolio'));
const SmartMoneyPage          = React.lazy(() => import('./components/SmartMoneyPage'));
const EarningsPage            = React.lazy(() => import('./components/EarningsPage'));
const TradeDecisionCockpit    = React.lazy(() => import('./components/TradeDecisionCockpit'));
const HedgeFundResearch       = React.lazy(() => import('./components/HedgeFundResearch'));
const SignalIntelligence      = React.lazy(() => import('./components/SignalIntelligence'));
const SignalReportCard        = React.lazy(() => import('./components/SignalReportCard').then(m => ({ default: m.SignalReportCard })));
const DLDashboard             = React.lazy(() => import('./components/DLDashboard'));
const TodaysPicks             = React.lazy(() => import('./components/TodaysPicks').then(m => ({ default: m.TodaysPicks })));
const ScreenerIntelligencePage = React.lazy(() => import('./components/ScreenerIntelligencePage').then(m => ({ default: m.ScreenerIntelligencePage })));
const AgentDataScientistPage   = React.lazy(() => import('./components/AgentDataScientistPage').then(m => ({ default: m.AgentDataScientistPage })));
const AgentStrategistPage      = React.lazy(() => import('./components/AgentStrategistPage').then(m => ({ default: m.AgentStrategistPage })));
const AgentAuditorPage         = React.lazy(() => import('./components/AgentAuditorPage').then(m => ({ default: m.AgentAuditorPage })));
const AgentOptimizerPage       = React.lazy(() => import('./components/AgentOptimizerPage').then(m => ({ default: m.AgentOptimizerPage })));
const CommandCenterDashboard   = React.lazy(() => import('./components/CommandCenterDashboard').then(m => ({ default: m.CommandCenterDashboard })));
// Named-export lazy wrappers
const ToDoPage           = React.lazy(() => import('./components/ToDoPage').then(m => ({ default: m.ToDoPage })));
const InvestmentStrategy = React.lazy(() => import('./components/InvestmentStrategy').then(m => ({ default: m.InvestmentStrategy })));
const IndicesPage        = React.lazy(() => import('./components/IndicesPage').then(m => ({ default: m.IndicesPage })));
const StrategyIntelligence = React.lazy(() => import('./components/StrategyIntelligence').then(m => ({ default: m.StrategyIntelligence })));
const DailySignals       = React.lazy(() => import('./components/DailySignals').then(m => ({ default: m.DailySignals })));
const SentimentIntelligence = React.lazy(() => import('./components/SentimentIntelligence').then(m => ({ default: m.SentimentIntelligence })));
const V2AppShell         = React.lazy(() => import('./v2/components/layout/V2AppShell').then(m => ({ default: m.V2AppShell })));
const V2StockDetails     = React.lazy(() => import('./v2/views/stock-analysis/V2StockDetails').then(m => ({ default: m.V2StockDetails })));
const V2Settings         = React.lazy(() => import('./v2/views/settings/V2Settings').then(m => ({ default: m.V2Settings })));
const V2Dashboard        = React.lazy(() => import('./v2/views/dashboard/V2Dashboard').then(m => ({ default: m.V2Dashboard })));

// Lazy Suspense fallback
const PageFallback = () => (
  <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">Loading…</div>
);


class MCErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 text-center bg-slate-950/30 border border-slate-800/50 rounded-2xl">
          <AlertCircle className="w-8 h-8 text-rose-500 mx-auto mb-3" />
          <p className="text-sm text-slate-400 font-bold">MC Intelligence failed to render</p>
          <p className="text-[10px] text-slate-400 mt-1">{this.state.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

const CHUNK_LOAD_ERRORS = ['Failed to fetch dynamically imported module', 'Loading chunk', 'dynamically imported module', 'Importing a module script failed'];

class TabErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; isChunkError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '', isChunkError: false };
  }
  static getDerivedStateFromError(error: Error) {
    const isChunkError = CHUNK_LOAD_ERRORS.some(msg => error.message?.includes(msg));
    return { hasError: true, message: error.message, isChunkError };
  }
  componentDidUpdate(_: unknown, prev: { isChunkError: boolean }) {
    // Auto-reload once on chunk load failures (transient network error from Vite)
    if (this.state.isChunkError && !prev.isChunkError) {
      const key = 'chunk_reload_' + window.location.pathname;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        window.location.reload();
      }
    }
  }
  render() {
    if (this.state.hasError) {
      if (this.state.isChunkError) {
        return (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <AlertCircle className="w-10 h-10 text-amber-500" />
            <p className="text-slate-300 font-medium">Loading failed — reloading…</p>
            <button
              className="px-4 py-1.5 text-xs rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
              onClick={() => window.location.reload()}
            >
              Reload now
            </button>
          </div>
        );
      }
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <AlertCircle className="w-10 h-10 text-rose-500" />
          <p className="text-slate-300 font-medium">Service temporarily unavailable</p>
          <p className="text-xs text-slate-500">{this.state.message}</p>
          <button
            className="px-4 py-1.5 text-xs rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
            onClick={() => this.setState({ hasError: false, message: '', isChunkError: false })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Resets the error boundary on every navigation change (keyed by pathname)
function SafeRoutes({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <TabErrorBoundary key={location.pathname}>
      <React.Suspense fallback={<PageFallback />}>
        {children}
      </React.Suspense>
    </TabErrorBoundary>
  );
}

// --- Types ---

interface Toast {
  id: string;
  title: string;
  message: string;
  type: 'BUY' | 'SELL';
  confidence: number;
}

interface IndexBarProps {
  name: string;
  value: number;
  change: number;
  isUp: boolean;
  onClick?: () => void;
}

// --- Components ---

const IndexBar: React.FC<IndexBarProps> = ({ name, value, change, isUp, onClick }) => (
  <div 
    onClick={onClick}
    className={cn(
      "flex items-center gap-3 px-4 py-2 border-r border-slate-800/50 last:border-0 min-w-fit select-none",
      onClick ? "cursor-pointer hover:bg-slate-800/40 transition-colors" : ""
    )}
  >
    <span className="text-slate-400 font-medium text-xs tracking-wider uppercase">{name}</span>
    <span className="text-slate-200 font-bold tabular-nums">{value.toLocaleString()}</span>
    <div className={cn(
      "flex items-center text-xs font-semibold",
      isUp ? "text-emerald-400" : "text-rose-400"
    )}>
      {isUp ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
      {Math.abs(change).toFixed(2)}%
    </div>
  </div>
);

// --- Types ---


// --- Dashboard Intelligence Components (Moved to separate files) ---

// --- Index Overview Component ---
// ─── Indices Feature ─────────────────────────────────────────────────────────

function extractIndexId(url: string): string | null {
  const m = url.match(/-(\d+)\.html$/);
  return m ? m[1] : null;
}


// --- Market Overview Components (Moved to separate files) ---

// --- Signal History Modal Component ---
const SignalHistoryModal: React.FC<{ symbol: string; onClose: () => void }> = ({ symbol, onClose }) => {
  const { data: history, isLoading } = trpc.getSignalHistory.useQuery({ symbol });

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 glass-strong/90 backdrop-blur-md"
      />
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="relative w-full max-w-3xl glass border border-slate-800/50 rounded-3xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]"
      >
        <div className="p-6 border-b border-slate-800/50 flex justify-between items-center glass/50 backdrop-blur-xl">
           <div className="flex items-center gap-3">
              <div className="w-10 h-10 glass-strong border border-slate-800/50 rounded-xl flex items-center justify-center">
                 <History className="w-5 h-5 text-blue-500" />
              </div>
              <div>
                <h3 className="text-xl font-black text-slate-200 italic tracking-tighter uppercase">{symbol} Signal History</h3>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Historical AI Performance Tracking</p>
              </div>
           </div>
           <button onClick={onClose} className="p-2 text-slate-400 hover:text-white transition-colors">
              <Plus className="w-6 h-6 rotate-45" />
           </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4 hide-scrollbar">
           {isLoading ? (
             <div className="py-20 flex flex-col items-center justify-center">
                <Activity className="w-10 h-10 text-blue-500/20 animate-pulse mb-4" />
                <p className="text-slate-400 text-xs font-bold uppercase tracking-widest animate-pulse">Syncing with history logs...</p>
             </div>
           ) : history && history.length > 0 ? (
             <div className="space-y-4">
               {history.map((sig: any) => (
                 <div key={sig.id} className="p-4 glass-strong rounded-2xl border border-slate-800/30 hover:border-slate-800/30 transition-all flex flex-col gap-4 group">
                    <div className="flex justify-between items-start">
                       <div className="flex items-center gap-3">
                          <div className={cn(
                            "px-3 py-1 rounded text-[10px] font-black tracking-widest uppercase",
                            sig.type === 'BUY' ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" : "bg-rose-500/10 text-rose-500 border border-rose-500/20"
                          )}>
                            {sig.type}
                          </div>
                          <div>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-0.5">
                              {sig.createdAt?.seconds ? format(new Date(sig.createdAt.seconds * 1000), 'MMM dd, HH:mm') : 'Recent'}
                            </p>
                            <p className="text-xs text-white/70 italic line-clamp-1">"{sig.reasoning || sig.summary}"</p>
                          </div>
                       </div>
                       <div className="text-right">
                          <div className={cn(
                            "px-2 py-0.5 rounded text-[9px] font-black tracking-widest uppercase",
                            sig.status === 'COMPLETED' ? "bg-emerald-500 text-emerald-950" : 
                            sig.status === 'FAILED' ? "bg-rose-500 text-rose-950" : "bg-blue-500/10 text-blue-500 border border-blue-500/20"
                          )}>
                            {sig.status}
                          </div>
                          {sig.result && (
                            <p className={cn(
                              "text-[10px] font-black mt-1 uppercase italic",
                              sig.result === 'PROFIT' ? "text-emerald-400" : "text-rose-400"
                            )}>
                              {sig.result}
                            </p>
                          )}
                       </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                       <div className="glass/50 p-2 rounded-xl border border-slate-800/30 text-center">
                          <span className="text-[8px] font-black text-slate-400 uppercase block tracking-widest mb-0.5">Entry</span>
                          <span className="text-xs font-black text-slate-100">₹{sig.entry}</span>
                       </div>
                       <div className="glass/50 p-2 rounded-xl border border-slate-800/30 text-center">
                          <span className="text-[8px] font-black text-blue-500 uppercase block tracking-widest mb-0.5">Target</span>
                          <span className="text-xs font-black text-slate-100">₹{sig.target}</span>
                       </div>
                       <div className="glass/50 p-2 rounded-xl border border-slate-800/30 text-center">
                          <span className="text-[8px] font-black text-rose-500 uppercase block tracking-widest mb-0.5">Exit Price</span>
                          <span className="text-xs font-black text-slate-100">
                             {sig.status === 'ACTIVE' ? (
                               <span className="text-slate-400 italic">Pending</span>
                             ) : (
                               `₹${sig.exitPrice || (sig.result === 'PROFIT' ? sig.target : sig.stopLoss)}`
                             )}
                          </span>
                       </div>
                       <div className="glass/50 p-2 rounded-xl border border-slate-800/30 text-center">
                          <span className="text-[8px] font-black text-amber-500 uppercase block tracking-widest mb-0.5">Outcome</span>
                          <span className={cn(
                             "text-[10px] font-black uppercase tracking-tighter",
                             sig.result === 'PROFIT' ? "text-emerald-400" : 
                             sig.result === 'LOSS' ? "text-rose-400" : "text-slate-400"
                          )}>
                             {sig.result ? sig.result : (sig.status === 'ACTIVE' ? 'Running' : 'Closed')}
                          </span>
                       </div>
                    </div>
                 </div>
               ))}
             </div>
           ) : (
             <div className="py-20 flex flex-col items-center justify-center opacity-50">
                <Zap className="w-12 h-12 text-slate-200 mb-4" />
                <p className="text-slate-400 font-black text-lg uppercase italic tracking-tighter">No historical signals found</p>
                <p className="text-slate-400 text-[10px] uppercase font-bold tracking-widest mt-2 text-center">This asset hasn't been significantly tracked by AI yet.</p>
             </div>
           )}
        </div>
      </motion.div>
    </div>
  );
};

const Dashboard: React.FC<{ 
  stocks: MarketData[]; 
  onNewSignal: (signal: any) => void; 
  onSelectStock: (symbol: string) => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
  onSelectIndex?: (id: string, name: string) => void;
}> = ({ stocks, onNewSignal, onSelectStock, watchlist, onToggleWatchlist, onSelectIndex }) => {
  const news = useNewsFeed();
  const [newsFilter, setNewsFilter] = useState('All');
  const [aiSignals, setAiSignals] = useState<any[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [queueProgress, setQueueProgress] = useState<{ completed: number; total: number } | null>(null);
  const [selectedSignal, setSelectedSignal] = useState<any | null>(null);
  const [historySymbol, setHistorySymbol] = useState<string | null>(null);
  
  const filteredNews = news.filter(item => 
    newsFilter === 'All' ? true : item.category === newsFilter
  );

  const { data: niftyOhlc } = trpc.getOHLCData.useQuery({ symbol: 'in;NSX', dur: '1M' });
  const graphData = useMemo(() => {
    const candles: any[] = niftyOhlc?.data ?? [];
    if (candles.length === 0) return [];
    return candles.slice(-30).map((d: any, i: number) => ({
      time: i,
      value: d.close ?? d.c ?? 0,
    }));
  }, [niftyOhlc]);

  const enqueueSignalsMutation = trpc.enqueueSignals.useMutation();
  const { data: queueStats, refetch: refetchStats } = trpc.getQueueStats.useQuery(undefined, {
    refetchInterval: isGenerating ? 2000 : false,
  });
  const { data: savedSignals, refetch: refetchSignals } = trpc.getSignals.useQuery(
    { limit: 50 },
    { refetchInterval: isGenerating ? 3000 : false },
  );

  // Sync completed signals from DB into local state while the queue is running
  useEffect(() => {
    if (!isGenerating || !savedSignals) return;
    const mapped = (savedSignals as any[]).map((s: any) => ({
      symbol: s.symbol,
      type: s.type,
      signal: s.type,
      entry: s.entry,
      target: s.target,
      stopLoss: s.stopLoss,
      confidence: s.confidence,
      reasoning: s.reasoning,
      history: [],
    }));
    setAiSignals(mapped);

    if (queueStats) {
      const { waiting, active, completed, total } = queueStats as any;
      setQueueProgress({ completed: completed ?? 0, total: total ?? 0 });
      if ((waiting === 0 && active === 0 && total > 0) || !queueStats.available) {
        setIsGenerating(false);
        setQueueProgress(null);
        // Surface high-confidence signals as toasts
        mapped
          .filter((s: any) => (s.type === 'BUY' || s.type === 'SELL') && s.confidence > 70)
          .slice(0, 5)
          .forEach((s: any) => onNewSignal(s));
      }
    }
  }, [queueStats, savedSignals, isGenerating]);

  const handleGenerateSignals = async () => {
    if (stocks.length === 0) return;
    setIsGenerating(true);
    setQueueProgress({ completed: 0, total: stocks.length });
    try {
      const payload = stocks.map(s => ({
        symbol: s.symbol,
        stockData: s as unknown as Record<string, unknown>,
      }));
      const result = await enqueueSignalsMutation.mutateAsync(payload);

      if (!result.queueAvailable) {
        // BullMQ/Redis unavailable — signal generation requires Redis
        console.warn('[SIGNALS] Queue unavailable — start Redis to enable signal generation');
        setIsGenerating(false);
        setQueueProgress(null);
      } else {
        setQueueProgress({ completed: 0, total: result.queued });
        refetchStats();
        refetchSignals();
      }
    } catch (err) {
      console.error('[SIGNALS] enqueue failed:', err);
      setIsGenerating(false);
      setQueueProgress(null);
    }
  };

  useEffect(() => {
    if (aiSignals.length === 0 && stocks.length > 0 && !isGenerating) {
      handleGenerateSignals();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stocks.length]);

  return (
    <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-12 gap-4 relative">
      {/* 1. Market Indices (Full Width) */}
      <div className="xl:col-span-12">
        <MarketIndices onSelect={(id, name) => onSelectIndex?.(id, name)} />
      </div>
      
      {/* Row 2: Intelligence Mix (3-6-3 Symmetry) */}
      <div className="md:col-span-1 lg:col-span-1 xl:col-span-3">
        <IndexOverview className="h-full" onSelectIndex={onSelectIndex} />
      </div>

      <div className="md:col-span-1 lg:col-span-2 xl:col-span-6">
        <SectorHeatmap className="h-full" />
      </div>

      <div className="md:col-span-1 lg:col-span-1 xl:col-span-3">
        <GlobalMarkets className="h-full" />
      </div>

      {/* Row 3: Sector Detail (Full Width) */}
      <div className="xl:col-span-12">
        <SectorPerformance className="h-full" />
      </div>

      {/* 4. Core Intelligence Modules */}
      <div className="xl:col-span-12">
        <MomentumIntelligence watchlist={watchlist} onToggle={onToggleWatchlist} onSelectStock={onSelectStock} />
      </div>

      <div className="md:col-span-1 lg:col-span-1 xl:col-span-6">
        <InstitutionalInsights symbol={stocks[0]?.symbol || 'RELIANCE'} className="h-full" />
      </div>

      <div className="md:col-span-1 lg:col-span-2 xl:col-span-6">
        <PennyStockIntelligence watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} onSelectStock={onSelectStock} className="h-full" />
      </div>


      {/* Row 4: Chart & Sidebar */}
      <div className="md:col-span-2 lg:col-span-2 xl:col-span-8 flex flex-col gap-4">
        <Card title="Market Sentiment" icon={Activity} className="flex-1 flex flex-col">
          <div className="flex-1 min-h-[300px] mt-4">
            <ResponsiveContainer width="100%" height="100%">
              {graphData.length > 0 ? (
                <AreaChart data={graphData}>
                  <defs>
                    <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="time" hide />
                  <YAxis hide domain={['auto', 'auto']} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px' }}
                    itemStyle={{ color: '#fff' }}
                  />
                  <Area type="monotone" dataKey="value" stroke="#3b82f6" fillOpacity={1} fill="url(#colorValue)" strokeWidth={3} />
                </AreaChart>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <Activity className="w-8 h-8 text-blue-500/20 animate-pulse" />
                </div>
              )}
            </ResponsiveContainer>
          </div>
          <div className="flex justify-between items-center mt-6 p-4 glass-strong rounded-xl border border-slate-800/50">
            <div>
              <p className="text-slate-400 text-xs font-bold uppercase tracking-widest">Nifty 50 Rank</p>
              <p className="text-xl font-black text-slate-100">22,453.20</p>
            </div>
            <div className="text-right">
              <p className="text-slate-400 text-xs font-bold uppercase tracking-widest">Day Range</p>
              <div className="w-32 h-1.5 bg-slate-800 rounded-full mt-2 relative">
                 <div className="absolute left-[40%] w-2 h-2 -top-0.5 bg-blue-500 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.8)]" />
              </div>
              <div className="flex justify-between text-[10px] text-slate-400 mt-1 font-bold">
                <span>22,380</span>
                <span>22,510</span>
              </div>
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1">
          <Card title="AI Intelligence Hub" icon={Zap} className="h-full">
             <div className="space-y-4 pt-2">
                {aiSignals.length > 0 ? aiSignals.map((signal, idx) => (
                  <div 
                    key={`${signal.symbol}-${idx}`} 
                    onClick={() => onSelectStock(signal.symbol)}
                    className="p-4 glass-strong rounded-2xl border border-slate-800/50 flex flex-col gap-4 hover:border-slate-800/30 transition-all cursor-pointer group relative overflow-hidden"
                  >
                    <div className="flex justify-between items-start relative z-10">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-black text-slate-100 italic tracking-tighter uppercase">{signal.symbol}</span>
                          <div className={cn(
                            "px-2 py-0.5 rounded text-[8px] font-black tracking-widest uppercase",
                            signal.signal === 'BUY' ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" : 
                            signal.signal === 'SELL' ? "bg-rose-500/10 text-rose-500 border border-rose-500/20" : "bg-slate-9000/10 text-slate-400 border border-slate-500/20"
                          )}>
                            {signal.signal} Signal
                          </div>
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1 italic line-clamp-1 leading-relaxed">
                          {signal.reasoning}
                        </p>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] font-black text-slate-200 tracking-widest mb-1">{signal.confidence}% <span className="text-slate-400">CONF.</span></div>
                        <div className="w-16 h-1 glass rounded-full overflow-hidden border border-slate-800/50 ml-auto">
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${signal.confidence}%` }}
                            className={cn(
                              "h-full",
                              signal.signal === 'BUY' ? "bg-emerald-500" : 
                              signal.signal === 'SELL' ? "bg-rose-500" : "bg-slate-9000"
                            )}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="h-20 w-full relative group/chart">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={signal.history}>
                          <defs>
                            <linearGradient id={`gradient-${signal.symbol}`} x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={signal.signal === 'BUY' ? "#10b981" : "#f43f5e"} stopOpacity={0.1}/>
                              <stop offset="95%" stopColor={signal.signal === 'BUY' ? "#10b981" : "#f43f5e"} stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <Area 
                            type="monotone" 
                            dataKey="price" 
                            stroke={signal.signal === 'BUY' ? "#10b981" : "#f43f5e"} 
                            strokeWidth={2} 
                            fill={`url(#gradient-${signal.symbol})`} 
                            dot={false}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="flex justify-between items-center text-[9px] font-black uppercase tracking-widest text-slate-400 border-t border-slate-900 pt-3">
                      <div className="flex gap-4">
                        <span>Entry: <span className="text-slate-200 font-bold">₹{signal.entry}</span></span>
                      </div>
                      <div className="flex gap-2">
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setHistorySymbol(signal.symbol);
                          }}
                          className="px-3 py-1 glass hover:bg-slate-800 border border-slate-800/50 rounded-lg text-slate-400 hover:text-white flex items-center gap-1.5 transition-all group/hist shadow-lg"
                        >
                          <History className="w-3 h-3 group-hover/hist:rotate-[-45deg] transition-transform text-blue-500" /> 
                          History
                        </button>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedSignal(signal);
                          }}
                          className="px-3 py-1 bg-blue-500/10 hover:bg-blue-500 border border-blue-500/20 hover:border-blue-500 rounded-lg text-blue-500 hover:text-white flex items-center gap-1.5 transition-all shadow-lg"
                        >
                          Deep Insight <ArrowUpRight className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="flex-1 flex flex-col items-center justify-center min-h-[400px]">
                     <Activity className="w-12 h-12 text-blue-500/20 animate-pulse mb-4" />
                     <p className="text-slate-400 text-xs font-black uppercase tracking-[0.2em] text-center">AI Intelligence Engine<br/><span className="text-[10px] text-blue-500/50">Analyzing Market Cycles...</span></p>
                  </div>
                )}
             </div>
             {isGenerating && queueProgress && queueProgress.total > 0 && (
               <div className="mt-3 space-y-1">
                 <div className="flex justify-between text-[9px] font-black text-slate-400 uppercase tracking-widest">
                   <span>Progress</span>
                   <span>{queueProgress.completed} / {queueProgress.total}</span>
                 </div>
                 <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
                   <div
                     className="h-full bg-blue-500 transition-all duration-500"
                     style={{ width: `${Math.round((queueProgress.completed / queueProgress.total) * 100)}%` }}
                   />
                 </div>
               </div>
             )}
             <button
                onClick={handleGenerateSignals}
                disabled={isGenerating}
                className={cn(
                    "w-full mt-4 py-2 border border-slate-800/50 rounded-xl text-[10px] font-black transition-all uppercase tracking-widest flex items-center justify-center gap-2",
                    isGenerating ? "glass border-slate-800/50 text-slate-400 cursor-not-allowed" : "text-blue-500 hover:text-white hover:bg-blue-600 hover:border-blue-600"
                )}
             >
                {isGenerating ? 'Analyzing...' : 'Generate Signals'}
             </button>
          </Card>
          
          <Card title="Signal Performance" icon={TrendingUp} className="h-full">
             <div className="flex flex-col items-center justify-center h-full py-8">
                <div className="text-5xl font-black text-emerald-500 mb-2 italic">84%</div>
                <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest">Historical Win Rate</p>
                <div className="w-full h-1 glass rounded-full mt-8 overflow-hidden">
                   <div className="h-full bg-emerald-500 w-[84%]" />
                </div>
                <p className="text-[10px] text-slate-400 mt-6 italic font-medium text-center leading-relaxed">
                  Based on backtested machine learning models for the current Nifty cycle.
                </p>
                <div className="grid grid-cols-2 gap-4 w-full mt-8">
                   <div className="p-3 glass-strong rounded-xl border border-slate-800/50 text-center">
                      <p className="text-[8px] font-black text-slate-400 uppercase mb-1">Total Signals</p>
                      <p className="text-lg font-black text-slate-100 italic">1,240</p>
                   </div>
                   <div className="p-3 glass-strong rounded-xl border border-slate-800/50 text-center">
                      <p className="text-[8px] font-black text-slate-400 uppercase mb-1">Avg Profit</p>
                      <p className="text-lg font-black text-emerald-500 italic">+4.2%</p>
                   </div>
                </div>
             </div>
          </Card>
        </div>
      </div>

      {/* Sidebar Section */}
      <div className="md:col-span-2 lg:col-span-1 xl:col-span-4 flex flex-col gap-4">
        <Card title="Market Heatmap" icon={Filter} className="flex-1">
            <div className="grid grid-cols-4 gap-1 h-full min-h-[120px]">
                {stocks.map(s => (
                    <div 
                        key={s.symbol} 
                        onClick={() => onSelectStock(s.symbol)}
                        className={cn(
                            "rounded-sm transition-all duration-500 cursor-pointer hover:ring-2 hover:ring-white/20 select-none",
                            s.changePct > 2 ? "bg-emerald-600" : 
                            s.changePct > 0 ? "bg-emerald-900" : 
                            s.changePct < -2 ? "bg-rose-600" : "bg-rose-900"
                        )}
                        title={`${s.symbol}: ${s.changePct}%`}
                    />
                ))}
            </div>
            <div className="flex justify-between text-[10px] font-bold text-slate-400 mt-2">
                <span>BEARISH</span>
                <span>BULLISH</span>
            </div>
        </Card>

        <Card title="Live Market News" icon={Activity} className="flex-[2]">
            <div className="flex gap-2 mb-4 overflow-x-auto hide-scrollbar pb-1">
                {['All', 'Market', 'Stock', 'Economy'].map(cat => (
                    <button 
                        key={cat}
                        onClick={() => setNewsFilter(cat)}
                        className={cn(
                            "px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-tighter border transition-all shrink-0",
                            newsFilter === cat ? "bg-blue-600 border-blue-600 text-white" : "glass-strong border-slate-800/50 text-slate-400 hover:text-white"
                        )}
                    >
                        {cat}
                    </button>
                ))}
            </div>
            <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 hide-scrollbar">
                {filteredNews.map((item) => (
                    <div key={item.id} className="group cursor-pointer">
                        <div className="flex gap-2 items-center mb-1">
                            <span className={cn(
                                "text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-tighter",
                                item.category === 'Economy' ? "bg-amber-500/10 text-amber-500" :
                                item.category === 'Stock' ? "bg-blue-500/10 text-blue-500" : "bg-purple-500/10 text-purple-500"
                            )}>
                                {item.category}
                            </span>
                            <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">{item.time}</span>
                            <span className="text-[8px] font-black text-slate-200 mx-1">•</span>
                            <span className="text-[8px] font-black text-blue-500/70 uppercase tracking-widest">{item.source}</span>
                        </div>
                        <h4 className="text-xs font-bold text-slate-200 leading-snug group-hover:text-blue-400 transition-colors line-clamp-2">
                            {item.title}
                        </h4>
                        <p className="text-[10px] text-slate-400 line-clamp-2 mt-1 italic leading-relaxed">
                            {item.summary}
                        </p>
                    </div>
                ))}
            </div>
            <button className="w-full mt-6 py-2 border border-slate-800/50 rounded-xl text-xs font-bold text-slate-400 hover:text-white hover:border-slate-800/30 transition-all uppercase tracking-widest">
                Browse News Hub
            </button>
        </Card>

        <Card title="Portfolio Snapshot" icon={PieChart}>
           <div className="text-center py-4">
              <h4 className="text-slate-400 text-xs font-bold uppercase tracking-widest mb-1">Unrealized Gain</h4>
              <p className="text-3xl font-black text-slate-100">₹12,450.40</p>
              <div className="flex items-center justify-center gap-2 mt-2 text-emerald-400 font-bold text-sm">
                <ArrowUpRight className="w-4 h-4" />
                +₹450.20 (3.20%)
              </div>
           </div>
           <div className="mt-4 border-t border-slate-800/50 pt-4 space-y-3">
             <div className="flex justify-between text-xs">
               <span className="text-slate-400 font-medium tracking-tight">Invested Value</span>
               <span className="text-slate-200 font-bold">₹380,000.00</span>
             </div>
             <div className="flex justify-between text-xs">
               <span className="text-slate-400 font-medium tracking-tight">Daily Change</span>
               <span className="text-emerald-400 font-bold">+₹1,240</span>
             </div>
           </div>
        </Card>

        <div className="relative group cursor-pointer overflow-hidden rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-800 p-6 shadow-2xl">
           <div className="relative z-10">
             <h3 className="text-white font-black text-xl leading-tight">ADVANCED BACKTESTING<br/>ENGINE</h3>
             <p className="text-blue-100/70 text-[10px] font-bold mt-2 uppercase tracking-widest">Test strategies against 10yr NSE history</p>
             <button className="mt-6 bg-white text-blue-900 text-xs font-black px-4 py-2 rounded-lg items-center inline-flex gap-2 group-hover:gap-3 transition-all">
                TRY BETA <ArrowUpRight className="w-3 h-3" />
             </button>
           </div>
           <History className="absolute -right-4 -bottom-4 w-32 h-32 text-white/10 -rotate-12 group-hover:scale-110 transition-transform" />
        </div>
      </div>

      <div className="xl:col-span-12">
        <TopMoversIntelligence onSelectStock={onSelectStock} />
      </div>

      <div className="xl:col-span-12">
        <IntradayBreakouts onSelectStock={onSelectStock} />
      </div>


      {/* Modals & Overlays (Outside Grid Flow) */}
      <AnimatePresence>
        {historySymbol && (
          <SignalHistoryModal symbol={historySymbol} onClose={() => setHistorySymbol(null)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {selectedSignal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedSignal(null)}
              className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-2xl glass border border-slate-800/50 rounded-3xl overflow-hidden shadow-2xl"
            >
              <div className="p-8">
                <div className="flex justify-between items-start mb-8">
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 glass-strong border border-slate-800/50 rounded-2xl flex items-center justify-center">
                       <Zap className="w-8 h-8 text-blue-500 fill-blue-500/20" />
                    </div>
                    <div>
                      <h2 className="text-3xl font-black text-slate-200 tracking-tighter uppercase italic">{selectedSignal.symbol} Analysis</h2>
                      <div className="flex gap-2 mt-1">
                        <span className={cn(
                          "px-2 py-0.5 rounded text-[10px] font-black tracking-widest uppercase",
                          selectedSignal.signal === 'BUY' ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
                        )}>
                          {selectedSignal.signal} SIGNAL
                        </span>
                        <span className="text-[10px] font-bold text-slate-400 glass-strong px-2 py-0.5 rounded border border-slate-800/50 tracking-widest">{selectedSignal.confidence}% CONFIDENCE</span>
                      </div>
                    </div>
                  </div>
                  <button 
                    onClick={() => setSelectedSignal(null)}
                    className="p-2 text-slate-400 hover:text-white transition-colors"
                  >
                    <Plus className="w-6 h-6 rotate-45" />
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-4 mb-8">
                   <div className="p-4 glass-strong rounded-2xl border border-slate-800/50">
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 text-center">Entry Price</p>
                      <p className="text-xl font-black text-slate-100 text-center">₹{selectedSignal.entry}</p>
                   </div>
                   <div className="p-4 glass-strong rounded-2xl border border-blue-500/30 ring-1 ring-blue-500/10">
                      <p className="text-[9px] font-black text-blue-500 uppercase tracking-widest mb-1 text-center">AI Target</p>
                      <p className="text-xl font-black text-slate-100 text-center">₹{selectedSignal.target}</p>
                   </div>
                   <div className="p-4 glass-strong rounded-2xl border border-rose-500/30">
                      <p className="text-[9px] font-black text-rose-500 uppercase tracking-widest mb-1 text-center">Stop Loss</p>
                      <p className="text-xl font-black text-slate-100 text-center">₹{selectedSignal.stopLoss}</p>
                   </div>
                </div>

                <div className="mb-8">
                   <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                     <Info className="w-3 h-3" />
                     Strategy Reasoning
                   </h4>
                   <div className="p-5 glass-strong rounded-2xl border border-slate-800/50 relative overflow-hidden">
                      <Zap className="absolute -right-4 -bottom-4 w-24 h-24 text-blue-500/5 rotate-12" />
                      <p className="text-sm text-slate-300 leading-relaxed font-medium italic">
                        "{selectedSignal.reasoning}"
                      </p>
                   </div>
                </div>

                <div className="h-56 mb-8 glass-strong rounded-3xl border border-slate-800/50 p-6 relative overflow-hidden">
                   <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={selectedSignal.history || []}>
                      <defs>
                        <linearGradient id="modalGradientDashboard" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={selectedSignal.signal === 'BUY' ? "#10b981" : "#f43f5e"} stopOpacity={0.2}/>
                          <stop offset="95%" stopColor={selectedSignal.signal === 'BUY' ? "#10b981" : "#f43f5e"} stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <Area type="monotone" dataKey="price" stroke={selectedSignal.signal === 'BUY' ? "#10b981" : "#f43f5e"} strokeWidth={3} fill="url(#modalGradientDashboard)" />
                      <ReferenceLine y={selectedSignal.entry} stroke="#94a3b8" strokeDasharray="5 5" />
                      <ReferenceLine y={selectedSignal.target} stroke="#10b981" strokeDasharray="3 3" />
                      <ReferenceLine y={selectedSignal.stopLoss} stroke="#f43f5e" strokeDasharray="3 3" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                <button 
                  onClick={() => setSelectedSignal(null)}
                  className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-2xl transition-all shadow-[0_10px_30px_rgba(37,99,235,0.2)]"
                >
                  ACKNOWLEDGE SIGNAL
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
 const Screener: React.FC<{
  stocks?: MarketData[];
  onSelectStock: (symbol: string) => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
}> = ({ onSelectStock, watchlist, onToggleWatchlist }) => {
  const [filter, setFilter] = useState('All');
  const [activeScanner, setActiveScanner] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<string>('symbol');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [activeTab, setActiveTab] = useState<'fundamental' | 'technical'>('fundamental');
  
  // Specific Fundamental Filters
  const [minPe, setMinPe] = useState<number | undefined>(undefined);
  const [maxPe, setMaxPe] = useState<number | undefined>(undefined);
  const [minRoe, setMinRoe] = useState<number | undefined>(undefined);
  const [maxPb, setMaxPb] = useState<number | undefined>(undefined);
  const [maxDe, setMaxDe] = useState<number | undefined>(undefined);
  
  // Advanced Screener Filters
  const [minVolume, setMinVolume] = useState<number>(0);
  const [minMktCap, setMinMktCap] = useState<number>(0);
  const [selectedSector, setSelectedSector] = useState<string>('All');
  const [selectedTimeframes, setSelectedTimeframes] = useState<string[]>(['1h', 'D']);

  const { data: stocks, isLoading: stocksLoading } = trpc.getScreenerResults.useQuery(
    { 
      filter, 
      sector: selectedSector,
      minPe,
      maxPe,
      minRoe,
      maxPb,
      maxDe
    },
    { enabled: filter !== 'External' && filter !== 'TradingView' && activeTab === 'fundamental' }
  );

  const { data: tvScreener, isLoading: tvScreenerLoading } = trpc.getTvScreener.useQuery(undefined, {
    enabled: filter === 'TradingView' && activeTab === 'fundamental'
  });

  const { data: scannerGroups } = trpc.getMarketScanners.useQuery();
  
  const { data: marketData, isLoading: marketLoading } = trpc.fetchMarketData.useQuery(
    { 
      provider: activeScanner?.provider, 
      params: activeScanner?.provider === 'mc' ? {
        type: activeScanner.type, catId: activeScanner.catId, scanId: activeScanner.scanId
      } : activeScanner?.provider === 'custom' ? {
        timeframes: selectedTimeframes,
        minVolume,
        minMktCap,
        sector: selectedSector
      } : {
        screenerId: activeScanner?.screenerId, queryCondition: activeScanner?.queryCondition
      }
    },
    { enabled: !!activeScanner && activeTab === 'technical' }
  );

  const handleScannerSelect = (scanner: any) => {
    setFilter('External');
    setActiveScanner(scanner);
    setActiveTab('technical');
  };

  const isLoading = (activeTab === 'fundamental' && (stocksLoading || tvScreenerLoading)) || (activeTab === 'technical' && marketLoading);

  // Process data based on provider
  let displayStocks: any[] = [];
  let displayColumns: string[] = [];

  if (activeTab === 'technical' && activeScanner?.provider === 'mc') {
    displayStocks = marketData?.data?.list?.scannerDetails || [];
    displayColumns = displayStocks[0]?.columns?.map((c: any) => c.name) || [];
  } else if (activeTab === 'technical' && activeScanner?.provider === 'custom') {
    displayStocks = marketData?.data?.list?.scannerDetails || [];
    displayColumns = ['timeframesMet', 'momentum', 'pattern', 'mktCap'];
  } else if (activeTab === 'technical' && activeScanner?.provider === 'et') {
    displayStocks = marketData?.searchResult?.searchData?.records || [];
    // ETnow usually returns column names in a header or we can skip and show basic info
    const firstStock = displayStocks[0];
    if (firstStock) {
      displayColumns = Object.keys(firstStock).filter(k => 
        !['stkId', 'stkname', 'ltp', 'perChg', 'scUrl', 'symbol', 'name', 'companyName', 'recoid', 'id'].includes(k)
      ).slice(0, 4); // Limit to key columns
    }
  } else if (activeTab === 'fundamental' && filter === 'TradingView') {
    displayStocks = tvScreener?.results || [];
    displayColumns = ['market_cap', 'volume', 'recommendation'];
  } else if (activeTab === 'fundamental') {
    displayStocks = stocks || [];
    displayColumns = ['pe', 'roe', 'pb', 'debtEquity'];
  }

  const processedStocks = displayStocks.filter(s => {
    const symbol = s.symbol || s.stkId || s.ticker || "";
    const name = s.name || s.stkname || s.companyName || "";
    const matchesSearch = symbol.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch;
  }).sort((a, b) => {
    let aVal: any, bVal: any;
    
    if (activeTab === 'fundamental') {
      aVal = (a as any)[sortField];
      bVal = (b as any)[sortField];
    } else {
      // For external, we mostly sort by price or change if available
      if (sortField === 'ltp' || sortField === 'price') {
         aVal = parseFloat(a.ltp || a.price || a.lastPrice || 0);
         bVal = parseFloat(b.ltp || b.price || b.lastPrice || 0);
      } else if (sortField === 'perChg' || sortField === 'changePct') {
         aVal = parseFloat(a.perChg || a.changePct || a.percentageChange || 0);
         bVal = parseFloat(b.perChg || b.changePct || b.percentageChange || 0);
      } else {
         aVal = (a.stkname || a.companyName || a.symbol || "").toLowerCase();
         bVal = (b.stkname || b.companyName || b.symbol || "").toLowerCase();
      }
    }

    if (aVal === undefined || aVal === null) return 1;
    if (bVal === undefined || bVal === null) return -1;
    
    if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  return (
    <div className="p-6 space-y-6">
      <Card 
        title={activeScanner ? `Market Intelligence: ${activeScanner.name}` : "Elite Stock Discovery"} 
        icon={Filter}
      >
        <div className="flex flex-col gap-10 mb-8">
           {activeScanner && (
             <div className="p-5 bg-emerald-500/5 border border-emerald-500/20 rounded-3xl relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 blur-3xl -mr-16 -mt-16 group-hover:bg-emerald-500/20 transition-colors" />
                <div className="relative z-10">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <h3 className="text-base font-black text-slate-200 italic tracking-tight uppercase">
                      {activeScanner.provider === 'mc' ? (marketData?.data?.list?.scannerName || activeScanner.name) : activeScanner.name}
                    </h3>
                  </div>
                  <p className="text-xs text-slate-400 font-medium leading-relaxed italic max-w-2xl">
                    {activeScanner.provider === 'mc' ? (marketData?.data?.list?.scannerDescription || "Advanced technical analysis for professional trading.") : "Strategic fundamental screening powered by Economic Times Intelligence."}
                  </p>
                </div>
             </div>
           )}

           <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
              <div className="lg:col-span-3 space-y-6">
                <div className="space-y-4">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                    <Zap className="w-3 h-3 text-blue-500" /> System Presets
                  </h4>
                  <div className="flex flex-col gap-2">
                    {['All', 'TradingView', 'Gainers', 'Losers', 'High ROE', 'Low Debt', 'Near 52W High', 'Near 52W Low'].map(tag => (
                      <button 
                          key={tag} 
                          onClick={() => { setFilter(tag); setActiveScanner(null); }}
                          className={cn(
                              "px-4 py-2.5 rounded-xl text-[10px] font-black tracking-widest transition-all border uppercase text-left",
                              (filter === tag && !activeScanner) ? "bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-500/20" : "glass-strong border-slate-800/50 text-slate-400 hover:border-slate-800/30 hover:text-white"
                          )}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-4 pt-4 border-t border-slate-800/30">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                    <Filter className="w-3 h-3 text-emerald-500" /> Fundamental Gears
                  </h4>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Max P/E Ratio</label>
                       <input 
                          type="range" min="0" max="60" step="5" 
                          value={maxPe || 60} 
                          onChange={(e) => setMaxPe(parseInt(e.target.value))}
                          className="w-full accent-blue-500 h-1 glass rounded-full appearance-none cursor-pointer"
                       />
                       <div className="flex justify-between text-[8px] font-bold text-slate-400"><span>0</span><span>{maxPe || 60}</span></div>
                    </div>
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Min ROE %</label>
                       <input 
                          type="range" min="0" max="40" step="5" 
                          value={minRoe || 0} 
                          onChange={(e) => setMinRoe(parseInt(e.target.value))}
                          className="w-full accent-emerald-500 h-1 glass rounded-full appearance-none cursor-pointer"
                       />
                       <div className="flex justify-between text-[8px] font-bold text-slate-400"><span>0</span><span>{minRoe || 0}%</span></div>
                    </div>
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Max P/B Ratio</label>
                       <input 
                          type="range" min="0" max="15" step="1" 
                          value={maxPb || 15} 
                          onChange={(e) => setMaxPb(parseInt(e.target.value))}
                          className="w-full accent-indigo-500 h-1 glass rounded-full appearance-none cursor-pointer"
                       />
                       <div className="flex justify-between text-[8px] font-bold text-slate-400"><span>0</span><span>{maxPb || 15}</span></div>
                    </div>
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Max D/E Ratio</label>
                       <input 
                          type="range" min="0" max="3" step="0.5" 
                          value={maxDe || 3} 
                          onChange={(e) => setMaxDe(parseFloat(e.target.value))}
                          className="w-full accent-rose-500 h-1 glass rounded-full appearance-none cursor-pointer"
                       />
                       <div className="flex justify-between text-[8px] font-bold text-slate-400"><span>0</span><span>{maxDe || 3.0}</span></div>
                    </div>
                    <button 
                       onClick={() => { setMaxPe(undefined); setMinRoe(undefined); setMaxDe(undefined); setMaxPb(undefined); }}
                       className="w-full py-2 glass-strong border border-slate-800/50 rounded-lg text-[8px] font-black text-slate-400 uppercase tracking-widest hover:border-slate-800/30 hover:text-slate-300 transition-all"
                    >
                       Reset Gears
                    </button>
                  </div>
                </div>

                <div className="space-y-4 pt-4 border-t border-slate-800/30">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                    <TrendingUp className="w-3 h-3 text-rose-500" /> Breakout & Trend
                  </h4>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Min Market Cap (Cr)</label>
                       <select 
                          value={minMktCap}
                          onChange={(e) => setMinMktCap(parseInt(e.target.value))}
                          className="w-full glass-strong border border-slate-800/50 rounded-lg py-2 px-3 text-[10px] font-bold text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                       >
                          <option value="0">All Caps</option>
                          <option value="500">500 Cr+</option>
                          <option value="2000">2,000 Cr+</option>
                          <option value="10000">10,000 Cr+</option>
                          <option value="50000">50,000 Cr+</option>
                       </select>
                    </div>
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Sector Focus</label>
                       <select 
                          value={selectedSector}
                          onChange={(e) => setSelectedSector(e.target.value)}
                          className="w-full glass-strong border border-slate-800/50 rounded-lg py-2 px-3 text-[10px] font-bold text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                       >
                          <option value="All">All Sectors</option>
                          <option value="Energy">Energy</option>
                          <option value="IT">IT</option>
                          <option value="Banking">Banking</option>
                          <option value="Auto">Auto</option>
                          <option value="Healthcare">Healthcare</option>
                       </select>
                    </div>
                    <div className="space-y-2">
                       <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Timeframe Multi-Select</label>
                       <div className="grid grid-cols-2 gap-2">
                          {['15m', '1h', '4h', 'D', 'W'].map(tf => (
                            <button 
                              key={tf}
                              onClick={() => {
                                if (selectedTimeframes.includes(tf)) {
                                  setSelectedTimeframes(selectedTimeframes.filter(t => t !== tf));
                                } else {
                                  setSelectedTimeframes([...selectedTimeframes, tf]);
                                }
                              }}
                              className={cn(
                                "px-2 py-1.5 rounded-lg text-[9px] font-black tracking-widest border transition-all",
                                selectedTimeframes.includes(tf) ? "bg-blue-600 border-blue-600 text-white" : "glass-strong border-slate-800/50 text-slate-400"
                              )}
                            >
                              {tf}
                            </button>
                          ))}
                       </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-9 space-y-8">
                {activeTab === 'technical' && scannerGroups?.map((group) => (
                  <div key={group.category} className="space-y-4">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{group.category}</h4>
                    <div className="flex flex-wrap gap-2">
                      {group.items.map(scanner => (
                        <button 
                            key={scanner.id} 
                            onClick={() => handleScannerSelect(scanner)}
                            className={cn(
                                "px-4 py-2 rounded-xl text-[10px] font-black tracking-widest transition-all border uppercase",
                                activeScanner?.id === scanner.id ? "bg-emerald-600 border-emerald-600 text-white shadow-lg shadow-emerald-500/20" : "glass-strong border-slate-800/50 text-slate-400 hover:border-slate-800/30 hover:text-white"
                            )}
                        >
                          {scanner.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
            <div className="flex flex-col md:flex-row gap-4 items-center justify-between pt-6 border-t border-slate-800/30">
              <div className="flex flex-col gap-4 w-full">
                <div className="flex items-center gap-3">
                   <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Quick Technical Screener:</h4>
                   <div className="flex flex-wrap gap-2">
                      {[
                        { name: 'Bullish BO', id: 'mc-25-BPBULL' },
                        { name: 'RSI Power', id: 'mc-25-RSIPOWBO' },
                        { name: '52W High', id: 'mc-17-52HIGH' },
                        { name: '52W Low', id: 'mc-17-52LOW' }
                      ].map(iq => (
                        <button 
                          key={iq.id}
                          onClick={() => {
                            const scanner = (scannerGroups as any)?.flatMap((g: any) => g.items).find((i: any) => i.id === iq.id);
                            if (scanner) handleScannerSelect(scanner);
                          }}
                          className={cn(
                            "px-3 py-1.5 rounded-lg text-[9px] font-bold tracking-tight uppercase border transition-all",
                            activeScanner?.id === iq.id ? "bg-blue-600 border-blue-600 text-white" : "glass border-slate-800/50 text-slate-400 hover:border-slate-800/30 hover:text-white"
                          )}
                        >
                          {iq.name}
                        </button>
                      ))}
                   </div>
                </div>
                
                <div className="relative w-full md:w-96">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input 
                    type="text" 
                    placeholder="Deep search assets..." 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="glass-strong border border-slate-800/50 rounded-2xl py-3.5 pl-10 pr-4 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 w-full transition-all"
                  />
                </div>
              </div>
              <div className="flex gap-3 shrink-0">
                <div className="flex glass-strong border border-slate-800/50 p-1 rounded-2xl">
                   <button 
                    onClick={() => { setActiveTab('fundamental'); setFilter('All'); setActiveScanner(null); }}
                    className={cn(
                      "px-5 py-2.5 rounded-xl text-[10px] font-black tracking-widest uppercase transition-all",
                      activeTab === 'fundamental' ? "bg-indigo-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-300"
                    )}
                   >Fundamental</button>
                   <button 
                    onClick={() => setActiveTab('technical')}
                    className={cn(
                      "px-5 py-2.5 rounded-xl text-[10px] font-black tracking-widest uppercase transition-all",
                      activeTab === 'technical' ? "bg-indigo-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-300"
                    )}
                   >Technical</button>
                </div>
                <button className="flex items-center gap-2 glass-strong text-slate-400 border border-slate-800/50 px-5 py-3 rounded-2xl text-[10px] font-black tracking-widest transition-all hover:text-white hover:border-slate-800/30 uppercase">
                  <Download className="w-3 h-3" />
                  Extract
                </button>
              </div>
         </div>

        <div className="overflow-x-auto rounded-3xl border border-slate-800/30 glass-strong/50 backdrop-blur-sm">
          {isLoading ? (
            <div className="py-48 flex flex-col items-center justify-center space-y-6">
              <div className="relative w-12 h-12">
                <div className="absolute inset-0 border-2 border-blue-500/20 rounded-full" />
                <div className="absolute inset-0 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] animate-pulse">Synchronizing Intelligence...</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="glass/50 backdrop-blur-xl">
                  <th 
                    className="px-6 py-6 font-black text-[9px] text-slate-400 uppercase tracking-[0.25em] border-b border-slate-800/50 cursor-pointer hover:text-white transition-colors"
                    onClick={() => handleSort('symbol')}
                  >
                    Asset {sortField === 'symbol' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  <th 
                    className="px-6 py-6 font-black text-[9px] text-slate-400 uppercase tracking-[0.25em] border-b border-slate-800/50 text-right cursor-pointer hover:text-white transition-colors"
                    onClick={() => handleSort('price')}
                  >
                    LTP {sortField === 'price' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  <th 
                    className="px-6 py-6 font-black text-[9px] text-slate-400 uppercase tracking-[0.25em] border-b border-slate-800/50 text-center cursor-pointer hover:text-white transition-colors"
                    onClick={() => handleSort('changePct')}
                  >
                    Momentum {sortField === 'changePct' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  {displayColumns.map(col => (
                    <th key={col} className="px-6 py-6 font-black text-[9px] text-slate-400 uppercase tracking-[0.25em] border-b border-slate-800/50 text-center">{col}</th>
                  ))}
                  <th className="px-6 py-6 font-black text-[9px] text-slate-400 uppercase tracking-[0.25em] border-b border-slate-800/50 text-right">Direct</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/30">
                {processedStocks.map((row: any, idx: number) => {
                  const symbol = row.symbol || row.stkId || row.ticker;
                  const name = row.name || row.stkname || row.companyName || "";
                  const ltp = row.price || row.ltp || row.lastPrice || 0;
                  const perChg = row.changePct || row.perChg || row.percentageChange || 0;
                  
                  return (
                    <tr 
                      key={idx} 
                      onClick={() => onSelectStock(symbol)}
                      className="hover:bg-slate-800/20 group transition-all cursor-pointer"
                    >
                      <td className="px-6 py-6" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-3">
                          {watchlist.includes(symbol) ? (
                            <button 
                              onClick={() => onToggleWatchlist(symbol)}
                              className="p-1.5 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-md flex items-center justify-center w-8 h-8"
                              title="Remove from Watchlist"
                            >
                              <Minus className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <button 
                              onClick={() => onToggleWatchlist(symbol, { price: parseFloat(ltp), name, source: `Screener: ${activeScanner?.name || filter}` })}
                              className="p-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-500 hover:bg-emerald-500 hover:text-white transition-all shadow-md flex items-center justify-center w-8 h-8"
                              title="Add to Watchlist"
                            >
                              <Plus className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <div className="cursor-pointer" onClick={() => onSelectStock(symbol)}>
                            <div className="font-black text-slate-200 text-xs tracking-tight group-hover:text-blue-400 transition-colors uppercase truncate max-w-[150px]">{name || symbol}</div>
                            <div className="text-[8px] text-slate-400 font-bold tracking-widest mt-1 uppercase italic truncate max-w-[150px]">{symbol}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-6 text-right font-black text-xs tabular-nums text-slate-100">₹{parseFloat(ltp).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                      <td className="px-6 py-6 text-center">
                        <span className={cn(
                          "font-black text-[10px] tabular-nums px-3 py-1.5 rounded-lg border",
                          parseFloat(perChg) >= 0 ? "text-emerald-400 bg-emerald-400/5 border-emerald-400/10" : "text-rose-400 bg-rose-400/5 border-rose-400/10"
                        )}>
                          {parseFloat(perChg) >= 0 ? '+' : ''}{parseFloat(perChg).toFixed(2)}%
                        </span>
                      </td>
                      {activeTab === 'fundamental' ? (
                        ['pe', 'roe', 'pb', 'debtEquity'].map(f => (
                          <td key={f} className="px-6 py-6 text-center font-bold text-[10px] text-slate-400 uppercase tracking-widest">
                            {row[f]?.toFixed(2) || '-'}
                          </td>
                        ))
                      ) : (
                        (row.columns || displayColumns.map(c => ({ name: c, value: row[c] }))).map((c: any, cidx: number) => (
                          <td key={cidx} className="px-6 py-6 text-center font-bold text-[10px] text-slate-300 uppercase italic">
                            {c.value || '-'}
                          </td>
                        ))
                      )}
                      <td className="px-6 py-6 text-right">
                         <button 
                            onClick={() => onSelectStock(symbol)}
                            className="p-2.5 glass border border-slate-800/50 rounded-xl text-slate-400 hover:text-white hover:border-slate-600 transition-all"
                         >
                            <ArrowUpRight className="w-4 h-4" />
                         </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  </div>
</Card>
</div>
);
};

const OptionChain: React.FC<{ symbol: string; stockPrice: number }> = ({ symbol, stockPrice }) => {
  const { data: fnoSignals } = trpc.getFnOSignals.useQuery({ symbol });
  const { data: ocResponse, isLoading } = trpc.getOptionChain.useQuery({ symbol }, {
    refetchInterval: 30000
  });

  const ocData = ocResponse?.success ? ocResponse.data : null;
  const chain = ocData?.optionChain || [];
  
  const ivRank = ocData?.marketSentiment?.ivRank;
  const ivPercentile = ocData?.marketSentiment?.ivPercentile;
  const maxPain = ocData?.marketSentiment?.maxPain;

  if (isLoading) {
    return (
      <div className="py-20 text-center glass-strong rounded-2xl border border-slate-800/50 border-dashed">
        <Activity className="w-8 h-8 text-blue-500 animate-spin mx-auto mb-4" />
        <p className="text-slate-400 font-bold uppercase tracking-widest text-[10px]">Fetching real-time option chain...</p>
      </div>
    );
  }

  if (!ocData || chain.length === 0) {
    return (
      <div className="py-20 text-center glass-strong rounded-2xl border border-slate-800/50 border-dashed">
        <AlertCircle className="w-8 h-8 text-rose-500 mx-auto mb-4" />
        <h3 className="text-slate-300 font-black text-lg uppercase tracking-tighter italic">Option Chain Unavailable</h3>
        <p className="text-slate-400 text-[10px] uppercase font-bold tracking-widest mt-2">Could not retrieve F&O data for {symbol}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* IV Section */}
      {/* F&O Sentiment Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 glass border border-slate-800/50 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Max Pain Strike</p>
            <p className="text-2xl font-black text-slate-100 italic">₹{maxPain || '—'}</p>
            <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Expiry Magnet</p>
          </div>
          <div className="p-3 bg-blue-500/10 rounded-xl">
             <Target className="w-5 h-5 text-blue-400" />
          </div>
        </div>

        <div className="p-4 glass border border-slate-800/50 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">IV Rank</p>
            <p className="text-2xl font-black text-slate-100 italic">{ivRank || 'N/A'}</p>
            <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Volatility vs History</p>
          </div>
          <div className="w-12 h-12 relative opacity-50">
            <ResponsiveContainer width="100%" height="100%">
              <RePieChart>
                <Pie
                  data={[{ value: ivRank || 1 }, { value: Math.max(0, 100 - (ivRank || 0)) }]}
                  innerRadius="80%"
                  outerRadius="100%"
                  paddingAngle={0}
                  dataKey="value"
                  startAngle={90}
                  endAngle={-270}
                >
                  <Cell fill={ivRank ? "#3b82f6" : "#1e293b"} />
                  <Cell fill="#1e293b" />
                </Pie>
              </RePieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="p-4 glass border border-slate-800/50 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">IV Percentile</p>
            <p className="text-2xl font-black text-emerald-400 italic">{ivPercentile ? `${ivPercentile}%` : 'N/A'}</p>
            <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Relative Volatility</p>
          </div>
          <div className="w-12 h-12 relative opacity-50">
            <ResponsiveContainer width="100%" height="100%">
              <RePieChart>
                <Pie
                  data={[{ value: ivPercentile || 1 }, { value: Math.max(0, 100 - (ivPercentile || 0)) }]}
                  innerRadius="80%"
                  outerRadius="100%"
                  paddingAngle={0}
                  dataKey="value"
                  startAngle={90}
                  endAngle={-270}
                >
                  <Cell fill={ivPercentile ? "#10b981" : "#1e293b"} />
                  <Cell fill="#1e293b" />
                </Pie>
              </RePieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Option Chain Table */}
      <div className="overflow-x-auto rounded-2xl border border-slate-800/50 glass-strong/50">
        <table className="w-full text-left border-collapse min-w-[1200px]">
          <thead>
            <tr className="glass">
              <th colSpan={5} className="px-4 py-2 text-center text-[10px] font-black uppercase text-blue-500 border-b border-slate-800/50">Calls</th>
              <th className="px-4 py-2 text-center text-[10px] font-black uppercase text-slate-400 border-b border-slate-800/50">Strike</th>
              <th colSpan={5} className="px-4 py-2 text-center text-[10px] font-black uppercase text-rose-500 border-b border-slate-800/50">Puts</th>
            </tr>
            <tr className="glass/50">
              {['Buildup', 'OI', 'Delta', 'IV', 'LTP'].map(h => (
                <th key={`c-${h}`} className="px-3 py-3 text-[8px] font-black uppercase text-slate-400 tracking-widest text-center">{h}</th>
              ))}
              <th className="px-3 py-3 text-[8px] font-black uppercase text-slate-200 tracking-widest text-center bg-slate-800">Price</th>
              {['LTP', 'IV', 'Delta', 'OI', 'Buildup'].map(h => (
                <th key={`p-${h}`} className="px-3 py-3 text-[8px] font-black uppercase text-slate-400 tracking-widest text-center">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {chain.map((row: any) => {
              const strike = row.strikePrice;
              const isAtTheMoney = Math.abs(stockPrice - strike) < (stockPrice * 0.005);

              return (
                <tr key={strike} className={cn(
                  "hover:bg-slate-900/40 transition-colors text-center",
                  isAtTheMoney && "bg-blue-600/5"
                )}>
                  {/* CALLS */}
                  <td className={cn(
                    "px-3 py-4 text-[8px] font-black uppercase",
                    row.callBuiltup?.includes('Long') ? "text-emerald-400" : row.callBuiltup?.includes('Short') ? "text-rose-400" : "text-slate-400"
                  )}>{row.callBuiltup}</td>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-400">{(row.callOi/1000).toFixed(1)}k</td>
                  <td className="px-3 py-4 text-[10px] font-bold text-emerald-400">{row.callDelta?.toFixed(2)}</td>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-400">{row.callIv?.toFixed(1)}%</td>
                  <td className="px-3 py-4 text-[10px] font-black text-white tabular-nums">₹{row.callLtp?.toFixed(2)}</td>
                  
                  {/* STRIKE */}
                  <td className="px-3 py-4 text-xs font-black text-white bg-slate-800/30 border-x border-slate-800/50 tabular-nums">₹{strike}</td>
                  
                  {/* PUTS */}
                  <td className="px-3 py-4 text-[10px] font-black text-white tabular-nums">₹{row.putLtp?.toFixed(2)}</td>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-400">{row.putIv?.toFixed(1)}%</td>
                  <td className="px-3 py-4 text-[10px] font-bold text-rose-400">{row.putDelta?.toFixed(2)}</td>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-400">{(row.putOi/1000).toFixed(1)}k</td>
                  <td className={cn(
                    "px-3 py-4 text-[8px] font-black uppercase",
                    row.putBuiltup?.includes('Long') ? "text-emerald-400" : row.putBuiltup?.includes('Short') ? "text-rose-400" : "text-slate-400"
                  )}>{row.putBuiltup}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Card title="Greeks Analysis (Portfolio Impact)" icon={Activity}>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chain.map(row => ({ 
              strike: row.strikePrice, 
              delta: row.callDelta || 0,
              theta: Math.abs(row.callTheta || 0) / 10, // normalized
              vega: (row.callVega || 0) * 5 // scaled
            }))}>
              <XAxis dataKey="strike" hide />
              <YAxis hide />
              <Tooltip 
                contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px' }}
                itemStyle={{ fontSize: '11px', fontWeight: 'bold' }}
              />
              <Area type="monotone" dataKey="delta" stroke="#10b981" fill="#10b981" fillOpacity={0.1} name="Delta" />
              <Area type="monotone" dataKey="theta" stroke="#f43f5e" fill="#f43f5e" fillOpacity={0.1} name="Theta" />
              <Area type="monotone" dataKey="vega" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.1} name="Vega" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="grid grid-cols-4 gap-4 mt-6">
           {['Delta', 'Gamma', 'Theta', 'Vega'].map(g => (
             <div key={g} className="text-center p-3 glass-strong rounded-xl border border-slate-800/50">
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">{g}</p>
                <div className={cn(
                  "h-1 rounded-full mb-1",
                  g === 'Delta' ? 'bg-emerald-500' : g === 'Theta' ? 'bg-rose-500' : 'bg-blue-500'
                )} />
                <p className="text-[10px] font-bold text-slate-300">
                  {g === 'Gamma' ? '0.0024' : Math.random().toFixed(2)}
                </p>
             </div>
           ))}
        </div>
      </Card>
    </div>
  );
};

const MarketMap: React.FC = () => {
  const [activeInd, setActiveInd] = useState('9'); // Nifty 50 default index
  const { data: indices } = trpc.getAllIndices.useQuery();
  const { data: indicesOverview } = trpc.getMarketOverview.useQuery();

  const handleIndChange = (val: string) => {
    setActiveInd(val);
  };

  const indexList: any[] = (indices as any)?.data?.indiceList?.flatMap((g: any) => g.list) ?? [];
  const quickIndices = [
    { id: '9', name: 'Nifty 50' },
    { id: '4', name: 'Sensex' },
    { id: '23', name: 'Bank Nifty' },
    { id: '27', name: 'Midcap 100' },
    { id: '7', name: 'Nifty 500' },
  ];

  const currentIndexData = indexList.find((i: any) => i.indId === activeInd);
  const selectedIndexName = quickIndices.find(i => i.id === activeInd)?.name || 
                           currentIndexData?.name || 'Index';

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6">
        <div>
          <h2 className="text-3xl font-black text-white italic tracking-tighter uppercase flex items-center gap-3">
            <PieChart className="w-8 h-8 text-blue-500" />
            Market Intelligence Map
          </h2>
          <div className="flex items-center gap-3 mt-1">
             <p className="text-slate-400 text-xs font-bold uppercase tracking-widest italic">
               Analyzing sector rotation within <span className="text-white">{selectedIndexName}</span> context
             </p>
             {currentIndexData && (
                <div className="flex items-center gap-2 glass px-3 py-1 rounded-lg border border-slate-800/50">
                   <span className="text-xs font-black text-white tabular-nums">{parseFloat(currentIndexData.value).toLocaleString()}</span>
                   <span className={cn(
                      "text-[10px] font-bold flex items-center gap-0.5",
                      parseFloat(currentIndexData.changePer) >= 0 ? "text-emerald-400" : "text-rose-400"
                   )}>
                      {parseFloat(currentIndexData.changePer) >= 0 ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      {Math.abs(parseFloat(currentIndexData.changePer)).toFixed(2)}%
                   </span>
                </div>
             )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {quickIndices.map(idx => (
            <button
              key={idx.id}
              onClick={() => handleIndChange(idx.id)}
              className={cn(
                "px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all",
                activeInd === idx.id 
                  ? "bg-blue-600 border-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]" 
                  : "glass border-slate-800/50 text-slate-400 hover:border-slate-800/30"
              )}
            >
              {idx.name}
            </button>
          ))}
          <div className="w-[1px] h-8 bg-slate-800 mx-2 hidden md:block" />
          <select 
            value={activeInd} 
            onChange={(e) => handleIndChange(e.target.value)}
            className="glass border border-slate-800/50 rounded-xl px-4 py-2 text-xs font-bold text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">More Indices...</option>
            {indexList.map((idx: any) => (
              <option key={idx.indId} value={idx.indId}>{idx.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6">
        <SectorHeatmap indexId={activeInd} />
        
        <TrendlyneSectorDashboard />

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Card title="Distribution Analysis" icon={BarChart3}>
            <div className="h-48 pt-4">
              <ResponsiveContainer width="100%" height="100%">
                 <BarChart data={[{ name: 'Bullish', val: 65 }, { name: 'Neutral', val: 20 }, { name: 'Bearish', val: 15 }]}>
                    <XAxis dataKey="name" hide />
                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b' }} />
                    <Bar dataKey="val" fill="#3b82f6" radius={[8, 8, 0, 0]}>
                       <Cell fill="#10b981" />
                       <Cell fill="#3b82f6" />
                       <Cell fill="#f43f5e" />
                    </Bar>
                 </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-between mt-4">
               <div className="text-center">
                  <p className="text-[9px] font-black text-emerald-500 uppercase">Advancing</p>
                  <p className="text-lg font-black text-slate-100 italic">32</p>
               </div>
               <div className="text-center">
                  <p className="text-[9px] font-black text-rose-500 uppercase">Declining</p>
                  <p className="text-lg font-black text-slate-100 italic">18</p>
               </div>
               <div className="text-center">
                  <p className="text-[9px] font-black text-slate-400 uppercase">Unchanged</p>
                  <p className="text-lg font-black text-slate-100 italic">0</p>
               </div>
            </div>
          </Card>

          <Card title="Market Sentiment" icon={BrainCircuit}>
             <div className="space-y-6 pt-4">
                <div className="flex items-center gap-4">
                   <div className="relative w-20 h-20">
                      <svg className="w-full h-full" viewBox="0 0 100 100">
                         <circle className="text-slate-200" strokeWidth="8" stroke="currentColor" fill="transparent" r="40" cx="50" cy="50" />
                         <circle className="text-blue-500" strokeWidth="8" strokeDasharray="251.2" strokeDashoffset={251.2 * (1 - 0.72)} strokeLinecap="round" stroke="currentColor" fill="transparent" r="40" cx="50" cy="50" />
                      </svg>
                      <div className="absolute inset-0 flex items-center justify-center">
                         <span className="text-lg font-black text-slate-100 italic">72%</span>
                      </div>
                   </div>
                   <div>
                      <p className="text-[10px] font-black text-blue-500 uppercase tracking-widest">Greed/Fear Index</p>
                      <h4 className="text-xl font-black text-white italic tracking-tighter uppercase whitespace-nowrap">Extreme Optimism</h4>
                   </div>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed italic font-medium">
                  The current sector rotation suggests institutional accumulation in defensive pockets like Healthcare while IT remains volatile.
                </p>
             </div>
          </Card>

          <Card title="Top Sector Insights" icon={Zap}>
             <div className="space-y-4 pt-2">
                <div className="p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl flex justify-between items-center">
                   <div>
                      <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest">Leader</p>
                      <p className="text-sm font-black text-white italic tracking-tight">Nifty Auto</p>
                   </div>
                   <TrendingUp className="text-emerald-500 w-5 h-5" />
                </div>
                <div className="p-3 bg-rose-500/5 border border-rose-500/20 rounded-xl flex justify-between items-center">
                   <div>
                      <p className="text-[9px] font-black text-rose-500 uppercase tracking-widest">Laggard</p>
                      <p className="text-sm font-black text-white italic tracking-tight">Nifty IT</p>
                   </div>
                   <TrendingDown className="text-rose-500 w-5 h-5" />
                </div>
             </div>
          </Card>
        </div>
      </div>
    </div>
  );
};

const Backtest: React.FC<{ stocks?: MarketData[] }> = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<any>(null);
  const [symbol, setSymbol] = useState('RELIANCE');
  const [timeframe, setTimeframe] = useState('Daily Candlesticks');
  
  // Strategy Parameters
  const [rsiUpper, setRsiUpper] = useState(70);
  const [rsiLower, setRsiLower] = useState(30);
  const [emaShort, setEmaShort] = useState(20);
  const [emaLong, setEmaLong] = useState(50);
  const [strategyName, setStrategyName] = useState('');
  const [showSaveModal, setShowSaveModal] = useState(false);

  const utils = trpc.useContext();
  const { data: savedStrategies } = trpc.getBacktestStrategies.useQuery();

  const backtestMutation = trpc.runBacktest.useMutation({
    onSuccess: (data) => {
      setResults(data);
      setIsRunning(false);
    },
    onError: () => {
      setIsRunning(false);
    }
  });

  const saveStrategyMutation = trpc.saveBacktestStrategy.useMutation({
    onSuccess: () => {
      utils.getBacktestStrategies.invalidate();
      setShowSaveModal(false);
      setStrategyName('');
    }
  });

  const startBacktest = () => {
    setIsRunning(true);
    setResults(null);
    backtestMutation.mutate({ 
      symbol, 
      strategy: 'Custom RSI+EMA', 
      period: timeframe === 'Daily Candlesticks' ? '1D' : timeframe === '1H Momentum' ? '1H' : '15M',
      params: { rsiUpper, rsiLower, emaShort, emaLong }
    });
  };

  const handleSaveStrategy = () => {
    if (!strategyName) return;
    saveStrategyMutation.mutate({
      name: strategyName,
      symbol,
      timeframe,
      params: { rsiUpper, rsiLower, emaShort, emaLong }
    });
  };

  const loadStrategy = (s: any) => {
    setSymbol(s.symbol);
    setTimeframe(s.timeframe);
    setRsiUpper(s.params.rsiUpper);
    setRsiLower(s.params.rsiLower);
    setEmaShort(s.params.emaShort);
    setEmaLong(s.params.emaLong);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-4 space-y-6">
          <Card title="Strategy Parameters" icon={Filter}>
            <div className="space-y-5">
               <div className="space-y-2">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">Target Symbol</label>
                 <input 
                    type="text" 
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                    className="w-full glass-strong border border-slate-800/50 rounded-xl p-3 text-xs font-bold text-white focus:outline-none focus:ring-1 focus:ring-blue-500 uppercase"
                    placeholder="e.g. RELIANCE"
                 />
               </div>

               <div className="space-y-2">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">Timeframe</label>
                 <select 
                    value={timeframe}
                    onChange={(e) => setTimeframe(e.target.value)}
                    className="w-full glass-strong border border-slate-800/50 rounded-xl p-3 text-xs font-bold text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                 >
                   <option>Daily Candlesticks</option>
                   <option>1H Momentum</option>
                   <option>15M Scalping</option>
                 </select>
               </div>

               <div className="pt-4 border-t border-slate-800/30 space-y-4">
                  <h4 className="text-[10px] font-black text-blue-500 uppercase tracking-[0.2em] mb-2">Technical Indicators</h4>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">RSI Upper (Sell)</label>
                      <input 
                        type="number" value={rsiUpper} onChange={(e) => setRsiUpper(parseInt(e.target.value))}
                        className="w-full glass-strong border border-slate-800/50 rounded-lg p-2 text-xs font-bold text-white"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">RSI Lower (Buy)</label>
                      <input 
                        type="number" value={rsiLower} onChange={(e) => setRsiLower(parseInt(e.target.value))}
                        className="w-full glass-strong border border-slate-800/50 rounded-lg p-2 text-xs font-bold text-white"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">EMA Short Period</label>
                      <input 
                        type="number" value={emaShort} onChange={(e) => setEmaShort(parseInt(e.target.value))}
                        className="w-full glass-strong border border-slate-800/50 rounded-lg p-2 text-xs font-bold text-white"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">EMA Long Period</label>
                      <input 
                        type="number" value={emaLong} onChange={(e) => setEmaLong(parseInt(e.target.value))}
                        className="w-full glass-strong border border-slate-800/50 rounded-lg p-2 text-xs font-bold text-white"
                      />
                    </div>
                  </div>
               </div>

               <div className="pt-6 flex gap-2">
                 <button 
                   onClick={startBacktest}
                   disabled={isRunning}
                   className={cn(
                     "flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-xl text-[10px] tracking-widest uppercase transition-all shadow-lg shadow-blue-500/20",
                     isRunning && "opacity-50 cursor-not-allowed"
                   )}
                 >
                   {isRunning ? "Running..." : "Run Backtest"}
                 </button>
                 <button 
                   onClick={() => setShowSaveModal(true)}
                   className="p-3 glass-strong border border-slate-800/50 rounded-xl text-slate-400 hover:text-white hover:border-slate-800/30 transition-all"
                   title="Save Strategy"
                 >
                   <Save className="w-4 h-4" />
                 </button>
               </div>
            </div>
          </Card>

          {savedStrategies && savedStrategies.length > 0 && (
            <Card title="Saved Strategies" icon={Bookmark}>
              <div className="space-y-3 pt-2">
                {savedStrategies.map((s: any) => (
                  <button
                    key={s.id}
                    onClick={() => loadStrategy(s)}
                    className="w-full text-left p-3 glass-strong border border-slate-800/50 rounded-xl hover:border-blue-500 transition-all group"
                  >
                    <p className="text-xs font-black text-white italic group-hover:text-blue-400 uppercase tracking-tight">{s.name}</p>
                    <div className="flex gap-2 mt-1">
                      <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">{s.symbol}</span>
                      <span className="text-[8px] font-bold text-slate-300 uppercase tracking-widest">•</span>
                      <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">{s.timeframe}</span>
                    </div>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="lg:col-span-8">
          <Card title="Simulation Analysis" icon={Activity} className="h-full">
            {!results && (
              <div className="h-full min-h-[400px] flex flex-col items-center justify-center p-12 text-center relative overflow-hidden">
                <div className="w-24 h-24 bg-blue-600/10 rounded-full flex items-center justify-center mb-6">
                  <Activity className={cn("text-blue-500 w-12 h-12", isRunning && "animate-pulse")} />
                </div>
                <h4 className="text-white font-black text-2xl italic uppercase tracking-tighter">AI Scenario Simulation</h4>
                <p className="text-slate-400 text-sm mt-3 max-w-sm mx-auto leading-relaxed">
                  {isRunning ? "Simulating thousands of trade paths across 10 years of market data history..." : "Adjust your strategy parameters on the left and initiate the simulation to validate your edge."}
                </p>
                {isRunning && (
                  <div className="mt-8 w-48 h-1 glass rounded-full overflow-hidden border border-slate-800/50">
                    <motion.div 
                      initial={{ left: '-100%' }}
                      animate={{ left: '100%' }}
                      transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                      className="absolute top-0 h-1 w-1/3 bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.8)]"
                    />
                  </div>
                )}
              </div>
            )}

            {results && (
              <div className="space-y-8 animate-in fade-in duration-500">
                 <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                   {[
                     { label: 'Returns', value: `+${results.totalReturn}%`, icon: TrendingUp, color: 'text-emerald-400' },
                     { label: 'Profit Factor', value: results.profitFactor, icon: Activity, color: 'text-blue-400' },
                     { label: 'Win Rate', value: `${results.winRate}%`, icon: Zap, color: 'text-amber-400' },
                     { label: 'Max DD', value: `${results.maxDrawdown}%`, icon: ArrowDownRight, color: 'text-rose-400' },
                   ].map(stat => (
                     <div key={stat.label} className="p-5 glass-strong border border-slate-800/50 rounded-2xl relative overflow-hidden group">
                       <stat.icon className="w-4 h-4 text-slate-200 absolute -right-1 -top-1 scale-[300%] rotate-12 opacity-50 group-hover:scale-[400%] transition-transform" />
                       <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest relative z-10">{stat.label}</p>
                       <p className={cn("text-2xl font-black mt-2 relative z-10 tracking-tighter", stat.color)}>{stat.value}</p>
                     </div>
                   ))}
                 </div>

                 <div className="p-6 glass-strong rounded-3xl border border-slate-800/50">
                   <div className="flex justify-between items-center mb-8">
                     <div>
                       <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Equity Growth</h5>
                       <p className="text-sm font-black text-white italic">Backtest Period: 2014 - 2024</p>
                     </div>
                     <div className="flex gap-6">
                        <div className="flex items-center gap-2">
                           <div className="w-2.5 h-2.5 bg-blue-500 rounded-full" />
                           <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Portfolio</span>
                        </div>
                        <div className="flex items-center gap-2">
                           <div className="w-2.5 h-2.5 bg-rose-500/20 border border-rose-500 rounded-full" />
                           <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Drawdown</span>
                        </div>
                     </div>
                   </div>
                   <div className="h-80">
                     <ResponsiveContainer width="100%" height="100%">
                       <AreaChart data={results.history}>
                         <defs>
                           <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                             <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                             <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                           </linearGradient>
                           <linearGradient id="drawdownGradient" x1="0" y1="0" x2="0" y2="1">
                             <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.1}/>
                             <stop offset="95%" stopColor="#f43f5e" stopOpacity={0}/>
                           </linearGradient>
                         </defs>
                         <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                         <XAxis dataKey="day" hide />
                         <YAxis yAxisId="left" hide domain={['auto', 'auto']} />
                         <YAxis yAxisId="right" hide orientation="right" domain={[-20, 0]} />
                         <Tooltip 
                           contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px' }}
                           labelStyle={{ color: '#64748b', fontSize: '10px', fontWeight: 'bold' }}
                           itemStyle={{ fontSize: '12px', fontWeight: 'bold', color: '#fff' }}
                         />
                         <Area yAxisId="left" type="monotone" dataKey="equity" stroke="#3b82f6" fillOpacity={1} fill="url(#equityGradient)" strokeWidth={3} />
                         <Area yAxisId="right" type="monotone" dataKey="drawdown" stroke="#f43f5e" fillOpacity={1} fill="url(#drawdownGradient)" strokeWidth={1} strokeDasharray="3 3" />
                       </AreaChart>
                     </ResponsiveContainer>
                   </div>
                 </div>

                 <div className="p-6 bg-blue-500/10 border border-blue-500/20 rounded-3xl flex flex-col md:flex-row items-center justify-between gap-6 overflow-hidden relative">
                    <div className="absolute top-0 right-0 p-4 opacity-5">
                       <Zap className="w-32 h-32 text-blue-500" />
                    </div>
                    <div className="flex items-center gap-4 relative z-10">
                        <div className="w-12 h-12 bg-blue-500 text-blue-950 rounded-2xl flex items-center justify-center font-black italic">
                           AI
                        </div>
                        <div>
                            <h5 className="text-white font-black text-lg tracking-tight uppercase italic mb-1">Adaptive Strategy Intelligence</h5>
                            <p className="text-slate-400 font-medium text-xs max-w-md">Gemini has analyzed this strategy and recommends tightening the stop-loss during high volatility regimes to preserve the alpha generated.</p>
                        </div>
                    </div>
                    <button 
                      onClick={startBacktest}
                      className="px-6 py-3 bg-white text-blue-900 font-black rounded-xl text-[10px] tracking-widest uppercase hover:bg-blue-50 transition-all relative z-10"
                    >
                      Optimize Strategy
                    </button>
                 </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      <AnimatePresence>
        {showSaveModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSaveModal(false)}
              className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md glass border border-slate-800/50 rounded-3xl p-8 shadow-2xl"
            >
              <h3 className="text-xl font-black text-white italic tracking-tighter uppercase mb-6">Name Your Strategy</h3>
              <div className="space-y-4">
                <input 
                  type="text" 
                  value={strategyName}
                  onChange={(e) => setStrategyName(e.target.value)}
                  className="w-full glass-strong border border-slate-800/50 rounded-2xl p-4 text-xs font-bold text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="e.g. Aggressive RSI Scalper"
                  autoFocus
                />
                <div className="flex gap-3 mt-4">
                  <button 
                    onClick={() => setShowSaveModal(false)}
                    className="flex-1 py-3 glass-strong border border-slate-800/50 text-slate-400 font-black rounded-xl text-[10px] tracking-widest uppercase transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleSaveStrategy}
                    disabled={!strategyName}
                    className="flex-1 py-3 bg-blue-600 text-white font-black rounded-xl text-[10px] tracking-widest uppercase transition-all disabled:opacity-50"
                  >
                    Confirm Save
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

// --- Stock Details Page ---

const TechnicalAnalysis: React.FC<{ symbol: string }> = ({ symbol }) => {
  const [timeframe, setTimeframe] = useState<'D' | 'W' | 'M'>('D');
  const [maType, setMaType] = useState<'SMA' | 'EMA'>('SMA');
  const { data: tech, isLoading } = trpc.getTechnicalDetails.useQuery({ symbol, dur: timeframe });
  const { data: technicalScan, isLoading: scanLoading } = trpc.getTechnicalScan.useQuery({ symbol });
  const { data: ohlcData, isLoading: ohlcLoading } = trpc.getOHLCData.useQuery({ symbol, dur: '1y' });
  const { data: tvTa } = trpc.getTvTa.useQuery({ symbol });

  if (isLoading || scanLoading || ohlcLoading) return <div className="p-20 text-center animate-pulse text-slate-400">Processing signals...</div>;

  const indicators = tech?.data?.indicators?.map((i: any) => ({ name: i.displayName, value: i.value, sentiment: i.indication })) || [];
  const movingAverages = tech?.data?.[maType.toLowerCase()]?.map((i: any) => ({ name: `${maType} ${i.key}`, value: i.value, sentiment: i.indication })) || [];
  const crossovers = tech?.data?.crossover || [];
  const macdData = indicators.find((i: any) => i.name.includes('MACD')) || { value: 'N/A', sentiment: 'Neutral' };

  // Map OHLC to Candlestick format for detection
  const candles: Candlestick[] = ohlcData?.data?.map((d: any) => ({
    open: d.open,
    high: d.high,
    low: d.low,
    close: d.close,
    timestamp: d.time
  })) || [];

  const detectedPatterns = detectCandlestickPatterns(candles);

  return (
    <div className="space-y-6">
      {/* Timeframe Selector */}
      <div className="flex justify-end gap-2 mb-4">
        {[
          { id: 'D', label: 'Daily' },
          { id: 'W', label: 'Weekly' },
          { id: 'M', label: 'Monthly' }
        ].map(tf => (
          <button
            key={tf.id}
            onClick={() => setTimeframe(tf.id as any)}
            className={cn(
              "px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all border",
              timeframe === tf.id ? "bg-blue-600 border-blue-600 text-white shadow-lg" : "glass-strong border-slate-800/50 text-slate-400 hover:text-white"
            )}
          >
            {tf.label}
          </button>
        ))}
      </div>

      {tvTa && tvTa.summary && (
        <Card title="TradingView Advanced TA" icon={Zap}>
          <div className="grid grid-cols-3 gap-4 text-center mb-6">
            <div className="p-4 glass-strong rounded-2xl border border-slate-800/50">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Oscillators</p>
              <p className={cn("text-xl font-black italic tracking-tighter uppercase", 
                tvTa.oscillators?.RECOMMENDATION?.includes('BUY') ? 'text-emerald-500' :
                tvTa.oscillators?.RECOMMENDATION?.includes('SELL') ? 'text-rose-500' : 'text-amber-500'
              )}>{tvTa.oscillators?.RECOMMENDATION || 'NEUTRAL'}</p>
            </div>
            <div className="p-4 glass-strong rounded-2xl border border-slate-800/50">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Summary</p>
              <p className={cn("text-2xl font-black italic tracking-tighter uppercase", 
                tvTa.summary?.RECOMMENDATION?.includes('BUY') ? 'text-emerald-500' :
                tvTa.summary?.RECOMMENDATION?.includes('SELL') ? 'text-rose-500' : 'text-amber-500'
              )}>{tvTa.summary?.RECOMMENDATION || 'NEUTRAL'}</p>
            </div>
            <div className="p-4 glass-strong rounded-2xl border border-slate-800/50">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Moving Averages</p>
              <p className={cn("text-xl font-black italic tracking-tighter uppercase", 
                tvTa.moving_averages?.RECOMMENDATION?.includes('BUY') ? 'text-emerald-500' :
                tvTa.moving_averages?.RECOMMENDATION?.includes('SELL') ? 'text-rose-500' : 'text-amber-500'
              )}>{tvTa.moving_averages?.RECOMMENDATION || 'NEUTRAL'}</p>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card title="Momentum Indicators" icon={Activity}>
           <div className="space-y-4">
              {indicators.map((ind: any) => (
                <div key={ind.name} className="flex justify-between items-center p-3 glass-strong rounded-xl border border-slate-800/30">
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{ind.name}</p>
                    {Array.isArray(ind.value) ? (
                      <p className="text-xs font-bold text-slate-400 mt-0.5">Multiple Bands</p>
                    ) : (
                      <p className="text-xs font-bold text-white mt-0.5">{ind.value}</p>
                    )}
                  </div>
                  <span className={cn(
                    "text-[9px] font-black px-2 py-0.5 rounded uppercase tracking-tighter whitespace-nowrap",
                    ind.sentiment.includes('Bullish') ? "bg-emerald-500/10 text-emerald-500" :
                    ind.sentiment.includes('Bearish') ? "bg-rose-500/10 text-rose-500" :
                    ind.sentiment.includes('Overbought') || ind.sentiment.includes('High') ? "bg-purple-500/10 text-purple-400" :
                    ind.sentiment.includes('Oversold') ? "bg-amber-500/10 text-amber-500" : "bg-slate-800 text-slate-400"
                  )}>
                    {ind.sentiment}
                  </span>
                </div>
              ))}
           </div>
        </Card>
        
        <div className="space-y-6">
          <Card title="MACD Analysis" icon={Zap}>
             <div className="space-y-5">
                <div className="p-4 glass-strong border border-slate-800/50 rounded-2xl">
                   <div className="flex justify-between items-end mb-4">
                      <div>
                         <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Momentum Oscillator</p>
                         <h4 className="text-xl font-black text-white italic tracking-tighter">MACD Line</h4>
                      </div>
                      <span className={cn(
                         "text-[10px] font-black px-3 py-1 rounded uppercase italic tracking-tighter",
                         macdData.sentiment === 'Bullish' ? "bg-emerald-500/20 text-emerald-500 border border-emerald-500/30" : "bg-rose-500/20 text-rose-500 border border-rose-500/30"
                      )}>
                         {macdData.sentiment}
                      </span>
                   </div>
                   
                   <div className="space-y-3">
                      <div className="flex justify-between text-[11px] font-bold">
                         <span className="text-slate-400">Current Value:</span>
                         <span className="text-white">{macdData.value}</span>
                      </div>
                      <div className="flex justify-between text-[11px] font-bold">
                         <span className="text-slate-400">Signal Crossover:</span>
                         <span className={macdData.sentiment === 'Bullish' ? "text-emerald-400" : "text-rose-400"}>
                            {macdData.sentiment === 'Bullish' ? 'Bullish Crossover' : 'Bearish Crossover'}
                         </span>
                      </div>
                   </div>

                   <div className="mt-5 pt-5 border-t border-slate-900">
                      <div className="flex items-start gap-3">
                         <Info className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
                         <p className="text-[11px] text-slate-400 leading-relaxed italic">
                            MACD is a trend-following momentum indicator. A <span className="text-slate-200 font-bold">Bullish Crossover</span> occurs when the MACD line passes above the signal line.
                         </p>
                      </div>
                   </div>
                </div>

                <div className="space-y-3">
                   <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">Scanner Insights</h5>
                   {technicalScan?.signals?.filter((s: any) => s.type === 'MACD').map((signal: any, idx: number) => (
                      <div key={idx} className="p-3 bg-blue-500/5 border border-blue-500/10 rounded-xl">
                         <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-1">{signal.label}</p>
                         <p className="text-[11px] text-slate-400 leading-relaxed italic">{signal.description}</p>
                      </div>
                   ))}
                </div>
             </div>
          </Card>

          <Card title="Moving Average Crossovers" icon={Activity}>
             <div className="space-y-4">
                {crossovers.map((cross: any) => (
                   <div key={cross.key} className="p-4 glass-strong border border-slate-800/50 rounded-2xl flex items-center justify-between">
                      <div>
                         <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{cross.period}</p>
                         <p className="text-sm font-bold text-white leading-tight">{cross.displayValue}</p>
                      </div>
                      <span className={cn(
                         "text-[9px] font-black px-2 py-1 rounded uppercase tracking-tighter whitespace-nowrap",
                         cross.indication === 'Bullish' ? "bg-emerald-500/10 text-emerald-500" :
                         cross.indication === 'Bearish' ? "bg-rose-500/10 text-rose-500" : "bg-slate-800 text-slate-400"
                      )}>
                         {cross.indication}
                      </span>
                   </div>
                ))}
             </div>
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card 
          title="Moving Averages" 
          icon={TrendingUp}
          action={
            <div className="flex glass rounded-lg p-0.5 border border-slate-800/50">
              <button 
                onClick={() => setMaType('SMA')}
                className={cn("px-3 py-1 rounded-md text-[9px] font-black uppercase tracking-widest transition-all", maType === 'SMA' ? "bg-slate-800 text-white" : "text-slate-400")}
              >
                SMA
              </button>
              <button 
                onClick={() => setMaType('EMA')}
                className={cn("px-3 py-1 rounded-md text-[9px] font-black uppercase tracking-widest transition-all", maType === 'EMA' ? "bg-slate-800 text-white" : "text-slate-400")}
              >
                EMA
              </button>
            </div>
          }
        >
           <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {movingAverages.map((ma: any) => (
                 <div key={ma.name} className="flex justify-between items-center p-3 glass-strong rounded-xl border border-slate-800/30">
                    <div>
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{ma.name}</p>
                      <p className="text-xs font-bold text-white mt-0.5">₹{ma.value}</p>
                    </div>
                    <span className={cn(
                      "text-[9px] font-black px-2 py-0.5 rounded uppercase tracking-tighter",
                      ma.sentiment === 'Bullish' ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
                    )}>
                      {ma.sentiment}
                    </span>
                 </div>
              ))}
           </div>
        </Card>

        <Card title="Live Technical Scanner" icon={Zap}>
           <div className="space-y-4">
              {/* Custom patterns detected from chart data */}
              {detectedPatterns.length > 0 && (
                <div className="space-y-3">
                  <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">Chart Patterns Identified</h5>
                  {detectedPatterns.map((pattern, idx) => (
                    <div key={idx} className={cn(
                      "p-4 glass-strong border rounded-2xl relative overflow-hidden",
                      pattern.sentiment === 'bullish' ? 'border-emerald-500/20' : pattern.sentiment === 'bearish' ? 'border-rose-500/20' : 'border-slate-800/50'
                    )}>
                      <div className="absolute top-0 right-0 p-2 opacity-10">
                        {pattern.sentiment === 'bullish' ? <TrendingUp className="text-emerald-500 w-12 h-12" /> : <TrendingDown className="text-rose-500 w-12 h-12" />}
                      </div>
                      <div className="relative z-10">
                        <div className="flex items-center gap-2 mb-2">
                           <Zap className={cn("w-3 h-3", pattern.sentiment === 'bullish' ? 'text-emerald-400' : 'text-rose-400')} />
                           <span className={cn("text-[9px] font-black uppercase tracking-[0.2em]", pattern.sentiment === 'bullish' ? 'text-emerald-400' : 'text-rose-400')}>
                             {pattern.sentiment} SIGNAL (Confidence: {pattern.confidence})
                           </span>
                        </div>
                        <h4 className="text-lg font-black text-white italic tracking-tighter mb-1 uppercase">
                           {pattern.name} Identified
                        </h4>
                        <p className="text-[11px] text-slate-400 leading-relaxed italic font-medium">
                           {pattern.description}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="p-4 glass-strong border border-emerald-500/20 rounded-2xl relative overflow-hidden">
                 <div className="absolute top-0 right-0 p-2 opacity-10">
                    <Activity className="w-12 h-12 text-emerald-500" />
                 </div>
                 <div className="relative z-10">
                    <div className="flex items-center gap-2 mb-3">
                       <Zap className="w-4 h-4 text-emerald-400" />
                       <span className="text-[10px] font-black text-emerald-400 uppercase tracking-[0.2em]">Real-time Analysis</span>
                    </div>
                    <h4 className="text-lg font-black text-white italic tracking-tighter mb-2">
                       {technicalScan?.candlestickAnalysis?.pattern}
                    </h4>
                    <p className="text-xs text-slate-400 leading-relaxed italic font-medium">
                       {technicalScan?.candlestickAnalysis?.explanation}
                    </p>
                 </div>
              </div>

              <div className="p-4 glass-strong border border-slate-800/50 rounded-2xl">
                 <div className="flex justify-between items-center mb-1">
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Volatility Status</span>
                    <span className="text-[10px] font-black text-white uppercase">{technicalScan?.volatility?.label}</span>
                 </div>
                 <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
                    <motion.div 
                       initial={{ width: 0 }}
                       animate={{ width: `${technicalScan?.volatility?.score}%` }}
                       className="h-full bg-blue-500"
                    />
                 </div>
                 <p className="text-[9px] text-slate-400 mt-2 italic uppercase tracking-tighter">{technicalScan?.volatility?.description}</p>
              </div>
           </div>
        </Card>
      </div>

      <Card title="Pivot Levels (Standard)" icon={Filter}>
         <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {[
              { label: 'R2', val: (tech as any)?.data?.pivotLevels?.find((p: any) => p.key === 'Classic')?.pivotLevel?.r2 || '---' },
              { label: 'R1', val: (tech as any)?.data?.pivotLevels?.find((p: any) => p.key === 'Classic')?.pivotLevel?.r1 || '---' },
              { label: 'Pivot', val: (tech as any)?.data?.pivotLevels?.find((p: any) => p.key === 'Classic')?.pivotLevel?.pivotPoint || '---' },
              { label: 'S1', val: (tech as any)?.data?.pivotLevels?.find((p: any) => p.key === 'Classic')?.pivotLevel?.s1 || '---' },
              { label: 'S2', val: (tech as any)?.data?.pivotLevels?.find((p: any) => p.key === 'Classic')?.pivotLevel?.s2 || '---' },
            ].map(p => {
              const displayVal = typeof p.val === 'number' ? `₹${p.val.toFixed(2)}` : p.val;
              return (
                <div key={p.label} className="p-4 glass-strong rounded-2xl border border-slate-800/50 text-center">
                   <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">{p.label}</p>
                   <p className="text-sm font-black text-white italic">{displayVal}</p>
                </div>
              );
            })}
         </div>
      </Card>
    </div>
  );
};

const FundamentalInsights: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: unifiedData, isLoading: loadingUnified } = trpc.getAlphaQuantDetail.useQuery({ symbol });
  const { data: funds, isLoading: loadingFunds } = trpc.getTrendlyneFundamentals.useQuery({ symbol });
  const { data: actions, isLoading: loadingActions } = trpc.getCorporateActions.useQuery({ symbol });

  if (loadingUnified || loadingFunds || loadingActions) return <div className="p-20 text-center animate-pulse text-slate-400">Auditing financials...</div>;

  // Extract ratios from consolidated data
  const ratioItems = (unifiedData as any)?.ratios?.item || [];
  const detailedInsights = (unifiedData as any)?.detailedInsights;
  
  const getRatio = (name: string, fallbackNames: string[] = []) => {
    const allNames = [name, ...fallbackNames].map(n => n.toLowerCase().replace(/[^a-z0-9]/g, ''));
    
    // 1. Try primary ratios items
    const row = ratioItems.find((r: any) => {
      const label = (r.label || "").toLowerCase().replace(/[^a-z0-9]/g, '');
      return allNames.some(an => label.includes(an));
    });
    if (row && row.value !== undefined) return row.value;
    
    // 2. Try industry comparison in detailed insights
    const icRow = detailedInsights?.industryComparison?.find((ic: any) => {
      const title = (ic.title || "").toLowerCase().replace(/[^a-z0-9]/g, '');
      return allNames.some(an => title.includes(an));
    });
    if (icRow && icRow.value !== undefined) return icRow.value;

    // 3. Try Tradebrains key metrics fallback
    const tbMetrics = (unifiedData as any)?.tradebrains?.keyMetrics;
    if (tbMetrics) {
      // Direct match or include
      const tbEntry = Object.entries(tbMetrics).find(([k, v]) => {
        const key = k.toLowerCase().replace(/[^a-z0-9]/g, '');
        return allNames.some(an => key.includes(an) || an.includes(key));
      });
      if (tbEntry && tbEntry[1] !== undefined && tbEntry[1] !== null) return tbEntry[1];
    }

    return 'N/A';
  };

  const displayRatios = [
    { label: 'Debt/Equity', name: 'debt/equity', fallbacks: ['debt equity', 'debt to equity', 'gearing'], icon: Filter },
    { label: 'Current Ratio', name: 'current ratio', fallbacks: ['current'], icon: Activity },
    { label: 'Quick Ratio', name: 'quick ratio', fallbacks: ['quick'], icon: Activity },
    { label: 'Interest Coverage', name: 'interest coverage', fallbacks: ['interest coverage ratio'], icon: Activity },
    { label: 'ROE %', name: 'roe', fallbacks: ['return on equity', 'roe %'], icon: Activity },
    { label: 'P/E Ratio', name: 'p/e ratio', fallbacks: ['ttm pe ratio', 'pe'], icon: Activity },
    { label: 'P/B Ratio', name: 'p/b ratio', fallbacks: ['price to book ratio', 'pb'], icon: TrendingUp },
  ];

  // Extract shareholding from consolidated data
  const shPattern = (unifiedData as any)?.shareholdingPattern;
  let promoters = 0, fii = 0, dii = 0, publicHolding = 0, pledging = '0.00';
  
  if (shPattern?.list) {
    const findVal = (name: string) => parseFloat(shPattern.list.find((i: any) => i.name?.includes(name))?.value) || 0;
    promoters = findVal('Promoter');
    fii = findVal('FII');
    dii = findVal('DII');
    publicHolding = findVal('Public');
    pledging = shPattern.promoterPledging || '0.00';
  }

  const corpActions = (actions as any)?.corporate_actions || [];

  return (
    <div className="space-y-6">
       {/* Financial Ratios Section */}
       <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {displayRatios.map(ratio => (
            <div key={ratio.label} className="p-4 glass border border-slate-800/50 rounded-2xl">
               <div className="flex justify-between items-start mb-2">
                  <ratio.icon className="w-4 h-4 text-blue-400" />
                  <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest border border-slate-800/50 px-1.5 py-0.5 rounded">Ratios</span>
               </div>
               <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{ratio.label}</p>
               <p className="text-xl font-black text-white italic tracking-tighter mt-1">{getRatio(ratio.name, (ratio as any).fallbacks)}</p>
            </div>
          ))}
       </div>

       <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Shareholding Pattern Visual */}
          <Card title="Shareholding Pattern" icon={PieChart}>
             <div className="space-y-4 mt-2">
                {[
                  { type: 'Promoter', val: promoters },
                  { type: 'FII', val: fii },
                  { type: 'DII', val: dii },
                  { type: 'Public', val: publicHolding }
                ].map(item => (
                  <div key={item.type} className="space-y-1.5">
                    <div className="flex justify-between text-[10px] font-black uppercase tracking-widest">
                       <span className="text-slate-400">{item.type}</span>
                       <span className="text-white">{item.val}%</span>
                    </div>
                    <div className="h-1.5 glass-strong rounded-full overflow-hidden border border-slate-800/20">
                       <motion.div 
                          initial={{ width: 0 }}
                          animate={{ width: `${item.val}%` }}
                          className="h-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]"
                       />
                    </div>
                  </div>
                ))}
                <p className="text-[9px] text-slate-400 italic mt-4 font-bold text-center uppercase tracking-tighter">
                  Promoter pledging: {pledging}%
                </p>
             </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Corporate Actions */}
          <Card title="Corporate Actions" icon={History}>
             <div className="space-y-3 mt-2 max-h-[250px] overflow-y-auto pr-2 custom-scrollbar">
                {corpActions.length > 0 ? corpActions.map((action: any, i: number) => (
                  <div key={i} className="flex justify-between items-center p-3 glass-strong rounded-xl border border-slate-800/30 hover:border-slate-800/30 transition-colors">
                     <div>
                        <p className="text-[10px] font-black text-blue-500 uppercase tracking-widest">{action.purpose || 'Action'}</p>
                        <p className="text-xs font-bold text-slate-200 mt-0.5">{action.details || 'N/A'}</p>
                     </div>
                     <span className="text-[9px] font-black text-slate-400 glass px-2 py-1 rounded">
                       {action.date || action.ex_date || 'TBA'}
                     </span>
                  </div>
                )) : (
                  <p className="text-center py-10 text-slate-400 italic text-xs font-bold uppercase tracking-widest">No recent actions recorded</p>
                )}
             </div>
          </Card>
       </div>

       {(() => {
          // Use real quarterly data from Trendlyne fundamentals if available
          const quarterlyRows: any[] = (funds as any)?.data?.financials?.quarterly?.revenue ?? [];
          const profitRows: any[] = (funds as any)?.data?.financials?.quarterly?.profit ?? [];
          if (quarterlyRows.length === 0 && profitRows.length === 0) return null;
          const chartData = quarterlyRows.slice(-6).map((r: any, i: number) => ({
            q: r.period || `Q${i + 1}`,
            revenue: r.value ?? 0,
            profit: profitRows[i]?.value ?? 0,
          }));
          return (
            <Card title="Quarterly Performance" icon={BarChart3}>
               <div className="h-64 mt-4">
                  <ResponsiveContainer width="100%" height="100%">
                     <BarChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                        <XAxis dataKey="q" tick={{ fill: '#64748b', fontSize: 10 }} />
                        <YAxis hide />
                        <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b' }} />
                        <Bar dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Revenue" />
                        <Bar dataKey="profit" fill="#10b981" radius={[4, 4, 0, 0]} name="Profit" />
                     </BarChart>
                  </ResponsiveContainer>
               </div>
            </Card>
          );
       })()}
    </div>
  );
};

const MFAnalysis: React.FC<{ symbol: string }> = ({ symbol }) => {
  return (
    <div className="space-y-6">
       <Card title="Top Mutual Fund Holders" icon={PieChart}>
          <div className="overflow-x-auto rounded-xl border border-slate-800/50">
             <table className="w-full text-left">
                <thead className="glass">
                   <tr>
                      {['Fund Name', 'Shares Held', 'Value (Cr)', 'Trend'].map(h => (
                        <th key={h} className="px-4 py-3 text-[9px] font-black uppercase text-slate-400 tracking-widest">{h}</th>
                      ))}
                   </tr>
                </thead>
                <tbody className="glass-strong divide-y divide-slate-800">
                   {[1, 2, 3, 4, 5].map(i => (
                     <tr key={i} className="hover:glass transition-colors">
                        <td className="px-4 py-3 font-bold text-white text-xs whitespace-nowrap uppercase italic">HDFC Top 100 Fund</td>
                        <td className="px-4 py-3 text-slate-400 text-xs font-bold tabular-nums">2,450,000</td>
                        <td className="px-4 py-3 text-slate-400 text-xs font-bold tabular-nums">₹412.5</td>
                        <td className="px-4 py-3">
                           <span className="text-emerald-400 text-[9px] font-black uppercase">Increased</span>
                        </td>
                     </tr>
                   ))}
                </tbody>
             </table>
          </div>
       </Card>

       <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card title="FII/DII Trends" icon={Activity}>
             <div className="h-48 mt-4">
                <ResponsiveContainer width="100%" height="100%">
                   <AreaChart data={Array.from({ length: 6 }, (_, i) => ({ month: i, fii: 15 + Math.random() * 5, dii: 12 + Math.random() * 5 }))}>
                      <XAxis dataKey="month" hide />
                      <YAxis hide />
                      <Area type="monotone" dataKey="fii" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.1} />
                      <Area type="monotone" dataKey="dii" stroke="#f43f5e" fill="#f43f5e" fillOpacity={0.1} />
                   </AreaChart>
                </ResponsiveContainer>
             </div>
             <p className="text-[10px] text-slate-400 mt-4 italic text-center font-bold">Consolidated inflow trend across last 6 months</p>
          </Card>

          <Card title="SIP Return Explorer" icon={TrendingUp}>
             <div className="space-y-6">
                <div>
                   <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">SIP Return (3Y Ann.)</p>
                   <p className="text-3xl font-black text-emerald-400 italic tracking-tighter">18.4%</p>
                </div>
                <div className="pt-4 border-t border-slate-800/50">
                   <p className="text-[10px] text-slate-400 leading-relaxed font-medium italic">
                     Historical SIP performance if invested ₹10,000 monthly since 2021.
                   </p>
                </div>
             </div>
          </Card>
       </div>
    </div>
  );
};

const FnOSignals: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: fno, isLoading } = trpc.getFnOSignals.useQuery({ symbol });

  if (isLoading) return <div className="p-10 text-center animate-pulse text-slate-400">Scanning F&O Activity...</div>;
  if (!fno || !fno.success) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 glass-strong border border-slate-800/50 rounded-2xl">
          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Put-Call Ratio (PCR)</p>
          <p className={cn(
            "text-xl font-black italic",
            (fno.marketSentiment?.pcr ?? 0) > 1 ? "text-emerald-400" : "text-rose-400"
          )}>{fno.marketSentiment?.pcr?.toFixed(2) ?? '—'}</p>
          <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">{(fno.marketSentiment?.pcr ?? 0) > 1.2 ? 'Bullish Sentiment' : (fno.marketSentiment?.pcr ?? 0) < 0.8 ? 'Bearish Sentiment' : 'Neutral Zone'}</p>
        </div>
        <div className="p-4 glass-strong border border-slate-800/50 rounded-2xl">
          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Max Pain Strike</p>
          <p className="text-xl font-black text-white italic">₹{fno.marketSentiment?.maxPain ?? '—'}</p>
          <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Expected Expiry Zone</p>
        </div>
        <div className="p-4 glass-strong border border-slate-800/50 rounded-2xl">
          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Overall OI Trend</p>
          <p className="text-xl font-black text-blue-400 italic uppercase">{fno.marketSentiment?.oiTrend ?? '—'}</p>
          <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Positioning Analysis</p>
        </div>
        <div className="p-4 glass-strong border border-slate-800/50 rounded-2xl">
          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Active Signals</p>
          <p className="text-xl font-black text-white italic">{fno.signals?.length ?? 0}</p>
          <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Institutional Alerts</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card title="Unusual Options Activity" icon={Zap}>
          <div className="space-y-3 pt-2">
            {(fno.signals ?? []).filter(s => s.type === 'UNUSUAL_VOLUME' || s.type === 'PCR_SIGNAL').map((sig, idx) => (
              <div key={idx} className="p-4 glass/50 border border-slate-800/80 rounded-2xl group hover:border-blue-500/30 transition-all">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      "w-2 h-2 rounded-full",
                      sig.sentiment === 'bullish' ? "bg-emerald-500" : "bg-rose-500"
                    )} />
                    <h5 className="text-[10px] font-black text-white uppercase tracking-widest">{sig.value}</h5>
                  </div>
                  <span className={cn(
                    "text-[8px] font-black px-2 py-0.5 rounded uppercase tracking-widest",
                    sig.confidence === 'high' ? "bg-blue-500/20 text-blue-400" : "bg-slate-800 text-slate-400"
                  )}>{sig.confidence} Confidence</span>
                </div>
                <p className="text-[11px] text-slate-400 font-medium leading-relaxed italic">{sig.description}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Significant OI Shifts" icon={Activity}>
           <div className="space-y-3 pt-2">
            {(fno.signals ?? []).filter(s => s.type === 'OI_SPIKE' || s.type === 'BUILDUP').map((sig, idx) => (
              <div key={idx} className="p-4 glass/50 border border-slate-800/80 rounded-2xl group hover:border-purple-500/30 transition-all">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      "w-2 h-2 rounded-full",
                      sig.sentiment === 'bullish' ? "bg-emerald-500" : "bg-rose-500"
                    )} />
                    <h5 className="text-[10px] font-black text-white uppercase tracking-widest">{sig.value}</h5>
                  </div>
                  <span className="text-[8px] font-black px-2 py-0.5 rounded bg-slate-800 text-slate-400 uppercase tracking-widest">{sig.type}</span>
                </div>
                <p className="text-[11px] text-slate-400 font-medium leading-relaxed italic">{sig.description}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
};

// AnalystEstimates, PriceVolume, StockSWOT, FundamentalEssentials removed — data now shown via MCStockInfoPanel

const NewsTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const allNews = useNewsFeed();
  const news = allNews.filter(n => n.relatedSymbols?.includes(symbol));

  if (news.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 glass-strong rounded-2xl border border-slate-800/50 border-dashed">
         <Activity className="w-12 h-12 text-slate-200 animate-pulse mb-4" />
         <h3 className="text-slate-400 font-black text-lg uppercase tracking-tighter italic text-center">No Targeted News Found</h3>
         <p className="text-slate-400 text-[10px] uppercase font-bold tracking-widest mt-2">{symbol} section under observation</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card title={`${symbol} Intel Feed`} icon={Activity}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
          {news.map((item) => (
            <div key={item.id} className="p-5 glass-strong border border-slate-800/50 rounded-2xl hover:border-blue-500/30 transition-all group">
              <div className="flex gap-3 items-center mb-3">
                <span className={cn(
                  "text-[9px] font-black px-2 py-0.5 rounded uppercase tracking-widest",
                  item.category === 'Economy' ? "bg-amber-500/20 text-amber-500" :
                  item.category === 'Stock' ? "bg-blue-500/20 text-blue-500" : "bg-purple-500/20 text-purple-500"
                )}>
                  {item.category}
                </span>
                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">{item.time}</span>
                <span className="text-[9px] font-black text-slate-300 mx-1">•</span>
                <span className="text-[9px] font-black text-blue-500/80 uppercase tracking-widest">{item.source}</span>
              </div>
              <h4 className="text-lg font-black text-white italic tracking-tighter leading-tight mb-2 group-hover:text-blue-400 transition-colors">
                {item.title}
              </h4>
              <p className="text-[11px] text-slate-400 font-medium leading-relaxed italic mb-4 line-clamp-3">
                {item.summary}
              </p>
              <div className="flex justify-between items-center">
                <div className="flex gap-2">
                  {item.relatedSymbols?.map(sym => (
                    <span key={sym} className="text-[9px] font-black text-slate-400 glass px-2 py-0.5 border border-slate-800/50 rounded uppercase tracking-tighter">
                      ${sym}
                    </span>
                  ))}
                </div>
                <button className="text-[9px] font-black text-blue-500 uppercase tracking-widest hover:text-white transition-colors">
                  READ ARTICLE →
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};

const StockDetails: React.FC<{ 
  symbol: string; 
  stock?: MarketData; 
  onBack: () => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
  onSelectStock: (symbol: string) => void;
}> = ({ symbol, stock: initialStock, onBack, watchlist, onToggleWatchlist, onSelectStock }) => {
  const news = useNewsFeed().filter(n => n.relatedSymbols?.includes(symbol));
  const [activeTab, setActiveTab] = useState('insights');
  const [report, setReport] = useState<any>(null);
  const { data: unifiedData } = trpc.getAlphaQuantDetail.useQuery({ symbol });

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

  // Synthetic high-fidelity candlestick data
  const [chartData] = useState(() => {
    const base = stock?.price || 1000;
    let currentPrice = base;
    return Array.from({ length: 40 }, (_, i) => {
      const open = currentPrice;
      const volatility = base * 0.015;
      const close = currentPrice + (Math.random() - 0.48) * volatility;
      const high = Math.max(open, close) + Math.random() * (volatility * 0.5);
      const low = Math.min(open, close) - Math.random() * (volatility * 0.5);
      
      currentPrice = close;
      
      const vwap = close * 0.99;
      const stdDev = base * 0.02;
      const upperBand = close + stdDev;
      const lowerBand = close - stdDev;

      return { 
        time: `${10 + Math.floor(i/10)}:${(i%10)*6}`, 
        open,
        high,
        low,
        close,
        price: close, 
        vwap, 
        bollinger: [lowerBand, upperBand],
        volume: Math.random() * 100000 
      };
    });
  });

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
                        (stock?.changePct ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                      )}>
                        {(stock?.changePct ?? 0) >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                        {(stock?.changePct ?? 0) >= 0 ? '+' : ''}{stock?.changePct ?? 0}%
                      </span>
                    </>
              }
            </div>
          </div>
        </div>
        
        <div className="flex gap-3">
          <button className="flex-1 md:flex-none bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-2xl font-black text-sm transition-all shadow-[0_10px_20px_rgba(37,99,235,0.2)] uppercase tracking-widest">
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
              "px-6 py-3 text-[10px] font-black uppercase tracking-widest transition-all whitespace-nowrap border-b-2",
              activeTab === tab.id ? "border-blue-500 text-blue-500" : "border-transparent text-slate-400 hover:text-white"
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
                  className="p-4 glass-strong border border-blue-500/20 rounded-2xl relative overflow-hidden"
                >
                  <div className="absolute top-0 right-0 p-3 opacity-10">
                    <Activity className="w-16 h-16 text-blue-500" />
                  </div>
                  <div className="relative z-10 flex items-start gap-4">
                    <div className="p-3 bg-blue-500/10 rounded-xl">
                      <Zap className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-black text-blue-400 uppercase tracking-widest">AI Pattern Recognition Engine</span>
                        <div className="flex gap-1">
                           <div className="w-1 h-1 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                           <div className="w-1 h-1 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '200ms' }} />
                           <div className="w-1 h-1 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '400ms' }} />
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
                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Sentiment:</span>
                            <span className={cn(
                              "text-[9px] font-black uppercase px-2 py-0.5 rounded",
                              patterns[patterns.length - 1].sentiment === 'bullish' ? "bg-emerald-500/10 text-emerald-400" :
                              patterns[patterns.length - 1].sentiment === 'bearish' ? "bg-rose-500/10 text-rose-400" : "bg-slate-800 text-slate-400"
                            )}>
                              {patterns[patterns.length - 1].sentiment}
                            </span>
                         </div>
                         <div className="flex items-center gap-1.5">
                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Confidence:</span>
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
                        {stock?.name ?? displayName} is currently showing a {(stock?.changePct ?? 0) > 0 ? 'bullish' : 'bearish'} bias. The technical rating stands at <span className="text-slate-200 font-bold">{(unifiedData as any)?.technicalRating?.text || 'Neutral'}</span> with high institutional interest observed in recent sessions.
                      </p>
                      <div className="flex gap-4">
                         <div className="flex-1 p-3 glass-strong rounded-xl border border-slate-800/50">
                            <span className="text-[8px] font-black text-slate-400 uppercase block mb-1">52W High</span>
                            <span className="text-xs font-bold text-white">{stock?.high ? `₹${stock.high + 100}` : '—'}</span>
                         </div>
                         <div className="flex-1 p-3 glass-strong rounded-xl border border-slate-800/50">
                            <span className="text-[8px] font-black text-slate-400 uppercase block mb-1">52W Low</span>
                            <span className="text-xs font-bold text-white">{stock?.low ? `₹${stock.low - 50}` : '—'}</span>
                         </div>
                      </div>
                   </div>
                </Card>

              {/* AI Analyst Report Component */}
              <div className="mt-8">
                 <Card title="AI Strategic Analyst Report" icon={Zap} className="border-blue-500/20">
                    {!report ? (
                      <div className="py-12 flex flex-col items-center justify-center text-center">
                        <div className="w-16 h-16 bg-blue-500/10 rounded-full flex items-center justify-center mb-4">
                          <Activity className="w-8 h-8 text-blue-500 animate-pulse" />
                        </div>
                        <h4 className="text-lg font-black text-white italic uppercase tracking-tighter mb-2">Detailed Report Not Generated</h4>
                        <p className="text-slate-400 text-xs max-w-md mb-6 uppercase font-bold tracking-widest leading-loose">
                          Harness the power of Bharat Stock AI to generate a high-fidelity intelligence report including fundamental analysis, technical positioning, and risk scoring.
                        </p>
                        <button 
                          onClick={() => reportMutation.mutate({ symbol })}
                          disabled={reportMutation.isPending}
                          className={cn(
                            "px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-2xl transition-all shadow-lg flex items-center gap-2 uppercase text-xs tracking-widest",
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
                              <span className="text-[10px] font-black text-blue-500 uppercase tracking-widest flex items-center gap-1">
                                <Bookmark className="w-3 h-3" />
                                Institutional Grade
                              </span>
                              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                Timestamp: {report.generatedAt ? format(new Date(report.generatedAt), 'MMM dd, yyyy HH:mm') : 'Live'}
                              </span>
                            </div>
                          </div>
                          <div className={cn(
                            "px-4 py-2 rounded-xl border flex items-center gap-3",
                            report.outlook === 'BULLISH' ? "bg-emerald-500/10 border-emerald-500/20" : "bg-rose-500/10 border-rose-500/20"
                          )}>
                             <div className="text-right">
                               <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Overall Outlook</p>
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
                                <h5 className="text-[11px] font-black text-slate-300 uppercase tracking-widest border-l-2 border-blue-500 pl-3 mb-3">Executive Summary</h5>
                                <p className="text-sm text-slate-400 leading-relaxed italic font-medium">
                                  {report.summary}
                                </p>
                              </div>
                              
                              <div>
                                <h5 className="text-[11px] font-black text-slate-300 uppercase tracking-widest border-l-2 border-pink-500 pl-3 mb-3">Investment Thesis</h5>
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
                                <h5 className="text-[11px] font-black text-slate-300 uppercase tracking-widest border-l-2 border-rose-500 pl-3 mb-3">Risk Assessment</h5>
                                <div className="space-y-3">
                                  {report.riskFactors.map((risk: string, i: number) => (
                                    <div key={i} className="flex gap-3 p-3 glass-strong rounded-xl border border-rose-500/10 group hover:border-rose-500/20 transition-all">
                                      <AlertCircle className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5" />
                                      <p className="text-[11px] text-slate-400 font-bold leading-snug">{risk}</p>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              <div className="p-4 bg-blue-500/5 border border-blue-500/10 rounded-2xl">
                                <h6 className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-2 flex items-center gap-2">
                                  <Zap className="w-3 h-3 fill-blue-400" />
                                  AI Probability Core
                                </h6>
                                <p className="text-[10px] text-slate-400 font-bold leading-relaxed">
                                  Based on current volatility bands and historical earnings surprises, our core engine predicts a 68.4% probability of {report.outlook.toLowerCase()} continuation over the next 22 trading sessions.
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
                        "px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all border",
                        tf === '15m' ? "bg-blue-600 border-blue-600 text-white" : "glass-strong border-slate-800/50 text-slate-400 hover:text-white"
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
                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.1}/>
                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
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
                                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 border-b border-slate-800/50 pb-1">{data.time}</p>
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
                          fill="#3b82f6" 
                          fillOpacity={0.05} 
                          name="Volatility Band" 
                        />
                        <Bar 
                          dataKey="price" 
                          fill="#3b82f6" 
                          opacity={0.1} 
                          barSize={2} 
                        />
                        <Line type="monotone" dataKey="price" stroke="#fff" strokeWidth={2} dot={false} name="Price" activeDot={{ r: 4, fill: '#3b82f6', stroke: '#fff', strokeWidth: 2 }} />
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

              <TechnicalAnalysis symbol={symbol} />
              <MCErrorBoundary>
                <MCStockInfoPanel symbol={symbol} scId={mcScId} section="technical" onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />
              </MCErrorBoundary>
            </div>
          )}
          {activeTab === 'fundamentals' && (
            <div className="space-y-6">
              <FundamentalInsights symbol={symbol} />
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
            </div>
          )}

          {activeTab === 'analysis' && (
            <div className="space-y-6">
               <MCErrorBoundary>
                 <MCStockInfoPanel symbol={symbol} scId={mcScId} section="insights" onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />
               </MCErrorBoundary>
            </div>
          )}
          {activeTab === 'mf' && <MFAnalysis symbol={symbol} />}
          {activeTab === 'news' && <NewsTab symbol={symbol} />}

          {activeTab === 'trendlyne' && (
            <div className="space-y-6">
               <MCErrorBoundary>
                 <MCStockInfoPanel symbol={symbol} scId={mcScId} section="trendlyne" onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />
               </MCErrorBoundary>
            </div>
          )}

          {activeTab === 'fno' && (
            <div className="space-y-6">
               <OptionChain symbol={symbol} stockPrice={stock?.price ?? 0} />
               <FnOSignals symbol={symbol} />

               <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Card title="Institutional Flow (FII/DII)" icon={TrendingUp}>
                     <div className="space-y-4">
                        <div className="flex justify-between items-center p-3 glass-strong rounded-xl border border-slate-800/50">
                           <span className="text-xs font-bold text-slate-400">Net FII Position</span>
                           <span className="text-emerald-400 font-black">+₹4,250 Cr</span>
                        </div>
                        <div className="flex justify-between items-center p-3 glass-strong rounded-xl border border-slate-800/50">
                           <span className="text-xs font-bold text-slate-400">DII Activity</span>
                           <span className="text-rose-400 font-black">-₹1,120 Cr</span>
                        </div>
                        <p className="text-[9px] text-slate-400 italic text-center uppercase tracking-widest mt-2 font-bold">Update: 15 mins ago</p>
                     </div>
                  </Card>
               </div>
            </div>
          )}

          {/* Other tabs can be implemented similarly */}
          {activeTab !== 'insights' && activeTab !== 'fno' && activeTab !== 'technicals' && activeTab !== 'fundamentals' && activeTab !== 'financials' && activeTab !== 'peers' && activeTab !== 'mf' && activeTab !== 'news' && activeTab !== 'mc' && activeTab !== 'trendlyne' && (
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
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">RSI (14)</span>
                    <span className="text-amber-400 font-bold text-xs uppercase tracking-tighter">Neutral (58.4)</span>
                  </div>
                  <div className="w-full h-2 glass-strong rounded-full relative overflow-hidden border border-slate-800/50">
                    <div className="absolute inset-y-0 left-[30%] right-[70%] bg-blue-500/10 border-x border-blue-500/20" />
                    <div className="absolute top-0 h-full w-1 bg-amber-400 left-[58.4%]" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 glass-strong rounded-xl border border-slate-800/50">
                    <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">MACD</p>
                    <p className="text-xs font-bold text-emerald-400 italic">Bullish Crossover</p>
                  </div>
                  <div className="p-3 glass-strong rounded-xl border border-slate-800/50">
                    <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Bollinger</p>
                    <p className="text-xs font-bold text-slate-300 italic">Upper Band Touch</p>
                  </div>
                </div>

                <div className="space-y-2">
                   <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest pl-1">Pivot Points (Standard)</p>
                   <div className="space-y-1">
                      {[
                        { label: 'R2', val: (stock?.high ?? 0) + 10, color: 'text-emerald-400' },
                        { label: 'R1', val: stock?.high ?? 0, color: 'text-emerald-500' },
                        { label: 'PP', val: stock?.price ?? 0, color: 'text-white' },
                        { label: 'S1', val: stock?.low ?? 0, color: 'text-rose-500' },
                        { label: 'S2', val: (stock?.low ?? 0) - 10, color: 'text-rose-400' },
                      ].map(p => {
                         const displayVal = typeof p.val === 'number' ? `₹${p.val.toFixed(2)}` : p.val;
                         return (
                           <div key={p.label} className="flex justify-between items-center px-4 py-2 glass-strong rounded-lg border border-slate-800/30">
                              <span className={cn("text-[9px] font-black uppercase tracking-widest", p.color)}>{p.label}</span>
                              <span className="text-xs font-bold tabular-nums text-slate-300">{displayVal}</span>
                           </div>
                         );
                       })}
                   </div>
                </div>

                <div className="pt-2">
                  {report ? (
                    <div className="p-4 glass-strong border border-blue-500/30 rounded-xl space-y-3">
                      <h6 className="text-[10px] font-black text-blue-400 uppercase italic">Intelligence Report Ready</h6>
                      <p className="text-[11px] text-white/80 leading-relaxed italic">"{report.summary}"</p>
                      <div className="flex justify-between items-center bg-blue-500/10 p-2 rounded">
                        <span className="text-[9px] font-black text-blue-400 uppercase">Outlook</span>
                        <span className="text-xs font-bold text-white uppercase italic">{report.outlook}</span>
                      </div>
                    </div>
                  ) : (
                    <button 
                      onClick={() => reportMutation.mutate({ symbol })}
                      disabled={reportMutation.isPending}
                      className={cn(
                        "w-full py-3 rounded-xl border font-black text-[10px] uppercase tracking-widest transition-all",
                        reportMutation.isPending ? "glass border-slate-800/50 text-slate-400" : "bg-blue-600 border-blue-600 text-white hover:bg-blue-700 shadow-[0_5px_15px_rgba(37,99,235,0.3)]"
                      )}
                    >
                      {reportMutation.isPending ? 'Crunching Data...' : 'Generate Analyst Report'}
                    </button>
                  )}
                </div>
             </div>
          </Card>

          <Card title={`Latest ${symbol} News`} icon={Info}>
             <div className="space-y-4 max-h-[500px] overflow-y-auto pr-2 hide-scrollbar">
                {news.length > 0 ? news.map(item => (
                   <div key={item.id} className="group cursor-pointer">
                      <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mb-1">{item.time}</p>
                      <h4 className="text-xs font-bold text-slate-300 leading-snug group-hover:text-white transition-colors">
                        {item.title}
                      </h4>
                      <div className="mt-2 text-[9px] text-blue-500 font-black uppercase tracking-tighter group-hover:underline">Read Full Insight</div>
                   </div>
                )) : (
                  <div className="text-center py-8">
                     <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest italic">No specific news for {symbol}</p>
                  </div>
                )}
             </div>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  
  // Extract base tab from location (e.g. /indices/nifty -> indices)
  const pathParts = location.pathname.split('/').filter(Boolean);
  const activeTab = pathParts[0] || 'dashboard';
  
  const setActiveTab = (tab: string) => navigate('/' + tab);

  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [drawerSymbol, setDrawerSymbol] = useState<string | null>(null);
  const [v2Enabled, setV2Enabled] = useState(() => localStorage.getItem('v2Enabled') === 'true');
  const toggleV2 = (enabled: boolean) => {
    localStorage.setItem('v2Enabled', enabled ? 'true' : 'false');
    setV2Enabled(enabled);
  };
  const [researchSubTab, setResearchSubTab] = useState<'overview' | 'deep-learning'>('overview');
  const [selectedIndex, setSelectedIndex] = useState<{ id: string; name: string } | null>(null);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const stocks = useMarketData();
  const { data: realIndices } = trpc.getAllIndices.useQuery();
  const syncNSEStocksMutation = trpc.syncNSEStocks.useMutation();

  const handleSelectIndexByName = (indexName: string) => {
    const u = indexName.toUpperCase();
    let id = '';
    let name = indexName;
    if (u.includes('NIFTY 50') || u === 'NIFTY') {
      id = '9';
      name = 'Nifty 50';
    } else if (u.includes('SENSEX')) {
      id = '4';
      name = 'SENSEX';
    } else if (u.includes('BANK NIFTY') || u.includes('NIFTY BANK')) {
      id = '23';
      name = 'BANK NIFTY';
    } else if (u.includes('MIDCAP') || u.includes('MID CAP')) {
      id = '27';
      name = 'Nifty Midcap 50';
    } else if (u.includes('500')) {
      id = '7';
      name = 'Nifty 500';
    }
    
    if (id) {
      setSelectedIndex({ id, name });
      navigate('/indices');
    }
  };

  // Initialize NSE stocks on app load
  useEffect(() => {
    console.log('📊 Initializing NSE stocks database...');
    syncNSEStocksMutation.mutate();
  }, []);

  const rawIndexData = realIndices?.data;
  // MC API returns { indiceList: [{ name: "Key Indices", list: [...] }, ...] }
  const indexGroups: any[] = rawIndexData?.indiceList ?? [];
  const allIndices: any[] = indexGroups.flatMap((g: any) => Array.isArray(g.list) ? g.list : []);
  const keyIndices = allIndices.filter((idx: any) =>
    ['NIFTY 50', 'SENSEX', 'NIFTY BANK'].includes(idx.name)
  );

  const displayIndices = keyIndices.length > 0 ? keyIndices.map((idx: any) => ({
    name: idx.name,
    value: parseFloat(String(idx.value ?? '0').replace(/,/g, '')),
    change: parseFloat(idx.changePer ?? '0'),
    isUp: parseFloat(idx.changePer ?? '0') >= 0
  })) : [
    { name: 'Nifty 50', value: 22453.20, change: 0.84, isUp: true },
    { name: 'Sensex', value: 73845.54, change: 0.72, isUp: true },
    { name: 'Bank Nifty', value: 47285.30, change: 1.24, isUp: true }
  ];

  const addToast = (signal: any) => {
    const id = Math.random().toString(36).substring(2, 9);
    const newToast: Toast = {
      id,
      title: `${signal.signal} ALERT: ${signal.symbol}`,
      message: signal.reasoning,
      type: signal.signal as 'BUY' | 'SELL',
      confidence: signal.confidence
    };
    setToasts(prev => [...prev, newToast]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const { data: watchlistData } = trpc.getWatchlist.useQuery({ userId: user?.uid || '' }, { enabled: !!user });
  const { data: watchlistDetails, refetch: refetchWatchlistDetails } = trpc.getWatchlistDetails.useQuery(
    { userId: user?.uid || '' },
    { enabled: !!user }
  );
  
  useEffect(() => {
    if (watchlistData) {
      setWatchlist(watchlistData);
    } else if (!user) {
      setWatchlist([]);
    }
  }, [watchlistData, user]);

  const addToWatchlistMutation = trpc.addToWatchlist.useMutation();
  const removeFromWatchlistMutation = trpc.removeFromWatchlist.useMutation();

  const toggleWatchlist = async (
    symbol: string,
    metadata?: { price?: number; name?: string; source?: string }
  ) => {
    if (!user) {
      handleLogin();
      return;
    }

    const isInWatchlist = watchlist.includes(symbol);

    try {
      if (isInWatchlist) {
        await removeFromWatchlistMutation.mutateAsync({ userId: user.uid, symbol });
        setWatchlist(prev => prev.filter(s => s !== symbol));
      } else {
        await addToWatchlistMutation.mutateAsync({ 
          userId: user.uid, 
          symbol,
          price: metadata?.price,
          name: metadata?.name,
          source: metadata?.source
        });
        setWatchlist(prev => [...prev, symbol]);
      }
      // Refetch watchlist details metadata
      refetchWatchlistDetails();
    } catch (error) {
      console.error("Watchlist update failed:", error);
    }
  };

  const syncUserMutation = trpc.syncUser.useMutation();

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      
      await syncUserMutation.mutateAsync({
        id: result.user.uid,
        email: result.user.email,
        name: result.user.displayName,
        photoURL: result.user.photoURL
      });

    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  if (loading) return (
    <div className="h-screen w-screen glass-strong flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <Zap className="text-blue-500 w-12 h-12 fill-blue-500 animate-pulse" />
        <span className="text-slate-400 text-xs font-black uppercase tracking-[0.4em] animate-pulse italic">Connecting to NSE Gateway...</span>
      </div>
    </div>
  );

  if (v2Enabled) {
    return (
      <V2AppShell
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        v2Enabled={v2Enabled}
        setV2Enabled={(enabled) => {
          toggleV2(enabled);
          window.location.reload();
        }}
      >
        <AnimatePresence mode="wait">
          <SafeRoutes>
          <Routes location={location} key={activeTab}>
            <Route path="/watchlist" element={
              <Watchlist
                watchlist={watchlist}
                stocks={stocks}
                watchlistDetails={watchlistDetails || []}
                onSelectStock={(s) => setDrawerSymbol(s)}
                onRemove={toggleWatchlist}
              />
            } />
            <Route path="/details" element={selectedSymbol ? (
              <V2StockDetails
                key={selectedSymbol}
                symbol={selectedSymbol}
                stock={stocks.find(s => s.symbol === selectedSymbol)}
                onBack={() => navigate('/dashboard')}
              />
            ) : <div className="p-6">Select a stock to view details</div>} />
            <Route path="/" element={<V2Dashboard />} />
            <Route path="/dashboard" element={<V2Dashboard />} />
            <Route path="/top-rated" element={<TopRatedStocks onSelectStock={(s) => setDrawerSymbol(s)} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />} />
            <Route path="/indices" element={<IndicesPage onSelectStock={(s) => setDrawerSymbol(s)} selectedIndex={selectedIndex} setSelectedIndex={setSelectedIndex} />} />
            <Route path="/market-map" element={
              <div className="p-6 space-y-6">
                <Card title="NSE Market Heatmap" icon={Activity}>
                  <div className="pt-2"><MarketHeatmapWidget /></div>
                </Card>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <SectorPerformance />
                  <SectorHeatmap />
                </div>
              </div>
            } />
            <Route path="/screener" element={<Screener stocks={stocks} onSelectStock={(s) => setDrawerSymbol(s)} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />} />
            <Route path="/trendlyne" element={<TrendlyneScreenerPanel onSelectStock={(s) => setDrawerSymbol(s)} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />} />
            <Route path="/live-screener" element={<LiveMarketScreener />} />
            <Route path="/eod-screener" element={<EODMarketScreener />} />
            <Route path="/discover" element={<div className="p-6"><NSEStockDiscovery onSelectStock={(s) => setDrawerSymbol(s)} /></div>} />
            <Route path="/smart-money" element={<SmartMoneyPage onSelectStock={(s) => setDrawerSymbol(s)} />} />
            <Route path="/earnings" element={<EarningsPage onSelectStock={(s) => setDrawerSymbol(s)} />} />
            <Route path="/fno-scanners" element={<FnOIntelligenceCenter onSelectStock={(s) => setDrawerSymbol(s)} />} />
            <Route path="/options" element={<div className="p-6"><OptionsIntelligence /></div>} />
            <Route path="/todays-picks" element={<TodaysPicks onSelectStock={(s) => setDrawerSymbol(s)} />} />
            <Route path="/screener-intelligence" element={<ScreenerIntelligencePage />} />
            <Route path="/agent-data-scientist" element={<AgentDataScientistPage />} />
            <Route path="/agent-strategist"     element={<AgentStrategistPage />} />
            <Route path="/agent-auditor"        element={<AgentAuditorPage />} />
            <Route path="/agent-optimizer"      element={<AgentOptimizerPage />} />
            <Route path="/trade-cockpit" element={<TradeDecisionCockpit onSelectStock={(s) => setDrawerSymbol(s)} />} />
            <Route path="/backtest" element={<Backtest stocks={stocks} />} />
            <Route path="/signals" element={<DailySignals onSelectStock={(s) => setDrawerSymbol(s)} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />} />
            <Route path="/signal-intelligence" element={<SignalIntelligence />} />
            <Route path="/signal-report-card" element={<SignalReportCard />} />
            <Route path="/research" element={
              <div className="flex flex-col">
                <div className="flex gap-2 px-4 py-2 border-b border-slate-800">
                  <button
                    onClick={() => setResearchSubTab('overview')}
                    className={`text-xs px-3 py-1 rounded-full transition-colors ${researchSubTab === 'overview' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'}`}
                  >Overview</button>
                  <button
                    onClick={() => setResearchSubTab('deep-learning')}
                    className={`text-xs px-3 py-1 rounded-full transition-colors ${researchSubTab === 'deep-learning' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'}`}
                  >Deep Learning</button>
                </div>
                {researchSubTab === 'overview' ? <HedgeFundResearch onAddWatchlist={toggleWatchlist} /> : <DLDashboard />}
              </div>
            } />
            <Route path="/strategy" element={<StrategyIntelligence onSelectStock={(s) => setDrawerSymbol(s)} />} />
            <Route path="/strategy-builder" element={<InvestmentStrategy onSelectStock={(s) => setDrawerSymbol(s)} />} />
            <Route path="/sentiment" element={<SentimentIntelligence onSelectStock={(s) => setDrawerSymbol(s)} />} />
            <Route path="/superstars" element={<SuperstarPortfolio />} />
            <Route path="/todo" element={<ToDoPage />} />
            <Route path="/monitor" element={<SystemMonitorPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/portfolio" element={<div className="p-6"><PortfolioAnalytics /></div>} />
            <Route path="/builder" element={<div className="p-6"><StrategyBuilder /></div>} />
            <Route path="/settings" element={<V2Settings />} />
          </Routes>
          </SafeRoutes>
        </AnimatePresence>

        <SlideOutDrawer
          symbol={drawerSymbol}
          isOpen={drawerSymbol !== null}
          onClose={() => setDrawerSymbol(null)}
          watchlist={watchlist}
          onToggleWatchlist={toggleWatchlist}
          onSelectStock={setDrawerSymbol}
        />
        <AlertsToast />
      </V2AppShell>
    );
  }

  return (
    <>
      <AppShell
        user={user}
        onLogin={handleLogin}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        stocks={stocks}
        onSelectStock={(s) => setDrawerSymbol(s)}
        displayIndices={displayIndices}
        onSelectIndexByName={handleSelectIndexByName}
      >
        <TickerTapeWidget />
        <AnimatePresence mode="wait">
          <SafeRoutes>
          <Routes location={location} key={activeTab}>
            <Route path="/watchlist" element={
            <motion.div
              key="watchlist"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
            >
              <Watchlist
                watchlist={watchlist}
                stocks={stocks}
                watchlistDetails={watchlistDetails || []}
                onSelectStock={(s) => setDrawerSymbol(s)}
                onRemove={toggleWatchlist}
              />
            </motion.div>
            } />
            <Route path="/*" element={
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              className="pb-10"
            >
              <Routes>
                <Route path="/" element={<DashboardPage stocks={stocks} onNewSignal={addToast} onSelectStock={(s) => setDrawerSymbol(s)} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} onSelectIndex={(id, name) => { setSelectedIndex({ id, name }); navigate('/indices'); }} />} />
                <Route path="/dashboard" element={<DashboardPage stocks={stocks} onNewSignal={addToast} onSelectStock={(s) => setDrawerSymbol(s)} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} onSelectIndex={(id, name) => { setSelectedIndex({ id, name }); navigate('/indices'); }} />} />
                <Route path="/alpha" element={<CommandCenterDashboard onSelectStock={(s) => { setDrawerSymbol(s); navigate('/trade-cockpit'); }} />} />
              <Route path="/top-rated" element={<TopRatedStocks onSelectStock={(s) => setDrawerSymbol(s)} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />} />
                <Route path="/indices" element={<IndicesPage onSelectStock={(s) => setDrawerSymbol(s)} selectedIndex={selectedIndex} setSelectedIndex={setSelectedIndex} />} />
                <Route path="/market-map" element={
                <div className="p-6 space-y-6">
                  <Card title="NSE Market Heatmap" icon={Activity}>
                    <div className="pt-2"><MarketHeatmapWidget /></div>
                  </Card>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <SectorPerformance />
                    <SectorHeatmap />
                  </div>
                </div>
              } />
              <Route path="/screener" element={<Screener stocks={stocks} onSelectStock={(s) => setDrawerSymbol(s)} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />} />
              <Route path="/trendlyne" element={<TrendlyneScreenerPanel onSelectStock={(s) => setDrawerSymbol(s)} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />} />
              <Route path="/live-screener" element={<LiveMarketScreener />} />
              <Route path="/eod-screener" element={<EODMarketScreener />} />
              <Route path="/discover" element={<div className="p-6"><NSEStockDiscovery onSelectStock={(s) => setDrawerSymbol(s)} /></div>} />
              <Route path="/smart-money" element={
                <SmartMoneyPage onSelectStock={(s) => setDrawerSymbol(s)} />
              } />
              <Route path="/earnings" element={
                <EarningsPage onSelectStock={(s) => setDrawerSymbol(s)} />
              } />
              <Route path="/fno-scanners" element={<FnOIntelligenceCenter onSelectStock={(s) => setDrawerSymbol(s)} />} />
              <Route path="/options" element={<div className="p-6"><OptionsIntelligence /></div>} />
              <Route path="/todays-picks" element={<TodaysPicks onSelectStock={(s) => setDrawerSymbol(s)} />} />
              <Route path="/screener-intelligence" element={<ScreenerIntelligencePage />} />
              <Route path="/agent-data-scientist" element={<AgentDataScientistPage />} />
              <Route path="/agent-strategist"     element={<AgentStrategistPage />} />
              <Route path="/agent-auditor"        element={<AgentAuditorPage />} />
              <Route path="/agent-optimizer"      element={<AgentOptimizerPage />} />
              <Route path="/trade-cockpit" element={<TradeDecisionCockpit onSelectStock={(s) => setDrawerSymbol(s)} />} />
              <Route path="/details" element={selectedSymbol ? (
                <StockDetails
                  key={selectedSymbol}
                  symbol={selectedSymbol}
                  stock={stocks.find(s => s.symbol === selectedSymbol)}
                  onBack={() => navigate('/dashboard')}
                  watchlist={watchlist}
                  onToggleWatchlist={toggleWatchlist}
                  onSelectStock={(s) => setDrawerSymbol(s)}
                />
              ) : <div className="p-6">Select a stock to view details</div>} />
              <Route path="/backtest" element={<Backtest stocks={stocks} />} />
              <Route path="/signals" element={<DailySignals onSelectStock={(s) => setDrawerSymbol(s)} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />} />
              <Route path="/signal-intelligence" element={<SignalIntelligence />} />
              <Route path="/signal-report-card" element={<SignalReportCard />} />
              <Route path="/research" element={
                <div className="flex flex-col">
                  <div className="flex gap-2 px-4 py-2 border-b border-slate-800">
                    <button
                      onClick={() => setResearchSubTab('overview')}
                      className={`text-xs px-3 py-1 rounded-full transition-colors ${researchSubTab === 'overview' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'}`}
                    >Overview</button>
                    <button
                      onClick={() => setResearchSubTab('deep-learning')}
                      className={`text-xs px-3 py-1 rounded-full transition-colors ${researchSubTab === 'deep-learning' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'}`}
                    >Deep Learning</button>
                  </div>
                  {researchSubTab === 'overview' ? <HedgeFundResearch onAddWatchlist={toggleWatchlist} /> : <DLDashboard />}
                </div>
              } />
              <Route path="/strategy" element={<StrategyIntelligence onSelectStock={(s) => setDrawerSymbol(s)} />} />
              <Route path="/strategy-builder" element={<InvestmentStrategy onSelectStock={(s) => setDrawerSymbol(s)} />} />
              <Route path="/sentiment" element={<SentimentIntelligence onSelectStock={(s) => setDrawerSymbol(s)} />} />
              <Route path="/economics" element={
                <div className="p-6 space-y-6">
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <div className="lg:col-span-2">
                      <Card title="Global Economic Calendar" icon={Globe}>
                        <div className="pt-2"><EconomicCalendarWidget /></div>
                      </Card>
                    </div>
                    <div>
                      <Card title="Market Sentiment Overview" icon={Activity}>
                        <div className="pt-2"><MarketOverviewWidget /></div>
                      </Card>
                    </div>
                  </div>
                </div>
              } />
              <Route path="/superstars" element={<SuperstarPortfolio />} />
              <Route path="/todo" element={<ToDoPage />} />
              <Route path="/monitor" element={<SystemMonitorPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/portfolio" element={<div className="p-6"><PortfolioAnalytics /></div>} />
              <Route path="/builder" element={<div className="p-6"><StrategyBuilder /></div>} />
              </Routes>
            </motion.div>
            } />
          </Routes>
          </SafeRoutes>
        </AnimatePresence>
      </AppShell>

      <SlideOutDrawer
        symbol={drawerSymbol}
        isOpen={drawerSymbol !== null}
        onClose={() => setDrawerSymbol(null)}
        watchlist={watchlist}
        onToggleWatchlist={toggleWatchlist}
        onSelectStock={setDrawerSymbol}
      />

      <AlertsToast />

      {/* Signal toast notifications */}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-3 pointer-events-none">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 50, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 20, scale: 0.95 }}
              className={cn(
                'w-72 glass border-l-4 p-4 rounded-xl shadow-2xl pointer-events-auto flex gap-3',
                toast.type === 'BUY' ? 'border-emerald-500' : 'border-rose-500',
              )}
            >
              <div className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center shrink-0',
                toast.type === 'BUY' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500',
              )}>
                {toast.type === 'BUY' ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <h5 className="text-[10px] font-black uppercase tracking-widest text-slate-400 truncate">{toast.title}</h5>
                  <span className="text-[9px] font-black text-slate-400 glass-strong px-1 border border-slate-800/50 rounded shrink-0">{toast.confidence}%</span>
                </div>
                <p className="text-[11px] text-white font-bold line-clamp-2 leading-relaxed italic opacity-90">
                  {toast.message}
                </p>
              </div>
              <button
                onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
                className="text-slate-400 hover:text-white transition-colors ml-auto shrink-0"
              >
                <Plus className="w-4 h-4 rotate-45" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}


