import { dbAll } from './dbAsync';

async function getRecentCloses(symbol: string, days: number = 90): Promise<number[]> {
  const rows = await dbAll<any>(
    `SELECT close FROM stock_ohlcv WHERE symbol = ? AND close > 0 ORDER BY date DESC LIMIT ?`,
    [symbol, days]
  );
  // rows come newest-first; reverse to chronological
  return rows.map(r => r.close).reverse();
}

function returnsFromCloses(closes: number[]): number[] {
  const ret: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev > 0) ret.push((cur - prev) / prev);
  }
  return ret;
}

function std(arr: number[]): number {
  if (!arr || arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return Math.sqrt(v);
}

export async function buildRiskParityWeights(symbols: string[], lookbackDays = 90): Promise<Array<{ symbol: string; weight: number; volPct: number }>> {
  const vols: number[] = [];
  const volsMap = new Map<string, number>();
  const retsMap = new Map<string, number[]>();
  for (const s of symbols) {
    const closes = await getRecentCloses(s, lookbackDays + 5);
    const rets = returnsFromCloses(closes);
    retsMap.set(s, rets);
    const dstd = std(rets);
    const annVol = dstd * Math.sqrt(252); // annualised
    const volPct = annVol * 100;
    vols.push(annVol);
    volsMap.set(s, volPct || 0.0001);
  }

  // Build returns matrix aligned by the shortest series
  const series = symbols.map(s => retsMap.get(s) ?? []);
  const minLen = Math.min(...series.map(s => s.length));
  if (minLen <= 1) {
    // fallback to inverse-vol if insufficient data
    const inv = symbols.map(s => 1 / Math.max(0.0001, (volsMap.get(s) ?? 0) / 100));
    const sum = inv.reduce((a, b) => a + b, 0) || 1;
    return symbols.map((s, i) => ({ symbol: s, weight: inv[i] / sum, volPct: volsMap.get(s) ?? 0 }));
  }

  const matrixData: number[][] = series.map(s => s.slice(-minLen));

  function covMatrix(data: number[][]): number[][] {
    const n = data.length;
    const t = data[0].length;
    const means = data.map(arr => arr.reduce((a, b) => a + b, 0) / t);
    const cov: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        let s = 0;
        for (let k = 0; k < t; k++) s += (data[i][k] - means[i]) * (data[j][k] - means[j]);
        const v = s / (t - 1 || 1);
        cov[i][j] = v;
        cov[j][i] = v;
      }
    }
    return cov;
  }

  function matVecMul(mat: number[][], vec: number[]): number[] {
    return mat.map(row => row.reduce((acc, val, idx) => acc + val * (vec[idx] ?? 0), 0));
  }

  // regularise covariance to avoid singularities
  const eps = 1e-8;
  const cov = covMatrix(matrixData).map((row, i) => row.map((v, j) => v + (i === j ? eps : 0)));

  // initialize weights with inverse-vol
  let w = symbols.map(s => 1 / Math.max(1e-6, (volsMap.get(s) ?? 0) / 100));
  const wSum = w.reduce((a, b) => a + b, 0) || 1;
  w = w.map(x => x / wSum);

  const n = symbols.length;
  let prevW = w.slice();
  const maxIter = 500;
  const tol = 1e-6;

  for (let iter = 0; iter < maxIter; iter++) {
    const sigmaW = matVecMul(cov, w);
    const rc = w.map((wi, i) => wi * (sigmaW[i] ?? 0));
    const totalRc = rc.reduce((a, b) => a + b, 0);
    const target = totalRc / n;
    // update weights multiplicatively
    for (let i = 0; i < n; i++) {
      const denom = sigmaW[i] ?? 1e-12;
      // avoid division by zero
      w[i] = w[i] * (target / Math.max(1e-12, denom));
    }
    // normalise
    const s = w.reduce((a, b) => a + b, 0) || 1;
    w = w.map(x => Math.max(0, x / s));

    // convergence check
    const maxDiff = Math.max(...w.map((val, i) => Math.abs(val - prevW[i])));
    if (maxDiff < tol) break;
    prevW = w.slice();
  }

  const weights = symbols.map((s, i) => ({ symbol: s, weight: w[i], volPct: volsMap.get(s) ?? 0 }));
  return weights;
}

export default {
  buildRiskParityWeights,
};
