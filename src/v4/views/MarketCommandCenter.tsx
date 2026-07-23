import React from 'react';
import { Activity, Gauge, TrendingUp, TrendingDown, Flame, BarChart3 } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';
import { cn } from '../../lib/utils';
import { IndexOverview, InstitutionalInsights } from '../../components/MarketInsights';
import { SectorHeatmap } from '../../components/SectorIntelligence';
import { TopMoversIntelligence } from '../../components/TopMoversIntelligence';
import { IntradayBreakouts } from '../../components/IntradayBreakouts';
import { GlobalMarkets } from '../../components/GlobalMarkets';
import { PreMarketBriefing } from '../components/PreMarketBriefing';
import { FnOIndexInsight } from '../components/FnOIndexInsight';
import { SentimentPulseWidget } from '../components/SentimentPulseWidget';
import { EarningsPulseWidget } from '../components/EarningsPulseWidget';

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

const BreadthStrip: React.FC = () => {
  const { data } = trpc.getIntradayBreadth.useQuery(undefined, { refetchInterval: 60000 });
  const b = data?.breadth as { adv?: number; dec?: number; advDeclineRatio?: number } | null | undefined;
  if (!b) return null;
  const adv = b.adv ?? null;
  const dec = b.dec ?? null;
  const ratio = b.advDeclineRatio ?? 0.5;
  const color = ratio > 0.6 ? 'text-emerald-400' : ratio < 0.4 ? 'text-rose-400' : 'text-amber-400';

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-xl border border-slate-800 bg-slate-950/30">
      <Activity className={cn('w-4 h-4', color)} />
      <div>
        <div className={cn('text-xs font-black font-mono', color)}>
          {adv ?? '—'}<span className="text-slate-600 mx-1">/</span>{dec ?? '—'}
        </div>
        <div className="text-[9px] text-slate-500 uppercase tracking-widest">Advance / Decline</div>
      </div>
    </div>
  );
};

interface MarketCommandCenterProps {
  onSelectStock?: (symbol: string) => void;
  onSelectIndex?: (id: string, name: string) => void;
}

// Page 1 — "the pre-trading-day briefing" — a fresh page that combines what an expert analyst
// checks before the bell into one decisive view: indices, global overnight cues, F&O-derived
// read for the two indices that matter most (Nifty/Bank Nifty), breadth/regime, sector rotation,
// movers, institutional flows, and teasers into the full Sentiment and Earnings pages. Nothing
// here computes its own numbers where a proven engine already exists (F&O read reuses
// IndexFnoOverview's analyseOI(), sentiment/earnings pulses reuse the same tRPC queries as their
// full pages) — this page's job is composition and prioritization, not new math.
export const MarketCommandCenter: React.FC<MarketCommandCenterProps> = ({ onSelectStock, onSelectIndex }) => {
  return (
    <div className="space-y-6 pb-10">
      {/* Header strip: indices + regime + breadth */}
      <div className="flex flex-col lg:flex-row gap-4 lg:items-start">
        <div className="flex-1">
          <IndexOverview onSelectIndex={onSelectIndex} />
        </div>
        <div className="flex flex-row lg:flex-col gap-3 shrink-0">
          <RegimeBadge />
          <BreadthStrip />
        </div>
      </div>

      <PreMarketBriefing />

      <FnOIndexInsight />

      <div>
        <div className="flex items-center gap-2 mb-3">
          <BarChart3 className="w-4 h-4 text-indigo-400" />
          <h2 className="text-xs font-black text-slate-200 uppercase tracking-widest">Sector Rotation</h2>
        </div>
        <SectorHeatmap />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-indigo-400" />
            <h2 className="text-xs font-black text-slate-200 uppercase tracking-widest">Top Movers</h2>
          </div>
          <TopMoversIntelligence onSelectStock={onSelectStock ?? (() => {})} />
        </div>
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Flame className="w-4 h-4 text-indigo-400" />
            <h2 className="text-xs font-black text-slate-200 uppercase tracking-widest">Intraday Breakouts</h2>
          </div>
          <IntradayBreakouts onSelectStock={onSelectStock ?? (() => {})} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SentimentPulseWidget />
        <EarningsPulseWidget onSelectStock={onSelectStock} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <InstitutionalInsights />
        <Card title="Global Markets" icon={TrendingDown}>
          <GlobalMarkets />
        </Card>
      </div>
    </div>
  );
};

export default MarketCommandCenter;
