
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
// Phase 2 of the frontend consolidation ("V6 Canonical Workbench" proposal): v5's desk-page
// implementations, swapped in only for dashboardVersion==='v6' -- v1/v2/v3 keep their existing
// pages exactly as-is, matching the "gradual, default now, delete later" rollout.
// RiskMetricsDashboard.tsx was fully built and wired to real procedures (getMultiFactorScores,
// getRiskMetrics, getRiskDistribution, getRegimeSummary) but had NO route pointing at it at all
// -- found 2026-08-07 during the version-consolidation review. Ships at /risk now (v1/v2/v3's
// non-v6 fallback; v6 gets v5's RiskDeskPage, the stronger of the two independent
// implementations of the same four procedures).


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
  // 'v1' = the classic AppShell -- promoted (back) to the default 2026-08-20 now that it nav-links
  // every page the other shells had (the v6-native Screener Browser/Portfolio Tracker plus the
  // v5-desk retrofits: Pre-Market, Options/Institutional-Flow/Earnings/Risk desks, Signal Review,
  // and V2Settings) and its own <main> bridges v5/v6-origin components onto v1's color tokens via
  // v6-theme.css's `.v6-root` (see AppShell.tsx). v2/v3/v6/v5 stay reachable via the version
  // switcher for anyone who explicitly picks them (an existing `dashboardVersion` value in
  // localStorage is always honored below); only a visitor with NO saved preference at all now
  // lands on v1 instead of v6.
  // v1 IS the final frontend (2026-08-31 consolidation): every page renders through
  // V1Routes inside the classic AppShell, with V1PageFrame giving the v4/v5/v6-origin
  // pages the same Dashboard page chrome. The v2/v3/v6 shells and the version switcher
  // are retired — any stale localStorage preference is migrated to v1 once on mount so
  // returning visitors land on v1 as well.
  useEffect(() => {
    try {
      if (localStorage.getItem('dashboardVersion') !== 'v1') {
        localStorage.setItem('dashboardVersion', 'v1');
        localStorage.setItem('v2Enabled', 'false');
      }
    } catch { /* storage unavailable (private mode) — v1 is the only shell anyway */ }
  }, []);
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

      // No `id` — the server derives it from the verified Firebase ID token (ctx.uid).
      await syncUserMutation.mutateAsync({
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
                userId={user?.uid}
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
