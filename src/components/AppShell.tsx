import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  LayoutDashboard, Trophy, BarChart2, Activity, Filter, Target, Zap,
  Crosshair,
  Search, History, PieChart, Bookmark, Users, Globe, CheckCircle2,
  Star, LogIn, TrendingUp, ArrowUpRight, ArrowDownRight, Menu,
  ChevronLeft, ChevronRight, Radio, Settings2, Briefcase, Calendar, Sparkles,
  FlaskConical, Layers, MonitorDot, ChartLine, X, MessageSquare, Gauge, FileDown,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { nseStocksData } from '../data/nseStocks';
import type { MarketData } from '../services/marketService';
import type { User as FirebaseUser } from 'firebase/auth';
import { useWebSocket } from '../v2/hooks/useWebSocket';
import { notifyAlert } from '../lib/browserNotify';
import { CommandPalette } from './CommandPalette';

// ─── Nav Config ───────────────────────────────────────────────────────────────

interface NavItem { icon: React.ElementType; label: string; id: string; }
interface NavGroup { label: string; items: NavItem[]; }

// Nav restructuring (2026-08-04 UX audit follow-up): the old flat 18-item "Intelligence" group
// mixed the canonical cross-engine ranking (unified_recommendations, via unified_ranker.py --
// see CLAUDE.md's "Scoring Authority" section) with several independent/alternative scoring
// models and pure diagnostics tools, with no visual signal for which to trust first. Split into
// three groups by what each tab actually is, verified against each page's own backend query
// and on-page copy (several -- Best Picks, Strategy -- already self-label "independent scoring
// model, not the unified cross-engine model" in their own UI; that framing is now reflected in
// the nav itself instead of only showing up once you've already opened the page):
//   - "Top Picks": canonical, unified_recommendations-backed. Placed right after Markets.
//   - "Alternative Screens": independent scoring models -- a different lens, not a duplicate.
//   - "Signal Tools": logs/diagnostics/research, not ranked "buy this" lists at all.
// The old "Advanced" hide-behind-a-toggle mechanism (top-rated/signals/todays-picks/research)
// is dropped in favor of this grouping -- each new group is small enough (4-7 items) to show
// everything without an extra click, matching the density of the un-collapsed "Analysis" group.
//
// 2026-08-04 follow-up: "Top Picks" is capped at exactly the 2 pages worth trusting for a real
// decision. Alpha (CommandCenterDashboard) and Buy Recs/Alpha Cockpit all ran the literal same
// query (getBuyRecommendations -> unified_recommendations) under three different names -- Buy
// Recs and Alpha Cockpit now redirect to /alpha (App.tsx) rather than exist as separate pages,
// so there's no longer a real choice to make between them. Top Rated moved out -- it renders
// stock_scores only (one INPUT to the canonical blend, not the merge itself) and already carries
// its own LegacyScoreBanner -- it belongs beside Strategy/Strategy Builder in Alternative Screens,
// not implying equal standing with the canonical page.
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Markets',
    items: [
      { icon: Gauge,           label: 'Market Command',     id: 'market-command'        },
      { icon: Search,          label: 'Stock Intelligence', id: 'stock-intelligence-hub' },
      { icon: LayoutDashboard, label: 'Dashboard',  id: 'dashboard'   },
      { icon: BarChart2,       label: 'Indices',    id: 'indices'     },
      { icon: Activity,        label: 'Market Map', id: 'market-map'  },
    ],
  },
  {
    label: 'Top Picks',
    items: [
      { icon: Zap,        label: 'Alpha ⚡',      id: 'alpha'         },
      { icon: Sparkles,   label: 'Trade Cockpit', id: 'trade-cockpit' },
    ],
  },
  {
    label: 'Analysis',
    items: [
      { icon: Filter,  label: 'Screener',   id: 'screener'    },
      { icon: Target,  label: 'F&O Intel',  id: 'fno-scanners'},
      { icon: TrendingUp, label: 'Options Intel', id: 'options' },
      { icon: Zap,     label: 'Trendlyne',  id: 'trendlyne'   },
      { icon: Search,     label: 'Discover',    id: 'discover'    },
      { icon: Briefcase,  label: 'Smart Money', id: 'smart-money' },
      { icon: Users,      label: 'Money Flow',  id: 'money-flow'  },
      { icon: Calendar,   label: 'Earnings',    id: 'earnings'    },
    ],
  },
  {
    label: 'Alternative Screens',
    items: [
      { icon: Crosshair, label: 'Best Picks',           id: 'best-picks'            },
      { icon: Trophy,    label: 'Top Rated',            id: 'top-rated'             },
      { icon: Star,      label: 'Strategy',             id: 'strategy'              },
      { icon: Target,    label: 'Strategy Builder',     id: 'strategy-builder'      },
      { icon: Layers,    label: 'Signal Intel',         id: 'signal-intelligence'   },
      { icon: BarChart2, label: 'Screener Intel',       id: 'screener-intelligence' },
      { icon: Zap,       label: 'Early Spotter ⚡',     id: 'early-spotter'         },
      { icon: Zap,       label: "Today's Picks",        id: 'todays-picks'          },
    ],
  },
  {
    label: 'Signal Tools',
    items: [
      { icon: Radio,        label: 'Signal Ledger',      id: 'signal-tracking'    },
      { icon: Radio,        label: 'Signals',            id: 'signals'            },
      { icon: ChartLine,    label: 'Signal Report Card', id: 'signal-report-card' },
      { icon: Activity,     label: 'Sentiment',          id: 'sentiment'          },
      { icon: History,      label: 'Backtest',           id: 'backtest'           },
      { icon: Settings2,    label: 'ML Builder',         id: 'builder'            },
      { icon: FlaskConical, label: 'Research',           id: 'research'           },
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
    label: 'Agent Intelligence',
    items: [
      { icon: BarChart2,   label: 'Data Scientist', id: 'agent-data-scientist' },
      { icon: Target,      label: 'Strategist',     id: 'agent-strategist'     },
      { icon: Activity,    label: 'Auditor',        id: 'agent-auditor'        },
      { icon: Settings2,   label: 'Optimizer',      id: 'agent-optimizer'      },
    ],
  },
  {
    label: 'Tools',
    items: [
      { icon: MessageSquare, label: 'AI Chat',    id: 'chat'      },
      { icon: Sparkles,      label: 'Switch to V5', id: 'v5'      },
      { icon: Globe,         label: 'Economics',  id: 'economics' },
      { icon: CheckCircle2,  label: 'ToDo',       id: 'todo'      },
      { icon: MonitorDot,    label: 'Monitor',    id: 'monitor'   },
      { icon: Calendar,      label: 'Jobs',       id: 'jobs'      },
      { icon: FileDown,      label: 'Export Portfolio', id: 'export-picks' },
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
  /** Timestamp (ms) the live stock quotes were last fetched from the server — drives the "data as of" freshness badge. */
  dataUpdatedAt?: number;
  children: React.ReactNode;
}

// ─── Sidebar inner ────────────────────────────────────────────────────────────

const SidebarInner = React.memo(function SidebarInner({ collapsed, setCollapsed, activeTab, setActiveTab, user, onLogin, displayIndices, stocks, onSelectStock, closeMobile, dataUpdatedAt }: {
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
  dataUpdatedAt?: number;
}) {
  const [marketStatus, setMarketStatus] = useState(getMarketStatus());
  const [searchQuery, setSearchQuery]   = useState('');
  const [showSearch, setShowSearch]     = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setInterval(() => setMarketStatus(getMarketStatus()), 30000);
    return () => clearInterval(t);
  }, []);

  // Recompute the "as of" label every 30s so it reflects elapsed time, not just the fetch timestamp.
  const [staleTick, setStaleTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStaleTick(n => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  const dataAgeLabel = useMemo(() => {
    if (!dataUpdatedAt) return null;
    const ageSec = Math.max(0, Math.round((Date.now() - dataUpdatedAt) / 1000));
    const stamp = new Date(dataUpdatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (ageSec < 60) return `Prices as of ${stamp} · ${ageSec}s ago`;
    const ageMin = Math.round(ageSec / 60);
    return `Prices as of ${stamp} · ${ageMin}m ago${ageMin >= 10 ? ' (stale)' : ''}`;
  }, [dataUpdatedAt, staleTick]);

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

  const stockPriceMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of stocks) m.set(s.symbol, s.changePct ?? 0);
    return m;
  }, [stocks]);

  const searchResults = useMemo(() => {
    if (searchQuery.length < 2) return [];
    return nseStocksData
      .filter(s =>
        s.symbol?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.name?.toLowerCase().includes(searchQuery.toLowerCase()),
      )
      .slice(0, 6)
      .map(s => ({
        symbol: s.symbol,
        name: s.name,
        changePct: stockPriceMap.get(s.symbol) ?? 0,
      }));
  }, [searchQuery, stockPriceMap]);

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
                {dataAgeLabel && (
                  <p className="text-[8px] text-slate-500 mt-0.5 leading-none truncate" title="Backend polls live quotes every 5 minutes">
                    {dataAgeLabel}
                  </p>
                )}
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

            {group.items
              .map(item => {
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
});

// ─── AppShell (exported) ──────────────────────────────────────────────────────

export const AppShell: React.FC<AppShellProps> = ({
  user, onLogin, activeTab, setActiveTab,
  stocks, onSelectStock, displayIndices, onSelectIndexByName, dataUpdatedAt, children,
}) => {
  const [collapsed, setCollapsed]     = useState(false);
  const [mobileOpen, setMobileOpen]   = useState(false);

  const allNavItems = NAV_GROUPS.flatMap(g => g.items);
  const activeLabel = allNavItems.find(i => i.id === activeTab)?.label ?? '';
  const ActiveIcon  = allNavItems.find(i => i.id === activeTab)?.icon;

  const sidebarProps = {
    collapsed, setCollapsed, activeTab, setActiveTab,
    user, onLogin, displayIndices, stocks, onSelectStock, dataUpdatedAt,
  };

  const [toastMessage, setToastMessage] = useState<any>(null);
  const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:3000/signals';
  const { lastMessage, isConnected } = useWebSocket({ url: wsUrl });

  useEffect(() => {
    if (lastMessage) {
      setToastMessage(lastMessage);
      const body = lastMessage.type === 'new_signal'
        ? `New ${lastMessage.signal?.signalType || 'Signal'} generated (${lastMessage.source || 'AI'})`
        : lastMessage.level || 'Status update';
      notifyAlert(`Live Alert: ${lastMessage.symbol}`, body);
      const timer = setTimeout(() => {
        setToastMessage(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [lastMessage]);

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

          {/* Version Switchers */}
          <div className="flex gap-1 shrink-0 select-none">
            <button 
              onClick={() => {
                localStorage.setItem('dashboardVersion', 'v1');
                localStorage.setItem('v2Enabled', 'false');
                window.location.reload();
              }}
              className="bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 font-black text-[9px] rounded-md px-2.5 py-1 uppercase tracking-wider cursor-pointer transition-colors"
            >
              V1
            </button>
            <button 
              onClick={() => {
                localStorage.setItem('dashboardVersion', 'v2');
                localStorage.setItem('v2Enabled', 'true');
                window.location.reload();
              }}
              className="bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 font-black text-[9px] rounded-md px-2.5 py-1 uppercase tracking-wider cursor-pointer transition-colors"
            >
              V2
            </button>
            <button 
              onClick={() => {
                localStorage.setItem('dashboardVersion', 'v3');
                localStorage.setItem('v2Enabled', 'true');
                window.location.reload();
              }}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-black text-[9px] rounded-md px-2.5 py-1 uppercase tracking-wider cursor-pointer transition-colors"
            >
              V3 Pro
            </button>
            {/* V5 is a separate top-level route (main.tsx), not a dashboardVersion value --
                a plain navigation, not a localStorage-driven reload like its siblings. */}
            <button
              onClick={() => { window.location.href = '/v5'; }}
              className="bg-violet-600 hover:bg-violet-500 text-white font-black text-[9px] rounded-md px-2.5 py-1 uppercase tracking-wider cursor-pointer transition-colors"
            >
              V5
            </button>
          </div>
        </header>

        {/* Scrollable content */}
        <main className="flex-1 overflow-y-auto">
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

      <CommandPalette navGroups={NAV_GROUPS} onNavigate={setActiveTab} onSelectStock={onSelectStock} stocks={stocks} />
    </div>
  );
};
