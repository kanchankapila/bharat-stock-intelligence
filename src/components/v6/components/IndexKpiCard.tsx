import React from 'react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { trpc } from '../../../lib/trpc';

interface IndexKpiCardProps {
  name: string;
  value: number;
  change: number;
  changePct: number;
  hasData: boolean;
  dayLow?: number | null;
  dayHigh?: number | null;
  onClick?: () => void;
}

// ponytail: getMarketOverview doesn't return day-low/high yet (marketData.ts only captures
// last_trade_price/change_value/change_per from NiftyTrader) -- render a neutral 50% fill
// rather than fabricate a number. Unlocks once the backend threads dayLow/dayHigh through.
// Exported standalone so it's testable without rendering the component (repo has no
// component-render test infra -- see src/v6/components/__tests__/IndexKpiCard.test.ts).
export function dayRangePct(value: number, dayLow?: number | null, dayHigh?: number | null): number {
  if (dayLow == null || dayHigh == null || dayHigh <= dayLow) return 50;
  return Math.min(100, Math.max(0, ((value - dayLow) / (dayHigh - dayLow)) * 100));
}

export const IndexKpiCard: React.FC<IndexKpiCardProps> = ({
  name, value, change, changePct, hasData, dayLow, dayHigh, onClick,
}) => {
  const isUp = hasData && change >= 0;
  const tone = !hasData ? 'var(--v6-faint)' : isUp ? 'var(--v6-positive)' : 'var(--v6-negative)';
  const rangePct = dayRangePct(value, dayLow, dayHigh);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="glass rounded-xl px-4 py-3 border text-left flex-1 min-w-[180px]"
      style={{ borderColor: hasData ? `${tone}33` : 'var(--v6-border)', cursor: onClick ? 'pointer' : 'default' }}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--v6-faint)' }}>
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: tone, boxShadow: hasData ? `0 0 4px ${tone}` : 'none' }} />
          {name}
        </span>
        {hasData && (
          <span
            className="inline-flex items-center gap-0.5 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded"
            style={{ color: tone, background: `${tone}1f` }}
          >
            {isUp ? <ArrowUpRight className="w-2.5 h-2.5" /> : <ArrowDownRight className="w-2.5 h-2.5" />}
            {isUp ? 'BULL' : 'BEAR'}
          </span>
        )}
      </div>
      <p className="text-lg font-bold font-mono mb-1" style={{ color: 'var(--v6-ink)' }}>
        {hasData ? value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}
      </p>
      {hasData && (
        <p className="text-[11px] font-mono mb-2" style={{ color: tone }}>
          {change >= 0 ? '+' : ''}{change.toFixed(2)} ({changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%)
        </p>
      )}
      <div className="v6-bar-track">
        <div className="v6-bar-fill" style={{ width: `${rangePct}%`, background: hasData ? tone : 'var(--v6-border-strong)' }} />
      </div>
    </button>
  );
};

const INDEX_ID: Record<string, string> = { 'NIFTY 50': '9', SENSEX: '4', 'BANK NIFTY': '23' };

/** Owns the getMarketOverview query, same shape/stale-guard as src/components/MarketIndices.tsx --
    not importing that component directly since it hardcodes v1's raw Tailwind, not --v6-* tokens. */
export const IndexKpiRow: React.FC<{ onSelectIndex?: (id: string, name: string) => void }> = ({ onSelectIndex }) => {
  const { data: indices, isLoading } = trpc.getMarketOverview.useQuery();

  if (isLoading || !indices) {
    return (
      <div className="flex flex-wrap gap-3 flex-1">
        {[1, 2, 3].map((i) => <div key={i} className="flex-1 min-w-[180px] h-[92px] rounded-xl v6-bar-track" />)}
      </div>
    );
  }

  // The backend's stale-fetch fallback is a truthy object with null value/change/changePct --
  // object presence alone doesn't mean real data (see market.router.ts's getMarketOverview).
  const defaultIndex = { value: 0, change: 0, changePct: 0 };
  const hasRealData = (idx: { value: number | null } | null | undefined): boolean => !!idx && idx.value != null;
  const items = [
    { name: 'NIFTY 50', hasData: hasRealData(indices.nifty50), ...(indices.nifty50 || defaultIndex) },
    { name: 'SENSEX', hasData: hasRealData(indices.sensex), ...(indices.sensex || defaultIndex) },
    { name: 'BANK NIFTY', hasData: hasRealData(indices.bankNifty), ...(indices.bankNifty || defaultIndex) },
  ];

  return (
    <div className="flex flex-wrap gap-3 flex-1">
      {items.map((item) => (
        <IndexKpiCard
          key={item.name}
          name={item.name}
          value={item.value}
          change={item.change}
          changePct={item.changePct}
          hasData={item.hasData}
          onClick={onSelectIndex ? () => onSelectIndex(INDEX_ID[item.name] ?? '', item.name) : undefined}
        />
      ))}
    </div>
  );
};

export default IndexKpiCard;
