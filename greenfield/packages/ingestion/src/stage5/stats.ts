// Task 5.0.2: Bonferroni-corrected significance threshold. Computed, not
// approximated by hand -- BUILD_STAGE_5_SPEC.md's own draft guessed "~3.4"
// for 24 comparisons; the real inverse-normal-CDF value is ~3.08. Using a
// rough mental estimate for an actual promotion threshold is exactly the
// kind of unverified number this project's measurement discipline exists
// to catch.
//
// Acklam's rational approximation to the standard normal inverse CDF,
// accurate to ~1.15e-9 -- see Peter J. Acklam, "An algorithm for computing
// the inverse normal cumulative distribution function."
const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];

export function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) throw new Error(`inverseNormalCdf: p must be in (0,1), got ${p}`);
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  }
  if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    return (((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q /
      (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
    ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
}

/** Two-tailed Bonferroni-corrected critical |t| for `nComparisons`
 * independent tests at family-wise alpha `alpha` (default 0.05). Large-df
 * approximation (t -> z), acceptable here since every factor series has
 * hundreds to well over a thousand per-date observations. */
export function bonferroniCriticalT(nComparisons: number, alpha = 0.05): number {
  const perComparisonAlpha = alpha / nComparisons;
  return inverseNormalCdf(1 - perComparisonAlpha / 2);
}
