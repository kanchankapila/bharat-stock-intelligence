import React from 'react';
import { motion } from 'motion/react';
import { trpc } from '../../../lib/trpc';

// Same arc-path math as the private BreadthGauge in DashboardPage.tsx (v1 Dashboard), but the
// data source is swapped: v1 derives its ratio from a page-local `stocks` prop -- a second,
// non-canonical breadth read that can disagree with MarketBreadthIntraday sitting on the same
// page. This queries the same trpc.getAdvanceDecline that MarketBreadthIntraday already uses,
// so the donut can never drift from the chart next to it.
export const BreadthDonut: React.FC<{ ex?: string }> = ({ ex = 'N' }) => {
  const { data: advDec } = trpc.getAdvanceDecline.useQuery({ ex });
  const latest = (advDec as any)?.data?.['0'] ?? {};
  const advances = latest.advances ?? 0;
  const declines = latest.declines ?? 0;
  const total = advances + declines || 1;
  const ratio = advances / total;

  const R = 58;
  const cx = 70;
  const cy = 70;
  const startAngle = Math.PI * 0.85;
  const endAngle = Math.PI * 0.15;
  const sweep = 2 * Math.PI - (startAngle - endAngle);

  const arcPath = (fraction: number, r: number) => {
    const start = startAngle;
    const end = start + sweep * fraction;
    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const large = sweep * fraction > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  const gaugeColor = ratio > 0.6 ? 'var(--v6-positive)' : ratio < 0.4 ? 'var(--v6-negative)' : 'var(--v6-warning)';

  return (
    <div className="glass rounded-xl px-4 py-2 border border-[var(--v6-border)] flex flex-col items-center justify-center shrink-0">
      <svg width={140} height={100} viewBox="0 0 140 100">
        <path d={arcPath(1, R)} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={10} strokeLinecap="round" />
        <motion.path
          d={arcPath(ratio, R)}
          fill="none"
          stroke={gaugeColor}
          strokeWidth={10}
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: ratio }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
        />
        <text x={cx} y={cy - 4} textAnchor="middle" className="v6-mono" style={{ fontSize: 18, fontWeight: 700, fill: 'var(--v6-ink)' }}>
          {Math.round(ratio * 100)}%
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle" className="v6-title" style={{ fontSize: 9, fill: 'var(--v6-faint)' }}>
          BREADTH
        </text>
        <text x={12} y={95} className="v6-mono" style={{ fontSize: 9, fill: 'var(--v6-negative)' }}>{declines}↓</text>
        <text x={110} y={95} className="v6-mono" style={{ fontSize: 9, fill: 'var(--v6-positive)' }}>{advances}↑</text>
      </svg>
    </div>
  );
};

export default BreadthDonut;
