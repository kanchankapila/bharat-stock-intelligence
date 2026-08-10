import React, { useEffect, useState } from 'react';
import { Gauge, TrendingUp, TrendingDown, Flame, BarChart3, LayoutDashboard } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';
import { cn } from '../../lib/utils';
import { IndexOverview } from '../../components/MarketInsights';
import { SectorHeatmap } from '../../components/SectorIntelligence';
import { TopMoversIntelligence } from '../../components/TopMoversIntelligence';
import { IntradayBreakouts } from '../../components/IntradayBreakouts';
import { GlobalMarkets } from '../../components/GlobalMarkets';
import { PreMarketBriefing } from '../components/PreMarketBriefing';
import { FnOIndexInsight } from '../components/FnOIndexInsight';
import { SentimentPulseWidget } from '../components/SentimentPulseWidget';
import { EarningsPulseWidget } from '../components/EarningsPulseWidget';
import { HighFlyerWidget } from '../components/HighFlyerWidget';
import { ModelBacktestStatusCard } from '../components/ModelBacktestStatusCard';
import { ScreenerComboFinderCard } from '../components/ScreenerComboFinderCard';
import { V4QuickNav } from '../components/V4QuickNav';
import { TopPicksWidget } from '../components/TopPicksWidget';
import { MoneyFlowPulseWidget } from '../components/MoneyFlowPulseWidget';
import { MarketBreadthIntraday } from '../../components/MarketBreadthIntraday';
import { ActivityFeed } from '../../components/ActivityFeed';
import { MarketMoodGauge } from '../../components/MarketMoodGauge';
import { currentTimeInZone } from '../../lib/timeFormat';
import { SectorRotationGraph } from '../components/SectorRotationGraph';
import { SectorCorrelationWidget } from '../components/SectorCorrelationWidget';
import { InstitutionalDealFeed } from '../components/InstitutionalDealFeed';
import { ConcallTakeawaysWidget } from '../components/ConcallTakeawaysWidget';
import { SuperstarActivityFeed } from '../components/SuperstarActivityFeed';

const REGIME_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  BULL:     { color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/25', label: 'BULL' },
  SIDEWAYS: { color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/25',     label: 'SIDEWAYS' },
  BEAR:     { color: 'text-rose-400',    bg: 'bg-rose-500/10 border-rose-500/25',       label: 'BEAR' },
  HIGH_VOL: { color: 'text-orange-400',  bg: 'bg-orange-500/10 border-orange-500/25',   label: 'HIGH VOL' },
  CRASH:    { color: 'text-red-500',     bg: 'bg-red-500/15 border-red-500/40',         label: 'CRASH' },
};

const RegimeBadge: React.FC = () => {
  const { data, isLoading } = trpc.getRegimeSummary.useQuery();
  const regime = data?.current?.regime as string | undefined;
  const style = (regime && REGIME_STYLE[regime]) || { color: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/25', label: isLoading ? '…' : 'UNKNOWN' };
  const prob = data?.current?.prob;

  return (
    <div className={cn('flex items-center gap-2 px-3 py-2 rounded-xl border', style.bg)}>
      <Gauge className={cn('w-4 h-4', style.color)} />
      <div>
        <div className={cn('text-xs font-black tracking-wide', style.color)}>{style.label}</div>
        <div className="text-[9px] text-slate-500 uppercase tracking-widest">
          Regime{prob != null ? ` · ${Math.round(prob * 100)}% conf` : ''}
        </div>
      </div>
      {data?.current?.guidance?.action && (
        <span className="text-[10px] text-slate-400 ml-2 border-l border-slate-700 pl-2">
          {data.current.guidance.action}
        </span>
      )}
    </div>
  );
};

const LiveClock: React.FC = () => {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
      {currentTimeInZone('Asia/Kolkata')} IST
    </span>
  );
};

interface MarketCommandCenterProps {
  onSelectStock?: (symbol: string) => void;
  onSelectIndex?: (id: string, name: string) => void;
  userId?: string | null;
}

// Page 1 — "the pre-trading-day briefing" — a fresh page that combines what an expert analyst
// checks before the bell into one decisive view: indices, global overnight cues, F&O-derived
// read for the two indices that matter most (Nifty/Bank Nifty), breadth/regime, sector rotation,
// movers, institutional flows, and teasers into the full Sentiment and Earnings pages. Nothing
// here computes its own numbers where a proven engine already exists (F&O read reuses
// IndexFnoOverview's analyseOI(), sentiment/earnings pulses reuse the same tRPC queries as their
// full pages) — this page's job is composition and prioritization, not new math.
export const MarketCommandCenter: React.FC<MarketCommandCenterProps> = ({ onSelectStock, onSelectIndex, userId }) => {
  return (
    <div className="space-y-6 pb-10">
      <V4QuickNav />

      {/* Hero: title + live clock, then indices/regime/breadth in a unified gradient shell */}
      <div className="rounded-2xl border border-slate-800 bg-gradient-to-br from-indigo-950/30 via-slate-900/60 to-slate-950/80 p-4 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <LayoutDashboard className="w-4 h-4 text-indigo-400" />
            <h1 className="text-sm font-black text-slate-100 uppercase tracking-widest">Market Command Center</h1>
          </div>
          <LiveClock />
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4 flex-wrap">
            <RegimeBadge />
            <div className="flex-1 min-w-[220px] px-3 py-2 rounded-xl border border-slate-800 bg-slate-950/40">
              <MarketMoodGauge />
            </div>
          </div>
          <IndexOverview onSelectIndex={onSelectIndex} />
        </div>
      </div>

      {/* Market Breadth (Intraday) — replaces the old compact Advance/Decline strip with the
          fuller live chart, same shared widget used on Dashboard and the Index Detail page */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <BarChart3 className="w-4 h-4 text-indigo-400" />
          <h2 className="text-xs font-black text-slate-200 uppercase tracking-widest">Market Breadth</h2>
        </div>
        <MarketBreadthIntraday ex="N" refetchInterval={10000} />
      </div>

      {/* Canonical picks + institutional flow -- the decisive numbers, front and center */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopPicksWidget onSelectStock={onSelectStock} userId={userId} />
        <MoneyFlowPulseWidget />
      </div>

      {/* Chronological signal/news/alert stream -- the one piece this page was missing
          relative to v5's MarketPulsePage, per the Phase 3 home-page composition
          ("V6 Canonical Workbench" proposal). Reuses the same shared component
          DashboardPage.tsx already embeds, not a new implementation. */}
      <Card title="Activity Feed" icon={Flame}>
        <ActivityFeed onSelectStock={onSelectStock} />
      </Card>

      <PreMarketBriefing />

      <FnOIndexInsight />

      {/* Sentiment + Global Markets — surfaced right after the F&O read, ahead of the
          supporting sector/movers/earnings sections below */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SentimentPulseWidget />
        <Card title="Global Markets" icon={TrendingDown}>
          <GlobalMarkets />
        </Card>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-3">
          <BarChart3 className="w-4 h-4 text-indigo-400" />
          <h2 className="text-xs font-black text-slate-200 uppercase tracking-widest">Sector Rotation</h2>
        </div>
        <SectorHeatmap />
      </div>

      {/* Rotation trend + diversification -- complements the heatmap above (today's move) with
          the multi-week trend regime and whether these sector bets actually move independently. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectorRotationGraph />
        <SectorCorrelationWidget />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-indigo-400" />
            <h2 className="text-xs font-black text-slate-200 uppercase tracking-widest">Top Movers</h2>
          </div>
          <TopMoversIntelligence onSelectStock={onSelectStock ?? (() => {})} userId={userId} />
        </div>
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Flame className="w-4 h-4 text-indigo-400" />
            <h2 className="text-xs font-black text-slate-200 uppercase tracking-widest">Intraday Breakouts</h2>
          </div>
          <IntradayBreakouts onSelectStock={onSelectStock ?? (() => {})} />
        </div>
      </div>

      {/* Ownership/institutional conviction -- who's buying, ranked, not just what moved. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <InstitutionalDealFeed onSelectStock={onSelectStock} />
        <SuperstarActivityFeed onSelectStock={onSelectStock} />
      </div>

      <HighFlyerWidget onSelectStock={onSelectStock} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ModelBacktestStatusCard modelKey="flyer_classifier" title="Flyer Model — Research Status" />
        <ModelBacktestStatusCard modelKey="breakout_classifier" title="Breakout Model — Research Status" />
      </div>
      <ScreenerComboFinderCard />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <EarningsPulseWidget onSelectStock={onSelectStock} />
        <ConcallTakeawaysWidget onSelectStock={onSelectStock} />
      </div>
    </div>
  );
};

export default MarketCommandCenter;
