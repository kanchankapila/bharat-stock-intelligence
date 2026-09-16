import React from 'react';
import { trpc } from '../lib/trpc';

// Tickertape Market Mood Index (fear/greed, 0-100) — data already fed into macro_asset_prices
// by mmi_fetcher.py (scheduled daily in ml-daily-ops) and consumed by ml_ensemble.py's macro
// features + the HMM regime detector, but had zero frontend visibility until this widget
// (2026-08-06 urls.txt data analysis). India's best-known retail-sentiment gauge, analogous to
// CNN's Fear & Greed Index — a single-glance context widget, not a trading signal on its own.
const ZONE_COLOR: Record<string, string> = {
  'Extreme Greed': 'text-emerald-400',
  'Greed': 'text-emerald-300',
  'Fear': 'text-amber-400',
  'Extreme Fear': 'text-rose-400',
};

const ZONE_BAR: Record<string, string> = {
  'Extreme Greed': 'bg-emerald-500',
  'Greed': 'bg-emerald-400',
  'Fear': 'bg-amber-400',
  'Extreme Fear': 'bg-rose-500',
};

export const MarketMoodGauge: React.FC = () => {
  const { data, isLoading } = trpc.getMarketMoodIndex.useQuery(undefined, {
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-1">
        <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-[9px] font-black text-slate-500 font-display uppercase tracking-widest">Loading mood…</span>
      </div>
    );
  }

  if (!data) {
    return <p className="text-[9px] font-black text-slate-500 font-display uppercase tracking-wider">Market Mood Index unavailable</p>;
  }

  const { indicator, zone, date } = data;
  const pct = Math.max(0, Math.min(100, indicator));
  const zoneClass = ZONE_COLOR[zone] || 'text-slate-400';
  const barClass = ZONE_BAR[zone] || 'bg-slate-500';
  // date is a calendar day (macro_asset_prices.date), not a timestamp — never render server
  // output directly (see pgClient.ts's DATE type-parser note for why this was a real crash).
  const dateLabel = date instanceof Date ? date.toISOString().slice(0, 10) : String(date ?? '—');

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] font-black text-slate-400 font-display uppercase tracking-wider">Market Mood Index</span>
        <span className="text-[9px] text-slate-500">as of {dateLabel}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className={`text-2xl font-black tabular-nums ${zoneClass}`}>{indicator.toFixed(0)}</span>
        <div className="flex-1">
          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div className={`h-full rounded-full ${barClass}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <span className={`text-[10px] font-bold font-display uppercase tracking-wide ${zoneClass}`}>{zone}</span>
      </div>
    </div>
  );
};
