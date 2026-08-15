import { z } from 'zod';
import { dbGet, dbAll } from '../dbAsync';
import { router, publicProcedure, adminProcedure } from '../trpc';
import { runPython } from '../pythonRunner';
import { cacheGet } from '../cacheService';

// TTL cache for MAX(computed_at) — refreshes every 5 min so new ranker runs are picked up.
let _urLatestAtCC: string | null = null;
let _urLatestAtExp = 0;
async function urLatestAt(): Promise<string | null> {
  if (!_urLatestAtCC || Date.now() > _urLatestAtExp) {
    const row = await dbGet<{ ts: string }>('SELECT CAST(MAX(computed_at) AS TEXT) AS ts FROM unified_recommendations');
    _urLatestAtCC = row?.ts ?? null;
    _urLatestAtExp = Date.now() + 5 * 60_000;
  }
  return _urLatestAtCC;
}
export function invalidateUrLatestAt() { _urLatestAtCC = null; _urLatestAtExp = 0; }

export const commandCenterRouter = router({

  getCommandCenter: publicProcedure
    .input(z.object({
      conviction: z.enum(['ALL', 'S_ELITE', 'A_HIGH', 'B_MEDIUM', 'C_LOW', 'D_MARGINAL']).default('ALL'),
      horizon:    z.enum(['ALL', 'intraday', 'swing', 'long_term']).default('ALL'),
      limit:      z.number().min(1).max(100).default(30),
    }))
    .query(async ({ input }) => {
      const regimeRow = await dbGet<{ regime: string; regime_prob: number }>(
        'SELECT regime, regime_prob FROM market_regimes ORDER BY date DESC LIMIT 1'
      );
      const regime = {
        name:       regimeRow?.regime ?? 'BULL',
        confidence: regimeRow?.regime_prob ?? 0.5,
        updated_at: new Date().toISOString(),
      };

      const latest = await urLatestAt();
      let query = `
        SELECT symbol, unified_score, conviction_level, timeframe, sector,
               avg_engine_track_record, classification, stop_loss, target_1, target_2,
               entry_zone_low, entry_zone_high, risk_reward, screener_stock_score,
               ml_score, confluence_score, technical_score, dl_score, trade_reasoning,
               engine_coverage_count, computed_at
        FROM unified_recommendations
        WHERE CAST(computed_at AS TEXT) = ?
      `;
      const params: (string | number)[] = [latest ?? ''];
      if (input.conviction !== 'ALL') {
        query += ` AND conviction_level = ?`;
        params.push(input.conviction);
      }
      if (input.horizon !== 'ALL') {
        query += ` AND timeframe = ?`;
        params.push(input.horizon);
      }
      // trpc-surface-review, 2026-08-14: Postgres sorts NaN highest on ORDER BY DESC, so an
      // unscored/NaN row would rank #1 instead of last. No live NaN currently (dormant), but
      // risk.router.ts already guards its own score columns this way for the same reason.
      query += ` ORDER BY NULLIF(unified_score, 'NaN'::float8) DESC LIMIT ?`;
      params.push(input.limit);

      const eodRows = await dbAll<any>(query, params);

      let liveCache: Record<string, any> = {};
      try {
        const cached = await cacheGet('live-stocks-bulk');
        if (cached) liveCache = JSON.parse(cached as string);
      } catch { /* no cache */ }

      const eodPicks = eodRows.map((row) => {
        const live = liveCache[row.symbol];
        const livePrice = live?.price ?? live?.lastPrice ?? null;
        const realizedReturnPct = (livePrice && row.entry_zone_low)
          ? parseFloat(((livePrice - row.entry_zone_low) / row.entry_zone_low * 100).toFixed(2))
          : null;
        return { ...row, livePrice, realizedReturnPct, changePercent: live?.changePercent ?? null };
      });

      let intradaySignals: any[] = [];
      if (regime.name !== 'CRASH') {
        try {
          const today = new Date().toISOString().slice(0, 10);
          // Orders on COALESCE(calibrated_win_probability, win_probability) — was raw
          // unconditionally (2026-07-18 gating follow-up).
          // signal_strength was never a real technical_signals column (this always threw and
          // was silently swallowed by the catch below, so intradaySignals was always []) --
          // signal_score (real, 0-10 composite) is this codebase's actual strength measure;
          // >=7 matches the "HIGH" tier threshold used elsewhere. Found via CI smoke test.
          intradaySignals = await dbAll<any>(`
            SELECT symbol, signal_type, win_probability,
                   signal_score, rsi, cmp, change_pct, ai_insight,
                   entry_zone, stop_loss, targets, time_horizon
            FROM technical_signals
            WHERE date = ? AND signal_score >= 7
            ORDER BY COALESCE(calibrated_win_probability, win_probability) DESC LIMIT 20
          `, [today]);
        } catch (e) { console.error(e); /* table may differ in schema */ }
      }

      return {
        regime,
        eodPicks,
        intradaySignals,
        lastComputedAt: eodRows[0]?.computed_at ?? null,
        avgEngineTrackRecord: eodRows[0]?.avg_engine_track_record ?? null,
      };
    }),

  getBuyRecommendations: publicProcedure
    .input(z.object({
      // 'TOP' = S_ELITE + A_HIGH combined -- the "most accurate only" tier, and the default.
      conviction: z.enum(['TOP', 'ALL', 'S_ELITE', 'A_HIGH', 'B_MEDIUM']).default('TOP'),
      horizon:    z.enum(['ALL', 'intraday', 'swing', 'long_term']).default('ALL'),
      sector:     z.string().optional(),
      limit:      z.number().min(1).max(200).default(60),
    }))
    .query(async ({ input }) => {
      const regimeRow = await dbGet<{ regime: string; regime_prob: number }>(
        'SELECT regime, regime_prob FROM market_regimes ORDER BY date DESC LIMIT 1'
      );
      const regime = regimeRow?.regime ?? 'BULL';

      const latest = await urLatestAt();
      const params: (string | number)[] = [latest ?? ''];
      // This is a BUY recommendations page -- unified_score is a magnitude, not a signed
      // direction (a high score can back a Sell just as easily as a Buy: e.g. live data
      // 2026-08-03 had the #1 and #2 top-scored S_ELITE rows both classified 'Sell'). Found
      // while wiring up the "most accurate signals only" page -- without this filter, 62% of
      // what this endpoint returned (958/1551 rows, default filters) was Sell/Strong Sell/Hold,
      // not a buy call at all.
      let convFilter = ` AND ur.classification IN ('Buy', 'Strong Buy')`;
      if (input.conviction === 'TOP') {
        convFilter += ` AND ur.conviction_level IN ('S_ELITE', 'A_HIGH')`;
      } else if (input.conviction !== 'ALL') {
        convFilter += ` AND ur.conviction_level = ?`;
        params.push(input.conviction);
      } else {
        // ALL: still exclude D_MARGINAL -- never a useful "buy idea" tier
        convFilter += ` AND ur.conviction_level != 'D_MARGINAL'`;
      }
      let horizonFilter = '';
      if (input.horizon !== 'ALL') {
        horizonFilter = ` AND ur.timeframe = ?`;
        params.push(input.horizon);
      }
      let sectorFilter = '';
      if (input.sector) {
        sectorFilter = ` AND ur.sector = ?`;
        params.push(input.sector);
      }
      params.push(input.limit);

      // The `ts` subquery used to be `SELECT * FROM technical_signals WHERE date = (SELECT
      // MAX(date) ...)` -- materializing every symbol's full ~300-column row for the latest
      // date before joining down to the (up to 200) rows this endpoint actually returns.
      // Project only the columns the outer SELECT reads.
      const rows = await dbAll<any>(`
        SELECT
          ur.symbol, ur.unified_score, ur.conviction_level, ur.timeframe, ur.sector,
          ur.classification, ur.stop_loss, ur.target_1, ur.target_2,
          ur.entry_zone_low, ur.entry_zone_high, ur.risk_reward,
          ur.ml_score, ur.confluence_score, ur.technical_score, ur.dl_score,
          ur.trade_reasoning, ur.engine_coverage_count, ur.computed_at,
          -- technical_signals feature columns (signal_strength removed -- not a real column,
          -- always threw and 500'd this endpoint; found via CI smoke test)
          ts.win_probability, ts.signal_type,
          ts.rsi, ts.cmp, ts.change_pct,
          ts.rs_vs_sector_21d, ts.rs_vs_sector_63d,
          ts.eps_surprise_q1, ts.eps_surprise_q2, ts.eps_beat_streak,
          ts.eps_miss_after_streak, ts.rev_surprise_q1,
          ts.fcf_yield AS fcf_yield, ts.interest_coverage, ts.fcf_positive, ts.debt_coverage_risk,
          ts.delivery_trend_30d, ts.block_deal_flag, ts.block_deal_direction,
          ts.short_interest_proxy,
          ts.promoter_buy_90d_cr, ts.promoter_sell_90d_cr, ts.promoter_net_90d,
          ts.insider_buy_flag, ts.insider_sell_flag,
          ts.rating_upgrade_180d, ts.rating_downgrade_180d,
          ts.mf_sector_flow_pct,
          ts.ccc_trend, ts.wc_deteriorating, ts.wc_improving,
          ts.expected_move_pct, ts.stock_gex_proxy,
          ts.iep_gap_pct, ts.preopen_imbalance,
          ts.pledge_chg_90d, ts.asm_flag, ts.gsm_stage,
          ts.mc_broker_buy_7d, ts.mc_broker_sell_7d, ts.mc_broker_upside,
          ts.is_nifty50, ts.nifty_tier,
          ts.hv_20d, ts.iv_hv_ratio,
          ts.days_to_next_results
        FROM unified_recommendations ur
        LEFT JOIN (
          SELECT symbol, win_probability, signal_type, rsi, cmp, change_pct,
                 rs_vs_sector_21d, rs_vs_sector_63d,
                 eps_surprise_q1, eps_surprise_q2, eps_beat_streak,
                 eps_miss_after_streak, rev_surprise_q1,
                 fcf_yield_approx AS fcf_yield, interest_coverage, fcf_positive, debt_coverage_risk,
                 delivery_trend_30d, block_deal_flag, block_deal_direction,
                 short_interest_proxy,
                 promoter_buy_90d_cr, promoter_sell_90d_cr, promoter_net_90d,
                 insider_buy_flag, insider_sell_flag,
                 rating_upgrade_180d, rating_downgrade_180d,
                 mf_sector_flow_pct,
                 ccc_trend, wc_deteriorating, wc_improving,
                 expected_move_pct, stock_gex_proxy,
                 iep_gap_pct, preopen_imbalance,
                 pledge_chg_90d, asm_flag, gsm_stage,
                 mc_broker_buy_7d, mc_broker_sell_7d, mc_broker_upside,
                 is_nifty50, nifty_tier,
                 hv_20d, iv_hv_ratio,
                 days_to_next_results
          FROM technical_signals
          WHERE date = (SELECT MAX(date) FROM technical_signals)
        ) ts ON ts.symbol = ur.symbol
        WHERE ur.computed_at = ?
        ${convFilter}${horizonFilter}${sectorFilter}
        ORDER BY NULLIF(ur.unified_score, 'NaN'::float8) DESC
        LIMIT ?
      `, params);

      let liveCache: Record<string, any> = {};
      try {
        const cached = await cacheGet('live-stocks-bulk');
        if (cached) liveCache = JSON.parse(cached as string);
      } catch { /* no cache */ }

      const picks = rows.map((r) => {
        const live = liveCache[r.symbol];
        return {
          ...r,
          livePrice:    live?.price ?? live?.lastPrice ?? r.cmp ?? null,
          changePercent: live?.changePercent ?? r.change_pct ?? null,
        };
      });

      // distinct sectors for filter dropdown
      const sectorSet = [...new Set(picks.map((p: any) => p.sector).filter(Boolean))].sort();

      return { picks, regime, sectorList: sectorSet, lastComputedAt: rows[0]?.computed_at ?? null };
    }),

  // Same-day intraday picks from intraday_ranker.py's own ranked output (intraday_recommendations),
  // never surfaced by any existing page before this -- IntradayBreakouts/LiveMarketScreener are
  // live third-party pass-throughs with no persisted ranking, and getBuyRecommendations reads
  // unified_recommendations (a different, positional/swing engine; its own 'INTRADAY' timeframe
  // rows are a separate thing again). intraday_ranker.py gates Buy/Strong Buy emission on its own
  // trailing realised PnL (see EMISSION_GATE in that file) -- when the gate is closed this
  // legitimately returns zero picks, which is the correct behavior, not a bug, so gateOpen/
  // gateReason are returned explicitly rather than leaving an empty list unexplained.
  getIntradayTopPicks: publicProcedure
    .query(async () => {
      const latestRow = await dbGet<{ ts: string }>(
        'SELECT CAST(MAX(computed_at) AS TEXT) AS ts FROM intraday_recommendations'
      );
      const latest = latestRow?.ts ?? null;
      if (!latest) {
        return { picks: [], gateOpen: null, gateReason: null, lastComputedAt: null, totalScored: 0 };
      }

      const [picks, gateRow, totalRow] = await Promise.all([
        dbAll<any>(`
          SELECT symbol, intraday_regime, intraday_score, conviction_level, classification,
                 screener_score, breakout_score, news_sentiment, bullish_count, bearish_count,
                 cmp, entry_price, stop_loss, target_1, risk_reward, position_size_pct, reasoning
          FROM intraday_recommendations
          WHERE computed_at = ? AND classification IN ('Buy', 'Strong Buy')
          ORDER BY NULLIF(intraday_score, 'NaN'::float8) DESC
          LIMIT 60
        `, [latest]),
        dbGet<{ reasoning: string }>(`
          SELECT reasoning FROM intraday_recommendations
          WHERE computed_at = ? AND reasoning LIKE '%EMISSION GATED%'
          LIMIT 1
        `, [latest]),
        dbGet<{ n: number }>('SELECT COUNT(*) AS n FROM intraday_recommendations WHERE computed_at = ?', [latest]),
      ]);

      const gateOpen = !gateRow;
      return {
        picks,
        gateOpen,
        gateReason: gateOpen
          ? null
          : "The engine's own trailing realised P&L over the last 10 trading days is not positive, so Buy/Strong Buy emission is paused until it recovers (re-checked every 15-min cycle) -- scores are still computed, just not published as actionable.",
        lastComputedAt: latest,
        totalScored: totalRow?.n ?? 0,
      };
    }),

  // Single-symbol canonical score -- for stock-detail pages (v4 StockIntelligencePage) that
  // need one stock's unified_recommendations row plus its technical_signals feature set for a
  // tag row, without pulling and filtering the whole ranked list client-side.
  getUnifiedScoreForSymbol: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const latest = await urLatestAt();
      // Was `LEFT JOIN (SELECT * FROM technical_signals WHERE date = (SELECT MAX(date)...))` --
      // materializing every symbol's full ~300-column row for the latest date just to join
      // down to this one symbol. This is likely the single highest-traffic per-symbol endpoint
      // in the app (every stock-detail page load). Split into two indexed point lookups run
      // in parallel instead: `ur` by (symbol, computed_at) and `ts` by symbol, latest date only.
      const [ur, ts] = await Promise.all([
        dbGet<any>(`
          SELECT symbol, unified_score, conviction_level, timeframe, sector,
                 classification, stop_loss, target_1, target_2,
                 entry_zone_low, entry_zone_high, risk_reward,
                 ml_score, confluence_score, technical_score, dl_score,
                 trade_reasoning, engine_coverage_count, computed_at
          FROM unified_recommendations
          WHERE symbol = ? AND computed_at = ?
        `, [input.symbol, latest ?? '']),
        dbGet<any>(`
          SELECT win_probability, signal_type, rsi, cmp, change_pct,
                 eps_surprise_q1, eps_surprise_q2, eps_beat_streak, eps_miss_after_streak,
                 fcf_yield_approx AS fcf_yield, interest_coverage, fcf_positive, debt_coverage_risk,
                 delivery_trend_30d, block_deal_flag, block_deal_direction,
                 promoter_buy_90d_cr, promoter_sell_90d_cr, promoter_net_90d,
                 insider_buy_flag, insider_sell_flag,
                 rating_upgrade_180d, rating_downgrade_180d,
                 mf_sector_flow_pct, wc_improving, wc_deteriorating,
                 asm_flag, gsm_stage, is_nifty50, nifty_tier,
                 days_to_next_results
          FROM technical_signals
          WHERE symbol = ?
          ORDER BY date DESC
          LIMIT 1
        `, [input.symbol]),
      ]);
      if (!ur) return null;
      return { ...ur, ...(ts ?? {}) };
    }),

  runUnifiedRanker: adminProcedure
    .mutation(async () => {
      try {
        const { stdout } = await runPython('unified_ranker.py', [], 5 * 60_000);
        const parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}');
        return {
          success: true,
          stocks_scored:        parsed.stocks_scored ?? 0,
          conviction_breakdown: parsed.conviction_breakdown ?? {},
          regime:               parsed.regime ?? 'UNKNOWN',
          duration_ms:          0,
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }),
});
