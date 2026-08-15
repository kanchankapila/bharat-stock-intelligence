import React, { useEffect, useMemo, useState } from 'react';
import {
  TrendingUp, Menu, X, ShieldCheck, ShieldAlert,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useEscapeKey, SkipLink, MAIN_CONTENT_ID } from '../lib/a11y';
import { NAV_GROUPS } from '../lib/navGroups';
import { isNseMarketOpen, currentTimeInZone } from '../lib/timeFormat';
import { trpc } from '../lib/trpc';
import './v6-theme.css';

type DashboardVersion = 'v1' | 'v2' | 'v3' | 'v6';

interface V6ShellProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  dashboardVersion?: DashboardVersion;
  onChangeVersion?: (version: DashboardVersion) => void;
  userId?: string | null;
  children: React.ReactNode;
}

const REGIME_CHIP: Record<string, { color: string; bg: string }> = {
  BULL:     { color: '#34d399', bg: 'rgba(16,185,129,0.12)' },
  SIDEWAYS: { color: '#fbbf24', bg: 'rgba(245,158,11,0.12)' },
  BEAR:     { color: '#f87171', bg: 'rgba(244,63,94,0.12)'  },
  HIGH_VOL: { color: '#fb923c', bg: 'rgba(251,146,60,0.12)' },
  CRASH:    { color: '#ef4444', bg: 'rgba(239,68,68,0.14)'  },
};

const RegimeChip: React.FC = () => {
  const { data } = trpc.getRegimeSummary.useQuery(undefined, {
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const regime = (data?.current as any)?.regime as string | undefined;
  const prob   = (data?.current as any)?.prob as number | undefined;
  if (!regime) return null;
  const style = REGIME_CHIP[regime] ?? { color: 'var(--v6-muted)', bg: 'var(--v6-bg-band)' };
  return (
    <span
      className="v6-chip text-[10px] font-black uppercase tracking-wider"
      style={{ background: style.bg, color: style.color, border: `1px solid ${style.color}22` }}
    >
      {regime}{prob != null ? ` ${Math.round(prob * 100)}%` : ''}
    </span>
  );
};

const LiveClock: React.FC<{ marketOpen: boolean }> = ({ marketOpen }) => {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono" style={{ color: 'var(--v6-faint)' }}>
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: marketOpen ? 'var(--v6-positive)' : 'var(--v6-faint)', boxShadow: marketOpen ? '0 0 4px var(--v6-positive)' : 'none' }}
      />
      {currentTimeInZone('Asia/Kolkata')} IST
    </span>
  );
};

/**
 * Small, always-visible operational guardrail for analysts. A green market status is not
 * sufficient if the feature/scoring pipelines are stale, so this surfaces the existing
 * monitor-router result in the same chrome as regime and market state. It is intentionally
 * read-only and cached server-side; it must never block a research page from rendering.
 */
const DataHealthChip: React.FC<{ onClick: () => void }> = ({ onClick }) => {
  const { data, isLoading, isError } = trpc.getSystemStatus.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
  const rows = Array.isArray(data) ? data as Array<{ runState?: string; critical?: boolean }> : [];
  const criticalIssues = rows.filter((r) => r.critical && ['failed', 'stale', 'never'].includes(String(r.runState))).length;
  const degraded = rows.filter((r) => ['failed', 'stale', 'never'].includes(String(r.runState))).length;
  const failed = criticalIssues > 0;
  const warn = !failed && degraded > 0;
  // data-honesty-review, 2026-08-14: a hard query failure (not the DB-internal errors
  // monitor.router.ts already absorbs into runState) left `data` undefined, `rows` an empty
  // array, and both counts 0 -- rendering "Health nominal", indistinguishable from a genuinely
  // healthy system. isError must win over the derived-from-empty-array good state.
  const Icon = isError || failed ? ShieldAlert : ShieldCheck;
  const label = isError ? 'Health unknown' : isLoading ? 'Health …' : failed ? `Health ${criticalIssues} critical` : warn ? `Health ${degraded} degraded` : 'Health nominal';
  const colors = isError || failed
    ? { bg: 'var(--v6-negative-soft)', fg: 'var(--v6-negative)', border: 'rgba(244,63,94,0.24)' }
    : warn
      ? { bg: 'var(--v6-warning-soft)', fg: 'var(--v6-warning)', border: 'rgba(245,158,11,0.24)' }
      : { bg: 'var(--v6-positive-soft)', fg: 'var(--v6-positive)', border: 'rgba(16,185,129,0.2)' };

  return (
    <button
      type="button"
      onClick={onClick}
      className="v6-chip hidden md:inline-flex items-center gap-1.5 text-[10px] font-bold"
      style={{ background: colors.bg, color: colors.fg, border: `1px solid ${colors.border}` }}
      title={isError ? 'System Monitor query failed -- open System Monitor to investigate' : 'Open System Monitor for pipeline freshness and job failures'}
      aria-label={`${label}. Open System Monitor`}
    >
      <Icon className="w-3 h-3" aria-hidden="true" />
      {label}
    </button>
  );
};

/** Look up a nav item's label across every group, for the header title. */
function findLabel(id: string): string | null {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.id === id);
    if (item) return item.label;
  }
  return null;
}

/** Canonical V6 workbench shell around the shared route tree. */
export const V6Shell: React.FC<V6ShellProps> = ({
  activeTab,
  setActiveTab,
  dashboardVersion,
  onChangeVersion,
  userId,
  children,
}) => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [marketOpen, setMarketOpen] = useState(() => isNseMarketOpen());
  const { data: portfolio } = trpc.getPortfolioInsights.useQuery(undefined, {
    enabled: !!userId,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const t = setInterval(() => setMarketOpen(isNseMarketOpen()), 60_000);
    return () => clearInterval(t);
  }, []);


  // Escape closes the mobile drawer. Shared hook (src/lib/a11y.tsx) so this cannot drift
  // between the four shells the way chrome fixes have here before.
  const closeMobile = React.useCallback(() => setMobileOpen(false), []);
  useEscapeKey(mobileOpen, closeMobile);

  const handleNav = (id: string) => {
    setActiveTab(id);
    setMobileOpen(false);
  };

  const pageLabel = useMemo(() => findLabel(activeTab) ?? 'Workbench', [activeTab]);

  const switchVersion = (v: DashboardVersion) => {
    onChangeVersion?.(v);
    setMobileOpen(false);
  };

  const sidebarBody = (
    <>
      <div className="flex items-center justify-between px-1 pb-3 mb-3" style={{ borderBottom: '1px solid var(--v6-border)' }}>
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: 'var(--v6-accent)' }}
          >
            <TrendingUp className="w-4 h-4" style={{ color: '#ffffff' }} />
          </div>
          <div>
            <p className="v6-title text-[15px] font-bold leading-tight" style={{ color: 'var(--v6-ink)' }}>Workbench</p>
            <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--v6-faint)' }}>Bharat Stock Intelligence</p>
          </div>
        </div>
        <button
          onClick={() => setMobileOpen(false)}
          className="md:hidden p-1 rounded-md"
          style={{ color: 'var(--v6-muted)' }}
          aria-label="Close menu"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <nav aria-label="Main" className="flex-1 min-h-0 overflow-y-auto v6-scrollbar space-y-3 pr-1">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p
              className="px-2 pb-1 text-[9px] font-black uppercase tracking-widest"
              style={{ color: 'var(--v6-faint)' }}
            >
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = activeTab === item.id;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleNav(item.id)}
                    className="w-full flex items-center gap-2 px-2.5 py-1 rounded-lg text-left text-[12px] font-medium transition-colors"
                    aria-current={active ? 'page' : undefined}
                    title={item.label}
                    style={active ? {
                      background: 'var(--v6-accent-soft)',
                      color: 'var(--v6-accent-ink)',
                      fontWeight: 650,
                    } : { color: 'var(--v6-ink-soft)' }}
                    onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--v6-bg-band)'; }}
                    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: active ? 'var(--v6-accent)' : 'var(--v6-muted)' }} />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="pt-4 mt-3 space-y-2" style={{ borderTop: '1px solid var(--v6-border)' }}>
        <p className="px-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--v6-faint)' }}>Switch view</p>
        <div
          className="flex gap-0.5 p-0.5 rounded-lg"
          style={{ background: 'var(--v6-bg-band)', border: '1px solid var(--v6-border)' }}
        >
          {(['v1', 'v2', 'v3', 'v6'] as const).map((v) => {
            const active = (dashboardVersion || 'v6') === v;
            return (
              <button
                key={v}
                onClick={() => switchVersion(v)}
                // The visible label is 2 characters ("V1", "WB") — meaningless to a screen
                // reader without this, and "WB" is not even self-evident visually.
                aria-label={v === 'v6' ? 'Switch to Workbench view' : `Switch to version ${v.toUpperCase()} view`}
                aria-pressed={active}
                className="flex-1 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors"
                style={active
                  ? { background: 'var(--v6-accent)', color: '#ffffff' }
                  : { color: 'var(--v6-muted)' }}
              >
                {v === 'v6' ? 'WB' : v.toUpperCase()}
              </button>
            );
          })}
          <button
            onClick={() => { window.location.href = '/v5'; }}
            className="flex-1 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider"
            style={{ color: 'var(--v6-faint)' }}
            title="Legacy V5 isolated shell"
          >V5</button>
        </div>
      </div>
    </>
  );

  return (
    <div className={cn('v6-root', 'flex h-screen overflow-hidden')}>
      <SkipLink />
      {/* Desktop sidebar */}
      <aside
        className="hidden md:flex flex-col w-64 shrink-0 p-4"
        style={{
          borderRight: '1px solid var(--v6-border)',
          background: 'var(--v6-surface)',
          backdropFilter: 'var(--v6-surface-blur)',
          WebkitBackdropFilter: 'var(--v6-surface-blur)',
        }}
      >
        {sidebarBody}
      </aside>

      {/* Mobile off-canvas sidebar */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-30 md:hidden"
            style={{ background: 'rgba(5, 5, 8, 0.6)', backdropFilter: 'blur(2px)' }}
            onClick={closeMobile}
            aria-hidden="true"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className="fixed left-0 top-0 h-full w-72 max-w-[85vw] z-40 md:hidden flex flex-col p-4"
            style={{
              background: 'var(--v6-surface-raised)',
              backdropFilter: 'var(--v6-surface-blur-strong)',
              WebkitBackdropFilter: 'var(--v6-surface-blur-strong)',
              borderRight: '1px solid var(--v6-border-strong)',
              boxShadow: 'var(--v6-shadow)',
            }}
          >
            {sidebarBody}
          </aside>
        </>
      )}

      {/* Content area */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        <header
          className="flex items-center gap-3 px-4 sm:px-6 h-12 shrink-0"
          style={{
            borderBottom: '1px solid var(--v6-border)',
            background: 'var(--v6-surface-raised)',
            backdropFilter: 'var(--v6-surface-blur)',
            WebkitBackdropFilter: 'var(--v6-surface-blur)',
          }}
        >
          <button
            onClick={() => setMobileOpen(true)}
            className="md:hidden p-1.5 -ml-1 rounded-md shrink-0"
            style={{ color: 'var(--v6-muted)' }}
            aria-label="Open menu"
          >
            <Menu className="w-4 h-4" />
          </button>

          <h1 className="v6-title text-[14px] font-semibold truncate" style={{ color: 'var(--v6-ink)' }}>
            {pageLabel}
          </h1>

          <div className="flex-1" />

          <div className="flex items-center gap-2">
            {userId && portfolio?.totals && (
              <button
                onClick={() => handleNav('portfolio')}
                className="v6-chip hidden lg:inline-flex tabular-nums"
                style={{
                  background: portfolio.totals.unrealizedPnl >= 0 ? 'var(--v6-positive-soft)' : 'var(--v6-negative-soft)',
                  color: portfolio.totals.unrealizedPnl >= 0 ? 'var(--v6-positive)' : 'var(--v6-negative)',
                }}
                title="Open portfolio"
              >
                P&amp;L {portfolio.totals.unrealizedPnl >= 0 ? '+' : ''}₹{Math.abs(portfolio.totals.unrealizedPnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </button>
            )}
            <DataHealthChip onClick={() => handleNav('monitor')} />
            <RegimeChip />
            <span
              className="v6-chip hidden sm:inline-flex"
              style={marketOpen
                ? { background: 'var(--v6-positive-soft)', color: 'var(--v6-positive)', border: '1px solid rgba(16,185,129,0.2)' }
                : { background: 'var(--v6-bg-band)', color: 'var(--v6-muted)' }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: marketOpen ? 'var(--v6-positive)' : 'var(--v6-faint)', boxShadow: marketOpen ? '0 0 4px var(--v6-positive)' : 'none' }}
              />
              {marketOpen ? 'Live' : 'Closed'}
            </span>
            <LiveClock marketOpen={marketOpen} />
          </div>
        </header>

        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex-1 overflow-y-auto v6-scrollbar p-4 sm:p-6" style={{ background: 'var(--v6-bg)' }}>
          {children}
        </main>
      </div>
    </div>
  );
};

export default V6Shell;
