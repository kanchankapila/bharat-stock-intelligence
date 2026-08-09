import React, { useState, useEffect } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import {
  TrendingUp, LayoutDashboard, BarChart2, Activity, Trophy, Filter,
  Target, Zap, Search, Briefcase, Calendar, Sparkles, Radio, FlaskConical,
  Star, History, Settings2, PieChart, Bookmark, Users, Globe, CheckCircle2,
  ToggleLeft, ToggleRight, Settings, MonitorDot, X, Flame, Menu,
  Gauge, Newspaper, Crosshair, Layers, ChartLine, MessageSquare, FileDown,
} from 'lucide-react';
import { cn } from '../../../lib/utils';

interface V2AppShellProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  v2Enabled: boolean;
  setV2Enabled: (enabled: boolean) => void;
  dashboardVersion?: 'v1' | 'v2' | 'v3' | 'v6';
  onChangeVersion?: (version: 'v1' | 'v2' | 'v3' | 'v6') => void;
  children: React.ReactNode;
}

export const V2AppShell: React.FC<V2AppShellProps> = ({
  activeTab,
  setActiveTab,
  v2Enabled,
  setV2Enabled,
  dashboardVersion,
  onChangeVersion,
  children
}) => {
  const [toastMessage, setToastMessage] = useState<any>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:3000/signals';
  const { lastMessage, isConnected } = useWebSocket({ url: wsUrl });

  useEffect(() => {
    if (lastMessage) {
      setToastMessage(lastMessage);
      const timer = setTimeout(() => {
        setToastMessage(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [lastMessage]);

  // Grouped nav — every id here has a real, working route in App.tsx (verified against both
  // the v1 classic AppShell's nav list and the v2Enabled route block; anything present in v1
  // but missing a v2Enabled route got one added alongside this list: /alpha, /buy-recs, /economics).
  //
  // 2026-08-07: this file's own header comment previously claimed the 2026-08-04 nav-consolidation
  // (Top Picks / Alternative Screens / Signal Tools, see AppShell.tsx's matching note) had already
  // been mirrored here — it hadn't; the array below still had the old flat 14-item "Intelligence"
  // group. Since dashboardVersion defaults to 'v3' (App.tsx), THIS shell is what most users actually
  // see, not v1's AppShell.tsx — so the fix that shipped there never reached the majority of users.
  // Mirrored for real this time, keeping V2-only items (Live Screener, EOD Screener, Intraday,
  // Today's Picks, Money Flow, Export Portfolio) that v1 either doesn't route or doesn't nav-link.
  const tabGroups: { label: string; items: { label: string; id: string; icon: any }[] }[] = [
    {
      label: 'Markets',
      items: [
        { label: 'Market Command',     id: 'market-command',        icon: Gauge },
        { label: 'Stock Intelligence', id: 'stock-intelligence-hub', icon: Search },
        { label: 'Dashboard',          id: 'dashboard',              icon: LayoutDashboard },
        { label: 'Indices',            id: 'indices',                icon: BarChart2 },
        { label: 'Market Map',         id: 'market-map',             icon: Activity },
        { label: 'Intraday',           id: 'intraday',               icon: Flame },
      ],
    },
    {
      label: 'Top Picks',
      items: [
        { label: 'Alpha',              id: 'alpha',                  icon: Zap },
        { label: 'Trade Cockpit',      id: 'trade-cockpit',          icon: Sparkles },
      ],
    },
    {
      label: 'Analysis',
      items: [
        { label: 'Screener',      id: 'screener',       icon: Filter },
        { label: 'Live Screener', id: 'live-screener',  icon: Filter },
        { label: 'EOD Screener',  id: 'eod-screener',   icon: Filter },
        { label: 'F&O Intel',     id: 'fno-scanners',   icon: Target },
        { label: 'Options Intel', id: 'options',        icon: TrendingUp },
        { label: 'Trendlyne',     id: 'trendlyne',      icon: Zap },
        { label: 'Premium Screeners', id: 'premium-screeners', icon: Star },
        { label: 'Discover',      id: 'discover',       icon: Search },
        { label: 'Smart Money',   id: 'smart-money',    icon: Briefcase },
        { label: 'Money Flow',    id: 'money-flow',     icon: Users },
        { label: 'Earnings',      id: 'earnings',       icon: Calendar },
      ],
    },
    {
      label: 'Alternative Screens',
      items: [
        { label: 'Best Picks',          id: 'best-picks',            icon: Crosshair },
        { label: "Today's Picks",       id: 'todays-picks',          icon: Zap },
        { label: 'Top Rated',           id: 'top-rated',             icon: Trophy },
        { label: 'Strategy',            id: 'strategy',              icon: Star },
        { label: 'Strategy Builder',    id: 'strategy-builder',      icon: Target },
        { label: 'Signal Intel',        id: 'signal-intelligence',   icon: Layers },
        { label: 'Screener Intel',      id: 'screener-intelligence', icon: BarChart2 },
        { label: 'Early Spotter',       id: 'early-spotter',         icon: Zap },
      ],
    },
    {
      label: 'Signal Tools',
      items: [
        { label: 'Signal Ledger',       id: 'signal-tracking',       icon: Radio },
        { label: 'Signals',             id: 'signals',               icon: Radio },
        { label: 'Signal Report Card',  id: 'signal-report-card',    icon: ChartLine },
        { label: 'Sentiment',           id: 'sentiment',             icon: Newspaper },
        { label: 'Backtest',            id: 'backtest',              icon: History },
        { label: 'ML Builder',          id: 'builder',               icon: Settings2 },
        { label: 'Research',            id: 'research',              icon: FlaskConical },
      ],
    },
    {
      label: 'Portfolio',
      items: [
        { label: 'Portfolio',   id: 'portfolio',   icon: PieChart },
        { label: 'Watchlist',   id: 'watchlist',   icon: Bookmark },
        { label: 'Superstars',  id: 'superstars',  icon: Users },
        { label: 'My Profile',  id: 'profile',     icon: Star },
      ],
    },
    {
      label: 'Agent Intelligence',
      items: [
        { label: 'Data Scientist', id: 'agent-data-scientist', icon: BarChart2 },
        { label: 'Strategist',     id: 'agent-strategist',     icon: Target },
        { label: 'Auditor',        id: 'agent-auditor',        icon: Activity },
        { label: 'Optimizer',      id: 'agent-optimizer',      icon: Settings2 },
      ],
    },
    {
      label: 'Tools',
      items: [
        { label: 'AI Chat',  id: 'chat',    icon: MessageSquare },
        { label: 'Switch to V5', id: 'v5', icon: Sparkles },
        { label: 'Economics', id: 'economics', icon: Globe },
        { label: 'ToDo',     id: 'todo',    icon: CheckCircle2 },
        { label: 'System Monitor',  id: 'monitor', icon: MonitorDot },
        { label: 'Job Console',     id: 'jobs',    icon: Calendar },
        { label: 'Export Portfolio', id: 'export-picks', icon: FileDown },
        { label: 'Settings', id: 'settings', icon: Settings },
      ],
    },
  ];

  // Shared sidebar body, rendered once for the always-visible desktop rail and once for the
  // mobile off-canvas drawer -- `onNavigate` additionally closes the drawer on the mobile copy,
  // matching AppShell.tsx's (v1) established closeMobile pattern.
  const renderSidebarBody = (onNavigate: (id: string) => void) => (
    <>
      <div className="flex flex-col gap-4 min-h-0 flex-1">
        {/* V2 Header Logo */}
        <div className="flex items-center justify-between px-2 py-1.5 border-b border-terminal-border shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-indigo-600 rounded flex items-center justify-center shadow-[0_0_8px_rgba(79,70,229,0.4)]">
              <TrendingUp className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="text-xs font-black tracking-wider text-slate-100 uppercase font-mono">
              TERMINAL <span className="text-indigo-400">V2</span>
            </span>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="md:hidden p-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-900/50"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* V2 Navigation List */}
        <nav className="flex-1 min-h-0 overflow-y-auto space-y-4 terminal-scrollbar pr-1">
          {tabGroups.map((group) => (
            <div key={group.label}>
              <div className="px-3 pb-1 text-[9px] font-black uppercase tracking-widest text-slate-600">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((tab) => {
                  const active = activeTab === tab.id;
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => onNavigate(tab.id)}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-1.5 rounded-lg text-left text-xs font-bold transition-all",
                        active
                          ? "bg-indigo-600/10 text-indigo-400 border-l-2 border-indigo-500 font-extrabold"
                          : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/30"
                      )}
                    >
                      <Icon className={cn("w-4 h-4 shrink-0", active ? "text-indigo-400" : "text-slate-400")} />
                      <span className="truncate">{tab.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>

      {/* Version Switcher */}
      <div className="p-2.5 border-t border-terminal-border flex flex-col gap-2 bg-terminal-panel-header/50 rounded-xl">
        <span className="text-[9px] font-black uppercase text-slate-400 tracking-wider font-mono">Terminal Dashboard version</span>
        <div className="flex gap-1 bg-slate-950 p-0.5 rounded-lg border border-slate-900 select-none">
          {(['v1', 'v2', 'v3', 'v6'] as const).map((v) => {
            const active = (dashboardVersion || 'v6') === v;
            return (
              <button
                key={v}
                onClick={() => { onChangeVersion?.(v); setMobileOpen(false); }}
                className={cn(
                  "flex-1 py-1 rounded text-[9px] font-black uppercase tracking-wider transition-all cursor-pointer",
                  active
                    ? (v === 'v6' ? "bg-teal-600 text-white font-extrabold shadow" : "bg-indigo-600 text-white font-extrabold shadow")
                    : "text-slate-500 hover:text-slate-300"
                )}
              >
                {v === 'v6' ? 'New' : v.toUpperCase()}
              </button>
            );
          })}
        </div>
        {/* V5 is a separate top-level route (main.tsx), not a dashboardVersion value --
            a plain navigation, not part of the onChangeVersion('v1'|'v2'|'v3') contract above. */}
        <button
          onClick={() => { window.location.href = '/v5'; }}
          className="w-full py-1 rounded text-[9px] font-black uppercase tracking-wider transition-all cursor-pointer bg-violet-600 hover:bg-violet-500 text-white"
        >
          Switch to V5
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-terminal-bg text-slate-200 font-sans">
      {/* V2 Sidebar — desktop only; a fixed w-64 rail with no responsive fallback used to render
          on every viewport, leaving ~119px for content at a 375px mobile width (confirmed live
          2026-08-07). Hidden below md; the off-canvas drawer below covers mobile instead. */}
      <aside className="hidden md:flex w-64 border-r border-terminal-border bg-terminal-panel flex-col justify-between p-3 shrink-0 min-h-0">
        {renderSidebarBody(setActiveTab)}
      </aside>

      {/* Mobile off-canvas sidebar */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-30 md:hidden transition-opacity"
            onClick={() => setMobileOpen(false)}
          />
          <aside
            className="fixed left-0 top-0 h-full w-64 max-w-[85vw] border-r border-terminal-border bg-terminal-panel flex flex-col justify-between p-3 z-40 md:hidden shadow-2xl transition-transform duration-200"
          >
            {renderSidebarBody((id) => { setActiveTab(id); setMobileOpen(false); })}
          </aside>
        </>
      )}

      {/* Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-terminal-bg">
        {/* Top Ticker / Header Info bar */}
        <header className="h-12 border-b border-terminal-border bg-terminal-panel-header flex items-center px-3 md:px-6 justify-between shrink-0 gap-2">
          <div className="flex items-center gap-2 md:gap-4 min-w-0">
            <button
              onClick={() => setMobileOpen(true)}
              className="md:hidden p-1.5 -ml-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-900/50 shrink-0"
              aria-label="Open menu"
            >
              <Menu className="w-4 h-4" />
            </button>
            <span className="text-[9px] md:text-[10px] font-black uppercase tracking-[0.15em] md:tracking-[0.25em] text-slate-400 font-mono truncate">
              BHARAT STOCK INTELLIGENCE <span className="hidden sm:inline">// COGNITIVE QUANT TERMINAL</span>
            </span>
            <span className="h-4 w-px bg-terminal-border hidden sm:block shrink-0" />
            <div className="hidden sm:flex items-center gap-2 shrink-0">
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
              <span className="text-[9px] font-black uppercase text-slate-300 font-mono tracking-widest">
                {isConnected ? 'STREAMING CONNECTED' : 'STREAMING DISCONNECTED'}
              </span>
            </div>
          </div>

          <div className="text-right shrink-0 hidden md:block">
            <span className="text-[10px] text-slate-400 font-mono font-bold">
              EST. REGIME: <span className="text-emerald-400 font-black">LOW-VOL BULLISH</span>
            </span>
          </div>
        </header>

        {/* Scrollable content main area */}
        <main className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-6 bg-terminal-bg terminal-scrollbar">
          {children}
        </main>
      </div>

      {/* Global Floating Toast */}
      {toastMessage && (
        <div className="fixed bottom-4 right-4 left-4 sm:left-auto sm:bottom-6 sm:right-6 z-50 animate-in slide-in-from-bottom-5 fade-in duration-300">
          <div className="p-4 bg-indigo-900/90 border border-indigo-500/50 shadow-[0_0_20px_rgba(79,70,229,0.3)] backdrop-blur-md rounded-2xl flex items-center justify-between w-full sm:w-80">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-indigo-500/20 rounded-full">
                <Radio className="w-5 h-5 text-indigo-400 animate-pulse" />
              </div>
              <div>
                <h4 className="text-xs font-black text-slate-200 uppercase tracking-wider font-mono">
                  Live Alert: {toastMessage.symbol}
                </h4>
                <p className="text-[10px] text-indigo-200 mt-0.5 leading-snug">
                  {toastMessage.type === 'new_signal' 
                    ? `New ${toastMessage.signal?.signalType || 'Signal'} generated (${toastMessage.source || 'AI'})` 
                    : toastMessage.level || 'Status update'}
                </p>
              </div>
            </div>
            <button 
              onClick={() => setToastMessage(null)}
              className="p-1 hover:bg-white/10 rounded-full transition-colors self-start -mt-1 -mr-1"
            >
              <X className="w-3 h-3 text-slate-400" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
