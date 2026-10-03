// Parses the raw tRPC responses UltimateDecisionMatrix consumes. Every field is null when the
// source did not supply it -- the page must render "—", never a plausible constant
// (AF-20260930-43: it used to read fields these procedures never return and so showed its
// hard-coded fallbacks on every render).

export interface QuoteSnapshot { value: number; changePct: number | null }

export interface DecisionMatrixInputs {
  nifty: QuoteSnapshot | null;
  bankNifty: QuoteSnapshot | null;
  vix: number | null;
  advances: number | null;
  declines: number | null;
  fiiNetCr: number | null;   // getFiiDiiFlow's fii_net is already in ₹ crore
  fiiDate: string | null;
  pcr: number | null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const quote = (row: any): QuoteSnapshot | null => {
  const value = num(row?.value);
  return value == null ? null : { value, changePct: num(row?.changePer) };
};

export interface MatrixItem {
  symbol: string;
  name: string;
  source: 'canonical' | 'cockpit';
  price: number | null;
  changePct: number | null;
  action: string | null;
  score: number | null;
  confidence: number | null;   // a win probability %, only where the source has one
  rrRatio: string | null;
  entryZone: string | null;
  target1: number | null;
  target2: number | null;
  stopLoss: number | null;
  reasoning: string | null;
  setupType: string;
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

// Canonical unified_recommendations picks (getBuyRecommendations.picks) first, per
// scoring-authority.md; cockpit candidates only for symbols the ranker did not pick. A field the
// source does not carry stays null -- the page used to invent score 78, RSI 58, R:R 1:3.2,
// targets +8/15% and a canned reason, and 6 fake STRONG BUYs when both were empty.
export function buildMatrixItems(candidates: any[], picks: any[]): MatrixItem[] {
  const out = new Map<string, MatrixItem>();
  for (const p of picks ?? []) {
    if (!p?.symbol) continue;
    const lo = num(p.entry_zone_low), hi = num(p.entry_zone_high);
    const score = num(p.unified_score);
    const rr = num(p.risk_reward);
    out.set(p.symbol, {
      symbol: p.symbol,
      name: p.company_name ?? p.name ?? p.symbol,
      source: 'canonical',
      price: num(p.cmp),
      changePct: num(p.change_pct),
      action: p.classification ? String(p.classification).toUpperCase() : null,
      score: score == null ? null : Math.round(score),
      confidence: num(p.win_probability),
      rrRatio: rr == null ? null : `1:${rr}`,
      entryZone: lo != null && hi != null ? (Math.round(lo) === Math.round(hi) ? inr(lo) : `${inr(lo)}–${inr(hi)}`) : null,
      target1: num(p.target_1),
      target2: num(p.target_2),
      stopLoss: num(p.stop_loss),
      reasoning: p.trade_reasoning ?? null,
      setupType: 'AI_UNIFIED',
    });
  }
  for (const c of candidates ?? []) {
    if (!c?.symbol || out.has(c.symbol)) continue;
    const score = num(c.compositeScore);
    const entry = num(c.entryPrice);
    out.set(c.symbol, {
      symbol: c.symbol,
      name: c.name ?? c.symbol,
      source: 'cockpit',
      price: num(c.cmp),
      changePct: num(c.changePct),
      action: c.advice ?? c.actionAdvice ?? null,
      score: score == null ? null : Math.round(score),
      confidence: num(c.mlWinProbability),
      rrRatio: null,
      entryZone: entry == null ? null : inr(entry),
      target1: num(c.targetPrice),
      target2: null,
      stopLoss: num(c.stopLoss),
      reasoning: c.aiInsight ?? null,
      setupType: (num(c.factors?.momentum) ?? 0) > 80 ? 'BREAKOUT' : 'QUANT_ALPHA',
    });
  }
  return [...out.values()];
}

export function parseDecisionMatrixInputs(src: {
  overviewRes?: any; adRes?: any; fiiRes?: any; sentimentRes?: any;
}): DecisionMatrixInputs {
  const indices: any[] = src.overviewRes?.data?.indiceList?.flatMap((g: any) => g?.list ?? []) ?? [];
  const byName = (re: RegExp) => indices.find(i => re.test(String(i?.name ?? '')));
  const ad = Array.isArray(src.adRes?.data) ? src.adRes.data[0] : null; // newest snapshot first
  const fii = Array.isArray(src.fiiRes) ? src.fiiRes[0] : null;          // newest date first
  return {
    nifty: quote(byName(/^nifty\s*50$/i)),
    bankNifty: quote(byName(/^nifty\s*bank$|^bank\s*nifty$/i)),
    vix: num(byName(/india\s*vix/i)?.value),
    advances: num(ad?.advances),
    declines: num(ad?.declines),
    fiiNetCr: num(fii?.fii_net),
    fiiDate: fii?.date ?? null,
    pcr: num(src.sentimentRes?.pcr),
  };
}
