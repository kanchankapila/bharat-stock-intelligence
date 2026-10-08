import { dbAll, dbGet, dbRun } from './dbAsync';

export interface StockPick {
  symbol: string;
  conviction_score: number;
  quant_rank: number;
  signal_score: number;
  screener_net: number;
  news_boost: number;
  unified_score?: number;
  conviction_level?: string;
  confluence_score?: number;
  ml_score?: number;
  technical_score?: number;
  dl_score?: number;
  screener_stock_score?: number;
  avg_engine_track_record?: number;
  fundamental_score?: number | null;
  rsi: number | null;
  adx: number | null;
  trailing_pe: number | null;
  roe: number | null;
  debt_to_equity: number | null;
  piotroski: number | null;
  bullish_screeners: number;
  return_1m: number | null;
  return_3m: number | null;
  above_sma200: number;
  entry_note: string;
  stop_loss_pct: number;
  target_1_pct: number;
  target_2_pct: number | null;
  risk_reward: number;
  layers_confirmed: number;
  flags: string[];
  classification?: string;
  regime?: string;
  timeframe?: string;
  valid_until?: string | null;
  trade_reasoning?: string | null;
  entry_zone_low?: number;
  entry_zone_high?: number;
  stop_loss?: number;
  target_1?: number;
  target_2?: number | null;
}

export interface ResearchReport {
  report_date: string;
  report_type: 'PRE_MARKET' | 'POST_CLOSE';
  market_regime: string;
  sentiment_score: number;
  fii_net_5d: number;
  global_cue: string;
  hot_themes: string[];
  top_picks: StockPick[];
  watchlist: Pick<StockPick, 'symbol' | 'conviction_score' | 'layers_confirmed'>[];
  avoid_list: { symbol: string; reason: string }[];
  sector_rankings: { sector: string; score: number; momentum: string }[];
  executive_summary: string;
}

async function getMarketContext(): Promise<{
  regime: string;
  sentiment_score: number;
  fii_net_5d: number;
  global_cue: string;
  hot_themes: string[];
}> {
  const sentiment = await dbGet(`
    SELECT overall_score, nifty_bias, global_cue, key_themes_json
    FROM market_sentiment_snapshots
    ORDER BY snapshot_at DESC LIMIT 1
  `) as any;
  const fiiRows = await dbAll(`
    SELECT fii_net, dii_net FROM fii_dii_flow
    ORDER BY date DESC LIMIT 5
  `) as any[];

  const fiiNet5d = fiiRows.reduce((sum: number, row: any) => sum + Number(row.fii_net || 0), 0);
  const diiNet5d = fiiRows.reduce((sum: number, row: any) => sum + Number(row.dii_net || 0), 0);
  let regime = 'SIDEWAYS';
  if (fiiNet5d > 3000 && (sentiment?.overall_score ?? 0) > 20) regime = 'BULL';
  else if (fiiNet5d < -3000 || (sentiment?.overall_score ?? 0) < -20) regime = 'BEAR';
  else if (fiiNet5d > 1000 && diiNet5d > 1000) regime = 'TRANSITIONAL_BULL';

  let themes: string[] = [];
  try {
    const parsed = JSON.parse(sentiment?.key_themes_json || '[]');
    if (Array.isArray(parsed)) themes = parsed.map(String);
  } catch { /* malformed optional vendor context stays empty */ }

  return {
    regime,
    sentiment_score: Number(sentiment?.overall_score ?? 0),
    fii_net_5d: fiiNet5d,
    global_cue: sentiment?.global_cue ?? 'Mixed',
    hot_themes: themes,
  };
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pctFromEntry(level: number | null, entry: number): number | null {
  if (level == null || entry <= 0) return null;
  return Number((((level / entry) - 1) * 100).toFixed(1));
}

/**
 * Read the canonical ranker and add display-only facts. This report used to build a second
 * hand-weighted final score and fixed targets, allowing it to disagree with the actual engine.
 */
export async function loadCanonicalStockResearch(): Promise<{
  picks: StockPick[];
  avoid: { symbol: string; reason: string }[];
}> {
  const rows = await dbAll<any>(`
    SELECT u.*,
           q.rank_composite, q.screener_net_score, q.trailing_pe, q.return_on_equity,
           q.debt_to_equity, q.piotroski_f_score, q.return_1m, q.return_3m, q.above_sma200,
           ts.rsi, ts.adx
    FROM unified_recommendations u
    LEFT JOIN quant_scores q ON q.symbol = u.symbol
    LEFT JOIN LATERAL (
      SELECT rsi, adx FROM technical_signals t
      WHERE t.symbol = u.symbol ORDER BY t.date DESC LIMIT 1
    ) ts ON TRUE
    WHERE u.generated_at = (SELECT MAX(generated_at) FROM unified_recommendations)
    ORDER BY u.unified_score DESC
  `);
  if (!rows.length) throw new Error('Canonical recommendations unavailable; research report not generated');

  const picks: StockPick[] = [];
  const avoid: { symbol: string; reason: string }[] = [];
  for (const row of rows) {
    if (row.classification === 'Sell' || row.classification === 'Strong Sell') {
      avoid.push({
        symbol: row.symbol,
        reason: row.trade_reasoning || `${row.classification}; canonical score ${Number(row.unified_score).toFixed(1)}/100`,
      });
      continue;
    }
    if (row.classification !== 'Buy' && row.classification !== 'Strong Buy') continue;

    const entryLow = finiteNumber(row.entry_zone_low);
    const entryHigh = finiteNumber(row.entry_zone_high);
    const stopLoss = finiteNumber(row.stop_loss);
    const target1 = finiteNumber(row.target_1);
    const riskReward = finiteNumber(row.risk_reward);
    if (entryLow == null || entryHigh == null || stopLoss == null || target1 == null || riskReward == null) continue;

    const stopLossPct = pctFromEntry(stopLoss, entryHigh);
    const target1Pct = pctFromEntry(target1, entryHigh);
    if (stopLossPct == null || target1Pct == null) continue;

    const flags: string[] = [];
    if (Number(row.rsi) > 80) flags.push('RSI_OVERBOUGHT');
    if (row.debt_to_equity != null && Number(row.debt_to_equity) > 100) flags.push('HIGH_LEVERAGE');
    if (row.piotroski_f_score != null && Number(row.piotroski_f_score) < 4) flags.push('WEAK_FUNDAMENTALS');

    const target2 = finiteNumber(row.target_2);
    const validUntil = row.valid_until instanceof Date
      ? row.valid_until.toISOString()
      : row.valid_until == null ? null : String(row.valid_until);

    picks.push({
      symbol: row.symbol,
      conviction_score: Number(row.unified_score),
      quant_rank: Number(row.rank_composite ?? 0),
      signal_score: Number(row.technical_score ?? 0),
      screener_net: Number(row.screener_net_score ?? 0),
      news_boost: 0,
      unified_score: Number(row.unified_score),
      conviction_level: row.conviction_level,
      confluence_score: Number(row.confluence_score ?? 0),
      ml_score: Number(row.ml_score ?? 0),
      technical_score: Number(row.technical_score ?? 0),
      dl_score: Number(row.dl_score ?? 0),
      screener_stock_score: Number(row.screener_stock_score ?? 0),
      avg_engine_track_record: finiteNumber(row.avg_engine_track_record) ?? undefined,
      fundamental_score: finiteNumber(row.fundamental_score),
      rsi: finiteNumber(row.rsi),
      adx: finiteNumber(row.adx),
      trailing_pe: finiteNumber(row.trailing_pe),
      roe: finiteNumber(row.return_on_equity),
      debt_to_equity: finiteNumber(row.debt_to_equity),
      piotroski: finiteNumber(row.piotroski_f_score),
      bullish_screeners: Number(row.bullish_screener_count ?? 0),
      return_1m: finiteNumber(row.return_1m),
      return_3m: finiteNumber(row.return_3m),
      above_sma200: Number(row.above_sma200 ?? 0),
      entry_note: `${entryLow.toFixed(2)}-${entryHigh.toFixed(2)}`,
      stop_loss_pct: stopLossPct,
      target_1_pct: target1Pct,
      target_2_pct: pctFromEntry(target2, entryHigh),
      risk_reward: riskReward,
      layers_confirmed: Number(row.engine_coverage_count ?? 0),
      flags,
      classification: row.classification,
      regime: row.regime,
      timeframe: row.timeframe,
      valid_until: validUntil,
      trade_reasoning: row.trade_reasoning,
      entry_zone_low: entryLow,
      entry_zone_high: entryHigh,
      stop_loss: stopLoss,
      target_1: target1,
      target_2: target2,
    });
  }
  return { picks, avoid };
}

export function buildDeterministicBlurbs(
  picks: StockPick[],
  regime: string,
): Record<string, string> {
  const blurbs: Record<string, string> = {};
  for (const pick of picks.slice(0, 10)) {
    const plan = `entry ${pick.entry_note}, stop ${pick.stop_loss?.toFixed(2) ?? `${pick.stop_loss_pct.toFixed(1)}%`}, `
      + `first target ${pick.target_1?.toFixed(2) ?? `+${pick.target_1_pct.toFixed(1)}%`}, R:R ${pick.risk_reward.toFixed(2)}`;
    const risk = pick.flags.length ? ` Risk flags: ${pick.flags.join(', ')}.` : '';
    blurbs[pick.symbol] = `Canonical ${pick.classification ?? 'ranked'} score ${pick.conviction_score.toFixed(1)}/100 `
      + `with ${pick.layers_confirmed} active engines and ${pick.bullish_screeners} bullish screeners. `
      + `${regime} regime; ${pick.timeframe ?? 'unspecified'} plan: ${plan}.${risk}`;
  }
  return blurbs;
}

export async function generateBlurbs(
  picks: StockPick[],
  regime: string,
): Promise<Record<string, string>> {
  const blurbs = buildDeterministicBlurbs(picks, regime);
  if (process.env.RESEARCH_AI_BLURBS_ENABLED !== 'true') return blurbs;

  let aiService: any;
  try {
    aiService = await import('../services/aiService');
  } catch {
    return blurbs;
  }
  if (typeof aiService.generateStockAnalysis !== 'function') return blurbs;

  for (const pick of picks.slice(0, 10)) {
    try {
      const result = await Promise.race([
        aiService.generateStockAnalysis(pick.symbol, {
          regime,
          trailing_pe: pick.trailing_pe,
          roe: pick.roe,
          return_1m: pick.return_1m,
          conviction_score: pick.conviction_score,
          piotroski: pick.piotroski,
          bullish_screeners: pick.bullish_screeners,
          rsi: pick.rsi,
          adx: pick.adx,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 60_000)),
      ]) as any;
      if (result?.reasoning && !result.error) {
        blurbs[pick.symbol] += ` Optional AI context: ${result.reasoning}`;
      } else if (result?.error) {
        blurbs[pick.symbol] += ' AI enrichment unavailable; quantitative evidence shown.';
      }
    } catch {
      blurbs[pick.symbol] += ' AI enrichment unavailable; quantitative evidence shown.';
    }
  }
  return blurbs;
}

async function getSectorRankings(): Promise<{ sector: string; score: number; momentum: string }[]> {
  return (await dbAll(`
    SELECT n.sector, AVG(q.rank_composite) as score, AVG(q.return_1m) as avg_1m
    FROM quant_scores q
    JOIN nse_stocks n ON q.symbol = n.symbol
    WHERE q.composite_class IN ('Strong Buy','Buy') AND n.sector IS NOT NULL
    GROUP BY n.sector HAVING COUNT(*) >= 3
    ORDER BY score DESC LIMIT 10
  `) as any[]).map((row: any) => ({
    sector: row.sector,
    score: Number(Number(row.score || 0).toFixed(1)),
    momentum: Number(row.avg_1m || 0) > 5 ? 'STRONG' : Number(row.avg_1m || 0) > 0 ? 'MODERATE' : 'WEAK',
  }));
}

function buildExecutiveSummary(
  regime: string,
  fiiNet5d: number,
  sentimentScore: number,
  topPick: StockPick | undefined,
  topSector: string | undefined,
): string {
  const fiiDir = fiiNet5d > 0 ? 'net buyers' : 'net sellers';
  const fiiAmt = Math.abs(fiiNet5d / 100).toFixed(0);
  const sentDir = sentimentScore > 10 ? 'bullish' : sentimentScore < -10 ? 'bearish' : 'neutral';
  const pickStr = topPick ? `Top canonical pick is ${topPick.symbol} with score ${topPick.conviction_score}/100.` : '';
  const sectorStr = topSector ? `${topSector} leads sector momentum.` : '';
  return `Market regime is ${regime} with FIIs being ${fiiDir} (₹${fiiAmt}Cr over 5 days) and overall sentiment ${sentDir}. ${pickStr} ${sectorStr}`.trim();
}

export async function generateDailyReport(
  reportDate: string,
  reportType: 'PRE_MARKET' | 'POST_CLOSE',
): Promise<void> {
  await dbRun(`
    INSERT INTO daily_research_reports (report_date, report_type, status)
    VALUES (?, ?, 'GENERATING')
    ON CONFLICT(report_date, report_type) DO UPDATE SET status = 'GENERATING', error_message = NULL
  `, [reportDate, reportType]);

  try {
    const context = await getMarketContext();
    const { picks, avoid } = await loadCanonicalStockResearch();
    const top10 = picks.slice(0, 10);
    const watch10 = picks.slice(10, 20).map(pick => ({
      symbol: pick.symbol,
      conviction_score: pick.conviction_score,
      layers_confirmed: pick.layers_confirmed,
    }));
    const canonicalRegime = top10[0]?.regime || context.regime;
    const sectors = await getSectorRankings();
    const blurbs = await generateBlurbs(top10, canonicalRegime);
    const report: ResearchReport = {
      report_date: reportDate,
      report_type: reportType,
      market_regime: canonicalRegime,
      sentiment_score: context.sentiment_score,
      fii_net_5d: context.fii_net_5d,
      global_cue: context.global_cue,
      hot_themes: context.hot_themes,
      top_picks: top10,
      watchlist: watch10,
      avoid_list: avoid.slice(0, 10),
      sector_rankings: sectors,
      executive_summary: buildExecutiveSummary(
        canonicalRegime,
        context.fii_net_5d,
        context.sentiment_score,
        top10[0],
        sectors[0]?.sector,
      ),
    };

    await dbRun(`
      UPDATE daily_research_reports SET
        status = 'READY', generated_at = datetime('now'), market_regime = ?,
        sentiment_score = ?, fii_net_5d = ?, top_picks_json = ?, report_json = ?,
        ai_blurbs_json = ?
      WHERE report_date = ? AND report_type = ?
    `, [
      canonicalRegime,
      context.sentiment_score,
      context.fii_net_5d,
      JSON.stringify(top10),
      JSON.stringify(report),
      JSON.stringify(blurbs),
      reportDate,
      reportType,
    ]);
  } catch (error: any) {
    await dbRun(`
      UPDATE daily_research_reports SET status = 'FAILED', error_message = ?
      WHERE report_date = ? AND report_type = ?
    `, [String(error?.message ?? error), reportDate, reportType]);
    throw error;
  }
}
