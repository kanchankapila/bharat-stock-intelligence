// Task 5.1.1: ranker construction. Pure logic -- no DB, no clock, no I/O --
// so every rule below is unit-testable without a panel.
//
// The weight set is NOT a discretionary choice and is not hardcoded here. It
// is derived from Task 5.0's recorded evidence (`factor_net_tstat.*` rows and
// the computed `bonferroni_critical_t`, both in `audit_metric`): a factor
// enters the ranker only if its net-of-cost t-stat cleared the corrected bar,
// and its weight is that t-stat. That is spec invariant 11, expressed as code
// rather than as a list someone maintains by hand -- re-run Task 5.0 with more
// data and the ranker re-weights itself from the new evidence.
//
// As of the Task 5.0 run recorded on this panel, ZERO of 24 factor x horizon
// combinations cleared the bar, so `selectSurvivingFactors` returns [] and the
// null ranker below is what actually runs. That is the spec's own predicted
// outcome (BUILD_STAGE_5_SPEC.md §0), not a failure to find the real weights.

/** One `factor_net_tstat.<factor>` row from Task 5.0, as recorded in audit_metric. */
export interface NetTStatRow {
  factor: string;
  rebalanceDays: number;
  netTStat: number | null;
}

export interface SurvivingFactor {
  factor: string;
  rebalanceDays: number;
  netTStat: number;
  /** |t|, used as the weight magnitude. */
  weight: number;
  /** Sign of the measured relationship: a significantly NEGATIVE factor is
   * still usable evidence -- it just ranks the other way round. */
  direction: 1 | -1;
}

/** The placeholder factor the spec names for the zero-survivor case: the single
 * most theoretically-motivated candidate in the predecessor's own history, even
 * though it did not clear significance here either. */
export const NULL_RANKER_FACTOR = 'momentum_63d';

export const RANKER_VARIANT_NULL = 'null';
export const RANKER_VARIANT_WEIGHTED = 'weighted';

/** Task 5.1.1: which factors may enter the ranker. A factor clears only on
 * |netTStat| >= criticalT -- the Bonferroni-corrected bar Task 5.0 computed,
 * passed in rather than re-derived, so the ranker and the measurement can never
 * silently disagree about what the bar was.
 *
 * Where one factor cleared at BOTH rebalance horizons, the stronger |t| wins:
 * the two are the same underlying factor measured twice, not two independent
 * pieces of evidence, and double-counting one factor's t-stat into the weight
 * sum would overweight it purely for having been tested twice. */
export function selectSurvivingFactors(rows: NetTStatRow[], criticalT: number): SurvivingFactor[] {
  const best = new Map<string, SurvivingFactor>();
  for (const r of rows) {
    if (r.netTStat === null || !Number.isFinite(r.netTStat)) continue;
    if (Math.abs(r.netTStat) < criticalT) continue;
    const candidate: SurvivingFactor = {
      factor: r.factor,
      rebalanceDays: r.rebalanceDays,
      netTStat: r.netTStat,
      weight: Math.abs(r.netTStat),
      direction: r.netTStat >= 0 ? 1 : -1,
    };
    const incumbent = best.get(r.factor);
    if (!incumbent || candidate.weight > incumbent.weight) best.set(r.factor, candidate);
  }
  return [...best.values()].sort((a, b) => b.weight - a.weight || a.factor.localeCompare(b.factor));
}

export interface RankerSpec {
  variant: typeof RANKER_VARIANT_NULL | typeof RANKER_VARIANT_WEIGHTED;
  version: string;
  factors: SurvivingFactor[];
  /** True whenever no factor has a measured, cost-adjusted, multiple-testing-
   * corrected edge on this panel. Carried all the way into
   * `model_version.metrics` and every `recommendation.breakdown` -- the spec
   * requires this ranker never be silently presented as validated. */
  unvalidated: boolean;
  rationale: string;
}

/** Builds the ranker spec from Task 5.0's survivors. Zero survivors is a
 * legitimate, expected outcome and produces the null ranker -- a deterministic,
 * gradeable ranking on a single unvalidated factor, explicitly labelled as
 * such, rather than either (a) no ranker at all or (b) a ranker whose weights
 * imply evidence that does not exist. */
export function buildRankerSpec(survivors: SurvivingFactor[]): RankerSpec {
  if (survivors.length === 0) {
    return {
      variant: RANKER_VARIANT_NULL,
      version: `null-${NULL_RANKER_FACTOR}-v1`,
      factors: [{ factor: NULL_RANKER_FACTOR, rebalanceDays: 0, netTStat: 0, weight: 1, direction: 1 }],
      unvalidated: true,
      rationale:
        `Zero factors cleared Task 5.0's cost-adjusted Bonferroni bar. Ranking on ` +
        `${NULL_RANKER_FACTOR} alone as a deterministic placeholder so the shadow period has ` +
        `something gradeable. This ranker has NO demonstrated edge and must not be published.`,
    };
  }
  const names = survivors.map((s) => s.factor).join('+');
  return {
    variant: RANKER_VARIANT_WEIGHTED,
    version: `weighted-${names}-v1`,
    factors: survivors,
    unvalidated: false,
    rationale:
      `Linear combination of the ${survivors.length} factor(s) that cleared Task 5.0's ` +
      `cost-adjusted Bonferroni bar, weighted by |net t-stat|.`,
  };
}

export interface SymbolFeatures {
  symbol: string;
  /** The feature_snapshot row's own `values` blob. */
  values: Record<string, number | null>;
  /** The feature_snapshot row's own facts_cutoff -- copied through to the
   * recommendation verbatim, never re-derived from a later clock. */
  factsCutoff: string;
}

export interface RankedSymbol {
  symbol: string;
  score: number;
  rank: number;
  classification: string;
  conviction: string | null;
  engineCoverage: number;
  breakdown: Record<string, unknown>;
  factsCutoff: string;
}

/** Cross-sectional percentile rank in [0,1] of each finite value, ties sharing
 * the midpoint of the ranks they span. Percentile rather than z-score on
 * purpose: it is bounded, so no winsorisation step is needed and no single
 * extreme bar can dominate a weighted sum (measurement.md opens with a
 * +127,900% bar producing an 850%-annualised phantom edge on this exact data).
 * Non-finite values are not ranked at all -- returned as null, never coerced
 * to 0, which would fabricate a mid-universe reading for a missing one and a
 * bottom reading for a NaN. */
export function percentileRank(values: Array<number | null>): Array<number | null> {
  const finite: Array<{ idx: number; v: number }> = [];
  values.forEach((v, idx) => {
    if (v !== null && Number.isFinite(v)) finite.push({ idx, v });
  });
  const out = new Array<number | null>(values.length).fill(null);
  const n = finite.length;
  if (n === 0) return out;
  if (n === 1) {
    out[finite[0]!.idx] = 0.5;
    return out;
  }
  finite.sort((a, b) => a.v - b.v);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && finite[j + 1]!.v === finite[i]!.v) j++;
    // Midpoint of the tied block, normalised to [0,1] across n-1 gaps.
    const pct = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[finite[k]!.idx] = pct;
    i = j + 1;
  }
  return out;
}

/** Rank buckets, deliberately NOT the predecessor's Strong Buy/Buy/Hold/Sell
 * vocabulary. Emitting "Strong Buy" from a ranker whose own spec records that it
 * has no measured edge is precisely the false confidence this stage exists to
 * avoid -- and the predecessor's own conviction ladder is documented as
 * inverted in exactly that situation (measurement.md: Strong Sell underperformed
 * plain Sell on both graded dates, because extremity of an unvalidated score
 * does not predict direction). These names state what the number actually is: a
 * position in a ranking. Grading (Task 5.4) reads `score`, not this column. */
export function classifyByPercentile(pct: number): string {
  if (pct >= 0.9) return 'rank_top_decile';
  if (pct >= 0.7) return 'rank_upper';
  if (pct > 0.3) return 'rank_middle';
  if (pct > 0.1) return 'rank_lower';
  return 'rank_bottom_decile';
}

/** Task 5.1.1/5.1.2: score and rank one session's cross-section.
 *
 * A symbol with no usable value for ANY ranker factor is dropped entirely
 * rather than scored 0 -- scoring it would place it at the bottom of the
 * ranking on the strength of missing data, which is the `float(x or 0)` bug
 * class from recurring-bugs.md in ranking form.
 *
 * `conviction` is null for the null ranker by construction: no level of
 * conviction is warranted by a factor set that cleared no significance bar,
 * and inventing a ladder here would repeat the predecessor's inverted one. */
export function rankSession(spec: RankerSpec, rows: SymbolFeatures[]): RankedSymbol[] {
  const totalWeight = spec.factors.reduce((s, f) => s + f.weight, 0);
  if (totalWeight <= 0) return [];

  // Percentile-rank each factor independently across this session's cross-section.
  const pctByFactor = new Map<string, Array<number | null>>();
  for (const f of spec.factors) {
    pctByFactor.set(f.factor, percentileRank(rows.map((r) => r.values[f.factor] ?? null)));
  }

  const scored: Array<{ row: SymbolFeatures; score: number; coverage: number; contributions: Record<string, number> }> = [];
  rows.forEach((row, idx) => {
    let weighted = 0;
    let usedWeight = 0;
    let coverage = 0;
    const contributions: Record<string, number> = {};
    for (const f of spec.factors) {
      const pct = pctByFactor.get(f.factor)![idx];
      if (pct === null || pct === undefined) continue;
      // direction === -1 flips a significantly-negative factor's ranking
      // rather than dropping the evidence.
      const oriented = f.direction === 1 ? pct : 1 - pct;
      weighted += oriented * f.weight;
      usedWeight += f.weight;
      coverage++;
      contributions[f.factor] = oriented;
    }
    if (coverage === 0) return; // no usable factor -- not scored, not ranked
    // Renormalise by the weight actually used, so a symbol missing one of
    // several factors is scored on what it has rather than penalised toward 0
    // for the missing part.
    const score = weighted / usedWeight;
    if (!Number.isFinite(score)) return;
    scored.push({ row, score, coverage, contributions });
  });

  // Descending score; symbol as a deterministic tiebreak so a re-run over
  // identical input produces an identical ranking (the null ranker must be
  // reproducible to be gradeable).
  scored.sort((a, b) => b.score - a.score || a.row.symbol.localeCompare(b.row.symbol));

  const n = scored.length;
  return scored.map((s, i) => {
    // Percentile of position in the final ranking; n===1 has no spread, so it
    // sits at the midpoint rather than dividing by zero.
    const pctOfField = n > 1 ? (n - 1 - i) / (n - 1) : 0.5;
    return {
      symbol: s.row.symbol,
      score: s.score,
      rank: i + 1,
      classification: classifyByPercentile(pctOfField),
      conviction: spec.unvalidated ? null : convictionByPercentile(pctOfField),
      engineCoverage: s.coverage,
      breakdown: {
        rankerVariant: spec.variant,
        unvalidated: spec.unvalidated,
        factors: spec.factors.map((f) => ({ factor: f.factor, weight: f.weight, direction: f.direction })),
        contributions: s.contributions,
        percentileOfField: pctOfField,
      },
      factsCutoff: s.row.factsCutoff,
    };
  });
}

function convictionByPercentile(pct: number): string {
  if (pct >= 0.95 || pct <= 0.05) return 'high';
  if (pct >= 0.8 || pct <= 0.2) return 'medium';
  return 'low';
}
