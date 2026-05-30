import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  LayoutDashboard, Trophy, BarChart2, Activity, Filter, Target, Zap,
  Search, History, PieChart, Bookmark, Users, Globe, CheckCircle2,
  Star, LogIn, TrendingUp, ArrowUpRight, ArrowDownRight, Menu,
  ChevronLeft, ChevronRight, Radio, Settings2, Briefcase, Calendar, Sparkles,
  FlaskConical, Layers, MonitorDot,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { nseStocksData } from '../data/nseStocks';
import type { MarketData } from '../services/marketService';
import type { User as FirebaseUser } from 'firebase/auth';

// ─── Nav Config ───────────────────────────────────────────────────────────────

interface NavItem { icon: React.ElementType; label: string; id: string; }
interface NavGroup { label: string; items: NavItem[]; }

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Markets',
    items: [
      { icon: LayoutDashboard, label: 'Dashboard',  id: 'dashboard'   },
      { icon: BarChart2,       label: 'Indices',    id: 'indices'     },
      { icon: Activity,        label: 'Market Map', id: 'market-map'  },
    ],
  },
  {
    label: 'Analysis',
    items: [
      { icon: Trophy,  label: 'Top Rated',  id: 'top-rated'   },
      { icon: Filter,  label: 'Screener',   id: 'screener'    },
      { icon: Target,  label: 'F&O Intel',  id: 'fno-scanners'},
      { icon: TrendingUp, label: 'Options Intel', id: 'options' },
      { icon: Zap,     label: 'Trendlyne',  id: 'trendlyne'   },
      { icon: Search,     label: 'Discover',    id: 'discover'    },
      { icon: Briefcase,  label: 'Smart Money', id: 'smart-money' },
      { icon: Calendar,   label: 'Earnings',    id: 'earnings'    },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { icon: Zap,      label: "Today's Picks", id: 'todays-picks'  },
      { icon: Sparkles, label: 'Trade Cockpit', id: 'trade-cockpit' },
      { icon: Radio,   label: 'Signals',    id: 'signals'     },
      { icon: Layers,  label: 'Signal Intel', id: 'signal-intelligence' },
      { icon: FlaskConical, label: 'Research', id: 'research' },
      { icon: Star,    label: 'Strategy',   id: 'strategy'    },
      { icon: Target,  label: 'Builder',    id: 'strategy-builder' },
      { icon: Activity,label: 'Sentiment',  id: 'sentiment'   },
      { icon: History, label: 'Backtest',   id: 'backtest'    },
      { icon: Settings2, label: 'ML Builder', id: 'builder'   },
    ],
  },
  {
    label: 'Portfolio',
    items: [
      { icon: PieChart,  label: 'Portfolio',  id: 'portfolio'  },
      { icon: Bookmark,  label: 'Watchlist',  id: 'watchlist'  },
      { icon: Users,     label: 'Superstars', id: 'superstars' },
      { icon: Star,      label: 'My Profile', id: 'profile'    },
    ],
  },
  {
    label: 'Tools',
    items: [
      { icon: Globe,       label: 'Economics', id: 'economics' },
      { icon: CheckCircle2,label: 'ToDo',      id: 'todo'      },
      { icon: MonitorDot,  label: 'Monitor',   id: 'monitor'   },
    ],
  },
];

// ─── Market Status ────────────────────────────────────────────────────────────

function getMarketStatus() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  const totalMins = ist.getHours() * 60 + ist.getMinutes();
  const openMins  = 9 * 60 + 15;
  const closeMins = 15 * 60 + 30;
  const isWeekday = day >= 1 && day <= 5;
  const isOpen    = isWeekday && totalMins >= openMins && totalMins < closeMins;

  let countdown = '';
  if (isOpen) {
    const rem = closeMins - totalMins;
    countdown = `${Math.floor(rem / 60)}h ${rem % 60}m to close`;
  } else if (isWeekday && totalMins < openMins) {
    const rem = openMins - totalMins;
    countdown = rem < 60 ? `${rem}m to open` : `${Math.floor(rem / 60)}h ${rem % 60}m to open`;
  } else {
    const daysAway = day === 6 ? 2 : day === 0 ? 1 : 1;
    countdown = `Opens ${daysAway === 1 ? 'tomorrow' : 'Monday'} 9:15 AM`;
  }

  const istTime = ist.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  return { isOpen, countdown, istTime };
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AppShellProps {
  user: FirebaseUser | null;
  onLogin: () => void;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  stocks: MarketData[];
  onSelectStock: (symbol: string) => void;
  displayIndices: Array<{ name: string; value: number; change: number; isUp: boolean }>;
  onSelectIndexByName: (name: string) => void;
  children: React.ReactNode;
}

// ─── Sidebar inner ────────────────────────────────────────────────────────────

const SidebarInner: React.FC<{
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  activeTab: string;
  setActiveTab: (id: string) => void;
  user: FirebaseUser | null;
  onLogin: () => void;
  displayIndices: AppShellProps['displayIndices'];
  stocks: MarketData[];
  onSelectStock: (s: string) => void;
  closeMobile?: () => void;
}> = ({ collapsed, setCollapsed, activeTab, setActiveTab, user, onLogin, displayIndices, stocks, onSelectStock, closeMobile }) => {
  const [marketStatus, setMarketStatus] = useState(getMarketStatus());
  const [searchQuery, setSearchQuery]   = useState('');
  const [showSearch, setShowSearch]     = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setInterval(() => setMarketStatus(getMarketStatus()), 30000);
    return () => clearInterval(t);
  }, []);

  // "/" shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && (e.target as HTMLElement).tagName !== 'INPUT' && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchRef.current?.focus(), 50);
      }
      if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const searchResults = searchQuery.length >= 2
    ? nseStocksData
        .filter(s =>
          s.symbol?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.name?.toLowerCase().includes(searchQuery.toLowerCase()),
        )
        .slice(0, 6)
        .map(s => ({
          symbol: s.symbol,
          name: s.name,
          changePct: stocks.find(ms => ms.symbol === s.symbol)?.changePct ?? 0,
        }))
    : [];

  const handleNav = (id: string) => {
    setActiveTab(id);
    closeMobile?.();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Logo row */}
      <div className="h-14 flex items-center justify-between px-3 border-b border-slate-800/50 shrink-0">
        <button
          onClick={() => handleNav('dashboard')}
          className="flex items-center gap-2 min-w-0"
        >
          <div className="w-7 h-7 bg-indigo-600 rounded-md flex items-center justify-center shadow-[0_0_10px_rgba(79,70,229,0.25)] shrink-0">
            <TrendingUp className="w-3.5 h-3.5 text-white" />
          </div>
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.span
                key="logo-text"
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.18 }}
                className="text-sm font-black text-slate-200 tracking-wider overflow-hidden whitespace-nowrap"
                style={{ fontFamily: "'Rajdhani', sans-serif" }}
              >
                BHARAT<span className="text-amber-400">STOCK</span>
              </motion.span>
            )}
          </AnimatePresence>
        </button>

        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            className="p-1 rounded-md text-slate-400 hover:text-slate-300 hover:bg-slate-900/50 transition-all shrink-0"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Market status chip */}
      <div className="mx-2.5 mt-2.5 shrink-0">
        <div className={cn(
          'rounded-lg border px-2.5 py-2 flex items-center gap-2 transition-colors',
          marketStatus.isOpen
            ? 'bg-emerald-50 border-emerald-200'
            : 'bg-slate-900/50 border-slate-800/50',
        )}>
          <div className={cn(
            'w-1.5 h-1.5 rounded-full shrink-0',
            marketStatus.isOpen ? 'bg-emerald-400 animate-pulse' : 'bg-slate-400',
          )} />
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.div
                key="status-text"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="overflow-hidden min-w-0"
              >
                <p className={cn('text-[10px] font-black uppercase tracking-widest leading-none', marketStatus.isOpen ? 'text-emerald-400' : 'text-slate-400')}>
                  NSE {marketStatus.isOpen ? 'LIVE' : 'CLOSED'}
                </p>
                <p className="text-[9px] text-slate-400 mt-0.5 leading-none truncate">{marketStatus.countdown}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Search */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="search"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mx-2.5 mt-2 relative shrink-0"
          >
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search stocks…  /"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setShowSearch(true); }}
              onFocus={() => setShowSearch(true)}
              className="w-full bg-white/45 border border-slate-850/80 rounded-lg py-1.5 pl-7 pr-3 text-[11px] text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-indigo-500/30 focus:ring-1 focus:ring-indigo-500/20 transition-all shadow-[inset_0_1px_2px_rgba(0,0,0,0.02)]"
            />
            {showSearch && searchResults.length > 0 && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => { setShowSearch(false); setSearchQuery(''); }} />
                <div className="absolute top-full mt-1 left-0 right-0 glass-strong border border-slate-800/50 rounded-xl overflow-hidden shadow-2xl z-20">
                  {searchResults.map(s => (
                    <button
                      key={s.symbol}
                      onClick={() => { onSelectStock(s.symbol); setSearchQuery(''); setShowSearch(false); closeMobile?.(); }}
                      className="w-full px-3 py-2.5 hover:bg-indigo-50/50 flex items-center justify-between transition-colors border-b border-slate-800 last:border-0"
                    >
                      <div className="text-left min-w-0">
                        <div className="text-[11px] font-bold text-slate-200">{s.symbol}</div>
                        <div className="text-[9px] text-slate-400 truncate">{s.name}</div>
                      </div>
                      <span className={cn('text-[10px] font-bold tabular-nums shrink-0 ml-2', s.changePct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                        {s.changePct > 0 ? '+' : ''}{s.changePct.toFixed(2)}%
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Divider */}
      <div className="mx-2.5 mt-2 border-t border-slate-800/50 shrink-0" />

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-1 px-2 space-y-px" style={{ scrollbarWidth: 'none' }}>
        {NAV_GROUPS.map(group => (
          <div key={group.label}>
            <AnimatePresence initial={false}>
              {!collapsed && (
                <motion.p
                  key={`hdr-${group.label}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="px-2 pt-3 pb-1 text-[9px] font-black uppercase tracking-[0.15em] text-slate-400"
                >
                  {group.label}
                </motion.p>
              )}
            </AnimatePresence>
            {collapsed && <div className="my-1 mx-1 border-t border-slate-800/50" />}

            {group.items.map(item => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => handleNav(item.id)}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    'relative w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-all duration-100 group',
                    active
                      ? 'bg-indigo-500/10 text-amber-400 font-bold'
                      : 'text-slate-400 hover:text-slate-900 hover:bg-slate-900/40',
                    collapsed ? 'justify-center' : '',
                  )}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-indigo-500 rounded-r-full" />
                  )}
                  <item.icon className={cn('w-4 h-4 shrink-0', active ? 'text-amber-400' : '')} />
                  <AnimatePresence initial={false}>
                    {!collapsed && (
                      <motion.span
                        key={`lbl-${item.id}`}
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: 'auto' }}
                        exit={{ opacity: 0, width: 0 }}
                        transition={{ duration: 0.15 }}
                        className="text-[12px] font-semibold whitespace-nowrap overflow-hidden"
                      >
                        {item.label}
                      </motion.span>
                    )}
                  </AnimatePresence>
                  {/* Tooltip when collapsed */}
                  {collapsed && (
                    <span className="absolute left-full ml-2 px-2 py-1 bg-slate-900 border border-slate-850/10 text-white text-[10px] font-bold rounded-md whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl">
                      {item.label}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Bottom: mini index strip + user */}
      <div className="shrink-0 border-t border-slate-800/50">
        <AnimatePresence initial={false}>
          {!collapsed && displayIndices.length > 0 && (
            <motion.div
              key="indices"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="px-3 py-2 space-y-1"
            >
              {displayIndices.slice(0, 3).map(idx => (
                <div key={idx.name} className="flex items-center justify-between">
                  <span className="text-[9px] text-slate-400 uppercase tracking-wide truncate max-w-[80px]">{idx.name}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[9px] font-bold text-slate-400 tabular-nums">{idx.value.toLocaleString('en-IN')}</span>
                    <span className={cn('text-[8px] font-bold', idx.isUp ? 'text-emerald-400' : 'text-rose-400')}>
                      {idx.isUp ? '+' : ''}{idx.change.toFixed(2)}%
                    </span>
                  </div>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <div className={cn('px-3 py-3 flex items-center gap-2.5', collapsed ? 'flex-col' : '')}>
          {user ? (
            <>
              <img
                src={user.photoURL || ''}
                alt="avatar"
                className="w-7 h-7 rounded-full border border-slate-850 shrink-0"
              />
              <AnimatePresence initial={false}>
                {!collapsed && (
                  <motion.div
                    key="user-info"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="min-w-0 overflow-hidden"
                  >
                    <p className="text-[10px] font-bold text-slate-200 truncate">{user.displayName}</p>
                    <p className="text-[9px] text-slate-400 truncate">{user.email}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          ) : (
            <button
              onClick={onLogin}
              className={cn(
                'flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-black font-black text-[11px] rounded-lg transition-all shadow-[0_0_10px_rgba(245,158,11,0.25)] hover:shadow-[0_0_14px_rgba(245,158,11,0.4)]',
                collapsed ? 'p-2 justify-center w-full' : 'px-3 py-1.5 w-full',
              )}
            >
              <LogIn className="w-3.5 h-3.5 shrink-0" />
              {!collapsed && <span>Sign In</span>}
            </button>
          )}
        </div>

        {collapsed && (
          <div className="pb-2 flex justify-center">
            <button
              onClick={() => setCollapsed(false)}
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-300 hover:bg-slate-900/50 transition-all"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── AppShell (exported) ──────────────────────────────────────────────────────

export const AppShell: React.FC<AppShellProps> = ({
  user, onLogin, activeTab, setActiveTab,
  stocks, onSelectStock, displayIndices, onSelectIndexByName, children,
}) => {
  const [collapsed, setCollapsed]     = useState(false);
  const [mobileOpen, setMobileOpen]   = useState(false);

  const allNavItems = NAV_GROUPS.flatMap(g => g.items);
  const activeLabel = allNavItems.find(i => i.id === activeTab)?.label ?? '';
  const ActiveIcon  = allNavItems.find(i => i.id === activeTab)?.icon;

  const sidebarProps = {
    collapsed, setCollapsed, activeTab, setActiveTab,
    user, onLogin, displayIndices, stocks, onSelectStock,
  };

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-slate-200">
      {/* ── Desktop sidebar ── */}
      <motion.aside
        animate={{ width: collapsed ? 60 : 232 }}
        transition={{ duration: 0.2, ease: 'easeInOut' }}
        className="hidden md:flex flex-col h-full glass border-r border-slate-800/50 shrink-0 overflow-hidden z-20 shadow-sm"
      >
        <SidebarInner {...sidebarProps} />
      </motion.aside>

      {/* ── Mobile sidebar overlay ── */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              key="overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-30 md:hidden"
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              key="mobile-sidebar"
              initial={{ x: -240 }}
              animate={{ x: 0 }}
              exit={{ x: -240 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="fixed left-0 top-0 h-full w-56 glass-strong border-r border-slate-800/50 z-40 flex flex-col md:hidden shadow-2xl"
            >
              <SidebarInner {...sidebarProps} collapsed={false} closeMobile={() => setMobileOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ── Content area ── */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Top bar */}
        <header className="h-11 border-b border-slate-800/30 bg-slate-950/20 backdrop-blur-md flex items-center px-4 gap-3 shrink-0 z-10">
          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileOpen(true)}
            className="md:hidden p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-900/50"
          >
            <Menu className="w-4 h-4" />
          </button>

          {/* Page breadcrumb */}
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 hidden sm:block"
              style={{ fontFamily: "'Rajdhani', sans-serif" }}>
              BHARAT STOCK
            </span>
            {activeLabel && (
              <>
                <span className="text-slate-300 hidden sm:block">/</span>
                {ActiveIcon && <ActiveIcon className="w-3 h-3 text-amber-400 shrink-0" />}
                <span className="text-[11px] font-black text-amber-400 uppercase tracking-wide truncate"
                  style={{ fontFamily: "'Rajdhani', sans-serif" }}>
                  {activeLabel}
                </span>
              </>
            )}
          </div>

          <div className="flex-1" />

          {/* Index strip */}
          <div className="hidden lg:flex items-center gap-5 mr-2">
            {displayIndices.map(idx => (
              <button
                key={idx.name}
                onClick={() => onSelectIndexByName(idx.name)}
                className="flex items-center gap-1.5 group"
              >
                <span className="text-[9px] text-slate-400 uppercase tracking-wider group-hover:text-slate-300 transition-colors">
                  {idx.name.replace('NIFTY BANK', 'BANKNIFTY').replace('NIFTY 50', 'NIFTY50').replace('SENSEX', 'SENSEX')}
                </span>
                <span className="text-[11px] font-bold text-slate-300 tabular-nums">{idx.value.toLocaleString('en-IN')}</span>
                <span className={cn('text-[9px] font-bold flex items-center', idx.isUp ? 'text-emerald-400' : 'text-rose-400')}>
                  {idx.isUp ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                  {Math.abs(idx.change).toFixed(2)}%
                </span>
              </button>
            ))}
          </div>

          {/* Live dot */}
          <div className="flex items-center gap-1.5 bg-slate-900/60 border border-slate-800/50 rounded-md px-2 py-1 shrink-0">
            <div className={cn(
              'w-1.5 h-1.5 rounded-full',
              getMarketStatus().isOpen ? 'bg-emerald-400 animate-pulse' : 'bg-slate-400',
            )} />
            <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">
              {getMarketStatus().isOpen ? 'LIVE' : 'CLOSED'}
            </span>
          </div>

          {/* V2 Switch */}
          <button 
            onClick={() => {
              localStorage.setItem('v2Enabled', 'true');
              window.location.reload();
            }}
            className="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-500 text-white font-black text-[9px] rounded-md px-2 py-1 shrink-0 uppercase tracking-wider cursor-pointer transition-colors"
          >
            V2 Terminal
          </button>
        </header>

        {/* Scrollable content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
};
