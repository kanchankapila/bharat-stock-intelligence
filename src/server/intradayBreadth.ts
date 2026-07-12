/**
 * Intraday market-breadth nowcast.
 *
 * The daily HMM regime (regime_detector.py) is EOD and slow — 21-day windows dominate, so it
 * can't react intraday and lags real turns by days. This derives a live risk-on breadth read
 * from the whole-universe quote array that liveStockData already refreshes every 5 min (no new
 * feed), persists a point-in-time snapshot so history accumulates for a future intraday-aware
 * regime model, and publishes the latest read to app_settings for live consumers.
 *
 * Change-based breadth only: MarketData.volume is a formatted string ("1.2M"), not numeric, so a
 * volume-weighted thrust isn't cleanly available here — adv/decline + net magnitude is robust.
 */
import type { MarketData } from "../services/marketService";
import { dbRun, dbGet } from "./dbAsync";

// A move smaller than this (in %) counts as "unchanged" — filters noise around the flat line.
const FLAT_BAND_PCT = 0.1;
// Below this universe size the cross-section is too thin to read breadth fairly.
const MIN_UNIVERSE = 50;

export type RiskTilt = "RISK_ON" | "NEUTRAL" | "RISK_OFF";

export interface IntradayBreadth {
  adv: number;
  dec: number;
  unch: number;
  total: number;
  advDeclineRatio: number; // adv / (adv + dec), 0-1
  pctPositive: number;     // adv / total, 0-1
  avgChangePct: number;    // mean change% across the universe (net thrust)
  breadthScore: number;    // 0-1 risk-on composite
  riskTilt: RiskTilt;
}

/** Logistic squash of net average change% into 0-1 (≈±1.5% spans most of the 0-1 range). */
function squash(avgPct: number): number {
  return 1 / (1 + Math.exp(-avgPct / 0.75));
}

/** Pure: derive breadth metrics from a universe quote array (null if too thin). */
export function computeIntradayBreadth(quotes: MarketData[]): IntradayBreadth | null {
  const valid = quotes.filter((q) => Number.isFinite(q.changePct));
  const total = valid.length;
  if (total < MIN_UNIVERSE) return null;

  let adv = 0, dec = 0, unch = 0, sum = 0;
  for (const q of valid) {
    sum += q.changePct;
    if (q.changePct > FLAT_BAND_PCT) adv++;
    else if (q.changePct < -FLAT_BAND_PCT) dec++;
    else unch++;
  }
  const advDeclineRatio = adv + dec > 0 ? adv / (adv + dec) : 0.5;
  const pctPositive = adv / total;
  const avgChangePct = sum / total;

  // Composite: 60% participation (how many names confirm) + 40% magnitude (how hard the tape moves).
  const breadthScore = 0.6 * advDeclineRatio + 0.4 * squash(avgChangePct);
  const riskTilt: RiskTilt =
    breadthScore >= 0.62 ? "RISK_ON" : breadthScore <= 0.38 ? "RISK_OFF" : "NEUTRAL";

  return { adv, dec, unch, total, advDeclineRatio, pctPositive, avgChangePct, breadthScore, riskTilt };
}

/** Compute, persist a point-in-time snapshot, and publish the latest read to app_settings. */
export async function persistIntradayBreadth(quotes: MarketData[]): Promise<IntradayBreadth | null> {
  const b = computeIntradayBreadth(quotes);
  if (!b) return null;
  const nowIso = new Date().toISOString();

  await dbRun(
    `INSERT INTO intraday_breadth_snapshots
       (snapshot_at, date, adv, dec, unch, total, adv_decline_ratio, pct_positive,
        avg_change_pct, breadth_score, risk_tilt, computed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(snapshot_at) DO NOTHING`,
    [nowIso, nowIso.slice(0, 10), b.adv, b.dec, b.unch, b.total, b.advDeclineRatio,
     b.pctPositive, b.avgChangePct, b.breadthScore, b.riskTilt, nowIso],
  );

  for (const [key, value] of [
    ["intraday_breadth_score", b.breadthScore.toFixed(4)],
    ["intraday_risk_tilt", b.riskTilt],
  ] as const) {
    await dbRun(
      `INSERT INTO app_settings(key, value, "updatedAt") VALUES(?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = CURRENT_TIMESTAMP`,
      [key, value],
    );
  }
  return b;
}

/** Latest snapshot for the live UI gauge / any intraday consumer (null before the first run). */
export async function getLatestIntradayBreadth(): Promise<Record<string, unknown> | null> {
  return (
    (await dbGet(`SELECT * FROM intraday_breadth_snapshots ORDER BY snapshot_at DESC LIMIT 1`)) ?? null
  );
}
