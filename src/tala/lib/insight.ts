/**
 * The analyst layer.
 *
 * Everything here is a PRESENTATION of numbers the platform already computed —
 * it introduces no new score and re-weights nothing. That is a deliberate
 * constraint, not modesty: this repo's own rule file (.claude/rules/scoring-authority.md)
 * makes the ranker the single authority on what a stock scores, and the whole
 * measured track record is only valid while that stays true. So the functions
 * below read, classify, and explain — and where they warn, they say why, out loud.
 */

import { num, parseJson } from './format';

// â”€â”€ Regimes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type Regime = 'BULL' | 'SIDEWAYS' | 'HIGH_VOL' | 'BEAR' | 'CRASH';

export interface RegimeRead {
  name: Regime;
  confidence: number;
  /** One line, plain English: what this regime means for a long-only swing book. */
  stance: string;
  /** What to favour right now. */
  favour: string;
  /** What to avoid right now. */
  avoid: string;
  /** Position-size multiplier hint. Deliberately coarse — never a precise %,
   *  because a regime label cannot support one. */
  size: 'full' | 'reduced' | 'half' | 'minimal' | 'cash';
  tone: 'up' | 'down' | 'warn' | 'flat';
}

const REGIME_TABLE: Record<Regime, Omit<RegimeRead, 'name' | 'confidence'>> = {
  BULL: {
    stance: 'Trending. Own the leaders and let winners run.',
    favour: 'Momentum and breakout names above their 50-DMA',
    avoid: 'Defensive laggards and low-beta defensives',
    size: 'full',
    tone: 'up',
  },
  SIDEWAYS: {
    stance: 'Range-bound. Rotate and buy weakness, do not chase strength.',
    favour: 'Value + quality at range support, buy-on-dips setups',
    avoid: 'Anything that needs a trend to work',
    size: 'reduced',
    tone: 'warn',
  },
  HIGH_VOL: {
    stance: 'Elevated volatility. Cut size, tighten stops, hedge beta.',
    favour: 'Low-beta defensives and cash',
    avoid: 'High-beta small caps and wide-range names',
    size: 'half',
    tone: 'warn',
  },
  BEAR: {
    stance: 'Downtrend. Preserve capital; new longs must earn their place.',
    favour: 'Cash, short hedges, and only the strongest quality names',
    avoid: 'New long positions and falling-knife names',
    size: 'minimal',
    tone: 'down',
  },
  CRASH: {
    stance: 'Crash regime. The book should be in cash and waiting.',
    favour: 'Cash',
    avoid: 'Everything',
    size: 'cash',
    tone: 'down',
  },
};

export function readRegime(name: unknown, confidence: unknown): RegimeRead {
  const key = (String(name ?? '').toUpperCase() as Regime) in REGIME_TABLE
    ? (String(name).toUpperCase() as Regime)
    : 'SIDEWAYS';
  return {
    name: key,
    confidence: num(confidence) ?? 0.5,
    ...REGIME_TABLE[key],
  };
}

// â”€â”€ Conviction tiers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type Conviction = 'S_ELITE' | 'A_HIGH' | 'B_MEDIUM' | 'C_LOW' | 'D_MARGINAL';

const CONVICTION_TONE: Record<Conviction, { text: string; bg: string; ring: string; label: string }> = {
  S_ELITE: { text: 'text-marigold', bg: 'bg-marigold/12', ring: 'ring-marigold/40', label: 'S' },
  A_HIGH: { text: 'text-up', bg: 'bg-up/12', ring: 'ring-up/35', label: 'A' },
  B_MEDIUM: { text: 'text-info', bg: 'bg-info/12', ring: 'ring-info/30', label: 'B' },
  C_LOW: { text: 'text-mark-2', bg: 'bg-white/[0.05]', ring: 'ring-white/10', label: 'C' },
  D_MARGINAL: { text: 'text-mark-4', bg: 'bg-white/[0.03]', ring: 'ring-white/5', label: 'D' },
};

export function convictionTone(level: unknown) {
  const key = String(level ?? 'C_LOW').toUpperCase() as Conviction;
  return CONVICTION_TONE[key] ?? CONVICTION_TONE.C_LOW;
}

/** Classification (Strong Buy / Buy / Hold / Sell / Strong Sell) -> action + tone. */
export function classifyAction(classification: unknown): { action: string; tone: RegimeRead['tone']; long: boolean } {
  const c = String(classification ?? '').toLowerCase();
  if (c.includes('strong buy')) return { action: 'STRONG BUY', tone: 'up', long: true };
  if (c.includes('buy')) return { action: 'BUY', tone: 'up', long: true };
  if (c.includes('strong sell')) return { action: 'STRONG SELL', tone: 'down', long: false };
  if (c.includes('sell')) return { action: 'SELL', tone: 'down', long: false };
  return { action: 'HOLD', tone: 'flat', long: false };
}


// â”€â”€ Engine decomposition â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * A pick row carries several independent engine scores, all 0..100. Showing the
 * aggregate alone hides the most useful question a trader asks — "do all my
 * engines agree, or is one carrying this?" — so the desk always shows the parts
 * next to the whole.
 */
export interface EngineBar {
  key: string;
  label: string;
  value: number | null;
  /** True when this engine is meaningfully below the row's mean — the "one engine
   *  is dragging" case, the single most useful thing a panel of engine scores
   *  can tell you. */
  lagging: boolean;
}

export interface PickRow {
  symbol: string;
  unified_score: number | null;
  conviction_level: string;
  timeframe: string | null;
  sector: string | null;
  classification: string | null;
  stop_loss: number | null;
  target_1: number | null;
  target_2: number | null;
  entry_zone_low: number | null;
  entry_zone_high: number | null;
  risk_reward: number | null;
  ml_score: number | null;
  confluence_score: number | null;
  technical_score: number | null;
  dl_score: number | null;
  screener_stock_score?: number | null;
  fundamental_score?: number | null;
  trade_reasoning?: string | null;
  engine_coverage_count?: number | null;
  computed_at?: string | null;
  win_probability?: number | null;
  signal_type?: string | null;
  rsi?: number | null;
  cmp?: number | null;
  change_pct?: number | null;
  livePrice?: number | null;
  changePercent?: number | null;
  [k: string]: unknown;
}

export function engineBars(p: PickRow): EngineBar[] {
  const raw: [string, string, unknown][] = [
    ['confluence', 'Confluence', p.confluence_score],
    ['technical', 'Technical', p.technical_score],
    ['ml', 'ML', p.ml_score],
    ['dl', 'Deep-Learn', p.dl_score],
    ['screener', 'Screener', p.screener_stock_score],
    ['fundamental', 'Fundamental', p.fundamental_score],
  ];
  const present = raw.filter(([, , v]) => num(v) !== null) as [string, string, number][];
  const mean = present.length ? present.reduce((s, [, , v]) => s + v, 0) / present.length : null;
  return raw.map(([key, label, v]) => {
    const value = num(v);
    return {
      key,
      label,
      value,
      // "Lagging" = more than 12 points below the mean of the engines that scored.
      // 12 keeps a legitimately-low-but-valid engine from firing; this is a display
      // threshold, not a signal, and is labelled as such wherever it surfaces.
      lagging: value !== null && mean !== null && value < mean - 12,
    };
  });
}

/** How many engines are actually scoring this row. A 90+ from one engine is
 *  materially weaker than a 90+ from four, and the desk says so rather than
 *  letting the single number imply the latter. */
export function coverageRead(p: PickRow): { n: number; text: string; tone: 'up' | 'warn' | 'flat' } {
  const n = engineBars(p).filter((b) => b.value !== null).length;
  if (n >= 4) return { n, text: `${n} engines agree`, tone: 'up' };
  if (n === 0) return { n, text: 'no engine scores', tone: 'flat' };
  return { n, text: n === 1 ? 'single engine only' : `${n} engines`, tone: 'warn' };
}

// â”€â”€ Trade plan â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface TradePlan {
  entryLow: number | null;
  entryHigh: number | null;
  targets: { label: string; value: number | null; pctFromMid: number | null }[];
  stop: number | null;
  stopPct: number | null;
  riskReward: number | null;
  /** The most useful derived fact: is the live price inside the published entry zone? */
  inZone: boolean | null;
  aboveZone: boolean | null;
  zoneNote: string;
}

export function buildTradePlan(p: PickRow): TradePlan {
  const low = num(p.entry_zone_low);
  const high = num(p.entry_zone_high);
  const live = num(p.livePrice) ?? num(p.cmp);
  const stop = num(p.stop_loss);
  const mid = low !== null && high !== null ? (low + high) / 2 : (low ?? high ?? live);

  const pctFrom = (v: number | null) =>
    v === null || mid === null || mid === 0 ? null : ((v - mid) / mid) * 100;

  let inZone: boolean | null = null;
  let aboveZone: boolean | null = null;
  let zoneNote = 'No entry zone published';
  if (live !== null && low !== null && high !== null) {
    inZone = live >= low && live <= high;
    aboveZone = live > high;
    if (inZone) zoneNote = 'Trading inside the entry zone';
    else if (aboveZone) zoneNote = `Above the zone by ${(live - high).toFixed(2)} — wait for a pullback`;
    else zoneNote = `Below the zone by ${(low - live).toFixed(2)} — re-entering`;
  }

  return {
    entryLow: low,
    entryHigh: high,
    targets: [
      { label: 'T1', value: num(p.target_1), pctFromMid: pctFrom(num(p.target_1)) },
      { label: 'T2', value: num(p.target_2), pctFromMid: pctFrom(num(p.target_2)) },
    ],
    stop,
    stopPct: pctFrom(stop),
    riskReward: num(p.risk_reward),
    inZone,
    aboveZone,
    zoneNote,
  };
}

// â”€â”€ Risk flags â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type RiskLevel = 'blocker' | 'caution' | 'note';

export interface RiskFlag {
  level: RiskLevel;
  label: string;
  detail: string;
}

const RISK_TONE: Record<RiskLevel, string> = {
  blocker: 'border-down/35 bg-down/[0.07] text-down-2',
  caution: 'border-warn/30 bg-warn/[0.06] text-warn',
  note: 'border-line-2 bg-white/[0.02] text-mark-2',
};

/**
 * Read the risk columns that ride along on every pick row and turn the ones that
 * actually mean something into plain sentences.
 *
 * Each branch is gated on a value that is genuinely present in the row — a flag
 * is only raised when the underlying data says so, never as a generic disclaimer.
 * A trader who sees a blocker here should genuinely not take the trade.
 */
export function riskFlags(p: PickRow): RiskFlag[] {
  const out: RiskFlag[] = [];
  const n = (k: string) => num(p[k]);

  // NSE surveillance — a hard "do not touch" signal from the exchange itself.
  if (n('asm_flag') === 1) {
    out.push({
      level: 'blocker',
      label: 'ASM watchlist',
      detail: 'On the NSE Additional Surveillance Measure list — speculative surveillance, elevated circuit filters.',
    });
  }
  const gsm = n('gsm_stage');
  if (gsm !== null && gsm > 0) {
    out.push({
      level: 'blocker',
      label: `GSM stage ${gsm}`,
      detail: 'On the NSE Graded Surveillance Measure list — trade-to-trade settlement and periodic audit.',
    });
  }

  // Results inside a week: the single most common way a technically perfect setup
  // still loses money, because the stop gets gap-filled on the event.
  const dtr = n('days_to_next_results');
  if (dtr !== null && dtr >= 0 && dtr <= 7) {
    out.push({
      level: dtr <= 2 ? 'blocker' : 'caution',
      label: dtr === 0 ? 'Results today' : `Results in ${dtr}d`,
      detail: 'Binary event inside the trade window — size down or wait for the print.',
    });
  }

  // Implied vol running hot relative to realised: the buyer is overpaying for the
  // optionality, which is exactly when premium sellers are picked off.
  const ivHv = n('iv_hv_ratio');
  if (ivHv !== null && ivHv > 1.3) {
    out.push({
      level: 'caution',
      label: 'IV > HV',
      detail: `Implied vol is ${(ivHv * 100).toFixed(0)}% of realised — long premium is expensive here.`,
    });
  }

  // Overbought into a SIDEWAYS regime is a materially different setup from
  // overbought into a trend, so this is reported with the regime-neutral wording
  // and let the regime banner on the page carry the context.
  const rsi = num(p.rsi);
  if (rsi !== null && rsi >= 75) {
    out.push({ level: 'caution', label: 'RSI overbought', detail: `RSI ${rsi.toFixed(0)} — extended, poor entry for a fresh long.` });
  } else if (rsi !== null && rsi <= 25) {
    out.push({ level: 'note', label: 'RSI oversold', detail: `RSI ${rsi.toFixed(0)} — falling knife unless the fundamental case is intact.` });
  }

  const pledge = n('pledge_chg_90d');
  if (pledge !== null && pledge > 0) {
    out.push({ level: 'caution', label: 'Pledge rising', detail: 'Promoter collateral has increased over 90d — a governance overhang.' });
  }

  const dSell = n('promoter_sell_90d_cr');
  if (dSell !== null && dSell > 0) {
    out.push({ level: 'caution', label: 'Promoter selling', detail: `â‚¹${dSell.toFixed(0)} Cr sold by promoters in 90d.` });
  }
  const dBuy = n('promoter_buy_90d_cr');
  if (dBuy !== null && dBuy > 0) {
    out.push({ level: 'note', label: 'Promoter buying', detail: `â‚¹${dBuy.toFixed(0)} Cr bought by promoters in 90d.` });
  }

  const downgrades = n('rating_downgrade_180d');
  if (downgrades !== null && downgrades > 0) {
    out.push({ level: 'caution', label: 'Analyst downgrades', detail: `${downgrades} downgrade(s) in the last 180d.` });
  }
  const upgrades = n('rating_upgrade_180d');
  if (upgrades !== null && upgrades > 0) {
    out.push({ level: 'note', label: 'Analyst upgrades', detail: `${upgrades} upgrade(s) in the last 180d.` });
  }

  // Delivery trend: falling delivery % while price rises is the classic
  // low-conviction advance that tends to retrace.
  const delivery = num(p.delivery_trend_30d);
  const chg = num(p.changePercent) ?? num(p.change_pct);
  if (delivery !== null && delivery < -3 && chg !== null && chg > 0) {
    out.push({
      level: 'caution',
      label: 'Thin participation',
      detail: `Up ${chg.toFixed(1)}% but delivery is down ${Math.abs(delivery).toFixed(1)}pts over 30d.`,
    });
  }

  if (n('block_deal_flag') === 1) {
    out.push({ level: 'note', label: 'Block deal', detail: 'A bulk block has traded — size may be off-book.' });
  }

  const sector = String(p.sector ?? '');
  if (!sector || sector === 'Unknown') {
    out.push({ level: 'note', label: 'No sector', detail: 'Sector is unmapped, so sector-relative and rotation reads are unavailable.' });
  }

  return out;
}

export const riskTone = (l: RiskLevel) => RISK_TONE[l];

/** "Why this stock" — trade_reasoning is either prose or a JSON array of tagged
 *  reasons depending on which ranker wrote the row, so both are handled. */
export interface ReasonTag {
  name: string;
  sentiment: string;
  source?: string;
  category?: string;
}

export function parseReasons(raw: unknown): { prose: string | null; tags: ReasonTag[] } {
  if (raw === null || raw === undefined || raw === '') return { prose: null, tags: [] };
  const asArray = parseJson<ReasonTag[]>(raw, []);
  if (Array.isArray(asArray) && asArray.length) return { prose: null, tags: asArray };
  return { prose: String(raw), tags: [] };
}

