import React from 'react';
import { 
  TrendingUp, LayoutDashboard, BarChart2, Activity, Trophy, Filter,
  Target, Zap, Search, Briefcase, Calendar, Sparkles, Radio, FlaskConical,
  Star, History, Settings2, PieChart, Bookmark, Users, Globe, CheckCircle2,
  ToggleLeft, ToggleRight, Settings, MonitorDot,
} from 'lucide-react';
import { cn } from '../../../lib/utils';

interface V2AppShellProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  v2Enabled: boolean;
  setV2Enabled: (enabled: boolean) => void;
  children: React.ReactNode;
}

export const V2AppShell: React.FC<V2AppShellProps> = ({
  activeTab,
  setActiveTab,
  v2Enabled,
  setV2Enabled,
  children
}) => {
  const tabs = [
    { label: 'Dashboard', id: 'dashboard', icon: LayoutDashboard },
    { label: 'Indices', id: 'indices', icon: BarChart2 },
    { label: 'Market Map', id: 'market-map', icon: Activity },
    { label: 'Top Rated', id: 'top-rated', icon: Trophy },
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
    { label: 'Research', id: 'research', icon: FlaskConical },
    { label: 'Strategy', id: 'strategy', icon: Star },
    { label: 'Backtest', id: 'backtest', icon: History },
    { label: 'Portfolio', id: 'portfolio', icon: PieChart },
    { label: 'Watchlist', id: 'watchlist', icon: Bookmark },
    { label: 'Settings', id: 'settings', icon: Settings },
    { label: 'Monitor',  id: 'monitor',  icon: MonitorDot },
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

        {/* V2 Toggle Switch at bottom */}
        <div className="p-2 border-t border-terminal-border flex flex-col gap-2 bg-terminal-panel-header/50 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">V2 Institutional Mode</span>
            <button 
              onClick={() => setV2Enabled(!v2Enabled)}
              className="text-slate-400 hover:text-white transition-colors"
            >
              {v2Enabled ? (
                <ToggleRight className="w-7 h-7 text-indigo-500" />
              ) : (
                <ToggleLeft className="w-7 h-7 text-slate-500" />
              )}
            </button>
          </div>
          <p className="text-[8px] text-slate-500 font-bold leading-normal">
            Toggle off to switch back to the classic retail user experience.
          </p>
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
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[9px] font-black uppercase text-slate-300 font-mono tracking-widest">
                STREAMING CONNECTED
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
    </div>
  );
};
