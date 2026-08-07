
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import {
  TrendingUp, TrendingDown,
  AlertCircle, Activity, Zap,
  Globe, Plus
} from 'lucide-react';

import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { auth } from './lib/firebase';
import { 
  signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User as FirebaseUser 
} from 'firebase/auth';

import { useMarketData } from './services/marketService';

import { trpc } from './lib/trpc';
import { captureException } from './lib/sentry';
import { AppShell } from './components/AppShell';
import { TickerTapeWidget } from './components/TradingViewWidgets';
import { SlideOutDrawer } from './components/SlideOutDrawer';
import { AlertsToast } from './components/AlertsToast';
import { PageFallback } from './components/PageFallback';

// --- V1 Routes ---
import V1Routes from './v1/V1Routes';

// ─── V2+ Components ─────────────────
const V2AppShell         = React.lazy(() => import('./v2/components/layout/V2AppShell').then(m => ({ default: m.V2AppShell })));
const V6Shell            = React.lazy(() => import('./v6/V6Shell').then(m => ({ default: m.V6Shell })));
// Phase 2 of the frontend consolidation ("V6 Canonical Workbench" proposal): v5's desk-page
// implementations, swapped in only for dashboardVersion==='v6' -- v1/v2/v3 keep their existing
// pages exactly as-is, matching the "gradual, default now, delete later" rollout.
const OptionsDeskPage         = React.lazy(() => import('./v5/pages/OptionsDeskPage').then(m => ({ default: m.OptionsDeskPage })));
const InstitutionalFlowDeskPage = React.lazy(() => import('./v5/pages/InstitutionalFlowDeskPage').then(m => ({ default: m.InstitutionalFlowDeskPage })));
const EarningsPulseDeskPage   = React.lazy(() => import('./v5/pages/EarningsPulseDeskPage').then(m => ({ default: m.EarningsPulseDeskPage })));
const SignalReviewPage        = React.lazy(() => import('./v5/pages/SignalReviewPage').then(m => ({ default: m.SignalReviewPage })));
const RiskDeskPage            = React.lazy(() => import('./v5/pages/RiskDeskPage').then(m => ({ default: m.RiskDeskPage })));
// RiskMetricsDashboard.tsx was fully built and wired to real procedures (getMultiFactorScores,
// getRiskMetrics, getRiskDistribution, getRegimeSummary) but had NO route pointing at it at all
// -- found 2026-08-07 during the version-consolidation review. Ships at /risk now (v1/v2/v3's
// non-v6 fallback; v6 gets v5's RiskDeskPage, the stronger of the two independent
// implementations of the same four procedures).
const RiskMetricsDashboard    = React.lazy(() => import('./components/RiskMetricsDashboard').then(m => ({ default: m.RiskMetricsDashboard })));
const V2StockDetails     = React.lazy(() => import('./v2/views/stock-analysis/V2StockDetails').then(m => ({ default: m.V2StockDetails })));
const V2Settings         = React.lazy(() => import('./v2/views/settings/V2Settings').then(m => ({ default: m.V2Settings })));
const V2Dashboard        = React.lazy(() => import('./v2/views/dashboard/V2Dashboard').then(m => ({ default: m.V2Dashboard })));
const V3Dashboard        = React.lazy(() => import('./v3/views/dashboard/V3Dashboard').then(m => ({ default: m.V3Dashboard })));
const MarketCommandCenter = React.lazy(() => import('./v4/views/MarketCommandCenter').then(m => ({ default: m.MarketCommandCenter })));
const StockIntelligencePage = React.lazy(() => import('./v4/views/StockIntelligencePage').then(m => ({ default: m.StockIntelligencePage })));
const V2SignalTracking   = React.lazy(() => import('./v2/views/signals/V2SignalTracking').then(m => ({ default: m.V2SignalTracking })));
const ScreenerPage_v2    = React.lazy(() => import('./v2/views/screener/ScreenerPage').then(m => ({ default: m.ScreenerPage })));
const TopRatedStocks          = React.lazy(() => import('./components/TopRatedStocks'));
const IntradayPage       = React.lazy(() => import('./components/IntradayPage'));
const IndicesPage        = React.lazy(() => import('./components/IndicesPage').then(m => ({ default: m.IndicesPage })));
const SectorPerformance = React.lazy(() => import('./components/SectorIntelligence').then(m => ({ default: m.SectorPerformance })));
const SectorHeatmap = React.lazy(() => import('./components/SectorIntelligence').then(m => ({ default: m.SectorHeatmap })));
const SectorAdvanceDecline = React.lazy(() => import('./components/SectorIntelligence').then(m => ({ default: m.SectorAdvanceDecline })));
const SectorConstituents = React.lazy(() => import('./components/SectorIntelligence').then(m => ({ default: m.SectorConstituents })));
const SmartMoneyPage          = React.lazy(() => import('./components/SmartMoneyPage'));
const EarningsPage            = React.lazy(() => import('./components/EarningsPage'));
const FnOIntelligenceCenter   = React.lazy(() => import('./components/FnOIntelligenceCenter'));
const OptionsIntelligence     = React.lazy(() => import('./components/OptionsIntelligence'));
const TodaysPicks             = React.lazy(() => import('./components/TodaysPicks').then(m => ({ default: m.TodaysPicks })));
const EarlyHoursSpotter   = React.lazy(() => import('./components/EarlyHoursSpotter'));
const ScreenerIntelligencePage = React.lazy(() => import('./components/ScreenerIntelligencePage').then(m => ({ default: m.ScreenerIntelligencePage })));
const AgentDataScientistPage   = React.lazy(() => import('./components/AgentDataScientistPage').then(m => ({ default: m.AgentDataScientistPage })));
const AgentStrategistPage      = React.lazy(() => import('./components/AgentStrategistPage').then(m => ({ default: m.AgentStrategistPage })));
const AgentAuditorPage         = React.lazy(() => import('./components/AgentAuditorPage').then(m => ({ default: m.AgentAuditorPage })));
const AgentOptimizerPage       = React.lazy(() => import('./components/AgentOptimizerPage').then(m => ({ default: m.AgentOptimizerPage })));
const TradeDecisionCockpit    = React.lazy(() => import('./components/TradeDecisionCockpit'));
const DailySignals       = React.lazy(() => import('./components/DailySignals').then(m => ({ default: m.DailySignals })));
const SignalIntelligence      = React.lazy(() => import('./components/SignalIntelligence'));
const SignalReportCard        = React.lazy(() => import('./components/SignalReportCard').then(m => ({ default: m.SignalReportCard })));
const HedgeFundResearch       = React.lazy(() => import('./components/HedgeFundResearch'));
const DLDashboard             = React.lazy(() => import('./components/DLDashboard'));
const StrategyIntelligence = React.lazy(() => import('./components/StrategyIntelligence').then(m => ({ default: m.StrategyIntelligence })));
const HighConvictionPage = React.lazy(() => import('./components/HighConvictionPage').then(m => ({ default: m.HighConvictionPage })));
const InvestmentStrategy = React.lazy(() => import('./components/InvestmentStrategy').then(m => ({ default: m.InvestmentStrategy })));
const SentimentIntelligence = React.lazy(() => import('./components/SentimentIntelligence').then(m => ({ default: m.SentimentIntelligence })));
const SuperstarPortfolio      = React.lazy(() => import('./components/SuperstarPortfolio'));
const ToDoPage           = React.lazy(() => import('./components/ToDoPage').then(m => ({ default: m.ToDoPage })));
const SystemMonitorPage       = React.lazy(() => import('./components/SystemMonitorPage'));
const JobsDashboardPage   = React.lazy(() => import('./components/JobsDashboardPage'));
const ProfilePage             = React.lazy(() => import('./components/ProfilePage'));
const PortfolioAnalytics      = React.lazy(() => import('./components/PortfolioAnalytics'));
const StrategyBuilder         = React.lazy(() => import('./components/StrategyBuilder'));
const StockChatbot       = React.lazy(() => import('./components/StockChatbot'));
const CommandCenterDashboard   = React.lazy(() => import('./components/CommandCenterDashboard').then(m => ({ default: m.CommandCenterDashboard })));
const ExportPortfolioView      = React.lazy(() => import('./components/ExportPortfolioView'));
const MoneyFlowPage      = React.lazy(() => import('./components/MoneyFlowPage').then(m => ({ default: m.MoneyFlowPage })));
const MacroDashboard = React.lazy(() => import('./components/MacroDashboard').then(m => ({ default: m.MacroDashboard })));
const CorporateEventsPanel = React.lazy(() => import('./components/CorporateEventsPanel').then(m => ({ default: m.CorporateEventsPanel })));
const EconomicCalendarWidget = React.lazy(() => import('./components/TradingViewWidgets').then(m => ({ default: m.EconomicCalendarWidget })));
const MarketOverviewWidget = React.lazy(() => import('./components/TradingViewWidgets').then(m => ({ default: m.MarketOverviewWidget })));
const Card = React.lazy(() => import('./components/Card').then(m => ({ default: m.Card })));
const PriceAlertsPanel = React.lazy(() => import('./components/PriceAlertsPanel').then(m => ({ default: m.PriceAlertsPanel })));
const Watchlist = React.lazy(() => import('./components/Watchlist').then(m => ({ default: m.Watchlist })));
const V1Screener = React.lazy(() => import('./components/V1Screener').then(m => ({ default: m.V1Screener })));
const TrendlyneScreenerPanel = React.lazy(() => import('./components/TrendlyneScreenerPanel'));
const PremiumScreenersPage = React.lazy(() => import('./components/PremiumScreenersPage'));
const LiveMarketScreener = React.lazy(() => import('./components/LiveMarketScreener').then(m => ({ default: m.LiveMarketScreener })));
const EODMarketScreener = React.lazy(() => import('./components/EODMarketScreener').then(m => ({ default: m.EODMarketScreener })));
const NSEStockDiscovery = React.lazy(() => import('./components/NSEStockDiscovery'));
const V1Backtest = React.lazy(() => import('./components/V1Backtest').then(m => ({ default: m.V1Backtest })));


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
  componentDidCatch(error: Error) {
    const isChunkError = CHUNK_LOAD_ERRORS.some(msg => error.message?.includes(msg));
    if (!isChunkError) captureException(error, { boundary: 'TabErrorBoundary', path: window.location.pathname });
  }
  componentDidUpdate(_: unknown, prev: { isChunkError: boolean }) {
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

interface Toast {
  id: string;
  title: string;
  message: string;
  type: 'BUY' | 'SELL';
  confidence: number;
}

const FALLBACK_INDICES = [
  { name: 'Nifty 50', value: 22453.20, change: 0.84, isUp: true },
  { name: 'Sensex', value: 73845.54, change: 0.72, isUp: true },
  { name: 'Bank Nifty', value: 47285.30, change: 1.24, isUp: true },
];

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  
  const pathParts = location.pathname.split('/').filter(Boolean);
  const activeTab = pathParts[0] || 'dashboard';
  
  const setActiveTab = (tab: string) => navigate('/' + tab);

  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [drawerSymbol, setDrawerSymbol] = useState<string | null>(null);
  // 'v6' = the Phase 1 consolidation shell (V6Shell, see src/v6/) -- not yet the default; reachable
  // via the version switcher in every other shell until the phased rollout (see the "V6 Canonical
  // Workbench" proposal) promotes it. Renders through the same v2Enabled route tree as v2/v3 so it
  // inherits every existing page for free -- only the shell chrome differs.
  const [dashboardVersion, setDashboardVersion] = useState<'v1' | 'v2' | 'v3' | 'v6'>(() => {
    const saved = localStorage.getItem('dashboardVersion');
    if (saved === 'v1' || saved === 'v2' || saved === 'v3' || saved === 'v6') return saved;
    const v2 = localStorage.getItem('v2Enabled') === 'true';
    return v2 ? 'v2' : 'v3'; // Default to v3
  });
  const changeDashboardVersion = (version: 'v1' | 'v2' | 'v3' | 'v6') => {
    localStorage.setItem('dashboardVersion', version);
    localStorage.setItem('v2Enabled', version !== 'v1' ? 'true' : 'false');
    setDashboardVersion(version);
  };
  const v2Enabled = dashboardVersion === 'v2' || dashboardVersion === 'v3' || dashboardVersion === 'v6';
  const [researchSubTab, setResearchSubTab] = useState<'overview' | 'deep-learning'>('overview');
  const [selectedIndex, setSelectedIndex] = useState<{ id: string; name: string } | null>(null);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const { stocks, dataUpdatedAt: stocksUpdatedAt } = useMarketData();
  const { data: realIndices } = trpc.getAllIndices.useQuery();

  const handleSelectIndexByName = useCallback((indexName: string) => {
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
  }, [navigate]);

  const displayIndices = useMemo(() => {
    const rawIndexData = realIndices?.data;
    const indexGroups: any[] = rawIndexData?.indiceList ?? [];
    const allIndices: any[] = indexGroups.flatMap((g: any) => Array.isArray(g.list) ? g.list : []);
    const keyIndices = allIndices.filter((idx: any) =>
      ['NIFTY 50', 'SENSEX', 'NIFTY BANK'].includes(idx.name)
    );
    if (keyIndices.length === 0) return FALLBACK_INDICES;
    return keyIndices.map((idx: any) => ({
      name: idx.name,
      value: parseFloat(String(idx.value ?? '0').replace(/,/g, '')),
      change: parseFloat(idx.changePer ?? '0'),
      isUp: parseFloat(idx.changePer ?? '0') >= 0,
    }));
  }, [realIndices]);

  const addToast = useCallback((signal: any) => {
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
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const { data: watchlistData } = trpc.getWatchlist.useQuery(undefined, { enabled: !!user });
  const { data: watchlistDetails, refetch: refetchWatchlistDetails } = trpc.getWatchlistDetails.useQuery(
    undefined,
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
  const syncUserMutation = trpc.syncUser.useMutation();

  const handleLogin = useCallback(async () => {
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
  }, [syncUserMutation]);

  const toggleWatchlist = useCallback(async (
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
        await removeFromWatchlistMutation.mutateAsync({ symbol });
        setWatchlist(prev => prev.filter(s => s !== symbol));
      } else {
        await addToWatchlistMutation.mutateAsync({
          symbol,
          price: metadata?.price,
          name: metadata?.name,
          source: metadata?.source
        });
        setWatchlist(prev => [...prev, symbol]);
      }
      refetchWatchlistDetails();
    } catch (error) {
      console.error("Watchlist update failed:", error);
    }
  }, [user, watchlist, handleLogin, removeFromWatchlistMutation, addToWatchlistMutation, refetchWatchlistDetails]);

  const handleSelectStock = useCallback((s: string) => setDrawerSymbol(s), []);

  if (loading) return (
    <div className="h-screen w-screen glass-strong flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <Zap className="text-blue-500 w-12 h-12 fill-blue-500 animate-pulse" />
        <span className="text-slate-400 text-xs font-black uppercase tracking-[0.4em] animate-pulse italic">Connecting to NSE Gateway...</span>
      </div>
    </div>
  );

  if (v2Enabled) {
    // Shared by both the V2AppShell (v2/v3) and V6Shell (Phase 1 consolidation) branches below --
    // one route tree, rendered inside whichever shell chrome dashboardVersion selects. This is
    // exactly the reuse the "V6 Canonical Workbench" proposal's Phase 1 calls for: v6 inherits
    // every existing page for free rather than needing its own duplicate route definitions.
    const routedContent = (
      <>
        <AnimatePresence mode="wait">
          <SafeRoutes>
          <Routes location={location} key={activeTab}>
            <Route path="/watchlist" element={
              <div className="space-y-6">
                <Watchlist
                  watchlist={watchlist}
                  stocks={stocks}
                  watchlistDetails={watchlistDetails || []}
                  onSelectStock={handleSelectStock}
                  onRemove={toggleWatchlist}
                />
                <PriceAlertsPanel userId={user?.uid} />
              </div>
            } />
            <Route path="/market-command" element={
              <MarketCommandCenter
                onSelectStock={handleSelectStock}
                onSelectIndex={(id, name) => { setSelectedIndex({ id, name }); navigate('/indices'); }}
              />
            } />
            <Route path="/stock-intelligence-hub" element={
              <StockIntelligencePage
                initialSymbol={selectedSymbol}
                watchlist={watchlist}
                onToggleWatchlist={toggleWatchlist}
              />
            } />
            <Route path="/details" element={selectedSymbol ? (
              // v6 reuses v3's stock-detail view as a Phase 1 placeholder -- the merged
              // canonical stock-research page (Phase 3 of the consolidation) replaces this.
              (dashboardVersion === 'v3' || dashboardVersion === 'v6') ? (
                <V3Dashboard
                  stocks={stocks}
                  watchlist={watchlist}
                  onToggleWatchlist={toggleWatchlist}
                  onSelectStock={handleSelectStock}
                  onSelectIndex={(id, name) => { setSelectedIndex({ id, name }); navigate('/indices'); }}
                  initialSymbol={selectedSymbol}
                  initialTab="stock-intelligence"
                />
              ) : (
                <V2StockDetails
                  key={selectedSymbol}
                  symbol={selectedSymbol}
                  stock={stocks.find(s => s.symbol === selectedSymbol)}
                  onBack={() => navigate('/dashboard')}
                />
              )
            ) : <div className="p-6">Select a stock to view details</div>} />
            <Route path="/" element={
              // v6's real composed home page is Phase 3 of the consolidation; until then it
              // reuses v3's dashboard as a placeholder, matching /details and /dashboard below.
              (dashboardVersion === 'v3' || dashboardVersion === 'v6') ? (
                <V3Dashboard
                  stocks={stocks}
                  watchlist={watchlist}
                  onToggleWatchlist={toggleWatchlist}
                  onSelectStock={handleSelectStock}
                  onSelectIndex={(id, name) => { setSelectedIndex({ id, name }); navigate('/indices'); }}
                />
              ) : (
                <V2Dashboard />
              )
            } />
            <Route path="/dashboard" element={
              (dashboardVersion === 'v3' || dashboardVersion === 'v6') ? (
                <V3Dashboard
                  stocks={stocks}
                  watchlist={watchlist}
                  onToggleWatchlist={toggleWatchlist}
                  onSelectStock={handleSelectStock}
                  onSelectIndex={(id, name) => { setSelectedIndex({ id, name }); navigate('/indices'); }}
                />
              ) : (
                <V2Dashboard />
              )
            } />
            <Route path="/top-rated" element={<TopRatedStocks onSelectStock={handleSelectStock} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />} />
            <Route path="/intraday" element={<IntradayPage onSelectStock={handleSelectStock} />} />
            <Route path="/indices" element={<IndicesPage onSelectStock={handleSelectStock} selectedIndex={selectedIndex} setSelectedIndex={setSelectedIndex} />} />
            <Route path="/market-map" element={
              <div className="p-6 space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <SectorPerformance />
                  <SectorHeatmap />
                </div>
                <SectorAdvanceDecline />
                <SectorConstituents onSelectStock={handleSelectStock} />
              </div>
            } />
            <Route path="/screener" element={<V1Screener stocks={stocks} onSelectStock={handleSelectStock} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />} />
            <Route path="/screener-v2" element={<ScreenerPage_v2 />} />
            <Route path="/trendlyne" element={<TrendlyneScreenerPanel onSelectStock={handleSelectStock} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />} />
            <Route path="/premium-screeners" element={<PremiumScreenersPage onSelectStock={handleSelectStock} />} />
            <Route path="/live-screener" element={<LiveMarketScreener onSelectStock={handleSelectStock} />} />
            <Route path="/eod-screener" element={<EODMarketScreener onSelectStock={handleSelectStock} />} />
            <Route path="/discover" element={<div className="p-6"><NSEStockDiscovery onSelectStock={handleSelectStock} /></div>} />
            <Route path="/smart-money" element={
              dashboardVersion === 'v6'
                ? <InstitutionalFlowDeskPage onSelectSymbol={handleSelectStock} />
                : <SmartMoneyPage onSelectStock={handleSelectStock} />
            } />
            <Route path="/earnings" element={
              dashboardVersion === 'v6'
                ? <EarningsPulseDeskPage onSelectSymbol={handleSelectStock} />
                : <EarningsPage onSelectStock={handleSelectStock} />
            } />
            <Route path="/fno-scanners" element={<FnOIntelligenceCenter onSelectStock={handleSelectStock} />} />
            <Route path="/options" element={
              dashboardVersion === 'v6'
                ? <OptionsDeskPage onSelectSymbol={handleSelectStock} />
                : <div className="p-6"><OptionsIntelligence /></div>
            } />
            <Route path="/risk" element={
              dashboardVersion === 'v6'
                ? <RiskDeskPage onSelectSymbol={handleSelectStock} />
                : <div className="p-6"><RiskMetricsDashboard /></div>
            } />
            <Route path="/todays-picks" element={<TodaysPicks onSelectStock={handleSelectStock} />} />
            <Route path="/early-spotter" element={<EarlyHoursSpotter onSelectStock={handleSelectStock} />} />
            <Route path="/screener-intelligence" element={<ScreenerIntelligencePage />} />
            <Route path="/agent-data-scientist" element={<AgentDataScientistPage />} />
            <Route path="/agent-strategist"     element={<AgentStrategistPage />} />
            <Route path="/agent-auditor"        element={<AgentAuditorPage />} />
            <Route path="/agent-optimizer"      element={<AgentOptimizerPage />} />
            <Route path="/trade-cockpit" element={<TradeDecisionCockpit onSelectStock={handleSelectStock} />} />
            <Route path="/backtest" element={<V1Backtest stocks={stocks} />} />
            {/* v5's SignalReviewPage consolidates all 3 of these into one page (queue stats,
                report card, and the tracking ledger together) -- the strongest single UX call
                in v5, per the consolidation review. v1/v2/v3 keep the 3 separate pages; the
                routes stay resolvable either way so no existing bookmark/link breaks. */}
            <Route path="/signals" element={
              dashboardVersion === 'v6'
                ? <SignalReviewPage onSelectSymbol={handleSelectStock} />
                : <DailySignals onSelectStock={handleSelectStock} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />
            } />
            <Route path="/signal-tracking" element={
              dashboardVersion === 'v6' ? <SignalReviewPage onSelectSymbol={handleSelectStock} /> : <V2SignalTracking />
            } />
            <Route path="/signal-intelligence" element={<SignalIntelligence />} />
            <Route path="/signal-report-card" element={
              dashboardVersion === 'v6' ? <SignalReviewPage onSelectSymbol={handleSelectStock} /> : <SignalReportCard />
            } />
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
            <Route path="/strategy" element={<StrategyIntelligence onSelectStock={handleSelectStock} />} />
            <Route path="/best-picks" element={<HighConvictionPage onSelectStock={handleSelectStock} />} />
            <Route path="/strategy-builder" element={<InvestmentStrategy onSelectStock={handleSelectStock} />} />
            <Route path="/sentiment" element={<SentimentIntelligence onSelectStock={handleSelectStock} />} />
            <Route path="/superstars" element={<SuperstarPortfolio />} />
            <Route path="/todo" element={<ToDoPage />} />
            <Route path="/monitor" element={<SystemMonitorPage />} />
            <Route path="/jobs" element={<JobsDashboardPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/portfolio" element={<div className="p-6"><PortfolioAnalytics /></div>} />
            <Route path="/builder" element={<div className="p-6"><StrategyBuilder /></div>} />
            <Route path="/export-picks" element={<div className="p-6"><ExportPortfolioView /></div>} />
            <Route path="/settings" element={<V2Settings />} />
            <Route path="/chat" element={<div className="p-4 h-full"><StockChatbot /></div>} />
            <Route path="/alpha-cockpit" element={<Navigate to="/alpha" replace />} />
            <Route path="/alpha" element={<CommandCenterDashboard onSelectStock={(s) => { setDrawerSymbol(s); navigate('/trade-cockpit'); }} />} />
            <Route path="/buy-recs" element={<Navigate to="/alpha" replace />} />
            <Route path="/money-flow" element={<MoneyFlowPage />} />
            <Route path="/economics" element={
              <div className="p-6 space-y-6">
                <MacroDashboard />
                <CorporateEventsPanel onSelectStock={handleSelectStock} />
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
        <AlertsToast userId={user?.uid} />
      </>
    );

    if (dashboardVersion === 'v6') {
      return (
        <V6Shell
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          dashboardVersion={dashboardVersion}
          onChangeVersion={(v) => {
            changeDashboardVersion(v);
            window.location.reload();
          }}
        >
          {routedContent}
        </V6Shell>
      );
    }

    return (
      <V2AppShell
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        v2Enabled={v2Enabled}
        setV2Enabled={(enabled) => {
          changeDashboardVersion(enabled ? 'v2' : 'v1');
          window.location.reload();
        }}
        dashboardVersion={dashboardVersion}
        onChangeVersion={(v) => {
          changeDashboardVersion(v);
          window.location.reload();
        }}
      >
        {routedContent}
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
        onSelectStock={handleSelectStock}
        displayIndices={displayIndices}
        onSelectIndexByName={handleSelectIndexByName}
        dataUpdatedAt={stocksUpdatedAt}
      >
        <TickerTapeWidget />
        <AnimatePresence mode="wait">
          <SafeRoutes>
            <V1Routes
                stocks={stocks}
                watchlist={watchlist}
                watchlistDetails={watchlistDetails}
                onToggleWatchlist={toggleWatchlist}
                onSelectStock={handleSelectStock}
                addToast={addToast}
                setSelectedIndex={setSelectedIndex}
                selectedIndex={selectedIndex}
                selectedSymbol={selectedSymbol}
                researchSubTab={researchSubTab}
                setResearchSubTab={setResearchSubTab}
            />
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

      <AlertsToast userId={user?.uid} />

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
