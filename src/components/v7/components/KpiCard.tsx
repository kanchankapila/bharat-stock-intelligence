import React from 'react';
import { TrendingUp, TrendingDown, Minus, AlertTriangle, Activity } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { DASH, formatINR, formatPct, formatCr, formatNumber, toneOf, changeText } from '../lib';
import { formatIST } from '../../../lib/timeFormat';

interface KpiCardProps {
  title: string;
  value?: number | string | null;
  change?: number | null | undefined;
  changePct?: number | null | undefined;
  unit?: 'inr' | 'cr' | 'pct' | 'number' | 'raw';
  decimals?: number;
  asOf?: string | Date | null;
  stale?: boolean;
  subtitle?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
}

const VALUE_FMT: Record<KpiCardProps['unit'], (v: number | null | undefined, d?: number) => string> = {
  inr: (v, d) => (v == null || !Number.isFinite(Number(v))) ? DASH : `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: d ?? 0, maximumFractionDigits: d ?? 0 })}`,
  cr: (v, d) => formatCr(v, d),
  pct: (v, d) => formatPct(v, d ?? 2, true),
  number: (v, d) => formatNumber(v, d ?? 2),
  raw: (v) => (v == null || !Number.isFinite(Number(v))) ? DASH : String(v),
};

export const KpiCard: React.FC<KpiCardProps> = ({
  title, value, change, changePct, unit = 'raw', decimals, asOf, stale, subtitle, icon, onClick,
}) => {
  const n = value == null ? null : Number(value);
  const hasData = n != null && Number.isFinite(n);
  const displayed = hasData ? VALUE_FMT[unit](n, decimals) : DASH;
  const tone = toneOf(change);
  const changePart = changeText(change, changePct != null ? undefined : 2);
  const pctPart = changePct != null ? ` (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)` : '';

  return (
    <div
      className={cn('v7-kpi-card', onClick && 'cursor-pointer', onClick && 'hover:border-white/15 hover:shadow-[0_0_20px_rgba(0,0,0,0.4)] transition-all duration-200')}
      style={{ borderColor: stale ? 'var(--v7-warn-border)' : undefined }}
      onClick={onClick}
    >
      <div className="v7-kpi-head">
        <span className="v7-kpi-label">{title}</span>
        {stale && (
          <AlertTriangle size={12} strokeWidth={1.5} className="text-amber-400" />
        )}
        {asOf && <span className="v7-kpi-asof">AS OF {formatIST(asOf)}</span>}
      </div>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="v7-kpi-value">{displayed}</span>
        {unit === 'cr' && <span className="text-xs text-slate-500 font-mono">Cr</span>}
      </div>
      <span className={cn(changePart.cls)}>
        {tone === 'up' ? <TrendingUp className="w-3 h-3 mr-1" /> : tone === 'down' ? <TrendingDown className="w-3 h-3 mr-1" /> : <Minus className="w-3 h-3 mr-1" />}
        {changePart.text}{pctPart}
      </span>
      {subtitle && <p className="v7-kpi-sub">{subtitle}</p>}
    </div>
  );
};

export default KpiCard;
