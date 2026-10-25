import React, { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, BarChart2, ShieldAlert, Activity, TrendingUp,
  TrendingDown, Menu, ChevronDown,
} from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { cn } from '../../lib/utils';
import { KpiCard } from './components/KpiCard';
import { AsOfBanner } from './components/AsOfBanner';
import { changeText } from './lib';
import { isNseMarketOpen } from '../../lib/timeFormat';
import './v7-theme.css';

interface NavItem {
  icon: React.ElementType;
  label: string;
  id: string;
  href: string;
}

interface V7ShellProps {
  children: React.ReactNode;
}

const MARKET_NAV: NavItem[] = [
  { icon: LayoutDashboard, label: 'Dashboard', id: 'v7-dashboard', href: '/v7-dashboard' },
  { icon: BarChart2, label: 'Screener', id: 'v7-screener', href: '/v7-screener' },
];
const INTEL_NAV: NavItem[] = [
  { icon: ShieldAlert, label: 'Top Picks', id: 'v7-top-picks', href: '/v7-top-picks' },
  { icon: Activity, label: 'Stock Analysis', id: 'v7-stock', href: '/v7-stock' },
  { icon: TrendingUp, label: 'Signals', id: 'v7-signals', href: '/v7-signals' },
];

export const V7Shell: React.FC<V7ShellProps> = ({ children }) => {
  const [collapsed, setCollapsed] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const { data: indices } = trpc.getMarketOverview.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // Clock-based schedule only: it cannot establish holiday status or feed freshness.
  const isOpen = isNseMarketOpen(clock);

  const toggleSidebar = useCallback(() => setCollapsed((c) => !c), []);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const shell = document.querySelector('.v7-shell');
      if (shell && !shell.contains(e.target as Node)) setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Active state derives from the URL (not local state) so deep links and browser back/forward
  // highlight correctly; /v7-stock/RELIANCE keeps Stock Analysis lit via the prefix match.
  const isActive = (href: string) => location.pathname === href || location.pathname.startsWith(href + '/');

  const indexChip = (key: 'nifty50' | 'sensex' | 'bankNifty', name: string) => {
    const idx = (indices as any)?.[key];
    const hasData = idx?.value != null && Number.isFinite(Number(idx.value));
    const change = changeText(idx?.changePct);
    return (
      <div className="v7-index-chip" key={key}>
        <span className="name">{name}</span>
        <span className="value">{hasData ? idx.value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}</span>
        <span className={cn('change', change.cls)}>
          {change.text}{idx?.changePct != null && Number.isFinite(Number(idx.changePct)) ? '%' : ''}
        </span>
      </div>
    );
  };

  return (
    <div className="v7-shell v7-app v7-root">
      <a className="v7-skip-link" href="#v7-main">Skip to main content</a>
      {/* ─── Sidebar ─── */}
      <aside className={cn('v7-sidebar', collapsed && 'collapsed')}>
        <button type="button" aria-label="Toggle navigation" aria-expanded={!collapsed} className="v7-sidebar-brand" onClick={toggleSidebar} style={{ cursor: 'pointer' }}>
          <div className="v7-sidebar-brand-mark">B</div>
          {!collapsed && <span className="v7-sidebar-brand-text">Bharat Stock Intelligence</span>}
        </button>
        <div className="v7-sidebar-group">
          <div className="v7-sidebar-group-title">MARKET</div>
          <nav className="v7-sidebar-nav">
            {MARKET_NAV.map((item) => (
              <a key={item.id} href={item.href}
                className={cn('v7-sidebar-item', isActive(item.href) && 'active')}
                onClick={(e) => { e.preventDefault(); navigate(item.href); setCollapsed(false); }}
              >
                <item.icon className="shrink-0" />
                {!collapsed && <span className="v7-sidebar-label">{item.label}</span>}
              </a>
            ))}
          </nav>
          <div className="v7-sidebar-group-title">INTELLIGENCE</div>
          <nav className="v7-sidebar-nav">
            {INTEL_NAV.map((item) => (
              <a key={item.id} href={item.href}
                className={cn('v7-sidebar-item', isActive(item.href) && 'active')}
                onClick={(e) => { e.preventDefault(); navigate(item.href); setCollapsed(false); }}
              >
                <item.icon className="shrink-0" />
                {!collapsed && <span className="v7-sidebar-label">{item.label}</span>}
              </a>
            ))}
          </nav>
        </div>
        <div className="v7-sidebar-footer">
          v7 Pro · Trading Analyst<br />
          <span className="text-slate-500">NSE/BSE decision support</span>
        </div>
      </aside>

      {/* ─── Main ─── */}
      <div className={cn('v7-main', collapsed && 'collapsed')}>
        <header className="v7-topbar">
          <div className="v7-topbar-left">
            <button onClick={toggleSidebar} className="p-2 rounded-lg hover:bg-white/[0.05] text-slate-400 hover:text-white">
              <Menu className="w-5 h-5" />
            </button>
            <a href="/v7-dashboard" className="v7-brand"
              onClick={(e) => { e.preventDefault(); navigate('/v7-dashboard'); }}>
              Bharat <span className="v7-pro">PRO</span>
            </a>
          </div>
          <div className="v7-topbar-center hidden lg:flex">
            {indexChip('nifty50', 'NIFTY 50')}
            <div className="w-px h-5 bg-slate-700/40 mx-1" />
            {indexChip('sensex', 'SENSEX')}
            <div className="w-px h-5 bg-slate-700/40 mx-1" />
            {indexChip('bankNifty', 'BANKNIFTY')}
          </div>
          <div className="v7-topbar-right">
            <div className="v7-market-status" title="Clock-based schedule only; exchange holiday status and live feed freshness are unverified.">
              <div className={cn('v7-market-dot', !isOpen && 'closed')} />
              <span>{isOpen ? 'Scheduled session' : 'Outside scheduled hours'}</span>
            </div>
            <button aria-label="Toggle user menu" aria-expanded={userMenuOpen} onClick={() => setUserMenuOpen((o) => !o)} className="p-2 rounded-lg hover:bg-white/[0.05] text-slate-400 hover:text-white relative">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 text-slate-400">
                <circle cx="12" cy="12" r="5" />
                <path d="M16.65 10.35C15.28 9.38 13.55 8.88 12 8.88c-3.09 0-5.58 1.24-7.42 3.17C3.56 12.91 2 15.28 2 18c0 2.21 1.19 4.13 3 5.05" />
                <path d="M22 18c0 2.21-1.19 4.13-3 5.05" />
              </svg>
              {userMenuOpen && <ChevronDown className="w-4 h-4 text-slate-500 absolute -top-1 -right-1" />}
            </button>
          </div>
        </header>

        <main id="v7-main" className="v7-content">
          {children}
        </main>
      </div>
    </div>
  );
};

export default V7Shell;
