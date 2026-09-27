import { Link } from 'react-router-dom';
import { AlertTriangle, Inbox } from 'lucide-react';
import { cn } from '../lib/utils';
import { DASH } from '../lib/format';

/**
 * The one panel primitive. Every surface on the desk is a Panel so that border
 * weight, radius, padding and the hairline top-rule stay identical everywhere —
 * a screen made of twelve slightly-different cards reads as a prototype, not a
 * product.
 */
export function Panel({
  title,
  eyebrow,
  action,
  children,
  className,
  bodyClassName,
  accent,
  dense,
}: {
  title?: React.ReactNode;
  eyebrow?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Draws the 2px marigold rule down the left edge — used for the one panel
   *  on a screen that is the page's actual answer. */
  accent?: boolean;
  dense?: boolean;
}) {
  return (
    <section
      className={cn(
        'relative flex min-w-0 flex-col rounded-lg border border-line bg-ink-850/70',
        accent && 'border-l-2 border-l-marigold',
        className,
      )}
    >
      {(title || eyebrow || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-2.5">
          <div className="flex min-w-0 items-baseline gap-2.5">
            {eyebrow && (
              <span className="font-mono text-[10px] font-medium tracking-[0.18em] text-marigold/80 uppercase">
                {eyebrow}
              </span>
            )}
            {title && (
              <h2 className="truncate font-display text-[13px] font-semibold tracking-tight text-mark">
                {title}
              </h2>
            )}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={cn('min-w-0 flex-1', dense ? 'p-0' : 'p-3.5', bodyClassName)}>{children}</div>
    </section>
  );
}

/** A labelled figure. `tone` colours the value only — the label stays quiet, which
 *  is what lets a dense grid of these stay scannable. */
export function Stat({
  label,
  value,
  sub,
  tone,
  mono = true,
  size = 'md',
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: string;
  mono?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const sizes = {
    sm: 'text-[12px]',
    md: 'text-[15px]',
    lg: 'text-[20px]',
    xl: 'text-[28px]',
  } as const;
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <span className="truncate text-[10px] font-medium tracking-[0.13em] text-mark-3 uppercase">{label}</span>
      <span
        className={cn(
          'tnum truncate leading-tight font-semibold',
          sizes[size],
          mono && 'font-mono',
          tone ?? 'text-mark',
        )}
      >
        {value}
      </span>
      {sub !== undefined && sub !== null && (
        <span className="truncate text-[11px] text-mark-3">{sub}</span>
      )}
    </div>
  );
}

/** Horizontal meter. The track is the full width always, so a 92 and a 34 are
 *  visually comparable at a glance in a stacked list — the whole point. */
export function Meter({
  value,
  max = 100,
  tone = 'bg-marigold',
  height = 'h-1.5',
  className,
}: {
  value: number | null | undefined;
  max?: number;
  tone?: string;
  height?: string;
  className?: string;
}) {
  const v = value == null ? null : Math.max(0, Math.min(max, value));
  return (
    <div className={cn('w-full overflow-hidden rounded-full bg-white/[0.06]', height, className)}>
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', v === null ? 'bg-transparent' : tone)}
        style={{ width: v === null ? '0%' : `${(v / max) * 100}%` }}
      />
    </div>
  );
}

/** Score in a ring. Used where a single number must dominate a panel. */
export function ScoreRing({
  value,
  size = 64,
  label,
  tone,
}: {
  value: number | null | undefined;
  size?: number;
  label?: string;
  tone?: 'marigold' | 'up' | 'down' | 'warn' | 'auto';
}) {
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  const resolved = tone && tone !== 'auto' ? tone : v === null ? 'warn' : v >= 70 ? 'up' : v >= 45 ? 'marigold' : 'down';
  const stroke = { marigold: 'var(--color-marigold)', up: 'var(--color-up)', down: 'var(--color-down)', warn: 'var(--color-mark-4)' }[resolved];
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line-2)" strokeWidth={4} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - (v ?? 0) / 100)}
          style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.16,1,0.3,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="tnum font-mono text-[15px] leading-none font-bold" style={{ color: stroke }}>
          {v === null ? DASH : v.toFixed(0)}
        </span>
        {label && <span className="mt-0.5 text-[8px] tracking-[0.14em] text-mark-3 uppercase">{label}</span>}
      </div>
    </div>
  );
}

/** Small pill. `tone` maps to a closed set so a badge can never be mis-coloured
 *  by an ad-hoc className at a call site. */
export function Chip({
  children,
  tone = 'neutral',
  className,
  mono = true,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'marigold' | 'up' | 'down' | 'warn' | 'info' | 'cool';
  className?: string;
  mono?: boolean;
}) {
  const tones = {
    neutral: 'border-line-2 bg-white/[0.04] text-mark-2',
    marigold: 'border-marigold/30 bg-marigold/10 text-marigold',
    up: 'border-up/30 bg-up/10 text-up',
    down: 'border-down/30 bg-down/10 text-down',
    warn: 'border-warn/30 bg-warn/10 text-warn',
    info: 'border-info/30 bg-info/10 text-info',
    cool: 'border-cool/30 bg-cool/10 text-cool',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] leading-none font-medium whitespace-nowrap',
        mono && 'font-mono',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Inline link to a stock's page. The symbol is the anchor for every row on the
 *  desk, so it is its own component to keep the hit target and mono treatment
 *  identical everywhere. */
export function SymbolLink({
  symbol,
  name,
  className,
  showName,
}: {
  symbol: string;
  name?: string | null;
  className?: string;
  showName?: boolean;
}) {
  return (
    <Link
      to={`/tala/stock/${encodeURIComponent(symbol)}`}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'group inline-flex min-w-0 items-baseline gap-1.5 no-underline',
        className,
      )}
    >
      <span className="tnum font-mono text-[12px] font-semibold text-marigold transition-colors group-hover:text-marigold-2">
        {symbol}
      </span>
      {showName && name && (
        <span className="truncate text-[11px] text-mark-3 group-hover:text-mark-2">{name}</span>
      )}
    </Link>
  );
}

/** Three visual states that every data surface in the app must be able to show.
 *  The empty state is NOT a spinner-forever case: main.tsx documents that this app's
 *  dominant failure mode is a failed query rendering identically to a loading one,
 *  so "no rows" and "request failed" are visually distinct at every call site. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('tala-live-dot rounded bg-white/[0.06]', className)} />;
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const msg = error instanceof Error ? error.message : String((error as any)?.message ?? 'Request failed');
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-2 rounded border border-down/25 bg-down/[0.05]',
        compact ? 'p-2.5' : 'p-4',
      )}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle size={13} className="shrink-0 text-down" />
        <span className="text-[11px] font-semibold text-down-2">Data unavailable</span>
      </div>
      <p className="tala-scroll max-h-20 overflow-y-auto font-mono text-[10px] leading-relaxed break-words text-mark-3">
        {msg}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="rounded border border-line-2 px-2 py-1 font-mono text-[10px] text-mark-2 transition-colors hover:border-marigold/40 hover:text-marigold"
        >
          RETRY
        </button>
      )}
    </div>
  );
}

export function EmptyState({ label, hint, icon }: { label: string; hint?: string; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
      <div className="text-mark-4">{icon ?? <Inbox size={20} />}</div>
      <p className="text-[12px] font-medium text-mark-2">{label}</p>
      {hint && <p className="max-w-sm text-[11px] leading-relaxed text-mark-4">{hint}</p>}
    </div>
  );
}
