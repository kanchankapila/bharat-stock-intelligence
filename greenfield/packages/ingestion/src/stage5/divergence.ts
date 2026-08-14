// Task 5.3: dual-run divergence analysis. Pure logic, no DB (same reasoning
// as ranker.ts) -- compares the shadow ranker's calls against the old
// system's live `unified_recommendations` for one trading date. Per spec:
// "This is descriptive, not a promotion criterion by itself -- the old
// ranker has no demonstrated edge either (measurement.md: unified_score 5d
// rank IC ~= 0.0001), so agreement or disagreement with it says nothing
// about correctness." Its purpose is operational: catching a shadow ranker
// broken in a way the old system's own monitoring would have caught (a
// collapsed universe, a NaN-poisoned score, identical rank for every symbol).
import { spearman } from '../stage4/research-harness.js';

export interface NewSystemRankRow {
  symbol: string;
  score: number | null;
}

export interface LegacySystemRow {
  symbol: string;
  unifiedScore: number | null;
  classification: string | null;
}

export type Direction = 'bullish' | 'bearish' | 'neutral';

/** The new ranker's `score` is already a [0,1] weighted-percentile average
 * (ranker.ts's rankSession) -- 0.5 is its own natural midpoint, not an
 * arbitrary threshold, since a symbol scoring exactly at the cross-sectional
 * median of every contributing factor lands there by construction. */
export function newSystemDirection(score: number | null): Direction {
  if (score === null || !Number.isFinite(score)) return 'neutral';
  if (score > 0.5) return 'bullish';
  if (score < 0.5) return 'bearish';
  return 'neutral';
}

/** The old system's classification vocabulary (unified_ranker.py: 'Strong
 * Buy'/'Buy'/'Hold'/'Sell'/'Strong Sell', confirmed from source, not
 * guessed). Anything else (a future value, a NULL, a genuinely unrecognised
 * string) is 'neutral' -- excluded from directional agreement rather than
 * silently forced to a pole, same discipline as the neutral-tag-as-bearish
 * bug class in recurring-bugs.md that this deliberately avoids repeating. */
export function legacyDirection(classification: string | null): Direction {
  if (classification === 'Strong Buy' || classification === 'Buy') return 'bullish';
  if (classification === 'Strong Sell' || classification === 'Sell') return 'bearish';
  return 'neutral';
}

export interface DivergenceResult {
  /** Spearman rank correlation between the two systems' scores, restricted to
   * the union of both systems' top-50 (by their own score), among symbols
   * present with a real score on BOTH sides -- a symbol only one system
   * ranked at all cannot be correlated and is reported separately below. */
  rankCorrelation: number | null;
  /** Decisive-call agreement only (measurement.md's own convention throughout
   * this project: NEUTRAL/PENDING excluded) -- among symbols where BOTH
   * systems make a bullish/bearish call (neither is 'neutral'), the fraction
   * where the calls agree. */
  directionalAgreementRate: number | null;
  nCompared: number;
  nDecisiveBoth: number;
  nNewOnly: number;
  nLegacyOnly: number;
}

/** Task 5.3's core comparison for one trading date. `topK` defaults to 50
 * per spec text ("rank correlation between the two rankers' top-50"). */
export function computeDivergenceForSession(
  newRows: NewSystemRankRow[], legacyRows: LegacySystemRow[], topK = 50,
): DivergenceResult {
  const newTop = [...newRows]
    .filter((r) => r.score !== null && Number.isFinite(r.score))
    .sort((a, b) => b.score! - a.score!)
    .slice(0, topK);
  const legacyTop = [...legacyRows]
    .filter((r) => r.unifiedScore !== null && Number.isFinite(r.unifiedScore))
    .sort((a, b) => b.unifiedScore! - a.unifiedScore!)
    .slice(0, topK);

  const newBySymbol = new Map(newRows.map((r) => [r.symbol, r]));
  const legacyBySymbol = new Map(legacyRows.map((r) => [r.symbol, r]));

  const unionSymbols = new Set([...newTop.map((r) => r.symbol), ...legacyTop.map((r) => r.symbol)]);

  const xs: number[] = [];
  const ys: number[] = [];
  let nCompared = 0;
  let nNewOnly = 0;
  let nLegacyOnly = 0;

  for (const symbol of unionSymbols) {
    const n = newBySymbol.get(symbol);
    const l = legacyBySymbol.get(symbol);
    const nScore = n?.score;
    const lScore = l?.unifiedScore;
    const nHas = nScore !== null && nScore !== undefined && Number.isFinite(nScore);
    const lHas = lScore !== null && lScore !== undefined && Number.isFinite(lScore);
    if (nHas && lHas) {
      xs.push(nScore!);
      ys.push(lScore!);
      nCompared++;
    } else if (nHas && !lHas) {
      nNewOnly++;
    } else if (!nHas && lHas) {
      nLegacyOnly++;
    }
  }

  const rankCorrelation = xs.length >= 3 ? spearman(xs, ys) : null;

  // Directional agreement: decisive calls only, among the SAME union (not
  // restricted to nCompared's finite-score pairs above -- a classification
  // can be decisive even where a raw score is absent on one side, e.g. the
  // new system's null-ranker still assigns bullish/bearish via score, but a
  // legacy row could plausibly carry a classification without a
  // unified_score in a degraded state; handled uniformly here rather than
  // assumed impossible).
  let agree = 0;
  let nDecisiveBoth = 0;
  for (const symbol of unionSymbols) {
    const n = newBySymbol.get(symbol);
    const l = legacyBySymbol.get(symbol);
    if (!n || !l) continue;
    const nDir = newSystemDirection(n.score);
    const lDir = legacyDirection(l.classification);
    if (nDir === 'neutral' || lDir === 'neutral') continue;
    nDecisiveBoth++;
    if (nDir === lDir) agree++;
  }

  return {
    rankCorrelation,
    directionalAgreementRate: nDecisiveBoth > 0 ? agree / nDecisiveBoth : null,
    nCompared, nDecisiveBoth, nNewOnly, nLegacyOnly,
  };
}
