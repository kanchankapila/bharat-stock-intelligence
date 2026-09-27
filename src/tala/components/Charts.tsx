import { useMemo } from 'react';
import { cn } from '../lib/utils';
import { num } from '../lib/format';

function toPath(values: number[], w: number, h: number, pad: number): string {
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = (w - pad * 2) / (values.length - 1);
  return values
    .map((v, i) => {
      const x = pad + i * stepX;
      const y = pad + (1 - (v - min) / span) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

/**
 * Sparkline. Hand-rolled SVG rather than a chart library because at this size
 * recharts' ResponsiveContainer measurer fights a flex parent and adds a layout
 * pass per spark — and the desk renders a hundred of these at once. The fill
 * under the line is what makes a 40px chart readable as a trend rather than a squiggle.
 */
export function Sparkline({
  data,
  width = 72,
  height = 22,
  tone,
  className,
}: {
  data: (number | null | undefined)[];
  width?: number;
  height?: number;
  tone?: 'up' | 'down' | 'auto' | 'muted';
  className?: string;
}) {
  const values = useMemo(() => data.map((d) => num(d)).filter((d): d is number => d !== null), [data]);
  const gid = useMemo(() => `sg-${Math.random().toString(36).slice(2, 9)}`, []);
  if (values.length < 2) {
    return <div className={cn('rounded bg-white/[0.04]', className)} style={{ width, height }} />;
  }
  const first = values[0];
  const last = values[values.length - 1];
  const resolved = tone === 'auto' || !tone ? (last >= first ? 'up' : 'down') : tone;
  const stroke =
    resolved === 'up' ? 'var(--color-up)' : resolved === 'down' ? 'var(--color-down)' : 'var(--color-mark-4)';
  const d = toPath(values, width, height, 2);
  const area = `${d} L${width - 2},${height} L2,${height} Z`;

  return (
    <svg width={width} height={height} className={cn('overflow-visible', className)} aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Full price chart with an area fill, an optional moving-average overlay and an
 * optional entry-zone band. Shared by the index page and the stock page so a
 * reader learns one chart grammar.
 */
export function PriceChart({
  data,
  height = 220,
  showArea = true,
  ma,
  band,
  className,
}: {
  data: { date: string; close: number }[];
  height?: number;
  showArea?: boolean;
  /** Optional moving-average series, same length as `data`. */
  ma?: (number | null)[];
  /** Optional horizontal band, e.g. a published entry zone. */
  band?: { from: number; to: number } | null;
  className?: string;
}) {
  const W = 1000;
  const H = height;
  const PAD = 6;
  const gid = useMemo(() => `pc-${Math.random().toString(36).slice(2, 9)}`, []);

  const { closePath, closeArea, maPath, min, max } = useMemo(() => {
    const closes = data.map((d) => d.close);
    const withMa = (ma ?? []).map((m) => num(m));
    const all = [...closes, ...withMa.filter((m): m is number => m !== null)];
    if (all.length < 2) return { closePath: '', closeArea: '', maPath: '', min: 0, max: 1 };
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const span = hi - lo || 1;
    const stepX = (W - PAD * 2) / (data.length - 1);
    const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - PAD * 2);
    const cp = closes
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${(PAD + i * stepX).toFixed(2)},${y(v).toFixed(2)}`)
      .join(' ');
    const mp = withMa
      .map((v, i) => (v === null ? null : `${i === 0 ? 'M' : 'L'}${(PAD + i * stepX).toFixed(2)},${y(v).toFixed(2)}`))
      .filter(Boolean)
      .join(' ');
    return {
      closePath: cp,
      closeArea: `${cp} L${W - PAD},${H - PAD} L${PAD},${H - PAD} Z`,
      maPath: mp,
      min: lo,
      max: hi,
    };
  }, [data, ma, H]);

  if (!closePath) {
    return (
      <div
        className={cn('flex items-center justify-center rounded border border-line text-[11px] text-mark-4', className)}
        style={{ height }}
      >
        Not enough price history
      </div>
    );
  }

  const rising = data[data.length - 1].close >= data[0].close;
  const stroke = rising ? 'var(--color-up)' : 'var(--color-down)';
  const span = max - min || 1;
  const yFor = (v: number) => PAD + (1 - (v - min) / span) * (H - PAD * 2);

  return (
    <div className={cn('tala-grid relative overflow-hidden rounded border border-line bg-ink-900/60', className)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {band && (
          <rect
            x={PAD}
            width={W - PAD * 2}
            y={yFor(band.to)}
            height={Math.max(1, yFor(band.from) - yFor(band.to))}
            fill="var(--color-marigold)"
            opacity="0.09"
          />
        )}
        {showArea && <path d={closeArea} fill={`url(#${gid})`} />}
        {maPath && (
          <path d={maPath} fill="none" stroke="var(--color-warn)" strokeWidth="1.2" opacity="0.7" vectorEffect="non-scaling-stroke" />
        )}
        <path d={closePath} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between px-2 py-1 font-mono text-[9px] text-mark-4">
        <span>{data[0]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  );
}

/** Horizontal bar row used for sector heat and category breakdowns. */
export function BarRow({
  label,
  value,
  max,
  tone = 'bg-marigold',
  right,
  sub,
  onClick,
}: {
  label: React.ReactNode;
  value: number | null;
  max?: number;
  tone?: string;
  right?: React.ReactNode;
  sub?: React.ReactNode;
  onClick?: () => void;
}) {
  const v = num(value);
  const m = max ?? Math.max(1, v ?? 1);
  return (
    <div onClick={onClick} className={cn('group flex items-center gap-2.5 py-1', onClick && 'cursor-pointer')}>
      <span className="w-24 shrink-0 truncate text-[11px] text-mark-2 group-hover:text-mark">{label}</span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
        <div
          className={cn('h-full rounded-full transition-[width] duration-500', tone)}
          style={{ width: v === null ? '0%' : `${Math.max(0, Math.min(100, (v / m) * 100))}%` }}
        />
      </div>
      {right && <span className="tnum w-14 shrink-0 text-right font-mono text-[11px] text-mark">{right}</span>}
      {sub && <span className="tnum w-10 shrink-0 text-right font-mono text-[10px] text-mark-3">{sub}</span>}
    </div>
  );
}
