import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { cn } from '../../lib/utils';
import {
  Gauge, Search, Zap, Sparkles, Users, Filter, Target, Activity,
} from 'lucide-react';

// v4 (MarketCommandCenter + StockIntelligencePage) previously had no identity of its own --
// just two routes rendered inside the v2 shell's sidebar with no cross-links to the
// canonical recommendation surfaces (Alpha/Trade Cockpit/Money Flow) built alongside it. This
// bar makes v4 read as one consolidated hub: every v4 page carries the same quick-nav strip
// so a user lands on any of them and can reach the rest in one click.
//
// 2026-08-04: dropped Buy Recs -- it ran the same unified_recommendations query as Alpha and
// now redirects there (App.tsx), so Alpha is the one canonical entry point here.

const LINKS: { path: string; label: string; icon: React.ElementType }[] = [
  { path: '/market-command',        label: 'Command Center', icon: Gauge },
  { path: '/stock-intelligence-hub', label: 'Stock Intelligence', icon: Search },
  { path: '/alpha',                 label: 'Alpha',           icon: Zap },
  { path: '/trade-cockpit',         label: 'Trade Cockpit',   icon: Sparkles },
  { path: '/money-flow',            label: 'Money Flow',      icon: Users },
  { path: '/screener',              label: 'Screener',        icon: Filter },
  { path: '/fno-scanners',          label: 'F&O Intel',       icon: Target },
  { path: '/sentiment',             label: 'Sentiment',       icon: Activity },
];

export const V4QuickNav: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto terminal-scrollbar pb-1 -mx-1 px-1">
      {LINKS.map(({ path, label, icon: Icon }) => {
        const active = location.pathname === path;
        return (
          <button
            key={path}
            onClick={() => navigate(path)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap border transition-colors shrink-0',
              active
                ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-200'
                : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
            )}
          >
            <Icon className="w-3 h-3" />
            {label}
          </button>
        );
      })}
    </div>
  );
};

export default V4QuickNav;
