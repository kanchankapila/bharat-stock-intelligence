import { cn } from '../lib/utils';

// Moneycontrol/Trendlyne-style tag strip: a single row of small colored chips summarizing
// every signal category (earnings, insider, ownership, financial quality, delivery, options,
// surveillance, index membership) at a glance. Shared by BuyRecommendationsPage's cards and
// v4's StockIntelligencePage header so a stock reads the same way wherever it's shown.
// Deliberately data-driven: a chip only renders when the underlying field is present, so an
// unscored/undercovered stock just shows fewer tags rather than a fabricated "neutral" one.

export const CONVICTION_STYLE: Record<string, { label: string; bg: string; border: string; text: string }> = {
  S_ELITE:    { label: 'S — Elite',    bg: 'bg-emerald-500/20', border: 'border-emerald-500/40', text: 'text-emerald-300' },
  A_HIGH:     { label: 'A — High',     bg: 'bg-sky-500/20',     border: 'border-sky-500/40',     text: 'text-sky-300'     },
  B_MEDIUM:   { label: 'B — Medium',   bg: 'bg-amber-500/15',   border: 'border-amber-500/35',   text: 'text-amber-300'   },
  C_LOW:      { label: 'C — Low',      bg: 'bg-slate-700/40',   border: 'border-slate-600/40',   text: 'text-slate-400'   },
  D_MARGINAL: { label: 'D — Marginal', bg: 'bg-zinc-800/60',    border: 'border-zinc-700/40',    text: 'text-zinc-500'    },
};

export function ConvictionPill({ level }: { level: string | null | undefined }) {
  if (!level) return null;
  const style = CONVICTION_STYLE[level] ?? CONVICTION_STYLE.C_LOW;
  return (
    <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-bold border', style.bg, style.border, style.text)}>
      {style.label}
    </span>
  );
}

function Tag({ label, color = 'bg-slate-700 text-slate-300' }: { label: string; color?: string }) {
  return <span className={cn('px-1.5 py-0.5 rounded text-[9px] font-semibold font-display uppercase tracking-wide', color)}>{label}</span>;
}

/** Row-shape accepted from either getBuyRecommendations picks or getUnifiedScoreForSymbol. */
export interface TaggableStock {
  eps_beat_streak?: number | null;
  eps_surprise_q1?: number | null;
  eps_miss_after_streak?: boolean | number | null;
  insider_buy_flag?: boolean | number | null;
  insider_sell_flag?: boolean | number | null;
  promoter_net_90d?: number | null;
  rating_upgrade_180d?: boolean | number | null;
  rating_downgrade_180d?: boolean | number | null;
  fcf_positive?: boolean | number | null;
  fcf_yield?: number | null;
  debt_coverage_risk?: boolean | number | null;
  block_deal_flag?: boolean | number | null;
  block_deal_direction?: number | null;
  mf_sector_flow_pct?: number | null;
  wc_improving?: boolean | number | null;
  wc_deteriorating?: boolean | number | null;
  asm_flag?: boolean | number | null;
  gsm_stage?: string | number | null;
  is_nifty50?: boolean | number | null;
  nifty_tier?: string | null;
}

/**
 * Pure decision logic, exported so it's testable without rendering. `?? 0` was replaced with
 * an explicit `!= null` guard throughout -- functionally identical against every threshold here
 * (0 never clears a `> 0.5`/`> 3`/`> 5`/`>= 3` bar), but makes "missing data suppresses the
 * badge" the visible intent rather than an accident of the fallback value.
 */
export function buildStockBadges(p: TaggableStock): Array<{ label: string; color: string }> {
  const badges: Array<{ label: string; color: string }> = [];

  if (p.eps_beat_streak != null && p.eps_beat_streak >= 3) badges.push({ label: `EPS ×${p.eps_beat_streak}`, color: 'bg-emerald-500/20 text-emerald-300' });
  else if (p.eps_surprise_q1 != null && p.eps_surprise_q1 > 5) badges.push({ label: 'EPS beat', color: 'bg-emerald-500/15 text-emerald-400' });
  if (p.eps_miss_after_streak) badges.push({ label: 'PEAD', color: 'bg-rose-500/20 text-rose-300' });

  if (p.insider_buy_flag) badges.push({ label: 'Insider buy', color: 'bg-violet-500/20 text-violet-300' });
  if (p.insider_sell_flag) badges.push({ label: 'Insider sell', color: 'bg-rose-500/15 text-rose-400' });
  if (p.promoter_net_90d != null && p.promoter_net_90d > 0.5) badges.push({ label: 'Promoter ↑', color: 'bg-violet-500/15 text-violet-400' });

  if (p.rating_upgrade_180d) badges.push({ label: 'Rating ↑', color: 'bg-sky-500/20 text-sky-300' });
  if (p.rating_downgrade_180d) badges.push({ label: 'Rating ↓', color: 'bg-rose-500/15 text-rose-400' });

  if (p.fcf_positive && p.fcf_yield != null && p.fcf_yield > 3) badges.push({ label: `FCF ${p.fcf_yield.toFixed(1)}%`, color: 'bg-teal-500/20 text-teal-300' });
  if (p.debt_coverage_risk) badges.push({ label: 'Debt risk', color: 'bg-orange-500/20 text-orange-300' });

  if (p.block_deal_flag && p.block_deal_direction != null && p.block_deal_direction > 0) badges.push({ label: 'Block buy', color: 'bg-sky-500/15 text-sky-400' });
  if (p.block_deal_flag && p.block_deal_direction != null && p.block_deal_direction < 0) badges.push({ label: 'Block sell', color: 'bg-rose-500/15 text-rose-400' });

  if (p.mf_sector_flow_pct != null && p.mf_sector_flow_pct > 1) badges.push({ label: 'MF inflow', color: 'bg-indigo-500/20 text-indigo-300' });

  if (p.wc_improving) badges.push({ label: 'WC ↑', color: 'bg-teal-500/15 text-teal-400' });
  if (p.wc_deteriorating) badges.push({ label: 'WC ↓', color: 'bg-orange-500/15 text-orange-400' });

  if (p.asm_flag) badges.push({ label: 'ASM', color: 'bg-red-500/25 text-red-300' });
  if (p.gsm_stage) badges.push({ label: `GSM ${p.gsm_stage}`, color: 'bg-red-500/20 text-red-300' });

  if (p.is_nifty50) badges.push({ label: 'N50', color: 'bg-slate-600/60 text-slate-300' });
  else if (p.nifty_tier) badges.push({ label: p.nifty_tier, color: 'bg-slate-700/60 text-slate-300' });

  return badges;
}

export function StockTagRow({ p, className }: { p: TaggableStock; className?: string }) {
  const badges = buildStockBadges(p);

  if (badges.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {badges.map((b, i) => <Tag key={i} label={b.label} color={b.color} />)}
    </div>
  );
}
