import React, { useState, useEffect } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { 
  TrendingUp, LayoutDashboard, BarChart2, Activity, Trophy, Filter,
  Target, Zap, Search, Briefcase, Calendar, Sparkles, Radio, FlaskConical,
  Star, History, Settings2, PieChart, Bookmark, Users, Globe, CheckCircle2,
  ToggleLeft, ToggleRight, Settings, MonitorDot, X, BrainCircuit, Flame
} from 'lucide-react';
import { cn } from '../../../lib/utils';

interface V2AppShellProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  v2Enabled: boolean;
  setV2Enabled: (enabled: boolean) => void;
  dashboardVersion?: 'v1' | 'v2' | 'v3';
  onChangeVersion?: (version: 'v1' | 'v2' | 'v3') => void;
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

  const tabs = [
    { label: 'Dashboard', id: 'dashboard', icon: LayoutDashboard },
    { label: 'Alpha Cockpit', id: 'alpha-cockpit', icon: BrainCircuit },
    { label: 'Indices', id: 'indices', icon: BarChart2 },
    { label: 'Market Map', id: 'market-map', icon: Activity },
    { label: 'Top Rated', id: 'top-rated', icon: Trophy },
    { label: 'Intraday', id: 'intraday', icon: Flame },
    { label: 'Screener', id: 'screener', icon: Filter },
    { label: 'Live Screener', id: 'live-screener', icon: Filter },
    { label: 'EOD Screener', id: 'eod-screener', icon: Filter },
    { label: 'F&O Intel', id: 'fno-scanners', icon: Target },
    { label: 'Options Intel', id: 'options', icon: TrendingUp },
    { label: 'Trendlyne', id: 'trendlyne', icon: Zap },
    { label: 'Discover', id: 'discover', icon: Search },
    { label: 'Smart Money', id: 'smart-money', icon: Briefcase },
    { label: 'Earnings', id: 'earnings', icon: Calendar },
    { label: 'Trade Cockpit', id: 'trade-cockpit', icon: Sparkles },
    { label: 'Signals', id: 'signals', icon: Radio },
    { label: 'Signal Ledger', id: 'signal-tracking', icon: Radio },
    { label: 'Research', id: 'research', icon: FlaskConical },
    { label: 'Strategy', id: 'strategy', icon: Star },
    { label: 'Backtest', id: 'backtest', icon: History },
    { label: 'Portfolio', id: 'portfolio', icon: PieChart },
    { label: 'Watchlist', id: 'watchlist', icon: Bookmark },
    { label: 'Settings', id: 'settings', icon: Settings },
    { label: 'Monitor',  id: 'monitor',  icon: MonitorDot },
    { label: 'Jobs',     id: 'jobs',     icon: Calendar },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-terminal-bg text-slate-200 font-sans">
      {/* V2 Sidebar */}
      <aside className="w-60 border-r border-terminal-border bg-terminal-panel flex flex-col justify-between p-3 shrink-0">
        <div className="flex flex-col gap-6">
          {/* V2 Header Logo */}
          <div className="flex items-center justify-between px-2 py-1.5 border-b border-terminal-border">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-indigo-600 rounded flex items-center justify-center shadow-[0_0_8px_rgba(79,70,229,0.4)]">
                <TrendingUp className="w-3.5 h-3.5 text-white" />
              </div>
              <span className="text-xs font-black tracking-wider text-slate-100 uppercase font-mono">
                TERMINAL <span className="text-indigo-400">V2</span>
              </span>
            </div>
          </div>

          {/* V2 Navigation List */}
          <nav className="flex-1 overflow-y-auto space-y-1 terminal-scrollbar max-h-[70vh]">
            {tabs.map((tab) => {
              const active = activeTab === tab.id;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-xs font-bold transition-all",
                    active 
                      ? "bg-indigo-600/10 text-indigo-400 border-l-2 border-indigo-500 font-extrabold" 
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/30"
                  )}
                >
                  <Icon className={cn("w-4 h-4", active ? "text-indigo-400" : "text-slate-400")} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Version Switcher */}
        <div className="p-2.5 border-t border-terminal-border flex flex-col gap-2 bg-terminal-panel-header/50 rounded-xl">
          <span className="text-[9px] font-black uppercase text-slate-400 tracking-wider font-mono">Terminal Dashboard version</span>
          <div className="flex gap-1 bg-slate-950 p-0.5 rounded-lg border border-slate-900 select-none">
            {(['v1', 'v2', 'v3'] as const).map((v) => {
              const active = (dashboardVersion || 'v3') === v;
              return (
                <button
                  key={v}
                  onClick={() => onChangeVersion?.(v)}
                  className={cn(
                    "flex-1 py-1 rounded text-[9px] font-black uppercase tracking-wider transition-all cursor-pointer",
                    active 
                      ? "bg-indigo-600 text-white font-extrabold shadow" 
                      : "text-slate-500 hover:text-slate-300"
                  )}
                >
                  {v.toUpperCase()}
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-terminal-bg">
        {/* Top Ticker / Header Info bar */}
        <header className="h-12 border-b border-terminal-border bg-terminal-panel-header flex items-center px-6 justify-between shrink-0">
          <div className="flex items-center gap-4">
            <span className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 font-mono">
              BHARAT STOCK INTELLIGENCE // COGNITIVE QUANT TERMINAL
            </span>
            <span className="h-4 w-px bg-terminal-border" />
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
              <span className="text-[9px] font-black uppercase text-slate-300 font-mono tracking-widest">
                {isConnected ? 'STREAMING CONNECTED' : 'STREAMING DISCONNECTED'}
              </span>
            </div>
          </div>
          
          <div className="text-right">
            <span className="text-[10px] text-slate-400 font-mono font-bold">
              EST. REGIME: <span className="text-emerald-400 font-black">LOW-VOL BULLISH</span>
            </span>
          </div>
        </header>

        {/* Scrollable content main area */}
        <main className="flex-1 overflow-y-auto p-6 space-y-6 bg-terminal-bg terminal-scrollbar">
          {children}
        </main>
      </div>

      {/* Global Floating Toast */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-5 fade-in duration-300">
          <div className="p-4 bg-indigo-900/90 border border-indigo-500/50 shadow-[0_0_20px_rgba(79,70,229,0.3)] backdrop-blur-md rounded-2xl flex items-center justify-between w-80">
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
