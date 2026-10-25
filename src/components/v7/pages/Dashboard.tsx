import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight,
  Eye, RefreshCw,
} from 'lucide-react';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { formatCr, formatNumber, formatPct, DASH, toneOf, changeText } from '../lib';
import { KpiCard } from '../components/KpiCard';
import { AsOfBanner } from '../components/AsOfBanner';
import { DataTable } from '../components/DataTable';
import { SignalBadge } from '../components/SignalBadge';
import { EmptyState } from '../components/EmptyState';
import { QueryError } from '../components/QueryError';

export const DashboardPage: React.FC = () => {
  const { data: overview, isLoading: overviewLoading, isError: overviewError } = trpc.getMarketOverview.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
  const { data: pulse, isLoading: pulseLoading, isError: pulseError } = trpc.getMarketPulse.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
  const { data: movers, isLoading: moversLoading, isError: moversError } = trpc.getTopMovers.useQuery(undefined, {
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });

  const indices = (overview as any) ?? {};
  const nifty = indices.nifty50 ?? {};
  const sensex = indices.sensex ?? {};
  const banknifty = indices.bankNifty ?? {};
  const pulseData = (pulse as any) ?? {};
  const asOf = pulseData.breadth?.asOf ?? pulseData.fiiDii?.date ?? null;
  // objectiveRegime() returns { label, close, mean200, distPct } or null — never a bare
  // string. Calling .toLowerCase() on the object crashed the page (reported 2026-10-17).
  const regimeLabel: string = pulseData.regime?.label ?? '—';

  if (overviewError || pulseError || moversError) return <QueryError />;

  return (
    <div className="v7-page">
      <div className="v7-page-header">
        <div className="v7-page-title-wrap">
          <div className="v7-page-icon"><Activity size={20} strokeWidth={2} /></div>
          <div>
            <h1 className="v7-page-title">Market Dashboard</h1>
            <p className="v7-page-kicker">NSE · BSE · live indices, breadth, flows and regime</p>
          </div>
        </div>
        <div className="v7-page-actions">
          <AsOfBanner asOf={asOf} label="Market data" stale={pulseLoading || overviewLoading} />
          <button className="v7-btn v7-btn-ghost" onClick={() => window.location.reload()}>
            <RefreshCw className="w-4 h-4" size={16} strokeWidth={1.6} /> Refresh
          </button>
        </div>
      </div>

      {/* ─── KPI strip ─── */}
      <div className="v7-kpi-grid">
        <KpiCard title="NIFTY 50" value={nifty.value} change={nifty.change} changePct={nifty.changePct} unit="number" asOf={asOf} stale={!!nifty.stale} />
        <KpiCard title="SENSEX" value={sensex.value} change={sensex.change} changePct={sensex.changePct} unit="number" asOf={asOf} stale={!!sensex.stale} />
        <KpiCard title="BANK NIFTY" value={banknifty.value} change={banknifty.change} changePct={banknifty.changePct} unit="number" asOf={asOf} stale={!!banknifty.stale} />
        <KpiCard title="INDIA VIX" value={pulseData.vix?.value} change={null} changePct={null} unit="number" decimals={2} asOf={pulseData.vix?.asOf ?? null} stale={!pulseData.vix} />
      </div>
      {/* ─── Market regime + FII/DII ─── */}
      <div className="v7-grid-cols-2">
        <div className="v7-card">
          <div className="v7-card-head">
            <span className="v7-card-title">Market Regime</span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Objective</span>
              <span className={cn('text-xs font-data font-bold px-2 py-1 rounded border',
                regimeLabel.includes('ABOVE') ? 'bg-up/10 border-up/30 text-up' :
                regimeLabel.includes('BELOW') ? 'bg-down/10 border-down/30 text-down' :
                'bg-slate-900/40 border-slate-700/40 text-slate-400')}>
                {regimeLabel}
              </span>
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Basis</span>
              <span className="font-data text-slate-300">NIFTY 50 close vs its own 200-session mean</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Last close</span>
              <span className="font-data text-slate-300">{pulseData.regime?.close == null ? DASH : formatNumber(pulseData.regime.close, 2)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">200-session mean</span>
              <span className="font-data text-slate-300">{pulseData.regime?.mean200 == null ? DASH : formatNumber(pulseData.regime.mean200, 2)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Distance</span>
              <span className={cn('font-data font-bold', toneOf(pulseData.regime?.distPct) === 'up' ? 'text-up' : toneOf(pulseData.regime?.distPct) === 'down' ? 'text-down' : 'text-slate-400')}>
                {pulseData.regime?.distPct == null ? DASH : formatPct(pulseData.regime.distPct, 2, true)}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Sessions</span>
              <span className="font-data text-slate-300">{pulseData.regimeSessions ?? '—'}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Regime as of</span>
              <span className="font-data text-slate-300">{pulseData.regimeAsOf ? new Date(pulseData.regimeAsOf).toLocaleDateString('en-IN') : '—'}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-3">An objective rule (close vs its own 200-session mean), not a forecast. It needs 200 sessions of history — empty until then.</p>
          </div>
        </div>
        <div className="v7-card">
          <div className="v7-card-head">
            <span className="v7-card-title">FII / DII Flows</span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Cash segment · net</span>
              <span className={cn('text-xs font-data font-bold px-2 py-1 rounded border',
                toneOf(pulseData.fiiDii?.fii_net) === 'up' ? 'bg-up/10 border-up/30 text-up' :
                toneOf(pulseData.fiiDii?.fii_net) === 'down' ? 'bg-down/10 border-down/30 text-down' :
                'bg-slate-900/40 border-slate-700/40 text-slate-400')}>
                {pulseData.fiiDii?.fii_net == null ? DASH : toneOf(pulseData.fiiDii.fii_net) === 'up' ? 'FII INFLOW' : toneOf(pulseData.fiiDii.fii_net) === 'down' ? 'FII OUTFLOW' : 'FII FLAT'}
              </span>
            </div>
          </div>
          <div className="v7-grid-cols-2">
            <div>
              <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">FII Net</div>
              <div className={cn('font-data font-bold', toneOf(pulseData.fiiDii?.fii_net) === 'up' ? 'text-up' : toneOf(pulseData.fiiDii?.fii_net) === 'down' ? 'text-down' : 'text-slate-400')}>
                {pulseData.fiiDii?.fii_net == null ? DASH : formatCr(pulseData.fiiDii.fii_net)}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">DII Net</div>
              <div className={cn('font-data font-bold', toneOf(pulseData.fiiDii?.dii_net) === 'up' ? 'text-up' : toneOf(pulseData.fiiDii?.dii_net) === 'down' ? 'text-down' : 'text-slate-400')}>
                {pulseData.fiiDii?.dii_net == null ? DASH : formatCr(pulseData.fiiDii.dii_net)}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between text-xs mt-3 text-slate-500">
            <span>As of {pulseData.fiiDii?.date ? new Date(pulseData.fiiDii.date).toLocaleDateString('en-IN') : '—'}</span>
            <span className="font-medium">₹ Cr</span>
          </div>
          <p className="text-[11px] text-slate-500 mt-3">Net institutional flow for the latest session. A single day's flow is not a signal by itself.</p>
        </div>
      </div>

      {/* ─── Breadth ─── */}
      <div className="v7-card">
        <div className="v7-card-head">
          <span className="v7-card-title">Market Breadth</span>
          <span className="text-[10px] font-bold text-slate-400 uppercase">Advances vs declines · NSE-listed</span>
        </div>
        <div className="v7-grid-cols-4">
          <div>
            <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">Advances</div>
            <div className="font-data font-bold text-up">{pulseData.breadth?.advances == null ? DASH : pulseData.breadth.advances}</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">Declines</div>
            <div className="font-data font-bold text-down">{pulseData.breadth?.declines == null ? DASH : pulseData.breadth.declines}</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">Unchanged</div>
            <div className="font-data font-bold text-slate-400">{pulseData.breadth?.unchanged == null ? DASH : pulseData.breadth.unchanged}</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">Advance–Decline Ratio</div>
            <div className="font-data font-bold">
              {pulseData.breadth?.advances != null && pulseData.breadth?.declines
                ? ((pulseData.breadth.advances / Math.max(pulseData.breadth.declines, 1))).toFixed(2)
                : DASH}
            </div>
          </div>
        </div>
        <div className="pt-3 text-[11px] text-slate-500">
          Compares the latest session close vs previous session for NSE-listed equities with both closes available.
          {' '}
          {pulseData.breadth?.vsDate && `Breadth as of ${new Date(pulseData.breadth.asOf).toLocaleDateString('en-IN')} vs ${new Date(pulseData.breadth.vsDate).toLocaleDateString('en-IN')}.`}
        </div>
      </div>

      {/* ─── Top movers ─── */}
      <div className="v7-section">
        <div className="v7-section-head">
          <div>
            <h2 className="v7-section-title">Top Movers</h2>
            <p className="v7-section-sub">Live quotes — latest refresh</p>
          </div>
        </div>
        <div className="v7-grid-cols-2">
          <div className="v7-card">
            <div className="v7-card-head">
              <span className="v7-card-title">Top Gainers</span>
              <span className="text-[10px] font-bold text-emerald-400 uppercase">+ change</span>
            </div>
            <MoverList items={topGainers(movers)} tone="up" />
          </div>
          <div className="v7-card">
            <div className="v7-card-head">
              <span className="v7-card-title">Top Losers</span>
              <span className="text-[10px] font-bold text-rose-400 uppercase">– change</span>
            </div>
            <MoverList items={topLosers(movers)} tone="down" />
          </div>
        </div>
      </div>
    </div>
  );
};

function topGainers(movers: any) {
  const list = Array.isArray(movers) ? movers : movers?.topGainers;
  if (!Array.isArray(list)) return [];
  return [...list]
    .filter((s: any) => (s.change_percent ?? 0) > 0)
    .sort((a: any, b: any) => (b.change_percent ?? 0) - (a.change_percent ?? 0))
    .slice(0, 8);
}
function topLosers(movers: any) {
  const list = Array.isArray(movers) ? movers : movers?.topLosers;
  if (!Array.isArray(list)) return [];
  return [...list]
    .filter((s: any) => (s.change_percent ?? 0) < 0)
    .sort((a: any, b: any) => (a.change_percent ?? 0) - (b.change_percent ?? 0))
    .slice(0, 8);
}

function MoverList({ items, tone }: { items: any[]; tone: 'up' | 'down' }) {
  const navigate = useNavigate();
  if (items.length === 0) {
    return (<EmptyState icon={<Eye className="w-8 h-8 text-slate-600" />} title="No movers data" variant="default" />);
  }
  const Arrow = tone === 'up' ? TrendingUp : TrendingDown;
  const cls = tone === 'up' ? 'text-emerald-400' : 'text-rose-400';
  return (
    <div className="space-y-2">
      {items.map((s) => {
        const pct = s.change_percent ?? 0;
        const sym = s.symbol ?? s.symbol_name;
        const price = s.today_close;
        return (
          <div key={sym}
            onClick={() => navigate(`/v7-stock/${sym}`)}
            className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-slate-800/40 bg-slate-900/30 text-sm cursor-pointer hover:border-slate-600/60 transition-colors">
            <div className="flex items-center gap-2">
              <Arrow className={cn('w-3 h-3', cls)} />
              <span className="font-data font-bold text-slate-200">{sym}</span>
            </div>
            <div className="flex items-center gap-2 text-right">
              <span className="font-data font-bold text-slate-300 tabular-nums">{price == null ? '—' : Number(price).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
              <span className={cn('font-data font-bold', cls)}>{pct >= 0 ? '+' : ''}{pct.toFixed(2)}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default DashboardPage;
