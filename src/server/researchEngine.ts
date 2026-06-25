import { dbAll, dbGet, dbRun } from './dbAsync';

export interface StockPick {
  symbol: string;
  conviction_score: number;
  quant_rank: number;
  signal_score: number;
  xgboost_score: number;
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
  target_2_pct: number;
  risk_reward: number;
  layers_confirmed: number;
  flags: string[];
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

  const fii_net_5d = fiiRows.reduce((sum: number, r: any) => sum + (r.fii_net || 0), 0);
  const dii_net_5d = fiiRows.reduce((sum: number, r: any) => sum + (r.dii_net || 0), 0);

  let regime = 'SIDEWAYS';
  if (fii_net_5d > 3000 && (sentiment?.overall_score ?? 0) > 20) regime = 'BULL';
  else if (fii_net_5d < -3000 || (sentiment?.overall_score ?? 0) < -20) regime = 'BEAR';
  else if (fii_net_5d > 1000 && dii_net_5d > 1000) regime = 'TRANSITIONAL_BULL';

  const themes = (() => {
    try { return JSON.parse(sentiment?.key_themes_json || '[]'); } catch { return []; }
  })();

  return {
    regime,
    sentiment_score: sentiment?.overall_score ?? 0,
    fii_net_5d,
    global_cue: sentiment?.global_cue ?? 'Mixed',
    hot_themes: themes,
  };
}

async function scoreStocks(): Promise<{ picks: StockPick[]; avoid: { symbol: string; reason: string }[] }> {
  const quantRows = await dbAll(`
    SELECT symbol, rank_composite, rank_momentum, momentum_score, screener_net_score,
           bullish_screener_count, bearish_screener_count, trailing_pe, return_on_equity,
           debt_to_equity, piotroski_f_score, return_1m, return_3m, above_sma200,
           max_drawdown_1y, annualized_vol, sharpe_ratio
    FROM quant_scores
    WHERE composite_class IN ('Strong Buy','Buy') AND ohlcv_days >= 60
  `) as any[];

  const quantMap = new Map<string, any>(quantRows.map((q: any) => [q.symbol, q]));

  const techMap = new Map<string, any>();
  (await dbAll(`
    SELECT ts.symbol, ts.signal_score, ts.win_probability, ts.rsi, ts.adx,
           ts.volume_ratio, ts.above_sma200, ts.signals_json, ts.news_sentiment_score
    FROM technical_signals ts
    INNER JOIN (
      SELECT symbol, MAX(date) as max_date FROM technical_signals GROUP BY symbol
    ) latest ON ts.symbol = latest.symbol AND ts.date = latest.max_date
    WHERE ts.signal_score >= 5
  `) as any[]).forEach(r => techMap.set(r.symbol, r));

  const xgbMap = new Map<string, any>();
  try {
    (await dbAll(`
      SELECT symbol, xgboost_score, signal, is_growth, is_breakout
      FROM xgboost_predictions WHERE signal = 'BUY'
    `) as any[]).forEach(r => xgbMap.set(r.symbol, r));
  } catch { /* table may not exist */ }

  const unifiedMap = new Map<string, any>();
  try {
    const unifiedRows = await dbAll(`
      SELECT symbol, unified_score, conviction_level, screener_stock_score,
             ml_score, confluence_score, technical_score, dl_score,
             avg_engine_track_record, fundamental_score
      FROM unified_recommendations
      WHERE computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
    `) as any[];
    unifiedRows.forEach(r => unifiedMap.set(r.symbol, r));
  } catch { /* unified engine may not have run yet */ }

  const confluenceMap = new Map<string, number>();
  try {
    (await dbAll(`
      SELECT symbol, confluence_score
      FROM confluence_signals
      WHERE computed_at = (SELECT MAX(computed_at) FROM confluence_signals)
    `) as any[]).forEach(r => confluenceMap.set(r.symbol, r.confluence_score ?? 0));
  } catch { /* confluence engine may not have run yet */ }

  const dlMap = new Map<string, number>();
  try {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    (await dbAll(`
      SELECT symbol, prob_up_5d as probability
      FROM deep_learning_predictions
      WHERE prediction_date >= ?
    `, [yesterday]) as any[]).forEach(r => dlMap.set(r.symbol, (r.probability ?? 0) * 100));
  } catch { /* DL predictions may not be available */ }

  const newsMap = new Map<string, number>();
  (await dbAll(`
    SELECT symbols_json, sentiment_score, impact
    FROM news_sentiment_items
    WHERE impact IN ('HIGH','MEDIUM')
      AND published_at >= datetime('now', '-2 days')
      AND sentiment IN ('BULLISH')
  `) as any[]).forEach((r: any) => {
    try {
      const syms: string[] = JSON.parse(r.symbols_json || '[]');
      syms.forEach(s => newsMap.set(s, (newsMap.get(s) || 0) + (r.impact === 'HIGH' ? 1 : 0.5)));
    } catch {}
  });

  const avoidList: { symbol: string; reason: string }[] = [];
  const scored: StockPick[] = [];

  const allSymbols = new Set<string>();
  quantRows.forEach(q => allSymbols.add(q.symbol));
  techMap.forEach((_, symbol) => allSymbols.add(symbol));
  xgbMap.forEach((_, symbol) => allSymbols.add(symbol));
  unifiedMap.forEach((_, symbol) => allSymbols.add(symbol));
  confluenceMap.forEach((_, symbol) => allSymbols.add(symbol));
  dlMap.forEach((_, symbol) => allSymbols.add(symbol));
  newsMap.forEach((_, symbol) => allSymbols.add(symbol));

  for (const symbol of allSymbols) {
    const q = quantMap.get(symbol);
    const tech = techMap.get(symbol);
    const xgb  = xgbMap.get(symbol);
    const u = unifiedMap.get(symbol);
    const newsScore = newsMap.get(symbol) || 0;

    const flags: string[] = [];
    if (tech?.rsi > 80) flags.push('RSI_OVERBOUGHT');
    if ((q?.debt_to_equity ?? 0) > 100) flags.push('HIGH_LEVERAGE');
    if ((q?.max_drawdown_1y ?? 0) > 40) flags.push('HIGH_DRAWDOWN');
    if ((q?.piotroski_f_score ?? 5) < 4) flags.push('WEAK_FUNDAMENTALS');

    if (flags.length >= 2 && !u) {
      avoidList.push({ symbol, reason: flags.join(', ') });
      continue;
    }

    const confluenceScore = u?.confluence_score ?? confluenceMap.get(symbol) ?? 0;
    const dlScore = u?.dl_score ?? dlMap.get(symbol) ?? 0;

    let layers_confirmed = 0;
    if (q) layers_confirmed++;
    if (tech) layers_confirmed++;
    if (xgb) layers_confirmed++;
    if (newsScore > 0) layers_confirmed++;
    if (u) layers_confirmed++;
    if (!u && confluenceScore > 0) layers_confirmed++;
    if (!u && dlScore > 0) layers_confirmed++;

    if (layers_confirmed < 2 && !u) continue;

    const unified_component    = u ? Math.min(u.unified_score / 100, 1) * 50 : 0;
    const quant_component      = q ? (q.rank_composite / 100) * 20 : 0;
    const tech_component       = tech ? (tech.signal_score / 10) * 15 : (u?.technical_score ? Math.min(u.technical_score / 10, 1) * 10 : 0);
    const xgb_component        = xgb ? xgb.xgboost_score * 10 : 0;
    const confluence_component = confluenceScore ? Math.min(confluenceScore / 100, 1) * 10 : 0;
    const ml_component         = u?.ml_score ? Math.min(u.ml_score / 100, 1) * 10 : (tech?.win_probability ? Math.min(tech.win_probability, 1) * 10 : 0);
    const screener_component   = u?.screener_stock_score ? Math.min(u.screener_stock_score / 100, 1) * 10 : Math.min((q?.screener_net_score || 0) / 50, 1) * 10;
    const news_component       = Math.min(newsScore / 3, 1) * 10;

    let conviction_score =
      unified_component + quant_component + tech_component + xgb_component + confluence_component + ml_component + screener_component + news_component;
    conviction_score = Math.min(Math.max(conviction_score, 0), 100);

    if (flags.includes('RSI_OVERBOUGHT'))    conviction_score *= 0.75;
    if (flags.includes('HIGH_LEVERAGE'))     conviction_score *= 0.80;
    if (flags.includes('HIGH_DRAWDOWN'))     conviction_score *= 0.85;
    if (flags.includes('WEAK_FUNDAMENTALS')) conviction_score *= 0.70;

    if (conviction_score < 25) continue;

    const vol           = q?.annualized_vol || 30;
    const stop_loss_pct = Math.round(Math.max(6, Math.min(15, vol * 0.4)));
    const target_1_pct  = stop_loss_pct * 2.5;
    const target_2_pct  = stop_loss_pct * 4;
    const risk_reward   = parseFloat((target_1_pct / stop_loss_pct).toFixed(1));

    scored.push({
      symbol:               symbol,
      conviction_score:     parseFloat(conviction_score.toFixed(1)),
      quant_rank:           q?.rank_composite ?? 0,
      signal_score:         tech?.signal_score ?? u?.technical_score ?? 0,
      xgboost_score:        xgb?.xgboost_score ?? 0,
      screener_net:         q?.screener_net_score ?? 0,
      news_boost:           newsScore,
      unified_score:        u?.unified_score,
      conviction_level:     u?.conviction_level,
      confluence_score:     confluenceScore,
      ml_score:             u?.ml_score ?? (tech?.win_probability ? tech.win_probability * 100 : 0),
      technical_score:      u?.technical_score ?? (tech?.signal_score ?? 0),
      dl_score:             dlScore,
      screener_stock_score: u?.screener_stock_score ?? Math.min((q?.screener_net_score || 0) / 50, 1) * 100,
      avg_engine_track_record: u?.avg_engine_track_record,
      fundamental_score:    u?.fundamental_score ?? q?.return_on_equity ?? null,
      rsi:                  tech?.rsi ?? null,
      adx:                  tech?.adx ?? null,
      trailing_pe:          q?.trailing_pe,
      roe:                  q?.return_on_equity,
      debt_to_equity:       q?.debt_to_equity,
      piotroski:            q?.piotroski_f_score,
      bullish_screeners:    q?.bullish_screener_count ?? 0,
      return_1m:            q?.return_1m,
      return_3m:            q?.return_3m,
      above_sma200:         q?.above_sma200 ?? 0,
      entry_note:           tech?.rsi > 65 ? 'Wait for pullback' : 'CMP entry acceptable',
      stop_loss_pct:        -stop_loss_pct,
      target_1_pct,
      target_2_pct,
      risk_reward,
      layers_confirmed,
      flags,
    });
  }

  scored.sort((a, b) => b.conviction_score - a.conviction_score);
  return { picks: scored, avoid: avoidList };
}

async function generateBlurbs(
  picks: StockPick[],
  regime: string
): Promise<Record<string, { bull: string; bear: string; risk: string }>> {
  const blurbs: Record<string, { bull: string; bear: string; risk: string }> = {};

  // Dynamically import AI service to avoid circular issues
  let aiService: any = null;
  try {
    aiService = await import('../services/aiService');
  } catch {
    return blurbs;
  }

  // aiService exports generateStockAnalysis(symbol, data) -> StockAnalysis
  const generateFn = aiService.generateStockAnalysis;
  if (typeof generateFn !== 'function') return blurbs;

  for (const pick of picks.slice(0, 10)) {
    try {
      const result = await Promise.race([
        generateFn(pick.symbol, {
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000)),
      ]) as any;

      if (result && typeof result === 'object' && result.reasoning) {
        blurbs[pick.symbol] = {
          bull: result.sentiment === 'Bullish' ? result.reasoning : '',
          bear: result.sentiment === 'Bearish' ? result.reasoning : '',
          risk: result.error ? result.reasoning : `Confidence: ${result.confidence ?? 0}%`,
        };
      }
    } catch {
      // AI unavailable or timeout — skip gracefully
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return blurbs;
}

async function getSectorRankings(): Promise<{ sector: string; score: number; momentum: string }[]> {
  return (await dbAll(`
    SELECT n.sector,
           AVG(q.rank_composite) as score,
           AVG(q.return_1m) as avg_1m
    FROM quant_scores q
    JOIN nse_stocks n ON q.symbol = n.symbol
    WHERE q.composite_class IN ('Strong Buy','Buy')
      AND n.sector IS NOT NULL
    GROUP BY n.sector
    HAVING COUNT(*) >= 3
    ORDER BY score DESC
    LIMIT 10
  `) as any[]).map((r: any) => ({
    sector:   r.sector,
    score:    parseFloat((r.score || 0).toFixed(1)),
    momentum: (r.avg_1m || 0) > 5 ? 'STRONG' : (r.avg_1m || 0) > 0 ? 'MODERATE' : 'WEAK',
  }));
}

function buildExecutiveSummary(
  regime: string,
  fii_net_5d: number,
  sentimentScore: number,
  topPick: StockPick | undefined,
  topSector: string | undefined
): string {
  const fiiDir = fii_net_5d > 0 ? 'net buyers' : 'net sellers';
  const fiiAmt = Math.abs(fii_net_5d / 100).toFixed(0);
  const sentDir = sentimentScore > 10 ? 'bullish' : sentimentScore < -10 ? 'bearish' : 'neutral';
  const pickStr = topPick ? `Top conviction pick is ${topPick.symbol} with score ${topPick.conviction_score}/100.` : '';
  const sectorStr = topSector ? `${topSector} leads sector momentum.` : '';
  return `Market regime is ${regime} with FIIs being ${fiiDir} (₹${fiiAmt}Cr over 5 days) and overall sentiment ${sentDir}. ${pickStr} ${sectorStr}`.trim();
}

export async function generateDailyReport(
  report_date: string,
  report_type: 'PRE_MARKET' | 'POST_CLOSE'
): Promise<void> {
  await dbRun(`
    INSERT INTO daily_research_reports (report_date, report_type, status)
    VALUES (?, ?, 'GENERATING')
    ON CONFLICT(report_date, report_type) DO UPDATE SET status = 'GENERATING', error_message = NULL
  `, [report_date, report_type]);

  try {
    const ctx    = await getMarketContext();
    const { picks, avoid } = await scoreStocks();
    const top10  = picks.slice(0, 10);
    const watch10 = picks.slice(10, 20).map(p => ({
      symbol:           p.symbol,
      conviction_score: p.conviction_score,
      layers_confirmed: p.layers_confirmed,
    }));
    const sectors = await getSectorRankings();
    const blurbs  = await generateBlurbs(top10, ctx.regime);

    const report: ResearchReport = {
      report_date,
      report_type,
      market_regime:     ctx.regime,
      sentiment_score:   ctx.sentiment_score,
      fii_net_5d:        ctx.fii_net_5d,
      global_cue:        ctx.global_cue,
      hot_themes:        ctx.hot_themes,
      top_picks:         top10,
      watchlist:         watch10,
      avoid_list:        avoid.slice(0, 10),
      sector_rankings:   sectors,
      executive_summary: buildExecutiveSummary(ctx.regime, ctx.fii_net_5d, ctx.sentiment_score, top10[0], sectors[0]?.sector),
    };

    await dbRun(`
      UPDATE daily_research_reports SET
        status          = 'READY',
        generated_at    = datetime('now'),
        market_regime   = ?,
        sentiment_score = ?,
        fii_net_5d      = ?,
        top_picks_json  = ?,
        report_json     = ?,
        ai_blurbs_json  = ?
      WHERE report_date = ? AND report_type = ?
    `, [
      ctx.regime,
      ctx.sentiment_score,
      ctx.fii_net_5d,
      JSON.stringify(top10),
      JSON.stringify(report),
      JSON.stringify(blurbs),
      report_date,
      report_type,
    ]);
  } catch (err: any) {
    await dbRun(`
      UPDATE daily_research_reports SET status = 'FAILED', error_message = ?
      WHERE report_date = ? AND report_type = ?
    `, [String(err?.message ?? err), report_date, report_type]);
    throw err;
  }
}
