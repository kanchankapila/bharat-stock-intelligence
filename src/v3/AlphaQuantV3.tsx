import React, { useState } from 'react';
import DashboardPage from './pages/DashboardPage';
import TradeCockpitPage from './pages/TradeCockpitPage';
import TopPicksPage from './pages/TopPicksPage';
import FnoIntelligencePage from './pages/FnoIntelligencePage';
import DiscoveryPage from './pages/DiscoveryPage';
import SentimentPage from './pages/SentimentPage';
import { cn } from '../lib/utils';
import {
  LayoutDashboard, Trophy, Sparkles, Layers,
  Filter, BarChart2, ArrowLeftRight,
} from 'lucide-react';

interface AlphaQuantV3Props {
  onSwitchVersion: (version: 'v1' | 'v2') => void;
}

type Tab = 'dashboard' | 'toppicks' | 'trade' | 'fno' | 'discovery' | 'sentiment';

const NAV_ITEMS: { id: Tab; label: string; icon: React.ElementType; badge?: string }[] = [
  { id: 'dashboard',  label: 'Dashboard',           icon: LayoutDashboard },
  { id: 'toppicks',   label: 'Top Picks',            icon: Trophy,    badge: 'NEW' },
  { id: 'trade',      label: 'Trade Cockpit',        icon: Sparkles },
  { id: 'fno',        label: 'F&O Intelligence',     icon: Layers },
  { id: 'discovery',  label: 'Screener & Discovery', icon: Filter },
  { id: 'sentiment',  label: 'News Sentiment',       icon: BarChart2 },
];

const AlphaQuantV3: React.FC<AlphaQuantV3Props> = ({ onSwitchVersion }) => {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [tradeSymbol, setTradeSymbol] = useState<string>('RELIANCE');

  const handleSelectStock = (symbol: string) => {
    setTradeSymbol(symbol);
    setActiveTab('trade');
  };

  const activeLabel = NAV_ITEMS.find(n => n.id === activeTab)?.label ?? activeTab;

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">

      {/* Sidebar */}
      <aside className="w-64 bg-slate-900/60 backdrop-blur border-r glass-border flex flex-col shrink-0">
        <div className="px-6 py-5 border-b glass-border">
          <h1 className="text-lg font-bold tracking-tight gradient-text-primary">
            AlphaQuant
          </h1>
          <p className="text-xs text-slate-500 font-mono mt-1">v3 · Institutional Edge</p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map(({ id, label, icon: Icon, badge }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={cn(
                'w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium interactive-base',
                activeTab === id
                  ? 'bg-indigo-500/12 text-indigo-300 glow-accent-strong'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              )}
            >
              <Icon className={cn('w-4 h-4 shrink-0 transition-colors', activeTab === id ? 'text-indigo-400' : 'text-slate-600')} />
              <span className="flex-1 text-left">{label}</span>
              {badge && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25">
                  {badge}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="px-3 py-3 border-t glass-border space-y-2">
          <button
            onClick={() => onSwitchVersion('v2')}
            className="w-full flex items-center justify-center gap-2 bg-slate-800/50 hover:bg-slate-700/60 text-slate-300 px-4 py-2.5 rounded-lg text-xs font-semibold interactive-base border glass-border"
          >
            <ArrowLeftRight className="w-3.5 h-3.5" /> v2
          </button>
          <button
            onClick={() => onSwitchVersion('v1')}
            className="w-full flex items-center justify-center gap-2 bg-slate-800/50 hover:bg-slate-700/60 text-slate-300 px-4 py-2.5 rounded-lg text-xs font-semibold interactive-base border glass-border"
          >
            <ArrowLeftRight className="w-3.5 h-3.5" /> v1
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-950">
        {/* Header bar */}
        <header className="h-14 border-b glass-border bg-slate-900/30 backdrop-blur flex items-center justify-between px-8 shrink-0">
          <div className="flex items-center gap-4">
            {(() => {
              const item = NAV_ITEMS.find(n => n.id === activeTab);
              const Icon = item?.icon;
              return Icon ? <Icon className="w-5 h-5 text-indigo-400" /> : null;
            })()}
            <h2 className="text-base font-semibold text-slate-100">{activeLabel}</h2>
            {activeTab === 'trade' && tradeSymbol && (
              <div className="ml-2 px-3 py-1 bg-indigo-500/12 text-indigo-300 border border-indigo-500/25 rounded-full text-xs font-semibold glow-accent">
                {tradeSymbol}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse-soft" />
              <span className="text-xs text-slate-500 font-mono">Live Connected</span>
            </div>
          </div>
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-auto">
          <div className="p-8">
            {activeTab === 'dashboard'  && <DashboardPage />}
            {activeTab === 'toppicks'   && <TopPicksPage onSelectStock={handleSelectStock} />}
            {activeTab === 'trade'      && <TradeCockpitPage initialSymbol={tradeSymbol} />}
            {activeTab === 'fno'        && <FnoIntelligencePage />}
            {activeTab === 'discovery'  && <DiscoveryPage />}
            {activeTab === 'sentiment'  && <SentimentPage />}
          </div>
        </div>
      </main>
    </div>
  );
};

export default AlphaQuantV3;
