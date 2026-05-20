/**
 * Options Mathematical Core
 *
 * Implements Black-Scholes-Merton (BSM) analytical pricing, option Greeks derivatives
 * (Delta, Gamma, Vega, Theta), and a high-performance Newton-Raphson + Bisection
 * hybrid solver for Implied Volatility (IV).
 */

const RISK_FREE_DEFAULT = 0.07; // 7.0% Indian government bond proxy

// ─── Cumulative Standard Normal Distribution (Abramowitz & Stegun) ───────────
export function normalCDF(x: number): number {
  if (x < 0) {
    return 1 - normalCDF(-x);
  }
  const p = 0.2316419;
  const a1 = 0.319381530;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;

  const t = 1.0 / (1.0 + p * x);
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const cdf = 1.0 - pdf * (a1 * t + a2 * Math.pow(t, 2) + a3 * Math.pow(t, 3) + a4 * Math.pow(t, 4) + a5 * Math.pow(t, 5));
  return cdf;
}

// ─── Standard Normal Probability Density Function ───────────────────────────
export function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// ─── Black-Scholes-Merton Option Pricing ────────────────────────────────────
export interface OptionDetails {
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
}

/**
 * Calculates option price and Greeks using the BSM model.
 *
 * @param isCall Call or Put option flag
 * @param S Stock Price (Underlying asset)
 * @param K Strike Price
 * @param t Time to Expiry (in years, e.g. 30 days = 30 / 365)
 * @param vol Annualized Volatility (decimal, e.g. 0.25 for 25%)
 * @param r Risk-Free Interest Rate (decimal, e.g. 0.07 for 7%)
 */
export function calculateBSM(
  isCall: boolean,
  S: number,
  K: number,
  t: number,
  vol: number,
  r = RISK_FREE_DEFAULT
): OptionDetails {
  // Edge case safeties
  if (t <= 0) {
    const price = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
    return { price, delta: isCall ? (S >= K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, vega: 0, theta: 0 };
  }
  if (vol <= 0) {
    const discount = Math.exp(-r * t);
    const price = isCall ? Math.max(0, S - K * discount) : Math.max(0, K * discount - S);
    return { price, delta: isCall ? (S >= K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, vega: 0, theta: 0 };
  }

  const d1 = (Math.log(S / K) + (r + 0.5 * vol * vol) * t) / (vol * Math.sqrt(t));
  const d2 = d1 - vol * Math.sqrt(t);

  const nd1 = normalCDF(d1);
  const nd2 = normalCDF(d2);
  const nMinusD1 = normalCDF(-d1);
  const nMinusD2 = normalCDF(-d2);
  const pdfD1 = normalPDF(d1);

  // Price calculations
  let price = 0;
  if (isCall) {
    price = S * nd1 - K * Math.exp(-r * t) * nd2;
  } else {
    price = K * Math.exp(-r * t) * nMinusD2 - S * nMinusD1;
  }

  // Greeks calculations
  const delta = isCall ? nd1 : nd1 - 1;
  const gamma = pdfD1 / (S * vol * Math.sqrt(t));
  const vega = (S * Math.sqrt(t) * pdfD1) / 100; // Divided by 100 to show price change per 1% vol shift

  // Theta (decay per calendar day, divided by 365)
  let thetaYear = 0;
  if (isCall) {
    thetaYear = -(S * pdfD1 * vol) / (2 * Math.sqrt(t)) - r * K * Math.exp(-r * t) * nd2;
  } else {
    thetaYear = -(S * pdfD1 * vol) / (2 * Math.sqrt(t)) + r * K * Math.exp(-r * t) * nMinusD2;
  }
  const theta = thetaYear / 365;

  return { price, delta, gamma, vega, theta };
}

// ─── Implied Volatility Hybrid Solver ────────────────────────────────────────

/**
 * Computes Implied Volatility (IV) given market price, stock price, strike, and time to expiry.
 * Employs a hybrid Newton-Raphson + Bisection fallback strategy for absolute convergence.
 *
 * @param isCall Call or Put option flag
 * @param marketPrice Current option premium traded
 * @param S Stock Price
 * @param K Strike Price
 * @param t Time to Expiry (in years)
 * @param r Risk-Free Interest Rate (decimal)
 */
export function calculateImpliedVolatility(
  isCall: boolean,
  marketPrice: number,
  S: number,
  K: number,
  t: number,
  r = RISK_FREE_DEFAULT
): number {
  // 1. Core intrinsic value safeties
  const discount = Math.exp(-r * t);
  const intrinsic = isCall ? Math.max(0, S - K * discount) : Math.max(0, K * discount - S);
  if (marketPrice <= intrinsic) {
    return 0; // No time value
  }

  // Newton-Raphson parameters
  let vol = 0.35; // Standard starting guess (35% volatility)
  const tolerance = 1e-4;
  const maxIterations = 50;

  for (let i = 0; i < maxIterations; i++) {
    const details = calculateBSM(isCall, S, K, t, vol, r);
    const diff = details.price - marketPrice;

    if (Math.abs(diff) < tolerance) {
      return vol; // Converged
    }

    // Vega is the derivative of option price with respect to volatility
    // Multiply by 100 because BSM vega returns change per 1% vol shift
    const vegaDeriv = details.vega * 100;

    if (vegaDeriv > 1e-4) {
      // Newton step
      const step = diff / vegaDeriv;
      const nextVol = vol - step;
      
      // Keep boundaries reasonable (between 1% and 400% vol)
      if (nextVol > 0.01 && nextVol < 4.0) {
        vol = nextVol;
        continue;
      }
    }

    // If Newton-Raphson hits a flat slope (vega near 0) or goes out of bounds,
    // immediately fall back to a robust Bisection solver to close the gap!
    return bisectionIV(isCall, marketPrice, S, K, t, r);
  }

  return vol;
}

function bisectionIV(
  isCall: boolean,
  marketPrice: number,
  S: number,
  K: number,
  t: number,
  r: number
): number {
  let low = 0.0001;
  let high = 5.0;
  let mid = 0.25;
  const tolerance = 1e-4;

  for (let i = 0; i < 40; i++) {
    mid = 0.5 * (low + high);
    const bsmPrice = calculateBSM(isCall, S, K, t, mid, r).price;
    const diff = bsmPrice - marketPrice;

    if (Math.abs(diff) < tolerance) {
      return mid;
    }

    if (diff > 0) {
      high = mid; // Lower volatility needed
    } else {
      low = mid;  // Higher volatility needed
    }
  }

  return mid;
}
